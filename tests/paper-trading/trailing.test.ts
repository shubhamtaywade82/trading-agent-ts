import {
  initTrailingState, atrPct, updateTrailingStop, DEFAULT_TRAILING_CONFIG, TrailingConfig,
} from "../../src/paper-trading/trailing.js";
import { Candle } from "../../src/backtest/types.js";

function candle(openTime: number, open: number, high: number, low: number, close: number, volume = 100): Candle {
  return { openTime, open, high, low, close, volume };
}

// Config with tight, easy-to-reason-about thresholds for tests.
const CFG: TrailingConfig = {
  enabled: true,
  breakevenAtrMult: 1.0,
  breakevenOffsetBps: 5,
  activationAtrMult: 2.0,
  trailAtrMult: 1.0,
  minTrailPct: 0.001,
  maxTrailPct: 0.10,
};

// Flat-ish warmup series so atrPct settles to a small, known-ish value,
// then the test appends whatever bars it needs to exercise a phase.
function warmup(n: number, px = 100): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) out.push(candle(i * 3_600_000, px, px + 0.5, px - 0.5, px));
  return out;
}

describe("initTrailingState", () => {
  it("starts in the initial phase at the entry price", () => {
    const s = initTrailingState(100);
    expect(s.phase).toBe("initial");
    expect(s.extremePrice).toBe(100);
  });
});

describe("atrPct", () => {
  it("returns a fallback for too-short candle histories", () => {
    expect(atrPct(warmup(3))).toBeGreaterThan(0);
  });

  it("computes a positive percentage for a normal series", () => {
    const v = atrPct(warmup(20));
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(0.1); // sane upper bound for a 1%-range series
  });
});

describe("updateTrailingStop", () => {
  it("is a no-op when trailing is disabled", () => {
    const s = initTrailingState(100);
    const candles = warmup(20);
    const result = updateTrailingStop(s, candles[19], "long", 100, 99, { ...CFG, enabled: false }, candles);
    expect(result.stopPrice).toBe(99);
    expect(result.phaseChanged).toBe(false);
    expect(result.targetDisabled).toBe(false);
  });

  it("locks the stop to breakeven once profit crosses breakevenAtrMult x ATR (long)", () => {
    const candles = warmup(20, 100);
    const atr = atrPct(candles); // ~0.01 for a 1-wide range on px=100
    let s = initTrailingState(100);

    // Bar that pushes price up well past the breakeven threshold but not yet activation.
    const bigMove = 100 * (1 + atr * 1.5);
    const bar = candle(20 * 3_600_000, 100, bigMove, 100, bigMove);
    const result = updateTrailingStop(s, bar, "long", 100, 99, CFG, [...candles, bar]);

    expect(result.state.phase).toBe("breakeven");
    expect(result.stopPrice).toBeGreaterThan(99); // moved up from the original stop
    expect(result.stopPrice).toBeGreaterThan(100); // above entry -- a real breakeven lock, not just "less bad"
    expect(result.phaseChanged).toBe(true);
  });

  it("activates trailing once profit crosses activationAtrMult x ATR, and disables the fixed target", () => {
    const candles = warmup(20, 100);
    const atr = atrPct(candles);
    let s = initTrailingState(100);

    const bigMove = 100 * (1 + atr * 2.5); // past activationAtrMult=2.0
    const bar = candle(20 * 3_600_000, 100, bigMove, 100, bigMove);
    const result = updateTrailingStop(s, bar, "long", 100, 99, CFG, [...candles, bar]);

    expect(result.state.phase).toBe("trailing");
    expect(result.targetDisabled).toBe(true);
    // Trailing stop should sit below the extreme, but still above the original stop/entry.
    expect(result.stopPrice).toBeLessThan(bigMove);
    expect(result.stopPrice).toBeGreaterThan(99);
  });

  it("never moves the stop against the position (invariant), even on a pullback bar", () => {
    const candles = warmup(20, 100);
    const atr = atrPct(candles);
    let s = initTrailingState(100);

    // Activate trailing on a strong up bar.
    const upMove = 100 * (1 + atr * 3);
    const upBar = candle(20 * 3_600_000, 100, upMove, 100, upMove);
    let result = updateTrailingStop(s, upBar, "long", 100, 99, CFG, [...candles, upBar]);
    const stopAfterUp = result.stopPrice;
    s = result.state;

    // Pullback bar: price retreats but stays above entry. Stop must not retreat with it.
    const pullback = candle(21 * 3_600_000, upMove, upMove, upMove * 0.995, upMove * 0.995);
    result = updateTrailingStop(s, pullback, "long", 100, stopAfterUp, CFG, [...candles, upBar, pullback]);

    expect(result.stopPrice).toBeGreaterThanOrEqual(stopAfterUp);
  });

  it("tracks the extreme correctly for shorts (lower is better) and trails above it", () => {
    const candles = warmup(20, 100);
    const atr = atrPct(candles);
    let s = initTrailingState(100);

    const downMove = 100 * (1 - atr * 3);
    const bar = candle(20 * 3_600_000, 100, 100, downMove, downMove);
    const result = updateTrailingStop(s, bar, "short", 100, 101, CFG, [...candles, bar]);

    expect(result.state.phase).toBe("trailing");
    expect(result.state.extremePrice).toBeCloseTo(downMove, 6);
    expect(result.stopPrice).toBeGreaterThan(downMove); // trail sits above the low, in favor of a short
    expect(result.stopPrice).toBeLessThan(101); // still moved down from the original stop
  });

  it("respects minTrailPct as a floor when ATR collapses", () => {
    const flat = warmup(30, 100); // near-zero ATR
    let s = initTrailingState(100);
    const bigMove = candle(30 * 3_600_000, 100, 110, 100, 110); // force activation regardless of tiny ATR
    const result = updateTrailingStop(s, bigMove, "long", 100, 99, { ...CFG, minTrailPct: 0.02 }, [...flat, bigMove]);

    expect(result.state.phase).toBe("trailing");
    // trail distance floored at 2% of the extreme (110), so stop <= 110 * 0.98
    expect(result.stopPrice).toBeLessThanOrEqual(110 * 0.98 + 1e-6);
  });

  it("respects maxTrailPct as a ceiling when ATR spikes", () => {
    const candles = warmup(20, 100);
    // Inject one huge-range bar to spike ATR, then the move bar.
    const spike = candle(20 * 3_600_000, 100, 140, 100, 130);
    const move = candle(21 * 3_600_000, 130, 160, 130, 160);
    let s = initTrailingState(100);
    const result = updateTrailingStop(s, move, "long", 100, 99, { ...CFG, maxTrailPct: 0.05 }, [...candles, spike, move]);

    expect(result.state.phase).toBe("trailing");
    // trail distance ceiled at 5% of the extreme (160), so stop >= 160 * 0.95
    expect(result.stopPrice).toBeGreaterThanOrEqual(160 * 0.95 - 1e-6);
  });

  it("DEFAULT_TRAILING_CONFIG is disabled by default", () => {
    expect(DEFAULT_TRAILING_CONFIG.enabled).toBe(false);
  });
});
