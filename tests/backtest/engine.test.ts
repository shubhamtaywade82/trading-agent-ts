import { runBacktest, computeMetrics, computeEquityCurve } from "../../src/backtest/engine.js";
import { Candle, StrategyConfig } from "../../src/backtest/types.js";

function makeCandles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ openTime: i, open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 100 }));
}

describe("runBacktest", () => {
  it("enters and hits target on a strategy with an always-true entry condition", () => {
    // RSI-below-100 is always true once warmed up — deterministic entry point for testing exits.
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i); // steadily rising
    const candles = makeCandles(closes);
    const strategy: StrategyConfig = {
      direction: "long",
      entry: [{ type: "rsi_below", period: 14, value: 101 }],
      risk: { stopPct: 0.5, targetPct: 0.02 }, // wide stop, tight target on a rising series
      feeBps: 0,
    };
    const result = runBacktest(candles, strategy);
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades[0].exitReason).toBe("target");
    expect(result.trades[0].returnPct).toBeCloseTo(0.02, 5);
  });

  it("hits stop on a falling series", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 200 - i);
    const candles = makeCandles(closes);
    const strategy: StrategyConfig = {
      direction: "long",
      entry: [{ type: "rsi_below", period: 14, value: 101 }],
      risk: { stopPct: 0.02, targetPct: 0.5 },
      feeBps: 0,
    };
    const result = runBacktest(candles, strategy);
    expect(result.trades[0].exitReason).toBe("stop");
    expect(result.trades[0].returnPct).toBeCloseTo(-0.02, 5);
  });

  it("subtracts fees from returns", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
    const candles = makeCandles(closes);
    const strategy: StrategyConfig = {
      direction: "long",
      entry: [{ type: "rsi_below", period: 14, value: 101 }],
      risk: { stopPct: 0.5, targetPct: 0.02 },
      feeBps: 100, // 1%
    };
    const result = runBacktest(candles, strategy);
    expect(result.trades[0].returnPct).toBeCloseTo(0.02 - 0.01, 5);
  });

  it("produces zero trades when entry conditions never fire", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
    const candles = makeCandles(closes);
    const strategy: StrategyConfig = {
      direction: "long",
      entry: [{ type: "rsi_above", period: 14, value: 100 }], // never true, RSI maxes at 100 not >100
      risk: { stopPct: 0.02, targetPct: 0.02 },
    };
    const result = runBacktest(candles, strategy);
    expect(result.trades).toHaveLength(0);
    expect(result.metrics.totalTrades).toBe(0);
  });

  it("short direction profits when price falls to target", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 200 - i);
    const candles = makeCandles(closes);
    const strategy: StrategyConfig = {
      direction: "short",
      entry: [{ type: "rsi_below", period: 14, value: 101 }],
      risk: { stopPct: 0.5, targetPct: 0.02 },
      feeBps: 0,
    };
    const result = runBacktest(candles, strategy);
    expect(result.trades[0].exitReason).toBe("target");
    expect(result.trades[0].returnPct).toBeCloseTo(0.02, 5);
  });
});

describe("computeMetrics", () => {
  it("computes win rate, expectancy, profit factor, drawdown from a known trade set", () => {
    const trades = [
      { entryIndex: 0, exitIndex: 1, entryPrice: 100, exitPrice: 110, direction: "long" as const, returnPct: 0.1, exitReason: "target" as const },
      { entryIndex: 1, exitIndex: 2, entryPrice: 100, exitPrice: 95, direction: "long" as const, returnPct: -0.05, exitReason: "stop" as const },
      { entryIndex: 2, exitIndex: 3, entryPrice: 100, exitPrice: 110, direction: "long" as const, returnPct: 0.1, exitReason: "target" as const },
    ];
    const metrics = computeMetrics(trades);
    expect(metrics.totalTrades).toBe(3);
    expect(metrics.winRate).toBeCloseTo(2 / 3);
    expect(metrics.avgWinPct).toBeCloseTo(0.1);
    expect(metrics.avgLossPct).toBeCloseTo(-0.05);
    expect(metrics.profitFactor).toBeCloseTo(0.2 / 0.05);
  });

  it("returns zeroed metrics for an empty trade list", () => {
    const metrics = computeMetrics([]);
    expect(metrics.totalTrades).toBe(0);
    expect(metrics.winRate).toBe(0);
  });

  it("computes max drawdown from the equity curve", () => {
    const trades = [
      { entryIndex: 0, exitIndex: 1, entryPrice: 100, exitPrice: 120, direction: "long" as const, returnPct: 0.2, exitReason: "target" as const },
      { entryIndex: 1, exitIndex: 2, entryPrice: 100, exitPrice: 80, direction: "long" as const, returnPct: -0.3, exitReason: "stop" as const },
    ];
    const curve = computeEquityCurve(trades);
    expect(curve[0]).toBeCloseTo(1.2);
    expect(curve[1]).toBeCloseTo(1.2 * 0.7);
    const metrics = computeMetrics(trades);
    expect(metrics.maxDrawdownPct).toBeCloseTo(0.3, 5);
  });
});
