import type { MarketBar } from "../domain/types.js";

export interface IMarketDataFeed {
  symbols(): string[];
  next(): Promise<Map<string, MarketBar[]>>; // window of bars per symbol per tick
}
