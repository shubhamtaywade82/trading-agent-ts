import {
  BinanceBacktestTool, BinanceWalkForwardTool, BinanceMonteCarloTool, BinanceParamSweepTool,
  BinancePortfolioBacktestTool, BinanceFuturesBacktestTool,
  fetchOpenInterestHist, alignOiToCandles, buildSignalEvaluator,
} from "../../src/tools/backtest-tools.js";
import { StrategyConfig, Candle } from "../../src/backtest/types.js";

function fakeKlines(closes: number[]): unknown[][] {
  return closes.map((c, i) => {
    const t = 1700000000000 + i * 3600000;
    return [t, c, c * 1.001, c * 0.999, c, "100", t + 3599999, "0", 0, "0", "0", "0"];
  });
}

const RISING = Array.from({ length: 200 }, (_, i) => 100 + i * 0.1);

const STRATEGY: StrategyConfig = {
  direction: "long",
  entry: [{ type: "rsi_below", period: 14, value: 101 }],
  risk: { stopPct: 0.5, targetPct: 0.01 },
  feeBps: 0,
};

describe("BinanceBacktestTool", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it("fetches candles and runs a backtest", async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => fakeKlines(RISING) });
    const tool = new BinanceBacktestTool();
    const result = await tool.call({ symbol: "BTCUSDT", interval: "1h", strategy: STRATEGY });
    expect(result.symbol).toBe("BTCUSDT");
    expect((result.metrics as any).totalTrades).toBeGreaterThan(0);
  });

  it("propagates a fetch error", async () => {
    (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error("network down"));
    const tool = new BinanceBacktestTool();
    const result = await tool.call({ symbol: "BTCUSDT", interval: "1h", strategy: STRATEGY });
    expect(result.error).toBe("RequestError");
  });
});

describe("BinanceWalkForwardTool", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it("runs walk-forward across folds", async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => fakeKlines(RISING) });
    const tool = new BinanceWalkForwardTool();
    const result = await tool.call({ symbol: "BTCUSDT", interval: "1h", strategy: STRATEGY, folds: 4 });
    expect(result.windows).toHaveLength(4);
  });
});

describe("BinanceMonteCarloTool", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it("runs monte carlo on the backtest's trade sample", async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => fakeKlines(RISING) });
    const tool = new BinanceMonteCarloTool();
    const result = await tool.call({ symbol: "BTCUSDT", interval: "1h", strategy: STRATEGY, simulations: 100 });
    expect(result.simulations).toBe(100);
    expect(typeof result.medianReturnPct).toBe("number");
  });

  it("returns NoTrades when the strategy never fires", async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => fakeKlines(RISING) });
    const tool = new BinanceMonteCarloTool();
    const neverFires: StrategyConfig = { direction: "long", entry: [{ type: "rsi_above", period: 14, value: 200 }], risk: { stopPct: 0.02, targetPct: 0.02 } };
    const result = await tool.call({ symbol: "BTCUSDT", interval: "1h", strategy: neverFires });
    expect(result.error).toBe("NoTrades");
  });
});

describe("BinanceParamSweepTool", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it("sweeps parameter ranges and ranks results", async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => fakeKlines(RISING) });
    const tool = new BinanceParamSweepTool();
    const result = await tool.call({
      symbol: "BTCUSDT", interval: "1h", strategy: STRATEGY,
      ranges: [{ conditionIndex: 0, field: "value", values: [90, 101] }],
    });
    expect(result.combinationsTested).toBe(2);
    expect((result.top as any[]).length).toBeGreaterThan(0);
  });
});

describe("BinancePortfolioBacktestTool", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it("fetches candles for multiple symbols and runs portfolio backtest", async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => fakeKlines(RISING) });
    const tool = new BinancePortfolioBacktestTool();
    const result = await tool.call({
      symbols: ["BTCUSDT", "ETHUSDT"],
      interval: "1h",
      strategy: STRATEGY,
      initialCapital: 10000,
      maxConcurrentPositions: 2,
    });
    expect(result.symbols).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(result.totalTradesExecuted).toBeGreaterThan(0);
    expect(result.finalCapital).toBeGreaterThan(10000);
  });
});

