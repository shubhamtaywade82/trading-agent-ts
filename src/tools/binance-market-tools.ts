import { BINANCE_TAGS, DEPTH_PATH, fetchBinance, KLINES_PATH, MARKETS } from "./binance-client.js";
import { bollingerBands, ema, macd, rsi, sma } from "./indicators.js";
import { Tool } from "./tool.js";

export async function fetchSpotPrice(symbol: string): Promise<{ price: number } | { error: string; message: string }> {
  const result = await fetchBinance("spot", "/api/v3/ticker/price", { symbol });
  if (result["error"]) return result as { error: string; message: string };
  const body = result["body"] as { price: string };
  return { price: Number(body.price) };
}

export async function fetchRecentCloses(symbol: string, tf: string, barsNeeded: number): Promise<{ closes: number[] } | { error: string; message: string }> {
  const klinesPath = KLINES_PATH["spot"];
  if (klinesPath === undefined) {
    return { error: "InvalidMarket", message: `market must be one of: ${Object.keys(MARKETS).join(", ")}` };
  }
  const result = await fetchBinance("spot", klinesPath, { symbol, interval: tf, limit: barsNeeded });
  if (result["error"]) return result as { error: string; message: string };
  const rows = result["body"] as unknown[][];
  return { closes: rows.map(row => Number(row[4])) };
}

// Ponytail: GET-only + no API key ever sent, so this is structurally incapable of
// Trading/account access regardless of path — no need for a per-endpoint allowlist.
export class BinancePublicApiTool extends Tool {
  readonly name = "binance_public_api";

  get description(): string {
    return (
      "GET a public Binance REST API endpoint (no auth) — market data, tickers, order book, " +
      "klines, exchange info. market: 'spot' (api.binance.com, paths under /api/v3/), " +
      "'usdm' (USD-M futures, fapi.binance.com, /fapi/v1|v2/), 'coinm' (COIN-M futures, " +
      "dapi.binance.com, /dapi/v1/). Example path: /api/v3/ticker/price?symbol=BTCUSDT."
    );
  }

  override get tags(): string[] {
    return [...BINANCE_TAGS, "http"];
  }

  override get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        market: { type: "string", enum: Object.keys(MARKETS), description: "Which Binance API to hit (default spot)" },
        path: { type: "string", description: "Endpoint path, e.g. /api/v3/klines" },
        params: { type: "object", description: "Query string parameters, e.g. { symbol: 'BTCUSDT', interval: '1h' }" },
      },
      required: ["path"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const market = typeof args["market"] === "string" ? args["market"] : "spot";
    const path = typeof args["path"] === "string" ? args["path"] : "";
    const params = args["params"] && typeof args["params"] === "object" ? (args["params"] as Record<string, unknown>) : {};
    return fetchBinance(market, path, params);
  }
}

const ALL_INDICATORS = ["sma", "ema", "rsi", "macd", "bollinger"] as const;

// Ponytail: models don't reliably respect the enum casing/spelling in the schema
// ("SMA20", "BB", "MACD" all showed up in practice) — normalize aliases at the
// Trust boundary instead of silently returning {} for anything that doesn't match.
const INDICATOR_ALIASES: Record<string, string> = {
  sma: "sma", sma20: "sma",
  ema: "ema", ema20: "ema",
  rsi: "rsi", rsi14: "rsi",
  macd: "macd",
  bollinger: "bollinger", bollingerbands: "bollinger", bb: "bollinger", bb20: "bollinger",
};

function normalizeIndicators(input: unknown): readonly string[] {
  if (!Array.isArray(input) || input.length === 0) return ALL_INDICATORS;
  const normalized = input
    .map((v) => INDICATOR_ALIASES[String(v).toLowerCase().replaceAll(/[^a-z0-9]/g, "")])
    .filter((v): v is string => Boolean(v));
  return normalized.length > 0 ? [...new Set(normalized)] : ALL_INDICATORS;
}

function computeIndicators(closes: number[], wanted: readonly string[]): Record<string, unknown> {
  const indicators: Record<string, unknown> = {};
  if (wanted.includes("sma")) indicators["sma20"] = sma(closes, 20);
  if (wanted.includes("ema")) indicators["ema20"] = ema(closes, 20);
  if (wanted.includes("rsi")) indicators["rsi14"] = rsi(closes, 14);
  if (wanted.includes("macd")) indicators["macd"] = macd(closes);
  if (wanted.includes("bollinger")) indicators["bollinger"] = bollingerBands(closes, 20, 2);
  return indicators;
}

function parseIndicatorArgs(args: Record<string, unknown>): { market: string; symbol: string; interval: string; limit: number } {
  return {
    market: typeof args["market"] === "string" ? args["market"] : "spot",
    symbol: typeof args["symbol"] === "string" ? args["symbol"] : "",
    interval: typeof args["interval"] === "string" ? args["interval"] : "1h",
    limit: Math.min(Number(args["limit"] ?? 100) || 100, 500),
  };
}

export class BinanceTechnicalIndicatorsTool extends Tool {
  readonly name = "binance_technical_indicators";

  get description(): string {
    return (
      "Fetch recent Binance klines (candles) and compute technical indicators from closing " +
      "prices — SMA(20), EMA(20), RSI(14), MACD(12,26,9), Bollinger Bands(20,2). Deterministic " +
      "math, not an LLM guess from raw candle numbers. Use this instead of eyeballing klines for trend/momentum questions."
    );
  }

