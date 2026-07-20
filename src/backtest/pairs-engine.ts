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