describe("fetchOpenInterestHist", () => {
  const originalFetch = global.fetch;
  afterEach(() => { (globalThis as any).fetch = originalFetch; });

  it("fetches and maps openInterestHist rows", async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => [
        { symbol: "BTCUSDT", sumOpenInterest: "1000.5", sumOpenInterestValue: "1", timestamp: 1700000000000 },
        { symbol: "BTCUSDT", sumOpenInterest: "1050.0", sumOpenInterestValue: "1", timestamp: 1700003600000 },
      ],
    });
    const result = await fetchOpenInterestHist("BTCUSDT", "1h", 1700000000000, 1700003600000);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.points).toEqual([
        { timestamp: 1700000000000, sumOpenInterest: 1000.5 },
        { timestamp: 1700003600000, sumOpenInterest: 1050.0 },
      ]);
    }
  });

  it("propagates a fetch error", async () => {
    (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error("network down"));
    const result = await fetchOpenInterestHist("BTCUSDT", "1h", 0, 1);
    expect(result).toEqual({ error: "RequestError", message: "network down" });
  });

  it("rejects an unsupported period", async () => {
    const result = await fetchOpenInterestHist("BTCUSDT", "3m", 0, 1);
    expect(result).toEqual({ error: "InvalidPeriod", message: "period must be one of: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d" });
  });
});

describe("alignOiToCandles", () => {
  it("carries forward the last OI sample at or before each candle's openTime", () => {
    const candles: Candle[] = [
      { openTime: 1000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { openTime: 2000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { openTime: 3000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ];
    const points = [
      { timestamp: 1500, sumOpenInterest: 100 },
      { timestamp: 2500, sumOpenInterest: 200 },
    ];
    expect(alignOiToCandles(candles, points)).toEqual([NaN, 100, 200]);
  });

  it("returns an empty array for empty candles", () => {
    expect(alignOiToCandles([], [{ timestamp: 1, sumOpenInterest: 1 }])).toEqual([]);
  });
});

describe("buildSignalEvaluator: OI divergence", () => {
  function candlesWithCloses(closes: number[]): Candle[] {
    return closes.map((c, i) => ({ openTime: 1000 + i * 3600000, open: c, high: c, low: c, close: c, volume: 1 }));
  }

  it("fires oi_bearish_divergence when price makes a new high but OI fell", () => {
    const closes = [...Array(10).fill(100), 105]; // bar 10 is a new high over the prior 10
    const candles = candlesWithCloses(closes);
    const oi = [...Array(10).fill(1000), 900]; // -10% vs bar 0
    const evaluator = buildSignalEvaluator(candles, [{ type: "oi_bearish_divergence", period: 10, value: 0.05 }], { oi });
    expect(evaluator(10)).toBe(true);
  });

  it("does not fire oi_bearish_divergence when OI rose", () => {
    const closes = [...Array(10).fill(100), 105];
    const candles = candlesWithCloses(closes);
    const oi = [...Array(10).fill(1000), 1100];
    const evaluator = buildSignalEvaluator(candles, [{ type: "oi_bearish_divergence", period: 10, value: 0.05 }], { oi });
    expect(evaluator(10)).toBe(false);
  });

  it("fires oi_bullish_divergence when price makes a new low and OI fell", () => {
    const closes = [...Array(10).fill(100), 95];
    const candles = candlesWithCloses(closes);
    const oi = [...Array(10).fill(1000), 900];
    const evaluator = buildSignalEvaluator(candles, [{ type: "oi_bullish_divergence", period: 10, value: 0.05 }], { oi });
    expect(evaluator(10)).toBe(true);
  });

  it("is a no-op when extraSeries is not supplied", () => {
    const closes = [...Array(10).fill(100), 105];
    const candles = candlesWithCloses(closes);
    const evaluator = buildSignalEvaluator(candles, [{ type: "oi_bearish_divergence" }]);
    expect(evaluator(10)).toBe(false);
  });
});

describe("Backtest tools (real network)", () => {
  it("backtests a real BTCUSDT strategy against real Binance history", async () => {
    const tool = new BinanceBacktestTool();
    const result = await tool.call({ symbol: "BTCUSDT", interval: "1h", limit: 300, strategy: STRATEGY });
    expect(result.candles).toBe(300);
    expect(typeof (result.metrics as any).totalTrades).toBe("number");
  }, 15000);
});