  override get tags(): string[] {
    return [...BINANCE_TAGS, "technical-analysis", "indicators"];
  }

  override get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        symbol: { type: "string", description: "e.g. BTCUSDT, SOLUSDT" },
        market: { type: "string", enum: Object.keys(MARKETS), description: "Default spot" },
        interval: { type: "string", description: "Binance kline interval, e.g. 1m, 15m, 1h, 4h, 1d (default 1h)" },
        limit: { type: "number", description: "Number of candles to fetch, max 500 (default 100)" },
        indicators: {
          type: "array",
          items: { type: "string", enum: ALL_INDICATORS as unknown as string[] },
          description: "Which indicators to compute (default: all)",
        },
      },
      required: ["symbol"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { market, symbol, interval, limit } = parseIndicatorArgs(args);
    const wanted = normalizeIndicators(args["indicators"]);

    const path = KLINES_PATH[market];
    if (!path) {
      return { error: "InvalidMarket", message: `market must be one of: ${Object.keys(MARKETS).join(", ")}` };
    }

    const result = await fetchBinance(market, path, { symbol, interval, limit });
    if (result["error"]) return result;

    const rows = result["body"] as unknown[][] | null;
    if (!Array.isArray(rows) || rows.length < 30) {
      return { error: "InsufficientData", message: `Need at least 30 candles for reliable indicators, got ${String(rows?.length ?? 0)}. Increase limit.` };
    }
    const closes = rows.map((row) => Number(row[4]));

    return { symbol, market, interval, candles: rows.length, lastClose: closes.at(-1), indicators: computeIndicators(closes, wanted) };
  }
}

export async function fetchOrderBookImbalance(
  symbol: string, market: string, limit: number,
): Promise<{ bestBid: string | null; bestAsk: string | null; bidVolume: number; askVolume: number; imbalance: number } | { error: string; message: string }> {
  const path = DEPTH_PATH[market];
  if (!path) {
    return { error: "InvalidMarket", message: `market must be one of: ${Object.keys(MARKETS).join(", ")}` };
  }
  const result = await fetchBinance(market, path, { symbol, limit });
  if (result["error"]) return result as { error: string; message: string };

  const body = result["body"] as { bids: Array<[string, string]>; asks: Array<[string, string]> };
  const bidVolume = body.bids.reduce((sum, [, qty]) => sum + Number(qty), 0);
  const askVolume = body.asks.reduce((sum, [, qty]) => sum + Number(qty), 0);
  const imbalance = (bidVolume - askVolume) / (bidVolume + askVolume);
  return { bestBid: body.bids[0]?.[0] ?? null, bestAsk: body.asks[0]?.[0] ?? null, bidVolume, askVolume, imbalance };
}

export class BinanceOrderBookTool extends Tool {
  readonly name = "binance_order_book";
  readonly description = "Fetch the Binance order book for a symbol and compute bid/ask volume imbalance — positive means more buy pressure near the top of book.";

  override get tags(): string[] {
    return [...BINANCE_TAGS, "order-book"];
  }

  override get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        symbol: { type: "string", description: "e.g. BTCUSDT" },
        market: { type: "string", enum: Object.keys(MARKETS), description: "Default spot" },
        limit: { type: "number", description: "Depth of book to fetch: 5,10,20,50,100,500,1000 (default 50)" },
      },
      required: ["symbol"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const market = typeof args["market"] === "string" ? args["market"] : "spot";
    const symbol = typeof args["symbol"] === "string" ? args["symbol"] : "";
    const limit = Number(args["limit"] ?? 50) || 50;
    const result = await fetchOrderBookImbalance(symbol, market, limit);
    if ("error" in result) return result;
    return { symbol, market, ...result };
  }
}

function classifyRsi(rsi14: number): string {
  if (rsi14 < 30) return "oversold";
  if (rsi14 > 70) return "overbought";
  return "neutral";
}

export class BinanceScreenerTool extends Tool {
  readonly name = "binance_screener";
  readonly description = "Run RSI(14) across multiple spot symbols and flag oversold (<30) / overbought (>70) — quick multi-symbol momentum scan.";

  override get tags(): string[] {
    return [...BINANCE_TAGS, "technical-analysis", "screener"];
  }

  override get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        symbols: { type: "array", items: { type: "string" }, description: "e.g. [\"BTCUSDT\", \"ETHUSDT\", \"SOLUSDT\"], max 20" },
        interval: { type: "string", description: "Default 1h" },
      },
      required: ["symbols"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbols = (Array.isArray(args["symbols"]) ? args["symbols"] : []).slice(0, 20) as string[];
    if (symbols.length === 0) return { error: "InvalidSymbols", message: "symbols must be a non-empty array" };
    const interval = typeof args["interval"] === "string" ? args["interval"] : "1h";

    const results = await Promise.all(
      symbols.map(async (symbol) => {
        const result = await fetchBinance("spot", "/api/v3/klines", { symbol, interval, limit: 100 });
        if (result["error"]) return { symbol, error: result["error"], message: result["message"] };
        const rows = result["body"] as unknown[][];
        if (rows.length < 30) return { symbol, error: "InsufficientData" };
        const closes = rows.map((row) => Number(row[4]));
        const rsi14 = rsi(closes, 14);
        return {
          symbol,
          rsi14,
          lastClose: closes.at(-1),
          signal: classifyRsi(rsi14),
        };
      })
    );

    return { interval, results };
  }
}
