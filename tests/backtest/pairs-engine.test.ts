import { alignPairCandles, pearsonCorrelation, computeZScoreSeries, runPairsBacktest } from "../../src/backtest/pairs-engine.js";
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

describe("runPairsBacktest", () => {
  function candlesFrom(closes: number[]): Candle[] {
    return closes.map((c, i) => candle(i, c));
  }

  const BASE_CONFIG = {
    lookback: 4, entryZ: 2, exitZ: 0.5, stopZ: 3.5, maxHoldBars: 20,
    notionalPerLeg: 2000, feeBps: 5, slippageBps: 3, initialCapital: 10000,
  };

  it("opens a short_a_long_b trade when A spikes far above B, and closes it on reversion", () => {
    // Flat, slightly noisy history to build a real variance reference, then a
    // spike in A (fires entry) which reverts back toward B a few bars later
    // (fires exit).
    const closesA = [100, 102, 98, 101, 99, 150, 140, 120, 105, 100, 100];
    const closesB = new Array(closesA.length).fill(100);
    const result = runPairsBacktest(candlesFrom(closesA), candlesFrom(closesB), BASE_CONFIG);
    expect(result.trades.length).toBeGreaterThan(0);
    const first = result.trades[0];
    expect(first.direction).toBe("short_a_long_b");
    expect(Number.isFinite(first.pnlUsd)).toBe(true);
  });

  it("opens a long_a_short_b trade when A drops far below B, and closes it on reversion", () => {
    const closesA = [100, 102, 98, 101, 99, 60, 70, 85, 95, 100, 100];
    const closesB = new Array(closesA.length).fill(100);
    const result = runPairsBacktest(candlesFrom(closesA), candlesFrom(closesB), BASE_CONFIG);
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades[0].direction).toBe("long_a_short_b");
  });

  it("computes metrics with the expected field names", () => {
    const closesA = [100, 102, 98, 101, 99, 150, 140, 120, 105, 100, 100];
    const closesB = new Array(closesA.length).fill(100);
    const result = runPairsBacktest(candlesFrom(closesA), candlesFrom(closesB), BASE_CONFIG);
    expect(result.metrics).toEqual(expect.objectContaining({
      totalTrades: expect.any(Number), winRate: expect.any(Number), profitFactor: expect.any(Number),
      sharpeRatio: expect.any(Number), totalPnlUsd: expect.any(Number), maxDrawdownPct: expect.any(Number),
    }));
  });
});
