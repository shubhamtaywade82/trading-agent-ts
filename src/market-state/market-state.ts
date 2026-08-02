import type { BinanceFuturesAdapter } from "../exchange/binance/client.js";
import type { FuturesCandle, FuturesTicker, OpenInterest, Timeframe } from "../types/market.js";

import { CandleStore } from "./candle-store.js";

// Read-side facade over CandleStore + latest mark price / open interest per
// symbol. Phases 2-4 (features, events, snapshot builder) read from this
// instead of each independently hitting REST -- see
// docs/superpowers/specs/2026-08-02-binance-pipeline-architecture-design.md.

function key(symbol: string, tf: Timeframe): string {
  return `${symbol.toUpperCase()}:${tf}`;
}

export class MarketState {
  private readonly stores = new Map<string, CandleStore>();
  private readonly markPrices = new Map<string, FuturesTicker>();
  private readonly openInterest = new Map<string, OpenInterest>();

  constructor(private readonly adapter: BinanceFuturesAdapter) {}

  async watch(symbol: string, timeframe: Timeframe, backfillLimit = 500): Promise<void> {
    const k = key(symbol, timeframe);
    if (this.stores.has(k)) return;

    const store = new CandleStore(symbol, timeframe);
    const initial = await this.adapter.getKlines(symbol, timeframe, backfillLimit);
    store.backfill(initial);
    this.stores.set(k, store);

    this.adapter.subscribeKlines(symbol, timeframe, (candle: FuturesCandle) => {
      store.push(candle);
    });
  }

  async refreshMarkPrice(symbol: string): Promise<void> {
    this.markPrices.set(symbol.toUpperCase(), await this.adapter.getMarkPrice(symbol));
  }

  async refreshOpenInterest(symbol: string): Promise<void> {
    this.openInterest.set(symbol.toUpperCase(), await this.adapter.getOpenInterest(symbol));
  }

  latestCandle(symbol: string, timeframe: Timeframe): FuturesCandle | undefined {
    return this.stores.get(key(symbol, timeframe))?.latest();
  }

  candles(symbol: string, timeframe: Timeframe, n?: number): FuturesCandle[] {
    return this.stores.get(key(symbol, timeframe))?.get(n) ?? [];
  }

  latestMarkPrice(symbol: string): FuturesTicker | undefined {
    return this.markPrices.get(symbol.toUpperCase());
  }

  latestOpenInterest(symbol: string): OpenInterest | undefined {
    return this.openInterest.get(symbol.toUpperCase());
  }

  isWatching(symbol: string, timeframe: Timeframe): boolean {
    return this.stores.has(key(symbol, timeframe));
  }
}
