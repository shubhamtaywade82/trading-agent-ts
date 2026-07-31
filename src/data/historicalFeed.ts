import type { MarketBar } from "../domain/types.js";
import type { IMarketDataFeed } from "./IMarketDataFeed.js";

export class HistoricalFeed implements IMarketDataFeed {
  private series = new Map<string, MarketBar[]>();
  private cursor = new Map<string, number>();

  constructor(
    csvBySymbol: Record<string, string>,
    private readonly window = 60,
  ) {
    for (const [sym, csv] of Object.entries(csvBySymbol)) {
      const rows = csv
        .trim()
        .split("\n")
        .slice(1)
        .filter(l => l.trim().length > 0)
        .map(line => {
          const [ts, o, h, l, c, v] = line.split(",");
          return {
            symbol: sym,
            ts: Number(ts),
            o: Number(o),
            h: Number(h),
            l: Number(l),
            c: Number(c),
            v: Number(v),
          } as MarketBar;
        });
      this.series.set(sym, rows);
      this.cursor.set(sym, this.window);
    }
  }

  symbols(): string[] {
    return [...this.series.keys()];
  }

  async next(): Promise<Map<string, MarketBar[]>> {
    const out = new Map<string, MarketBar[]>();
    for (const [sym, bars] of this.series) {
      const i = this.cursor.get(sym) ?? this.window;
      if (i >= bars.length) {
        out.set(sym, bars.slice(-this.window));
        continue;
      }
      out.set(sym, bars.slice(Math.max(0, i - this.window), i + 1));
      this.cursor.set(sym, i + 1);
    }
    return out;
  }
}
