import { ConceptsEngine } from "../../src/concepts/adapter.js";
import { Candle } from "../../src/backtest/types.js";
import { HTFContext } from "trading-concepts-ts";

function candle(openTime: number, open: number, high: number, low: number, close: number, volume = 100): Candle {
  return { openTime, open, high, low, close, volume };
}

// A simple, mildly-varying series — enough for TradingConcepts.analyze() to
// run without erroring; the assertions below don't depend on this series
// producing any particular SMC signal of its own.
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

    expect(sig.htfAlignedBullish[8]).toBe(true); // only the bullish event has happened yet
    expect(sig.htfAlignedBearish[8]).toBe(false);
    expect(sig.htfAlignedBullish[15]).toBe(false); // bearish event has since superseded it
    expect(sig.htfAlignedBearish[15]).toBe(true);
  });

  it("defaults every bar to false when no htfContext is supplied", () => {
    const engine = new ConceptsEngine(baseCandles(20));
    const sig = engine.getSignals();
    expect(sig.htfAlignedBullish.every(v => v === false)).toBe(true);
    expect(sig.htfAlignedBearish.every(v => v === false)).toBe(true);
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
    expect(sig.liquiditySweptNearZone.every(v => v === false)).toBe(true);
    expect(engine.evaluator([{ type: "concepts_liquidity_swept_near" }])(10)).toBe(false);
  });
});
