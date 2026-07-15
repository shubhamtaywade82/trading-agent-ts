import {
  BinancePublicApiTool, BinanceTechnicalIndicatorsTool, BinanceOrderBookTool,
  BinanceFuturesStatsTool, BinanceScreenerTool, BinanceWatchPriceTool,
  BinanceUnwatchPriceTool, BinancePriceAlertTool, BinanceLiquidationsTool,
} from "../../src/tools/binance-tools.js";
import { BinanceStreamManager } from "../../src/exchange/binance-stream.js";

function fakeKline(close: number, i: number): unknown[] {
  const t = 1700000000000 + i * 3600000;
  return [t, close, close, close, close, "100", t + 3599999, "0", 0, "0", "0", "0"];
}

describe("BinancePublicApiTool", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it("fetches a spot endpoint and returns the parsed body", async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ symbol: "BTCUSDT", price: "60000.00" }),
    }) ;

    const tool = new BinancePublicApiTool();
    const result = await tool.call({ path: "/api/v3/ticker/price", params: { symbol: "BTCUSDT" } });

    expect(result).toEqual({ status: 200, body: { symbol: "BTCUSDT", price: "60000.00" } });
    const calledUrl = ((globalThis as any).fetch as jest.Mock).mock.calls[0][0] as URL;
    expect(calledUrl.toString()).toBe("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
  });

  it("defaults to the spot market when none is given", async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }) ;
    const tool = new BinancePublicApiTool();
    await tool.call({ path: "/api/v3/exchangeInfo" });
    const calledUrl = ((globalThis as any).fetch as jest.Mock).mock.calls[0][0] as URL;
    expect(calledUrl.origin).toBe("https://api.binance.com");
  });

  it("routes to the futures host for market: usdm", async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }) ;
    const tool = new BinancePublicApiTool();
    await tool.call({ market: "usdm", path: "/fapi/v1/premiumIndex" });
    const calledUrl = ((globalThis as any).fetch as jest.Mock).mock.calls[0][0] as URL;
    expect(calledUrl.toString()).toBe("https://fapi.binance.com/fapi/v1/premiumIndex");
  });

  it("rejects an unknown market", async () => {
    const tool = new BinancePublicApiTool();
    const result = await tool.call({ market: "nope", path: "/api/v3/ping" });
    expect(result.error).toBe("InvalidMarket");
  });

  it("rejects a path outside the market's allowed prefixes (blocks e.g. /sapi/ account endpoints)", async () => {
    const tool = new BinancePublicApiTool();
    const result = await tool.call({ path: "/sapi/v1/account" });
    expect(result.error).toBe("InvalidPath");
  });

  it("allows /futures/data/ paths on usdm (open interest history, long/short ratio)", async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] });
    const tool = new BinancePublicApiTool();
    const result = await tool.call({ market: "usdm", path: "/futures/data/openInterestHist", params: { symbol: "BTCUSDT", period: "1h" } });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(200);
  });

  it("surfaces non-ok responses as BinanceApiError without throwing", async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ code: -1121, msg: "Invalid symbol." }),
    }) ;

    const tool = new BinancePublicApiTool();
    const result = await tool.call({ path: "/api/v3/ticker/price", params: { symbol: "NOTREAL" } });
    expect(result.error).toBe("BinanceApiError");
    expect(result.status).toBe(400);
  });

  it("returns a RequestError instead of throwing on network failure", async () => {
    (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND")) ;
    const tool = new BinancePublicApiTool();
    const result = await tool.call({ path: "/api/v3/ping" });
    expect(result.error).toBe("RequestError");
  });
});

