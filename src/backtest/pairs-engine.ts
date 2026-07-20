import { Candle } from "./types.js";

export function alignPairCandles(candlesA: Candle[], candlesB: Candle[]): { a: Candle[]; b: Candle[] } {
  const timesB = new Set(candlesB.map(c => c.openTime));
  const a = candlesA.filter(c => timesB.has(c.openTime));
  const timesA = new Set(a.map(c => c.openTime));
  const b = candlesB.filter(c => timesA.has(c.openTime));
  return { a, b };
}

export function pearsonCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const meanA = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const meanB = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    cov += da * db; varA += da * da; varB += db * db;
  }
  const denom = Math.sqrt(varA * varB);
  return denom === 0 ? 0 : cov / denom;
}

// z[i] compares spread[i] to the mean/std of the TRAILING `lookback` bars
// BEFORE i (not including i) — a live poll asks "is right now unusual
// relative to recent history", which excluding the current bar answers
// honestly (including it would let a huge move partly cancel itself out of
// its own reference window).
export function computeZScoreSeries(closesA: number[], closesB: number[], lookback: number): number[] {
  const n = Math.min(closesA.length, closesB.length);
  const spread = Array.from({ length: n }, (_, i) => Math.log(closesA[i]) - Math.log(closesB[i]));
  const z = new Array(n).fill(NaN);
  for (let i = lookback; i < n; i++) {
    const window = spread.slice(i - lookback, i);
    const mean = window.reduce((s, v) => s + v, 0) / lookback;
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / lookback;
    const std = Math.sqrt(variance);
    z[i] = std === 0 ? NaN : (spread[i] - mean) / std;
  }
  return z;
}

export interface PairsBacktestConfig {
  lookback: number; entryZ: number; exitZ: number; stopZ: number; maxHoldBars: number;
  notionalPerLeg: number; feeBps: number; slippageBps: number; initialCapital: number;
}

export interface PairsTrade {
  entryBarIdx: number; exitBarIdx: number;
  direction: "short_a_long_b" | "long_a_short_b";
  entryZ: number; exitZ: number;
  pnlUsd: number;
  exitReason: "target" | "stop" | "timeout";
}

export interface PairsBacktestMetrics {
  totalTrades: number; winRate: number; profitFactor: number; sharpeRatio: number;
  totalPnlUsd: number; maxDrawdownPct: number;
}

export function runPairsBacktest(
  candlesA: Candle[], candlesB: Candle[], config: PairsBacktestConfig,
): { trades: PairsTrade[]; metrics: PairsBacktestMetrics } {
  const { a, b } = alignPairCandles(candlesA, candlesB);
  const closesA = a.map(c => c.close);
  const closesB = b.map(c => c.close);
  const z = computeZScoreSeries(closesA, closesB, config.lookback);
  const feeFrac = config.feeBps / 10000;
  const slipFrac = config.slippageBps / 10000;

  const trades: PairsTrade[] = [];
  let pos: {
    direction: "short_a_long_b" | "long_a_short_b"; entryBarIdx: number; entryZ: number;
    qtyA: number; qtyB: number; fillA: number; fillB: number;
  } | null = null;

  for (let i = 0; i < closesA.length; i++) {
    const zi = z[i];
    if (Number.isNaN(zi)) continue;

    if (pos) {
      const barsHeld = i - pos.entryBarIdx;
      const hitExit = Math.abs(zi) < config.exitZ;
      const hitStop = Math.abs(zi) > config.stopZ;
      const timedOut = barsHeld >= config.maxHoldBars;
      if (hitExit || hitStop || timedOut) {
        const short = pos.direction === "short_a_long_b";
        const fillAExit = short ? closesA[i] * (1 + slipFrac) : closesA[i] * (1 - slipFrac);
        const fillBExit = short ? closesB[i] * (1 - slipFrac) : closesB[i] * (1 + slipFrac);
        const legAPnl = short ? pos.qtyA * (pos.fillA - fillAExit) : pos.qtyA * (fillAExit - pos.fillA);
        const legBPnl = short ? pos.qtyB * (fillBExit - pos.fillB) : pos.qtyB * (pos.fillB - fillBExit);
        const fees = 2 * config.notionalPerLeg * feeFrac; // feeBps already round-trip, x2 legs
        const pnlUsd = legAPnl + legBPnl - fees;
        trades.push({
          entryBarIdx: pos.entryBarIdx, exitBarIdx: i, direction: pos.direction,
          entryZ: pos.entryZ, exitZ: zi, pnlUsd,
          exitReason: hitStop ? "stop" : hitExit ? "target" : "timeout",
        });
        pos = null;
      }
      continue;
    }

    if (Math.abs(zi) > config.entryZ) {
      const direction: "short_a_long_b" | "long_a_short_b" = zi > 0 ? "short_a_long_b" : "long_a_short_b";
      const short = direction === "short_a_long_b";
      const qtyA = config.notionalPerLeg / closesA[i];
      const qtyB = config.notionalPerLeg / closesB[i];
      const fillA = short ? closesA[i] * (1 - slipFrac) : closesA[i] * (1 + slipFrac);
      const fillB = short ? closesB[i] * (1 + slipFrac) : closesB[i] * (1 - slipFrac);
      pos = { direction, entryBarIdx: i, entryZ: zi, qtyA, qtyB, fillA, fillB };
    }
  }

  const wins = trades.filter(t => t.pnlUsd > 0);
  const losses = trades.filter(t => t.pnlUsd <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0));
  const totalPnlUsd = grossProfit - grossLoss;

  let equity = config.initialCapital, peak = equity, maxDrawdownPct = 0;
  const returns: number[] = [];
  for (const t of trades) {
    equity += t.pnlUsd;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak);
    returns.push(t.pnlUsd / (2 * config.notionalPerLeg));
  }
  const meanReturn = returns.length ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const variance = returns.length ? returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / returns.length : 0;
  const stdReturn = Math.sqrt(variance);

  return {
    trades,
    metrics: {
      totalTrades: trades.length,
      winRate: trades.length ? wins.length / trades.length : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
      sharpeRatio: stdReturn > 0 ? meanReturn / stdReturn : 0,
      totalPnlUsd,
      maxDrawdownPct,
    },
  };
}
