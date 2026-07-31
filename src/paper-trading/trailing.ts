// ATR-adaptive 2-phase trailing stop: breakeven-lock, then ATR trail.
// Pure, side-effect-free — no fs/journal access, matching this codebase's
// Existing volScale/slippageMultiplier/correlationScale pattern (all in
// Live-runner.ts). Called from both LivePaperRunner.processGroup and
// RunFuturesBacktest's exit-scan loop, same "one shared engine" discipline
// This codebase already applies to signal evaluation and entry sizing.
//
// Deliberately 2-phase, not the 4-phase-with-partial-TP model considered in
// Design (see docs/superpowers/specs/2026-07-29-trailing-stop-engine-design.md):
// No partial closes, the whole position rides the trail until stopped out.

import type { Candle } from "../backtest/types.js";

export type TrailingPhase = "initial" | "breakeven" | "trailing";

export interface TrailingConfig {
  enabled: boolean;
  breakevenAtrMult: number;   // Profit (in ATR multiples) that triggers the breakeven lock
  breakevenOffsetBps: number; // Stop lands at entry +/- this many bps (covers fees)
  activationAtrMult: number;  // Profit (in ATR multiples) that triggers trailing
  trailAtrMult: number;       // Trail distance behind the extreme, in ATR multiples
  minTrailPct: number;        // Floor on trail distance — guards against an ATR collapse producing a stop so tight normal noise triggers it
  maxTrailPct: number;        // Ceiling on trail distance — guards against an ATR spike (e.g. a flash wick) widening the stop into meaninglessness
}

export const DEFAULT_TRAILING_CONFIG: TrailingConfig = {
  enabled: false, // Opt-in per strategy
  breakevenAtrMult: 1,
  breakevenOffsetBps: 5,
  activationAtrMult: 2,
  trailAtrMult: 1.5,
  minTrailPct: 0.005,
  maxTrailPct: 0.04,
};

export interface TrailingState {
  phase: TrailingPhase;
  extremePrice: number; // Best price seen since entry (high for long, low for short)
}

export function initTrailingState(entryPrice: number): TrailingState {
  return { phase: "initial", extremePrice: entryPrice };
}

// Same true-range-based ATR% methodology as live-runner.ts's atrRatio,
// Duplicated here rather than imported to keep this module dependency-free
// Of live-runner.ts (which itself will import FROM here) — avoids a
// Circular import for a ~10-line function.
export function atrPct(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0.02; // Fallback: assume 2%
  const trs: number[] = [];
  for (let j = candles.length - period; j < candles.length; j++) {
    const c = candles[j];
    const pc = candles[j - 1]?.close;
    if (c === undefined || pc === undefined) continue;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)) / pc);
  }
  return trs.reduce((s, x) => s + x, 0) / trs.length;
}

export interface TrailingUpdateResult {
  state: TrailingState;
  stopPrice: number;       // Updated stop — only ever moves in favor of the position vs currentStopPrice
  phaseChanged: boolean;
  targetDisabled: boolean; // True once phase reaches "trailing" — caller should stop checking the fixed target
}

export function updateTrailingStop(
  state: TrailingState,
  bar: Candle,
  direction: "long" | "short",
  entryPrice: number,
  currentStopPrice: number,
  config: TrailingConfig,
  candlesUpToBar: Candle[], // For ATR — must be causal (no bars after `bar`), no lookahead
): TrailingUpdateResult {
  if (!config.enabled) {
    return { state, stopPrice: currentStopPrice, phaseChanged: false, targetDisabled: false };
  }

  const s: TrailingState = { ...state };
  const atr = atrPct(candlesUpToBar);

  if (direction === "long") s.extremePrice = Math.max(s.extremePrice, bar.high);
  else s.extremePrice = Math.min(s.extremePrice, bar.low);

  const profitPct = direction === "long"
    ? (s.extremePrice - entryPrice) / entryPrice
    : (entryPrice - s.extremePrice) / entryPrice;

  let newStop = currentStopPrice;
  let phaseChanged = false;

  // Phase 1 -> 2: breakeven lock
  if (s.phase === "initial" && profitPct >= config.breakevenAtrMult * atr) {
    const offset = config.breakevenOffsetBps / 10_000;
    const beStop = direction === "long" ? entryPrice * (1 + offset) : entryPrice * (1 - offset);
    if (direction === "long" ? beStop > newStop : beStop < newStop) newStop = beStop;
    s.phase = "breakeven";
    phaseChanged = true;
  }

  // Phase 2 -> 3: trailing activation
  if ((s.phase === "initial" || s.phase === "breakeven") && profitPct >= config.activationAtrMult * atr) {
    s.phase = "trailing";
    phaseChanged = true;
  }

  // Phase 3: trail the stop from the extreme
  if (s.phase === "trailing") {
    const trailDist = Math.max(config.minTrailPct, Math.min(config.maxTrailPct, config.trailAtrMult * atr));
    const candidate = direction === "long" ? s.extremePrice * (1 - trailDist) : s.extremePrice * (1 + trailDist);
    // Invariant: the stop only ever moves in favor of the position.
    if (direction === "long" ? candidate > newStop : candidate < newStop) newStop = candidate;
  }

  return { state: s, stopPrice: newStop, phaseChanged, targetDisabled: s.phase === "trailing" };
}