describe("BinanceTechnicalIndicatorsTool", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it("computes indicators from fetched klines", async () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 0.5);
    const rows = closes.map((c, i) => fakeKline(c, i));
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => rows });

    const tool = new BinanceTechnicalIndicatorsTool();
    const result = await tool.call({ symbol: "SOLUSDT" });

    expect(result.symbol).toBe("SOLUSDT");
    expect(result.candles).toBe(40);
    const indicators = result.indicators as Record<string, unknown>;
    expect(indicators.sma20).toBeCloseTo(closes.slice(-20).reduce((a, b) => a + b, 0) / 20);
    expect((indicators.rsi14 as number)).toBe(100); // monotonically rising closes
    expect(indicators.macd).toBeDefined();
    expect(indicators.bollinger).toBeDefined();
  });

  it("only computes the requested indicators", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => fakeKline(100 + i, i));
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => rows });

    const tool = new BinanceTechnicalIndicatorsTool();
    const result = await tool.call({ symbol: "BTCUSDT", indicators: ["rsi"] });
    const indicators = result.indicators as Record<string, unknown>;
    expect(indicators.rsi14).toBeDefined();
    expect(indicators.sma20).toBeUndefined();
    expect(indicators.macd).toBeUndefined();
  });

  it("normalizes mis-cased/aliased indicator names instead of silently returning {} (regression: models pass 'SMA', 'BB20', 'MACD')", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => fakeKline(100 + i, i));
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => rows });

    const tool = new BinanceTechnicalIndicatorsTool();
    const result = await tool.call({ symbol: "BTCUSDT", indicators: ["SMA20", "EMA20", "RSI14", "MACD", "BB"] });
    const indicators = result.indicators as Record<string, unknown>;
    expect(indicators.sma20).toBeDefined();
    expect(indicators.ema20).toBeDefined();
    expect(indicators.rsi14).toBeDefined();
    expect(indicators.macd).toBeDefined();
    expect(indicators.bollinger).toBeDefined();
  });

  it("falls back to all indicators when every requested name is unrecognized", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => fakeKline(100 + i, i));
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => rows });

    const tool = new BinanceTechnicalIndicatorsTool();
    const result = await tool.call({ symbol: "BTCUSDT", indicators: ["nonsense"] });
    const indicators = result.indicators as Record<string, unknown>;
    expect(indicators.sma20).toBeDefined();
    expect(indicators.rsi14).toBeDefined();
  });

  it("errors when too few candles are returned", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => fakeKline(100 + i, i));
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => rows });

    const tool = new BinanceTechnicalIndicatorsTool();
    const result = await tool.call({ symbol: "BTCUSDT" });
    expect(result.error).toBe("InsufficientData");
  });

  it("rejects an unknown market", async () => {
    const tool = new BinanceTechnicalIndicatorsTool();
    const result = await tool.call({ symbol: "BTCUSDT", market: "nope" });
    expect(result.error).toBe("InvalidMarket");
  });
});

describe("BinanceOrderBookTool", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it("computes bid/ask imbalance", async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ bids: [["100", "10"], ["99", "5"]], asks: [["101", "3"], ["102", "2"]] }),
    });
    const tool = new BinanceOrderBookTool();
    const result = await tool.call({ symbol: "BTCUSDT" });
    expect(result.bidVolume).toBe(15);
    expect(result.askVolume).toBe(5);
    expect(result.imbalance).toBeCloseTo(0.5); // (15-5)/(15+5)
    expect(result.bestBid).toBe("100");
    expect(result.bestAsk).toBe("101");
  });
});

describe("BinanceFuturesStatsTool", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it("combines premium index and open interest", async () => {
    (globalThis as any).fetch = jest.fn().mockImplementation((url: URL) => {
      if (url.toString().includes("premiumIndex")) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ markPrice: "60000.5", lastFundingRate: "0.0001", nextFundingTime: 123 }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ openInterest: "1234.5" }) });
    });
    const tool = new BinanceFuturesStatsTool();
    const result = await tool.call({ symbol: "BTCUSDT" });
    expect(result.markPrice).toBe(60000.5);
    expect(result.lastFundingRate).toBe(0.0001);
    expect(result.openInterest).toBe(1234.5);
  });
});

describe("BinanceScreenerTool", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it("flags oversold and overbought symbols", async () => {
    (globalThis as any).fetch = jest.fn().mockImplementation((url: URL) => {
      const symbol = url.searchParams.get("symbol");
      const closes =
        symbol === "UPUSDT"
          ? Array.from({ length: 40 }, (_, i) => 100 + i)
          : Array.from({ length: 40 }, (_, i) => 100 - i);
      const rows = closes.map((c, i) => fakeKline(c, i));
      return Promise.resolve({ ok: true, status: 200, json: async () => rows });
    });
    const tool = new BinanceScreenerTool();
    const result = await tool.call({ symbols: ["UPUSDT", "DOWNUSDT"] });
    const results = result.results as Array<{ symbol: string; signal: string }>;
    expect(results.find((r) => r.symbol === "UPUSDT")?.signal).toBe("overbought");
    expect(results.find((r) => r.symbol === "DOWNUSDT")?.signal).toBe("oversold");
  });

  it("rejects an empty symbols array", async () => {
    const tool = new BinanceScreenerTool();
    const result = await tool.call({ symbols: [] });
    expect(result.error).toBe("InvalidSymbols");
  });
});

