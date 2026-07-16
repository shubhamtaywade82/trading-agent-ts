import { fetchCandlesRange } from "../src/tools/backtest-tools.js";
import { rsiSeries, macdSeries, bollingerSeries, emaSeries, smaSeries, superTrendSeries, adxSeries, ichimokuSeries, atrSeries } from "../src/tools/indicators.js";
import type { CandleHL } from "../src/tools/indicators.js";
import type { Candle, StrategyConfig } from "../src/backtest/types.js";
import { runFuturesBacktest } from "../src/tools/backtest-tools.js";
import { readFileSync, writeFileSync } from "fs";

const SYMBOLS = ["XRPUSDT", "ETHUSDT", "SOLUSDT"];
const INTERVAL = "1h";
const CAPITAL = 10000;
const LEVERAGE = 10;
const FEE = 5; // bps
const MAX_HOLD = 48;

const endTime = Date.now();
const startTime = endTime - 365 * 24 * 60 * 60 * 1000;

interface StrategyDef {
  id: string;
  label: string;
  direction: "long" | "short";
  signalType: string;
  signalPeriod?: number;
  signalValue?: number;
  stopPct: number;
  targetPct: number;
}

interface Result {
  id: string; label: string; symbol: string; trades: number; winRate: number; profitFactor: number; sharpe: number; pnl: number; maxDD: number;
}

async function testSym(sym: string, strats: StrategyDef[]): Promise<Result[]> {
  console.log(`  Fetching ${sym}...`);
  const fetched = await fetchCandlesRange(sym, INTERVAL, startTime, endTime);
  if ("error" in fetched) { console.error(`    ${fetched.message}`); return []; }
  const candles = fetched.candles;

  const results: Result[] = [];
  for (const s of strats) {
    const entry: StrategyConfig["entry"] = [{ type: s.signalType as any, period: s.signalPeriod, value: s.signalValue }];
    try {
      const bt = runFuturesBacktest(candles, entry, s.direction, s.stopPct, s.targetPct, FEE, MAX_HOLD, CAPITAL, LEVERAGE, 0.1, undefined) as any;
      const m = bt.metrics as any;
      if (m.totalTrades >= 5 && !isNaN(m.sharpeRatio) && m.sharpeRatio !== undefined) {
        results.push({
          id: s.id, label: s.label, symbol: sym,
          trades: m.totalTrades, winRate: m.winRate, profitFactor: m.profitFactor,
          sharpe: m.sharpeRatio, pnl: m.totalPnlUsd ?? m.totalReturnPct * CAPITAL, maxDD: m.maxDrawdownPct ?? 0,
        });
      }
    } catch (e) {
      // skip
    }
  }
  return results;
}

