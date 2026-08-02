import { BinanceFuturesClient } from "binance-client-js";

import type {
  FuturesCandle,
  FuturesTicker,
  OpenInterest,
  FundingRateEntry,
  PositionRisk,
  OrderParams,
  OrderResult,
  Timeframe,
} from "../../types/market.js";

// Authenticated Binance USDⓈ-M Futures access, via the shubhamtaywade82/
// Binance-client-js library (not on npm -- installed as a pinned git
// Dependency, see package.json). Deliberately separate from
// Src/tools/binance-client.ts, which is GET-only and never takes API keys
// (AGENTS.md architecture decision #2) -- this adapter is the new,
// Explicitly opt-in, authenticated code path.
//
// Defaults to Binance's testnet. Reaching production requires passing
// Testnet: false explicitly at construction -- never an env-var default
// Flip -- matching binance-client-js's own "Testnet First" guidance and
// This repo's fail-closed convention (see ai-gate.ts).
//
// Wraps only the subset of the library's 80+ methods this repo needs today;
// `.raw` escapes to the untyped client for everything else rather than
// Speculatively wrapping the whole surface.

export interface BinanceFuturesAdapterConfig {
  apiKey: string;
  apiSecret: string;
  testnet?: boolean;
  debug?: boolean;
}

// [openTime, open, high, low, close, volume, closeTime, ...] -- raw Binance kline row.
type RawKlineRow = unknown[];

interface RawMarkPrice {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
}

interface RawOpenInterest {
  symbol: string;
  openInterest: string;
  time: number;
}

interface RawFundingRateEntry {
  symbol: string;
  fundingRate: string;
  fundingTime: number;
}

interface RawPositionRisk {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  positionSide: string;
}

interface RawOrderResult {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  status: string;
  side: string;
  type: string;
  avgPrice: string;
  origQty: string;
  executedQty: string;
}

function mapOrderResult(res: RawOrderResult): OrderResult {
  return {
    orderId: res.orderId,
    clientOrderId: res.clientOrderId,
    symbol: res.symbol,
    status: res.status,
    side: res.side,
    type: res.type,
    avgPrice: Number(res.avgPrice),
    origQty: Number(res.origQty),
    executedQty: Number(res.executedQty),
  };
}

export class BinanceFuturesAdapter {
  private readonly client: BinanceFuturesClient;

  constructor(cfg: BinanceFuturesAdapterConfig) {
    if (!cfg.apiKey || !cfg.apiSecret) {
      throw new Error("BinanceFuturesAdapter requires apiKey and apiSecret (see BINANCE_API_KEY/BINANCE_API_SECRET)");
    }
    this.client = new BinanceFuturesClient({
      apiKey: cfg.apiKey,
      apiSecret: cfg.apiSecret,
      testnet: cfg.testnet ?? true,
      debug: cfg.debug ?? false,
    });
  }

  /** Escape hatch to the untyped client for the ~70 endpoints not wrapped here. */
  get raw(): BinanceFuturesClient {
    return this.client;
  }

  async getKlines(symbol: string, interval: Timeframe, limit = 500): Promise<FuturesCandle[]> {
    const rows = (await this.client.getKlines(symbol, interval, { limit })) as RawKlineRow[];
    return rows.map((row) => ({
      openTime: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: Number(row[6]),
    }));
  }

  async getMarkPrice(symbol: string): Promise<FuturesTicker> {
    const p = (await this.client.getMarkPrice(symbol)) as RawMarkPrice;
    return {
      symbol: p.symbol,
      markPrice: Number(p.markPrice),
      indexPrice: Number(p.indexPrice),
      lastFundingRate: Number(p.lastFundingRate),
      nextFundingTime: p.nextFundingTime,
    };
  }

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const oi = (await this.client.getOpenInterest(symbol)) as RawOpenInterest;
    return { symbol: oi.symbol, openInterest: Number(oi.openInterest), time: oi.time };
  }

  async getFundingRateHistory(symbol: string, limit = 100): Promise<FundingRateEntry[]> {
    const rows = (await this.client.getFundingRateHistory(symbol, limit)) as RawFundingRateEntry[];
    return rows.map((r) => ({ symbol: r.symbol, fundingRate: Number(r.fundingRate), fundingTime: r.fundingTime }));
  }

  async getPositionRisk(symbol?: string): Promise<PositionRisk[]> {
    const rows = (await this.client.getPositionRiskV3(symbol)) as RawPositionRisk[];
    return rows.map((r) => ({
      symbol: r.symbol,
      positionAmt: Number(r.positionAmt),
      entryPrice: Number(r.entryPrice),
      markPrice: Number(r.markPrice),
      unrealizedProfit: Number(r.unRealizedProfit),
      liquidationPrice: Number(r.liquidationPrice),
      leverage: Number(r.leverage),
      positionSide: r.positionSide,
    }));
  }

  async createOrder(params: OrderParams): Promise<OrderResult> {
    return mapOrderResult((await this.client.createOrder(params)) as RawOrderResult);
  }

  async cancelOrder(symbol: string, orderId: number): Promise<boolean> {
    const res = (await this.client.cancelOrder(symbol, orderId)) as { status?: string };
    return res.status === "CANCELED";
  }

  async getOpenOrders(symbol?: string): Promise<OrderResult[]> {
    const rows = (await this.client.getOpenOrders(symbol)) as RawOrderResult[];
    return rows.map(mapOrderResult);
  }

  /** Subscribes to closed 1m/5m/.../1d candles for symbol. Only fires on candle CLOSE (k.x === true), matching src/exchange/binance-stream.ts's convention. */
  subscribeKlines(symbol: string, interval: Timeframe, onClose: (candle: FuturesCandle) => void): void {
    this.client.wsSubscribeCandles(symbol, interval);
    this.client.on("ws:candlestick", (normalized: unknown) => {
      const c = normalized as {
        symbol: string;
        raw: { k: { x: boolean } };
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
        openTime: number;
        closeTime: number;
      };
      if (c.symbol !== symbol.toUpperCase() || !c.raw.k.x) return;
      onClose({
        openTime: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        closeTime: c.closeTime,
      });
    });
  }

  /** Opens the user-data stream (creates/renews listenKey internally) and forwards order + account updates. */
  async subscribeUserStream(handlers: {
    onOrderUpdate?: (update: unknown) => void;
    onAccountUpdate?: (update: unknown) => void;
    onError?: (err: unknown) => void;
  }): Promise<void> {
    await this.client.subscribeUserStream();
    if (handlers.onOrderUpdate) this.client.on("ws:df-order-update", handlers.onOrderUpdate);
    if (handlers.onAccountUpdate) this.client.on("ws:balance-update", handlers.onAccountUpdate);
    if (handlers.onError) this.client.on("ws:error", handlers.onError);
  }

  async closeUserStream(): Promise<void> {
    await this.client.closeUserStream();
  }

  closeAll(): void {
    this.client.closeAllWebSockets();
  }
}

/** Returns null (not an adapter defaulting to some placeholder identity) when BINANCE_API_KEY/BINANCE_API_SECRET aren't set -- absence of these env vars must never construct a live-capable client. */
export function binanceFuturesAdapterFromEnv(): BinanceFuturesAdapter | null {
  const apiKey = process.env["BINANCE_API_KEY"];
  const apiSecret = process.env["BINANCE_API_SECRET"];
  if (!apiKey || !apiSecret) return null;
  const testnet = process.env["BINANCE_TESTNET"] !== "false"; // Opt OUT of testnet explicitly
  return new BinanceFuturesAdapter({ apiKey, apiSecret, testnet });
}