function fakeStream(overrides: Partial<BinanceStreamManager> = {}): BinanceStreamManager {
  return {
    subscribe: jest.fn().mockResolvedValue(undefined),
    unsubscribe: jest.fn().mockReturnValue(true),
    isSubscribed: jest.fn().mockReturnValue(false),
    getLatest: jest.fn().mockReturnValue(undefined),
    listSubscriptions: jest.fn().mockReturnValue([]),
    addAlert: jest.fn(),
    removeAlert: jest.fn().mockReturnValue(true),
    listAlerts: jest.fn().mockReturnValue([]),
    subscribeLiquidations: jest.fn().mockResolvedValue(undefined),
    unsubscribeLiquidations: jest.fn().mockReturnValue(true),
    isSubscribedToLiquidations: jest.fn().mockReturnValue(false),
    getLiquidations: jest.fn().mockReturnValue([]),
    closeAll: jest.fn(),
    ...overrides,
  } as unknown as BinanceStreamManager;
}

describe("BinanceLiquidationsTool", () => {
  it("subscribes", async () => {
    const stream = fakeStream();
    const tool = new BinanceLiquidationsTool(stream);
    const result = await tool.call({ action: "subscribe" });
    expect(stream.subscribeLiquidations).toHaveBeenCalled();
    expect(result).toEqual({ subscribed: true });
  });

  it("does not re-subscribe if already subscribed", async () => {
    const stream = fakeStream({ isSubscribedToLiquidations: jest.fn().mockReturnValue(true) });
    const tool = new BinanceLiquidationsTool(stream);
    await tool.call({ action: "subscribe" });
    expect(stream.subscribeLiquidations).not.toHaveBeenCalled();
  });

  it("lists liquidations, optionally filtered by symbol", async () => {
    const liqs = [{ symbol: "BTCUSDT", side: "SELL" as const, price: 60000, quantity: 1, time: 1 }];
    const stream = fakeStream({ getLiquidations: jest.fn().mockReturnValue(liqs) });
    const tool = new BinanceLiquidationsTool(stream);
    const result = await tool.call({ action: "list", symbol: "BTCUSDT" });
    expect(stream.getLiquidations).toHaveBeenCalledWith("BTCUSDT");
    expect(result.liquidations).toEqual(liqs);
  });

  it("unsubscribes", async () => {
    const stream = fakeStream();
    const tool = new BinanceLiquidationsTool(stream);
    const result = await tool.call({ action: "unsubscribe" });
    expect(result).toEqual({ unsubscribed: true });
  });

  it("returns a SubscribeError instead of throwing", async () => {
    const stream = fakeStream({ subscribeLiquidations: jest.fn().mockRejectedValue(new Error("connect failed")) });
    const tool = new BinanceLiquidationsTool(stream);
    const result = await tool.call({ action: "subscribe" });
    expect(result.error).toBe("SubscribeError");
  });

  it("rejects an unknown action", async () => {
    const tool = new BinanceLiquidationsTool(fakeStream());
    const result = await tool.call({ action: "nope" });
    expect(result.error).toBe("InvalidAction");
  });
});

describe("BinanceWatchPriceTool", () => {
  it("subscribes then returns the latest tick once available", async () => {
    const tick = { symbol: "BTCUSDT", price: 60000, time: 1 };
    const stream = fakeStream({ isSubscribed: jest.fn().mockReturnValue(false), getLatest: jest.fn().mockReturnValue(tick) });
    const tool = new BinanceWatchPriceTool(stream);
    const result = await tool.call({ symbol: "btcusdt" });
    expect(stream.subscribe).toHaveBeenCalledWith("BTCUSDT");
    expect(result).toEqual(tick);
  });

  it("does not re-subscribe if already subscribed", async () => {
    const tick = { symbol: "BTCUSDT", price: 1, time: 1 };
    const stream = fakeStream({ isSubscribed: jest.fn().mockReturnValue(true), getLatest: jest.fn().mockReturnValue(tick) });
    const tool = new BinanceWatchPriceTool(stream);
    await tool.call({ symbol: "BTCUSDT" });
    expect(stream.subscribe).not.toHaveBeenCalled();
  });

  it("returns a SubscribeError instead of throwing", async () => {
    const stream = fakeStream({ subscribe: jest.fn().mockRejectedValue(new Error("connect failed")) });
    const tool = new BinanceWatchPriceTool(stream);
    const result = await tool.call({ symbol: "BTCUSDT" });
    expect(result.error).toBe("SubscribeError");
  });
});

