import type { FuturesCandle, Timeframe } from "../types/market.js";

// Per-(symbol, timeframe) rolling candle buffer. Backfilled once via REST,
// kept current via a WS push -- replaces the pattern in
// src/paper-trading/live-runner.ts where every strategy on the same
// (symbol, timeframe) independently refetches the same candles on every
// poll tick. Not wired into live-runner.ts by this change; see
// docs/superpowers/plans/2026-08-02-binance-pipeline-phase1-market-data.md.

export class CandleStore {
  private readonly candles: FuturesCandle[] = [];

  constructor(
    readonly symbol: string,
    readonly timeframe: Timeframe,
    private readonly maxSize = 1000,
  ) {}

  backfill(initial: FuturesCandle[]): void {
    this.candles.length = 0;
    this.candles.push(...initial.slice(-this.maxSize));
  }

  /** Appends a newly-closed candle, or replaces the last one if openTime matches (idempotent under WS reconnect replay). */
  push(candle: FuturesCandle): void {
    const last = this.candles.at(-1);
    if (last && last.openTime === candle.openTime) {
      this.candles[this.candles.length - 1] = candle;
      return;
    }
    this.candles.push(candle);
    if (this.candles.length > this.maxSize) this.candles.shift();
  }

  latest(): FuturesCandle | undefined {
    return this.candles.at(-1);
  }

  /** Returns the most recent n candles, oldest -> newest. */
  get(n?: number): FuturesCandle[] {
    if (n === undefined) return [...this.candles];
    return this.candles.slice(-n);
  }

  size(): number {
    return this.candles.length;
  }
}
