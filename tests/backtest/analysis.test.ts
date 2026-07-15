import { walkForward, monteCarlo, paramSweep } from "../../src/backtest/analysis.js";
import { Candle, StrategyConfig } from "../../src/backtest/types.js";

function makeCandles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ openTime: i, open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 100 }));
}

describe("walkForward", () => {
  it("splits candles into folds and reports per-window metrics", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + i * 0.1);
    const candles = makeCandles(closes);
    const strategy: StrategyConfig = {
      direction: "long",
      entry: [{ type: "rsi_below", period: 14, value: 101 }],
      risk: { stopPct: 0.5, targetPct: 0.01 },
      feeBps: 0,
    };
    const result = walkForward(candles, strategy, 4);
    expect(result.windows).toHaveLength(4);
    expect(result.windows.every((w) => w.metrics.totalTrades >= 0)).toBe(true);
  });

  it("flags consistent direction when every window's edge points the same way", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + i * 0.1); // steadily rising throughout
    const candles = makeCandles(closes);
    const strategy: StrategyConfig = {
      direction: "long",
      entry: [{ type: "rsi_below", period: 14, value: 101 }],
      risk: { stopPct: 0.5, targetPct: 0.01 },
      feeBps: 0,
    };
    const result = walkForward(candles, strategy, 4);
    expect(result.consistentDirection).toBe(true);
  });
});

describe("monteCarlo", () => {
  it("returns probabilityOfLoss 1 and zeroed stats for an empty trade list", () => {
    const result = monteCarlo([]);
    expect(result.simulations).toBe(0);
    expect(result.probabilityOfLoss).toBe(1);
  });

  it("a trade set of all-winners has probabilityOfLoss 0", () => {
    const trades = Array.from({ length: 20 }, () => ({ returnPct: 0.02 }));
    const result = monteCarlo(trades, 200);
    expect(result.probabilityOfLoss).toBe(0);
    expect(result.medianReturnPct).toBeGreaterThan(0);
  });

  it("a trade set of all-losers has probabilityOfLoss 1", () => {
    const trades = Array.from({ length: 20 }, () => ({ returnPct: -0.02 }));
    const result = monteCarlo(trades, 200);
    expect(result.probabilityOfLoss).toBe(1);
  });

  it("is deterministic given a seed sequence", () => {
    const trades = [{ returnPct: 0.05 }, { returnPct: -0.03 }, { returnPct: 0.02 }];
    const seed = [0.1, 0.5, 0.9, 0.2, 0.7];
    const a = monteCarlo(trades, 10, seed);
    const b = monteCarlo(trades, 10, seed);
    expect(a).toEqual(b);
  });
});

describe("paramSweep", () => {
  it("tests every combination and ranks by expectancy", () => {
    const closes = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5) * 5);
    const candles = makeCandles(closes);
    const strategy: StrategyConfig = {
      direction: "long",
      entry: [{ type: "rsi_below", period: 14, value: 30 }],
      risk: { stopPct: 0.02, targetPct: 0.02 },
      feeBps: 0,
    };
    const results = paramSweep(candles, strategy, [{ conditionIndex: 0, field: "value", values: [20, 30, 40] }]);
    expect(results).toHaveLength(3);
    // sorted descending by expectancy
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].metrics.expectancyPct).toBeGreaterThanOrEqual(results[i].metrics.expectancyPct);
    }
  });
});
