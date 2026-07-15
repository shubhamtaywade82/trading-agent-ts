import {
  BinanceBacktestTool, BinanceWalkForwardTool, BinanceMonteCarloTool, BinanceParamSweepTool,
} from "../../src/tools/backtest-tools.js";
import { StrategyConfig } from "../../src/backtest/types.js";

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

describe("Backtest tools (real network)", () => {
  it("backtests a real BTCUSDT strategy against real Binance history", async () => {
    const tool = new BinanceBacktestTool();
    const result = await tool.call({ symbol: "BTCUSDT", interval: "1h", limit: 300, strategy: STRATEGY });
    expect(result.candles).toBe(300);
    expect(typeof (result.metrics as any).totalTrades).toBe("number");
  }, 15000);
});
