import { alignPairCandles, pearsonCorrelation, computeZScoreSeries } from "../../src/backtest/pairs-engine.js";
import { Candle } from "../../src/backtest/types.js";

function candle(openTime: number, close: number): Candle {
  return { openTime, open: close, high: close, low: close, close, volume: 1 };
}

describe("alignPairCandles", () => {
  it("keeps only openTimes present in both series", () => {
    const a = [candle(1, 10), candle(2, 11), candle(3, 12), candle(4, 13)];
    const b = [candle(2, 20), candle(3, 21), candle(4, 22), candle(5, 23)];
    const { a: alignedA, b: alignedB } = alignPairCandles(a, b);
    expect(alignedA.map(c => c.openTime)).toEqual([2, 3, 4]);
    expect(alignedB.map(c => c.openTime)).toEqual([2, 3, 4]);
  });
});

describe("pearsonCorrelation", () => {
  it("is exactly 1 for a perfectly positively linear relationship", () => {
    expect(pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBeCloseTo(1);
  });

  it("is exactly -1 for a perfectly negatively linear relationship", () => {
    expect(pearsonCorrelation([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBeCloseTo(-1);
  });
});

describe("computeZScoreSeries", () => {
  it("returns NaN before the lookback window is filled", () => {
    const closesA = [100, 101, 99, 100, 101];
    const closesB = [100, 100, 100, 100, 100];
    const z = computeZScoreSeries(closesA, closesB, 4);
    expect(Number.isNaN(z[0])).toBe(true);
    expect(Number.isNaN(z[3])).toBe(true);
  });

  it("returns NaN when the trailing window has zero variance", () => {
    const closesA = [100, 100, 100, 100, 100];
    const closesB = [100, 100, 100, 100, 100];
    const z = computeZScoreSeries(closesA, closesB, 3);
    expect(Number.isNaN(z[4])).toBe(true);
  });

  it("produces a large positive z-score when the spread jumps far above recent history", () => {
    const closesA = [100, 102, 98, 101, 99, 150];
    const closesB = [100, 100, 100, 100, 100, 100];
    const z = computeZScoreSeries(closesA, closesB, 4);
    expect(z[5]).toBeGreaterThan(2);
  });

  it("produces a large negative z-score when the spread drops far below recent history", () => {
    const closesA = [100, 102, 98, 101, 99, 60];
    const closesB = [100, 100, 100, 100, 100, 100];
    const z = computeZScoreSeries(closesA, closesB, 4);
    expect(z[5]).toBeLessThan(-2);
  });
});
