import { Candle, StrategyConfig, BacktestMetrics, Condition } from "./types.js";
import { runBacktest, computeMetrics } from "./engine.js";

export interface WalkForwardWindow {
  fromIndex: number;
  toIndex: number;
  metrics: BacktestMetrics;
}

export interface WalkForwardResult {
  windows: WalkForwardWindow[];
  // Stddev of per-window expectancy relative to its mean — high = the "edge"
  // is regime-dependent, not a stable behavior. Not a re-optimizing walk
  // forward (no parameter search per fold) — a stability check across time.
  expectancyStability: number;
  consistentDirection: boolean; // did every window with trades have the same expectancy sign?
}

export function walkForward(candles: Candle[], config: StrategyConfig, folds = 4): WalkForwardResult {
  const windowSize = Math.floor(candles.length / folds);
  const windows: WalkForwardWindow[] = [];

  for (let f = 0; f < folds; f++) {
    const fromIndex = f * windowSize;
    const toIndex = f === folds - 1 ? candles.length : fromIndex + windowSize;
    const slice = candles.slice(fromIndex, toIndex);
    const result = runBacktest(slice, config);
    windows.push({ fromIndex, toIndex, metrics: result.metrics });
  }

  const withTrades = windows.filter((w) => w.metrics.totalTrades > 0);
  const expectancies = withTrades.map((w) => w.metrics.expectancyPct);
  const mean = expectancies.length > 0 ? expectancies.reduce((s, v) => s + v, 0) / expectancies.length : 0;
  const variance = expectancies.length > 0 ? expectancies.reduce((s, v) => s + (v - mean) ** 2, 0) / expectancies.length : 0;
  const expectancyStability = Math.sqrt(variance);
  const consistentDirection = expectancies.length > 0 && expectancies.every((v) => Math.sign(v) === Math.sign(mean || expectancies[0]));

  return { windows, expectancyStability, consistentDirection };
}

export interface MonteCarloResult {
  simulations: number;
  medianReturnPct: number;
  p5ReturnPct: number;
  p95ReturnPct: number;
  medianMaxDrawdownPct: number;
  probabilityOfLoss: number;
}

// Bootstrap resampling: reshuffle the trade sequence (sample with
// replacement) N times to see how much of the equity curve's shape depends
// on the specific order trades happened to occur in, versus the edge itself.
// This is not a source of NEW predictive information — it's a stability
// check on the trade sample already observed.
export function monteCarlo(trades: { returnPct: number }[], simulations = 1000, seedSequence?: number[]): MonteCarloResult {
  if (trades.length === 0) {
    return { simulations: 0, medianReturnPct: 0, p5ReturnPct: 0, p95ReturnPct: 0, medianMaxDrawdownPct: 0, probabilityOfLoss: 1 };
  }

  const returns: number[] = [];
  const drawdowns: number[] = [];
  // seedSequence lets tests be deterministic; production calls omit it and
  // fall back to Math.random() (fine here — this module never runs inside a
  // Workflow script where Math.random() is unavailable).
  const rand = seedSequence ? indexedRandom(seedSequence) : Math.random;

  for (let s = 0; s < simulations; s++) {
    let equity = 1;
    let peak = 1;
    let maxDrawdown = 0;
    for (let t = 0; t < trades.length; t++) {
      const pick = trades[Math.floor(rand() * trades.length)];
      equity *= 1 + pick.returnPct;
      if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
    returns.push(equity - 1);
    drawdowns.push(maxDrawdown);
  }

  returns.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);
  const percentile = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];

  return {
    simulations,
    medianReturnPct: percentile(returns, 0.5),
    p5ReturnPct: percentile(returns, 0.05),
    p95ReturnPct: percentile(returns, 0.95),
    medianMaxDrawdownPct: percentile(drawdowns, 0.5),
    probabilityOfLoss: returns.filter((r) => r < 0).length / returns.length,
  };
}

function indexedRandom(seed: number[]): () => number {
  let i = 0;
  return () => seed[i++ % seed.length];
}

export interface ParamRange {
  conditionIndex: number; // which entry condition to vary
  field: "period" | "value";
  values: number[];
}

export interface ParamSweepCandidate {
  overrides: Array<{ conditionIndex: number; field: "period" | "value"; value: number }>;
  metrics: BacktestMetrics;
}

// Grid search over the given parameter ranges (NOT Bayesian optimization —
// no Gaussian-process library exists in this stack and hand-rolling one
// isn't proportionate to a handful of TA parameters; grid/random search is
// the honest, simple substitute for a search space this small).
export function paramSweep(candles: Candle[], baseConfig: StrategyConfig, ranges: ParamRange[], rankBy: keyof BacktestMetrics = "expectancyPct"): ParamSweepCandidate[] {
  const combos = cartesianProduct(ranges);
  const results: ParamSweepCandidate[] = combos.map((combo) => {
    const entry: Condition[] = baseConfig.entry.map((c) => ({ ...c }));
    for (const { conditionIndex, field, value } of combo) {
      if (entry[conditionIndex]) entry[conditionIndex] = { ...entry[conditionIndex], [field]: value };
    }
    const result = runBacktest(candles, { ...baseConfig, entry });
    return { overrides: combo, metrics: result.metrics };
  });

  return results.sort((a, b) => {
    const av = a.metrics[rankBy] as number;
    const bv = b.metrics[rankBy] as number;
    return bv - av;
  });
}

function cartesianProduct(ranges: ParamRange[]): Array<Array<{ conditionIndex: number; field: "period" | "value"; value: number }>> {
  if (ranges.length === 0) return [[]];
  const [first, ...rest] = ranges;
  const restProduct = cartesianProduct(rest);
  const out: Array<Array<{ conditionIndex: number; field: "period" | "value"; value: number }>> = [];
  for (const value of first.values) {
    for (const combo of restProduct) {
      out.push([{ conditionIndex: first.conditionIndex, field: first.field, value }, ...combo]);
    }
  }
  return out;
}

export { computeMetrics };