describe("BinanceUnwatchPriceTool", () => {
  it("unsubscribes", async () => {
    const stream = fakeStream();
    const tool = new BinanceUnwatchPriceTool(stream);
    const result = await tool.call({ symbol: "BTCUSDT" });
    expect(stream.unsubscribe).toHaveBeenCalledWith("BTCUSDT");
    expect(result).toEqual({ unsubscribed: true });
  });
});

describe("BinancePriceAlertTool", () => {
  it("creates an alert, subscribing first if needed", async () => {
    const alert = { id: 1, symbol: "BTCUSDT", condition: "above", threshold: 70000, triggered: false, triggeredAt: null, triggeredPrice: null };
    const stream = fakeStream({ addAlert: jest.fn().mockReturnValue(alert) });
    const tool = new BinancePriceAlertTool(stream);
    const result = await tool.call({ action: "create", symbol: "btcusdt", condition: "above", threshold: 70000 });
    expect(stream.subscribe).toHaveBeenCalledWith("BTCUSDT");
    expect(result).toEqual(alert);
  });

  it("rejects an invalid create call", async () => {
    const tool = new BinancePriceAlertTool(fakeStream());
    const result = await tool.call({ action: "create", symbol: "BTCUSDT" });
    expect(result.error).toBe("InvalidArgs");
  });

  it("lists alerts", async () => {
    const stream = fakeStream({ listAlerts: jest.fn().mockReturnValue([{ id: 1 }]) });
    const tool = new BinancePriceAlertTool(stream);
    const result = await tool.call({ action: "list" });
    expect(result.alerts).toEqual([{ id: 1 }]);
  });

  it("removes an alert", async () => {
    const stream = fakeStream();
    const tool = new BinancePriceAlertTool(stream);
    const result = await tool.call({ action: "remove", id: 1 });
    expect(stream.removeAlert).toHaveBeenCalledWith(1);
    expect(result).toEqual({ removed: true });
  });

  it("rejects an unknown action", async () => {
    const tool = new BinancePriceAlertTool(fakeStream());
    const result = await tool.call({ action: "nope" });
    expect(result.error).toBe("InvalidAction");
  });
});

describe("BinancePublicApiTool (real network)", () => {
  it("pings the real Binance spot API", async () => {
    const tool = new BinancePublicApiTool();
    const result = await tool.call({ path: "/api/v3/ping" });
    expect(result.status).toBe(200);
  }, 15000);

  it("fetches a real BTCUSDT spot price", async () => {
    const tool = new BinancePublicApiTool();
    const result = await tool.call({ path: "/api/v3/ticker/price", params: { symbol: "BTCUSDT" } });
    expect(result.status).toBe(200);
    expect((result.body as { symbol: string }).symbol).toBe("BTCUSDT");
  }, 15000);
});

describe("BinanceTechnicalIndicatorsTool (real network)", () => {
  it("computes real indicators for BTCUSDT", async () => {
    const tool = new BinanceTechnicalIndicatorsTool();
    const result = await tool.call({ symbol: "BTCUSDT", interval: "1h", limit: 100 });
    expect(result.symbol).toBe("BTCUSDT");
    const indicators = result.indicators as Record<string, unknown>;
    expect(typeof indicators.rsi14).toBe("number");
    expect(indicators.rsi14 as number).toBeGreaterThanOrEqual(0);
    expect(indicators.rsi14 as number).toBeLessThanOrEqual(100);
  }, 15000);
});

describe("BinanceOrderBookTool (real network)", () => {
  it("fetches a real BTCUSDT order book", async () => {
    const tool = new BinanceOrderBookTool();
    const result = await tool.call({ symbol: "BTCUSDT" });
    expect(typeof result.imbalance).toBe("number");
  }, 15000);
});

describe("BinanceFuturesStatsTool (real network)", () => {
  it("fetches real BTCUSDT funding rate and open interest", async () => {
    const tool = new BinanceFuturesStatsTool();
    const result = await tool.call({ symbol: "BTCUSDT" });
    expect(typeof result.markPrice).toBe("number");
    expect(typeof result.openInterest).toBe("number");
  }, 15000);
});

describe("BinanceScreenerTool (real network)", () => {
  it("screens real symbols", async () => {
    const tool = new BinanceScreenerTool();
    const result = await tool.call({ symbols: ["BTCUSDT", "ETHUSDT"] });
    const results = result.results as Array<{ symbol: string; signal: string }>;
    expect(results).toHaveLength(2);
    expect(["oversold", "overbought", "neutral"]).toContain(results[0].signal);
  }, 15000);
});
