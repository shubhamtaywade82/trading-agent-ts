import type { HTFContext } from "trading-concepts-ts";

import type { Candle } from "../../src/backtest/types.js";
import { ConceptsEngine } from "../../src/concepts/adapter.js";

function candle(openTime: number, open: number, high: number, low: number, close: number, volume = 100): Candle {
  return { openTime, open, high, low, close, volume };
}

// A simple, mildly-varying series — enough for TradingConcepts.analyze() to
// Run without erroring; the assertions below don't depend on this series
// Producing any particular SMC signal of its own.
function baseCandles(n: number, startTime = 0, stepMs = 3_600_000): Candle[] {
  const out: Candle[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 5) * 0.5;
    px += drift;
    out.push(candle(startTime + i * stepMs, px, px + 1, px - 1, px + drift, 100));
  }
  return out;
}

describe("ConceptsEngine htfAligned signals", () => {
  it("marks bars at-or-after an HTF structure signal's time as aligned, and earlier bars as not", () => {
    const candles = baseCandles(20);
    // HTF structure event lands exactly at the 10th LTF bar's openTime.
    const htfContext: HTFContext = {
      structure: [{ index: 0, time: candles[10].openTime, type: "BOS", direction: "bullish", level: 100 }],
    };

    const engine = new ConceptsEngine(candles, { htfContext });
    const sig = engine.getSignals();

    for (let i = 0; i < 10; i++) {
      expect(sig.htfAlignedBullish[i]).toBe(false);
      expect(sig.htfAlignedBearish[i]).toBe(false);
    }
    for (let i = 10; i < 20; i++) {
      expect(sig.htfAlignedBullish[i]).toBe(true);
      expect(sig.htfAlignedBearish[i]).toBe(false);
    }
  });

  it("tracks the most recent HTF structure signal when several are supplied, never a future one", () => {
    const candles = baseCandles(20);
    const htfContext: HTFContext = {
      structure: [
        { index: 0, time: candles[5].openTime, type: "BOS", direction: "bullish", level: 100 },
        { index: 1, time: candles[12].openTime, type: "CHoCH", direction: "bearish", level: 100 },
      ],
    };

    const engine = new ConceptsEngine(candles, { htfContext });
    const sig = engine.getSignals();

    expect(sig.htfAlignedBullish[8]).toBe(true); // Only the bullish event has happened yet
    expect(sig.htfAlignedBearish[8]).toBe(false);
    expect(sig.htfAlignedBullish[15]).toBe(false); // Bearish event has since superseded it
    expect(sig.htfAlignedBearish[15]).toBe(true);
  });

  it("defaults every bar to false when no htfContext is supplied", () => {
    const engine = new ConceptsEngine(baseCandles(20));
    const sig = engine.getSignals();
    expect(sig.htfAlignedBullish.every(v => !v)).toBe(true);
    expect(sig.htfAlignedBearish.every(v => !v)).toBe(true);
  });

  it("exposes the new signals through evaluator()'s concepts_htf_aligned_* conditions", () => {
    const candles = baseCandles(20);
    const htfContext: HTFContext = {
      structure: [{ index: 0, time: candles[10].openTime, type: "BOS", direction: "bullish", level: 100 }],
    };
    const engine = new ConceptsEngine(candles, { htfContext });
    const evalBullish = engine.evaluator([{ type: "concepts_htf_aligned_bullish" }]);
    const evalBearish = engine.evaluator([{ type: "concepts_htf_aligned_bearish" }]);

    expect(evalBullish(15)).toBe(true);
    expect(evalBearish(15)).toBe(false);
    expect(evalBullish(5)).toBe(false);
  });
});

describe("ConceptsEngine liquiditySweptNearZone", () => {
  it("defaults to false everywhere when no liquidity sweeps or judas swings are detected", () => {
    const engine = new ConceptsEngine(baseCandles(20));
    const sig = engine.getSignals();
    expect(sig.liquiditySweptNearZone.every(v => !v)).toBe(true);
    expect(engine.evaluator([{ type: "concepts_liquidity_swept_near" }])(10)).toBe(false);
  });
});

describe("ConceptsEngine newBullishFVG/newBearishFVG — no hindsight mitigation gate", () => {
  it("still marks a FVG as fresh at its formation bar even when later candles fill it back in", () => {
    // 3-candle bullish gap: c1.high (102) sits below c3.low (104) -> FVG forms
    // At index 1 (the middle candle). trading-concepts-ts computes `mitigated`
    // By scanning ALL THE WAY to the end of the array for a later candle whose
    // Low dips back into the gap — that must never suppress the formation
    // Signal at index 1, since at bar 1 nothing about the future is knowable.
    const candles: Candle[] = [
      candle(0, 100, 101, 99, 100),
      candle(3_600_000, 100, 102, 100, 101.5),    // C1: high 102
      candle(7_200_000, 103, 105, 103, 104.5),    // Gap candle (index 2, the FVG's own formation index is 1)
      candle(10_800_000, 104.5, 106, 104, 105.5), // C3: low 104 > c1.high 102 -> bullish FVG confirmed, index = 1
      candle(14_400_000, 105.5, 107, 105, 106),
      candle(18_000_000, 106, 106.5, 101, 101.5), // Dips back down through the gap -> mitigates it, much later
    ];

    const engine = new ConceptsEngine(candles);
    const sig = engine.getSignals();

    expect(sig.newBullishFVG[1]).toBe(true);
    // Sanity: the underlying library did mark it mitigated (proves this test
    // Actually exercises the hindsight path, not a series with no mitigation at all).
    const ar = engine.analyze();
    const fvg = ar.fvgs.find(f => f.index === 1);
    expect(fvg?.mitigated).toBe(true);
  });
});