// ── New strategy definitions ──
function allStrategies(): StrategyDef[] {
  const s: StrategyDef[] = [];

  // --- SuperTrend ---
  s.push({ id: "st-flip-long", label: "ST Up Flip Long", direction: "long", signalType: "supertrend_up", signalPeriod: 10, signalValue: 3, stopPct: 0.02, targetPct: 0.06 });
  s.push({ id: "st-flip-short", label: "ST Down Flip Short", direction: "short", signalType: "supertrend_down", signalPeriod: 10, signalValue: 3, stopPct: 0.02, targetPct: 0.06 });

  // --- ADX + DI ---
  s.push({ id: "adx-plusdi-cross-long", label: "ADX+DI Cross Long", direction: "long", signalType: "adx_plus_di_cross", signalPeriod: 14, stopPct: 0.02, targetPct: 0.06 });
  s.push({ id: "adx-minusdi-cross-short", label: "ADX-DI Cross Short", direction: "short", signalType: "adx_minus_di_cross", signalPeriod: 14, stopPct: 0.02, targetPct: 0.06 });

  // --- Ichimoku ---
  s.push({ id: "ichimoku-above-cloud-long", label: "Ichimoku Above Cloud Long", direction: "long", signalType: "ichimoku_above_cloud", stopPct: 0.02, targetPct: 0.06 });
  s.push({ id: "ichimoku-below-cloud-short", label: "Ichimoku Below Cloud Short", direction: "short", signalType: "ichimoku_below_cloud", stopPct: 0.02, targetPct: 0.06 });
  s.push({ id: "ichimoku-tk-cross-long", label: "Ich TK Cross Long", direction: "long", signalType: "ichimoku_tk_cross", stopPct: 0.02, targetPct: 0.06 });
  s.push({ id: "ichimoku-tk-cross-short", label: "Ich TK Cross Short", direction: "short", signalType: "ichimoku_tk_cross_short", stopPct: 0.02, targetPct: 0.06 });

  // --- Bollinger Squeeze / Volatility Breakout ---
  s.push({ id: "bb-squeeze-long", label: "BB Squeeze Long", direction: "long", signalType: "bollinger_squeeze_long", stopPct: 0.02, targetPct: 0.06 });
  s.push({ id: "bb-squeeze-short", label: "BB Squeeze Short", direction: "short", signalType: "bollinger_squeeze_short", stopPct: 0.02, targetPct: 0.06 });

  // --- ATR Breakout ---
  s.push({ id: "atr-breakout-long", label: "ATR Breakout Long", direction: "long", signalType: "atr_breakout_long", signalPeriod: 14, stopPct: 0.02, targetPct: 0.06 });
  s.push({ id: "atr-breakout-short", label: "ATR Breakout Short", direction: "short", signalType: "atr_breakout_short", signalPeriod: 14, stopPct: 0.02, targetPct: 0.06 });

  // --- Volume Spike ---
  s.push({ id: "vol-spike-long", label: "Volume Spike Long", direction: "long", signalType: "volume_spike_long", stopPct: 0.02, targetPct: 0.06 });
  s.push({ id: "vol-spike-short", label: "Volume Spike Short", direction: "short", signalType: "volume_spike_short", stopPct: 0.02, targetPct: 0.06 });

  // --- EMA Alignment (Qullamaggi style) ---
  s.push({ id: "ema-alignment-long", label: "EMA Alignment Long", direction: "long", signalType: "ema_alignment_long", stopPct: 0.02, targetPct: 0.06 });
  s.push({ id: "ema-alignment-short", label: "EMA Alignment Short", direction: "short", signalType: "ema_alignment_short", stopPct: 0.02, targetPct: 0.06 });

  return s;
}

