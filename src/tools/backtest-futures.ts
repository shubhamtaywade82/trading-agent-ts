import type { Candle } from "../backtest/types.js";
import { legacyBullishLiqSweep, legacyBearishLiqSweep } from "../concepts/legacy-conditions.js";
import { computeLiqPrice } from "../paper-trading/symbol-position.js";
import { initTrailingState, updateTrailingStop, type TrailingConfig } from "../paper-trading/trailing.js";

import { buildSignalEvaluator } from "./backtest-signals.js";

// ── Futures backtest engine (shared between the two tools above) ──
export interface TradeRecord {
  entryTime: number; exitTime: number; holdBars: number; holdMs: number;
  direction: "long" | "short"; pnlUsd: number; pnlPct: number;
  exitReason: "liq" | "stop" | "target" | "timeout";
}

export function runFuturesBacktest(
  candles: Candle[],
  // Either a raw condition array (dispatched through buildSignalEvaluator,
  // The default) or an already-built per-bar evaluator — e.g.
  // `new ConceptsEngine(candles, { htfContext }).evaluator(strat.entry)` —
  // So concepts_*-based and HTF-gated candidates can be validated through
  // This exact same simulation engine without duplicating it.
  entryConditions: Array<{ type: string; period?: number; value?: number }> | ((i: number) => boolean),
  direction: "long" | "short",
  stopPct: number, targetPct: number, feeBps: number, maxHoldBars: number,
  initialCapital: number, leverage: number, marginPerTradePct: number,
  slippageBps = 0,
  // Optional per-candle entry gate for multi-timeframe bias filtering: entries
  // Only allowed where entryMask[i] is true. Caller is responsible for building
  // The mask WITHOUT lookahead (i.e. from already-closed higher-timeframe bars).
  entryMask?: boolean[],
  // Optional sub-bar exit resolution: lower-timeframe candles (e.g. 5m) used
  // To determine WHICH of stop/target was hit first when both fall inside one
  // Native bar (at native resolution the engine assumes stop-first —
  // Pessimistic). barMs = the native timeframe's bar duration in ms; sub
  // Candles are grouped into native bars by openTime.
  subBars?: { candles: Candle[]; barMs: number },
  // Optional risk-based sizing: when set, margin is sized so a stop-out
  // Loses exactly riskPerTradePct of current capital (capital * riskPerTradePct
  // / stopPct / leverage), instead of the flat marginPerTradePct fraction.
  // MarginPerTradePct still applies as a CEILING either way — risk-based
  // Sizing on a very tight stop can otherwise demand more margin than is
  // Prudent to commit to one trade. Omit to keep the flat-% behavior every
  // Existing caller already relies on.
  riskPerTradePct?: number,
  // Optional ATR-adaptive trailing stop (src/paper-trading/trailing.ts) — same
  // Engine LivePaperRunner uses, so live and backtest never drift. Omit to
  // Keep every existing caller's fixed-stop/fixed-target behavior unchanged.
  trailingConfig?: TrailingConfig,
): Record<string, unknown> {

  const subMap = new Map<number, Candle[]>();
  if (subBars) {
    for (const sc of subBars.candles) {
      const key = Math.floor(sc.openTime / subBars.barMs) * subBars.barMs;
      const arr = subMap.get(key);
      if (arr) arr.push(sc); else subMap.set(key, [sc]);
    }
  }

  const evaluator = typeof entryConditions === "function"
    ? entryConditions
    : buildSignalEvaluator(candles, entryConditions);
  const slipFrac = slippageBps / 10_000;
  const feeFrac = feeBps / 10_000;
  let capital = initialCapital;
  const eq: number[] = [capital];
  const returns: number[] = [];
  let trades = 0; let wins = 0; let losses = 0;
  let grossProfit = 0; let grossLoss = 0;
  const tradeLog: TradeRecord[] = [];

  let i = 0;
  while (i < candles.length) {
    const allTrue = evaluator(i);
    if (!allTrue || (entryMask && !entryMask[i])) { i++; continue; }

    const entryCandle = candles[i];
    if (entryCandle === undefined) { i++; continue; }
    const rawEntry = entryCandle.close;
    const entryPrice = direction === "long" ? rawEntry * (1 + slipFrac) : rawEntry * (1 - slipFrac);
    const flatMargin = capital * marginPerTradePct;
    const margin = riskPerTradePct !== undefined
      ? Math.min(flatMargin, (capital * riskPerTradePct) / stopPct / leverage)
      : flatMargin;
    const notional = margin * leverage;
    const qty = notional / entryPrice;
    let stopPrice = direction === "long" ? entryPrice * (1 - stopPct) : entryPrice * (1 + stopPct);
    const targetPrice = direction === "long" ? entryPrice * (1 + targetPct) : entryPrice * (1 - targetPct);
    const liqPrice = computeLiqPrice(direction, entryPrice, leverage);
    let trailState = trailingConfig?.enabled ? initTrailingState(entryPrice) : null;
    let targetDisabled = false;

    let exitIdx = candles.length - 1;
    const lastCandle = candles[exitIdx];
    if (lastCandle === undefined) break;
    let exitPrice = lastCandle.close;
    let exitReason: TradeRecord["exitReason"] = "timeout";
    for (let j = i + 1; j < candles.length && j <= i + maxHoldBars; j++) {
      const b = candles[j];
      if (b === undefined) continue;

      // Trailing update — once per native bar (not per sub-bar), same
      // Granularity LivePaperRunner uses. Causal: only candles up to and
      // Including this bar feed the ATR.
      if (trailState && trailingConfig) {
        const trailResult = updateTrailingStop(trailState, b, direction, entryPrice, stopPrice, trailingConfig, candles.slice(0, j + 1));
        trailState = trailResult.state;
        stopPrice = trailResult.stopPrice;
        targetDisabled = trailResult.targetDisabled;
      }

      const subs = subBars ? subMap.get(b.openTime) : undefined;
      if (subs && subs.length > 0) {
        // Sub-bar resolution: walk lower-TF candles chronologically, first
        // Level touched wins (residual within-sub-bar ambiguity keeps the
        // Conservative liq→stop→target order at 1/12th the bar size).
        let resolved = false;
        for (const s of subs) {
          if (direction === "long" ? s.low <= liqPrice : s.high >= liqPrice) { exitIdx = j; exitPrice = liqPrice; exitReason = "liq"; resolved = true; break; }
          if (direction === "long" ? s.low <= stopPrice : s.high >= stopPrice) { exitIdx = j; exitPrice = direction === "long" ? stopPrice * (1 - slipFrac) : stopPrice * (1 + slipFrac); exitReason = "stop"; resolved = true; break; }
          if (!targetDisabled && (direction === "long" ? s.high >= targetPrice : s.low <= targetPrice)) { exitIdx = j; exitPrice = targetPrice; exitReason = "target"; resolved = true; break; }
        }
        if (resolved) break;
        if (j === i + maxHoldBars) { exitIdx = j; exitPrice = direction === "long" ? b.close * (1 - slipFrac) : b.close * (1 + slipFrac); exitReason = "timeout"; }
        continue;
      }
      if (direction === "long" ? b.low <= liqPrice : b.high >= liqPrice) { exitIdx = j; exitPrice = liqPrice; exitReason = "liq"; break; }
      if (direction === "long" ? b.low <= stopPrice : b.high >= stopPrice) { exitIdx = j; exitPrice = direction === "long" ? stopPrice * (1 - slipFrac) : stopPrice * (1 + slipFrac); exitReason = "stop"; break; }
      if (!targetDisabled && (direction === "long" ? b.high >= targetPrice : b.low <= targetPrice)) { exitIdx = j; exitPrice = targetPrice; exitReason = "target"; break; }
      if (j === i + maxHoldBars) { exitIdx = j; exitPrice = direction === "long" ? b.close * (1 - slipFrac) : b.close * (1 + slipFrac); exitReason = "timeout"; }
    }
    const exitCandle = candles[exitIdx];
    if (exitCandle === undefined) break;
    const entryNotional = qty * entryPrice;
    const exitNotional = qty * exitPrice;
    const totalFee = (entryNotional + exitNotional) * feeFrac;
    const pnl = (exitPrice - entryPrice) * (direction === "long" ? 1 : -1) * qty - totalFee;
    capital += pnl; eq.push(capital);
    const ret = pnl / margin;
    returns.push(ret);
    trades++; if (pnl > 0) { wins++; grossProfit += pnl; } else { losses++; grossLoss += Math.abs(pnl); }
    tradeLog.push({
      entryTime: entryCandle.openTime, exitTime: exitCandle.openTime,
      holdBars: exitIdx - i, holdMs: exitCandle.openTime - entryCandle.openTime,
      direction, pnlUsd: pnl, pnlPct: ret, exitReason,
    });
    i = exitIdx + 1;
  }

  const winRate = trades > 0 ? wins / trades : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  const totalPnlUsd = capital - initialCapital;
  const totalReturnPct = totalPnlUsd / initialCapital;
  const expectancyPct = trades > 0 ? returns.reduce((s, v) => s + v, 0) / trades : 0;
  let peak = initialCapital; let mdd = 0;
  for (const e of eq) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > mdd) mdd = dd; }
  const avgR = trades > 0 ? returns.reduce((s, v) => s + v, 0) / trades : 0;
  const variance = trades > 1 ? returns.reduce((s, v) => s + (v - avgR)**2, 0) / (trades - 1) : 0;
  const sharpeRatio = Math.sqrt(365 * 24) * avgR / (Math.sqrt(variance) || 1);
  const avgWinPct = wins > 0 ? returns.filter(r => r > 0).reduce((s, v) => s + v, 0) / wins : 0;
  const avgLossPct = losses > 0 ? returns.filter(r => r <= 0).reduce((s, v) => s + v, 0) / losses : 0;
  const maxDrawdownPct = mdd;

  return {
    metrics: {
      totalTrades: trades,
      winRate,
      avgWinPct,
      avgLossPct,
      expectancyPct,
      profitFactor,
      totalReturnPct,
      maxDrawdownPct,
      totalPnlUsd,
      sharpeRatio,
    },
    equityCurve: eq,
    trades: tradeLog,
  };
}
// ── SMC/ICT market structure helpers (shared by signal-fusion tool) ──
export function smcSwingHighs(closes: number[], lookback: number): boolean[] {
  return closes.map((c, i) => {
    if (i < lookback || i >= closes.length - lookback) return false;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      const cj = closes[j];
      if (cj !== undefined && cj >= c) return false;
    }
    return true;
  });
}
export function smcSwingLows(closes: number[], lookback: number): boolean[] {
  return closes.map((c, i) => {
    if (i < lookback || i >= closes.length - lookback) return false;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      const cj = closes[j];
      if (cj !== undefined && cj <= c) return false;
    }
    return true;
  });
}
// Compat shims — scripts/ob-retest-test.ts (research scratch, not part of any
// Call site above) still imports these with the old (candles, swingArr, i, lb)
// Signature. Body now delegates to legacy-conditions.ts; swingArr/lb are
// Accepted but ignored.
export function smcBullishLiqSweep(candles: Candle[], _lows: boolean[], i: number, _lb: number): boolean {
  return legacyBullishLiqSweep(candles, i);
}
export function smcBearishLiqSweep(candles: Candle[], _highs: boolean[], i: number, _lb: number): boolean {
  return legacyBearishLiqSweep(candles, i);
}