// ── Custom backtest that supports new signal types directly ──
function runAdvancedBacktest(
  candles: Candle[], strat: StrategyDef
): { metrics: Record<string, any>; trades: any[] } {
  const n = candles.length;
  const closes = candles.map(c => c.close);

  // Pre-compute all indicators
  const superTrend = superTrendSeries(candles as CandleHL[], 10, 3);
  const adx = adxSeries(candles as CandleHL[], 14);
  const ichi = ichimokuSeries(candles as CandleHL[]);
  const bb = bollingerSeries(closes, 20, 2);
  const atr = atrSeries(candles as CandleHL[], 14);
  const rsi = rsiSeries(closes, 14);
  const macd = macdSeries(closes, 12, 26, 9);
  const ema10 = [...Array(closes.length - 10).fill(NaN), ...emaSeries(closes.slice(0), 10)];
  const ema20 = [...Array(closes.length - 20).fill(NaN), ...emaSeries(closes.slice(0), 20)];
  const ema50 = [...Array(closes.length - 50).fill(NaN), ...emaSeries(closes.slice(0), 50)];

  // Volume SMA
  const vol = candles.map(c => c.volume ?? 0);
  const volSMA = smaSeries(vol, 20);

  // SMC
  const sh = new Array(n).fill(false);
  const sl = new Array(n).fill(false);
  for (let i = 5; i < n - 5; i++) {
    let ok = true;
    for (let j = i - 5; j <= i + 5; j++) if (j !== i && closes[j] >= closes[i]) { ok = false; break; }
    sh[i] = ok;
    ok = true;
    for (let j = i - 5; j <= i + 5; j++) if (j !== i && closes[j] <= closes[i]) { ok = false; break; }
    sl[i] = ok;
  }

  const dir = strat.direction;
  const sig = strat.signalType;
  const per = strat.signalPeriod ?? 14;
  const val = strat.signalValue;

  const trades: any[] = [];
  let capital = CAPITAL;
  let peak = CAPITAL;
  let maxDD = 0;
  let inTrade = false;
  let entryPrice = 0;
  let entryIdx = 0;
  let stopPrice = 0;
  let targetPrice = 0;
  let liqPrice = 0;
  let qty = 0;
  let notional = 0;
  const feeFrac = FEE / 10000;

  for (let i = Math.max(52, 1); i < n; i++) {
    // Check exit
    if (inTrade) {
      const bar = candles[i];
      const hitLiq = dir === "long" ? bar.low <= liqPrice : bar.high >= liqPrice;
      const hitStop = dir === "long" ? bar.low <= stopPrice : bar.high >= stopPrice;
      const hitTarget = dir === "long" ? bar.high >= targetPrice : bar.low <= targetPrice;
      if (hitLiq || hitStop || hitTarget || i - entryIdx >= MAX_HOLD) {
        let xp: number; let reason: string;
        if (hitLiq) { xp = liqPrice; reason = "liq"; }
        else if (hitStop) { xp = stopPrice; reason = "stop"; }
        else if (hitTarget) { xp = targetPrice; reason = "target"; }
        else { xp = bar.close; reason = "timeout"; }
        const pnl = (xp - entryPrice) * (dir === "long" ? 1 : -1) * qty - notional * feeFrac;
        capital += pnl;
        if (pnl > 0) trades.push({ dir, entryPrice, exitPrice: xp, pnl: Math.round(pnl * 100) / 100, reason, win: true });
        else trades.push({ dir, entryPrice, exitPrice: xp, pnl: Math.round(pnl * 100) / 100, reason, win: false });
        inTrade = false;
        if (capital > peak) peak = capital;
        const dd = (peak - capital) / peak;
        if (dd > maxDD) maxDD = dd;
        continue;
      }
    }

    if (inTrade) continue;

    // Evaluate entry condition
    let hit = false;

    if (sig === "supertrend_up") {
      hit = i > 0 && superTrend[i]?.trend === "up" && superTrend[i - 1]?.trend === "down";
    } else if (sig === "supertrend_down") {
      hit = i > 0 && superTrend[i]?.trend === "down" && superTrend[i - 1]?.trend === "up";
    } else if (sig === "adx_plus_di_cross") {
      const cur = adx[i]; const prev = adx[i - 1];
      hit = !!cur && !!prev && cur.adx > 25 && prev.plusDI <= prev.minusDI && cur.plusDI > cur.minusDI;
    } else if (sig === "adx_minus_di_cross") {
      const cur = adx[i]; const prev = adx[i - 1];
      hit = !!cur && !!prev && cur.adx > 25 && prev.plusDI >= prev.minusDI && cur.plusDI < cur.minusDI;
    } else if (sig === "ichimoku_above_cloud") {
      hit = ichi[i]?.cloud === "above" && ichi[i - 1]?.cloud !== "above";
    } else if (sig === "ichimoku_below_cloud") {
      hit = ichi[i]?.cloud === "below" && ichi[i - 1]?.cloud !== "below";
    } else if (sig === "ichimoku_tk_cross") {
      hit = !!ichi[i] && !!ichi[i - 1] && ichi[i - 1].tenkan <= ichi[i - 1].kijun && ichi[i].tenkan > ichi[i].kijun && ichi[i].cloud === "above";
    } else if (sig === "ichimoku_tk_cross_short") {
      hit = !!ichi[i] && !!ichi[i - 1] && ichi[i - 1].tenkan >= ichi[i - 1].kijun && ichi[i].tenkan < ichi[i].kijun && ichi[i].cloud === "below";
    } else if (sig === "bollinger_squeeze_long") {
      const prevBB = bb[i - 1]; const curBB = bb[i];
      hit = !!prevBB && !!curBB && !isNaN(prevBB.upper) && !isNaN(curBB.upper) && (curBB.upper - curBB.lower) < (prevBB.upper - prevBB.lower) * 0.9 && candles[i].close > curBB.upper;
    } else if (sig === "bollinger_squeeze_short") {
      const prevBB = bb[i - 1]; const curBB = bb[i];
      hit = !!prevBB && !!curBB && !isNaN(prevBB.upper) && !isNaN(curBB.upper) && (curBB.upper - curBB.lower) < (prevBB.upper - prevBB.lower) * 0.9 && candles[i].close < curBB.lower;
    } else if (sig === "atr_breakout_long") {
      const a = atr[i]; hit = a !== undefined && !isNaN(a) && (candles[i].high - candles[i - 1].close) > a * 1.5;
    } else if (sig === "atr_breakout_short") {
      const a = atr[i]; hit = a !== undefined && !isNaN(a) && (candles[i - 1].close - candles[i].low) > a * 1.5;
    } else if (sig === "volume_spike_long") {
      const v = vol[i]; const avg = volSMA[i];
      hit = candles[i].close > candles[i - 1].close && v > avg * 2 && avg > 0;
    } else if (sig === "volume_spike_short") {
      const v = vol[i]; const avg = volSMA[i];
      hit = candles[i].close < candles[i - 1].close && v > avg * 2 && avg > 0;
    } else if (sig === "ema_alignment_long") {
      hit = candles[i].close > ema10[i] && ema10[i] > ema20[i] && ema20[i] > ema50[i];
    } else if (sig === "ema_alignment_short") {
      hit = candles[i].close < ema10[i] && ema10[i] < ema20[i] && ema20[i] < ema50[i];
    }

    // Also test existing SMC/rsi/macd types via runFuturesBacktest fallback — handled separately

    if (hit && !inTrade) {
      const baseMargin = CAPITAL * 0.1;
      notional = baseMargin * LEVERAGE;
      qty = notional / candles[i].close;
      entryPrice = candles[i].close;
      entryIdx = i;
      stopPrice = dir === "long" ? entryPrice * (1 - strat.stopPct) : entryPrice * (1 + strat.stopPct);
      targetPrice = dir === "long" ? entryPrice * (1 + strat.targetPct) : entryPrice * (1 - strat.targetPct);
      liqPrice = dir === "long" ? entryPrice * (1 - 1 / LEVERAGE + 0.005) : entryPrice * (1 + 1 / LEVERAGE - 0.005);
      inTrade = true;
    }
  }

  // Force close
  if (inTrade) {
    const xp = candles[n - 1].close;
    const pnl = (xp - entryPrice) * (dir === "long" ? 1 : -1) * qty - notional * feeFrac;
    capital += pnl;
    if (pnl > 0) trades.push({ dir, entryPrice, exitPrice: xp, pnl: Math.round(pnl * 100) / 100, reason: "force", win: true });
    else trades.push({ dir, entryPrice, exitPrice: xp, pnl: Math.round(pnl * 100) / 100, reason: "force", win: false });
    inTrade = false;
  }

  const totalPnl = capital - CAPITAL;
  const wins = trades.filter(t => t.win).length;
  const total = trades.length;
  const winRate = total > 0 ? wins / total : 0;
  const avgWin = wins > 0 ? trades.filter(t => t.win).reduce((s, t) => s + t.pnl, 0) / wins : 0;
  const avgLoss = (total - wins) > 0 ? trades.filter(t => !t.win).reduce((s, t) => s + Math.abs(t.pnl), 0) / (total - wins) : 1;
  const profitFactor = avgLoss > 0 ? (wins * avgWin) / ((total - wins) * avgLoss) : wins > 0 ? Infinity : 0;
  const returns = trades.filter(t => t.win).map(t => t.pnl);
  const avgReturn = returns.length > 0 ? returns.reduce((s, v) => s + v, 0) / trades.length : 0;
  const std = returns.length > 1 ? Math.sqrt(returns.reduce((s, v) => s + (v - avgReturn) ** 2, 0) / returns.length) : 1;
  const sharpeRatio = std > 0 ? (avgReturn / std) * Math.sqrt(365) : 0;
  const totalPnL = totalPnl;

  return {
    metrics: { totalTrades: total, winRate, profitFactor, sharpeRatio, totalReturnPct: totalPnl / CAPITAL, totalPnlUsd: totalPnL, maxDrawdownPct: maxDD },
    trades,
  };
}

async function main() {
  console.log("=== COMPREHENSIVE STRATEGY RESEARCH ===\n");

  const allResults: Result[] = [];
  const newStrats = allStrategies();

  // Test existing strategies (simple TA) via runFuturesBacktest
  const existingStrats: StrategyDef[] = [
    { id: "rsi-short-mr-80", label: "RSI>80 Short MR", direction: "short", signalType: "rsi_above", signalPeriod: 14, signalValue: 80, stopPct: 0.02, targetPct: 0.08 },
    { id: "rsi-long-mr-30", label: "RSI<30 Long MR", direction: "long", signalType: "rsi_below", signalPeriod: 14, signalValue: 30, stopPct: 0.02, targetPct: 0.08 },
    { id: "macd-bearish-short", label: "MACD Bearish Cross Short", direction: "short", signalType: "macd_bearish_cross", stopPct: 0.02, targetPct: 0.08 },
    { id: "macd-bullish-long", label: "MACD Bullish Cross Long", direction: "long", signalType: "macd_bullish_cross", stopPct: 0.02, targetPct: 0.08 },
    { id: "bb-upper-short", label: "BB Upper Touch Short", direction: "short", signalType: "bollinger_touch_upper", stopPct: 0.02, targetPct: 0.08 },
    { id: "bb-lower-long", label: "BB Lower Touch Long", direction: "long", signalType: "bollinger_touch_lower", stopPct: 0.02, targetPct: 0.08 },
    { id: "ema-above-long", label: "Price>EMA20 Long", direction: "long", signalType: "price_above_ema", signalPeriod: 20, stopPct: 0.02, targetPct: 0.08 },
    { id: "ema-below-short", label: "Price<EMA20 Short", direction: "short", signalType: "price_below_ema", signalPeriod: 20, stopPct: 0.02, targetPct: 0.08 },
  ];

  for (const sym of SYMBOLS) {
    console.log(`\n\n== ${sym} ==`);

    const fetched = await fetchCandlesRange(sym, INTERVAL, startTime, endTime);
    if ("error" in fetched) { console.error(`  Fetch error: ${fetched.message}`); continue; }
    const candles = fetched.candles;

    // 1. Existing strategies via runFuturesBacktest
    console.log("\n--- Existing TA Strategies ---");
    for (const s of existingStrats) {
      try {
        const entry: StrategyConfig["entry"] = [{ type: s.signalType as any, period: s.signalPeriod, value: s.signalValue }];
        const bt = runFuturesBacktest(candles, entry, s.direction, s.stopPct, s.targetPct, FEE, MAX_HOLD, CAPITAL, LEVERAGE, 0.1) as any;
        const m = bt.metrics as any;
        if (m.totalTrades >= 5) {
          allResults.push({ id: s.id, label: s.label, symbol: sym, trades: m.totalTrades, winRate: m.winRate, profitFactor: m.profitFactor, sharpe: m.sharpeRatio, pnl: m.totalPnlUsd ?? m.totalReturnPct * CAPITAL, maxDD: m.maxDrawdownPct ?? 0 });
          console.log(`  ${s.label.padEnd(28)} T:${String(m.totalTrades).padEnd(4)} WR:${(m.winRate*100).toFixed(0)}% PF:${m.profitFactor.toFixed(2)} SR:${m.sharpeRatio.toFixed(1)} PnL:$${Math.round(m.totalPnlUsd ?? m.totalReturnPct * CAPITAL).toLocaleString()}`);
        }
      } catch (e) {}
    }

    // 2. New advanced strategies
    console.log("\n--- New Advanced Strategies ---");
    for (const s of newStrats) {
      const bt = runAdvancedBacktest(candles, s);
      const m = bt.metrics;
      if (m.totalTrades >= 5 && m.sharpeRatio > 0) {
        allResults.push({ id: s.id, label: s.label, symbol: sym, trades: m.totalTrades, winRate: m.winRate, profitFactor: m.profitFactor, sharpe: m.sharpeRatio, pnl: m.totalPnlUsd, maxDD: m.maxDrawdownPct });
        console.log(`  ${s.label.padEnd(28)} T:${String(m.totalTrades).padEnd(4)} WR:${(m.winRate*100).toFixed(0)}% PF:${m.profitFactor.toFixed(2)} SR:${m.sharpeRatio.toFixed(1)} PnL:$${Math.round(m.totalPnlUsd).toLocaleString()} DD:${(m.maxDrawdownPct*100).toFixed(1)}%`);
      }
    }
  }

  // ── Summary ──
  console.log("\n\n=== SUMMARY (Sharpe >= 1.0) ===");
  const filtered = allResults.filter(r => r.sharpe >= 1.0).sort((a, b) => b.sharpe - a.sharpe);
  console.log(`\n${"Strategy".padEnd(28)} ${"Symbol".padEnd(10)} ${"Trades".padEnd(6)} ${"WR".padEnd(5)} ${"PF".padEnd(6)} ${"Sharpe".padEnd(7)} ${"PnL".padEnd(14)} ${"MaxDD"}`);
  console.log("-".repeat(90));
  for (const r of filtered) {
    console.log(`${r.label.padEnd(28)} ${r.symbol.padEnd(10)} ${String(r.trades).padEnd(6)} ${(r.winRate*100).toFixed(0)+"%".padEnd(3)} ${r.profitFactor.toFixed(2).padEnd(5)} ${r.sharpe.toFixed(1).padEnd(6)} $${Math.round(r.pnl).toLocaleString().padEnd(12)} ${(r.maxDD*100).toFixed(1)}%`);
  }

  // Save
  writeFileSync("strategies-research.json", JSON.stringify({ results: allResults, filter: { sharpeGte: 1.0, results: filtered } }, null, 2));
  console.log(`\nSaved ${allResults.length} results to strategies-research.json`);
  console.log(`Filtered (Sharpe>=1.0): ${filtered.length}`);
}
main().catch(console.error);
