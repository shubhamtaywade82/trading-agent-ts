import { BinanceStreamManager } from "./binance-stream.js";

export interface PaperPosition {
  id: number;
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  quantity: number;
  stopPrice?: number;
  targetPrice?: number;
  openedAt: number;
  closedAt: number | null;
  closePrice: number | null;
  closeReason: "manual" | "stop" | "target" | null;
  realizedPnlPct: number | null;
}

// ponytail: in-memory, one paper account, mark-to-market on demand (not a
// live tick loop) — no persistence, no fees/slippage model beyond what the
// caller bakes into stop/target. This never touches a real exchange; it's a
// hypothesis-tracking ledger, not an execution system.
export class PaperTradingManager {
  private positions: PaperPosition[] = [];
  private nextId = 1;

  constructor(private stream: BinanceStreamManager) {}

  async open(symbol: string, direction: "long" | "short", quantity: number, stopPrice?: number, targetPrice?: number): Promise<PaperPosition | { error: string; message: string }> {
    const sym = symbol.toUpperCase();
    try {
      if (!this.stream.isSubscribed(sym)) await this.stream.subscribe(sym);
    } catch (e) {
      return { error: "SubscribeError", message: (e as Error).message };
    }

    let tick = this.stream.getLatest(sym);
    for (let i = 0; i < 20 && !tick; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      tick = this.stream.getLatest(sym);
    }
    if (!tick) return { error: "NoPriceYet", message: "Subscribed but no live price received yet, try again" };

    const position: PaperPosition = {
      id: this.nextId++,
      symbol: sym,
      direction,
      entryPrice: tick.price,
      quantity,
      stopPrice,
      targetPrice,
      openedAt: tick.time,
      closedAt: null,
      closePrice: null,
      closeReason: null,
      realizedPnlPct: null,
    };
    this.positions.push(position);
    return position;
  }

  // Mark every open position to the latest live price, auto-closing any
  // that have crossed their stop/target. Call before listing for a fresh read.
  markToMarket(): void {
    for (const p of this.positions) {
      if (p.closedAt !== null) continue;
      const tick = this.stream.getLatest(p.symbol);
      if (!tick) continue;
      if (p.stopPrice !== undefined) {
        const hitStop = p.direction === "long" ? tick.price <= p.stopPrice : tick.price >= p.stopPrice;
        if (hitStop) {
          this.close(p.id, "stop", tick.price);
          continue;
        }
      }
      if (p.targetPrice !== undefined) {
        const hitTarget = p.direction === "long" ? tick.price >= p.targetPrice : tick.price <= p.targetPrice;
        if (hitTarget) this.close(p.id, "target", tick.price);
      }
    }
  }

  close(id: number, reason: PaperPosition["closeReason"] = "manual", priceOverride?: number): PaperPosition | undefined {
    const p = this.positions.find((pos) => pos.id === id);
    if (!p || p.closedAt !== null) return undefined;
    const price = priceOverride ?? this.stream.getLatest(p.symbol)?.price;
    if (price === undefined) return undefined;
    p.closedAt = Date.now();
    p.closePrice = price;
    p.closeReason = reason;
    p.realizedPnlPct = p.direction === "long" ? (price - p.entryPrice) / p.entryPrice : (p.entryPrice - price) / p.entryPrice;
    return p;
  }

  list(openOnly = false): PaperPosition[] {
    this.markToMarket();
    return openOnly ? this.positions.filter((p) => p.closedAt === null) : [...this.positions];
  }

  unrealizedPnlPct(p: PaperPosition): number | null {
    if (p.closedAt !== null) return p.realizedPnlPct;
    const tick = this.stream.getLatest(p.symbol);
    if (!tick) return null;
    return p.direction === "long" ? (tick.price - p.entryPrice) / p.entryPrice : (p.entryPrice - tick.price) / p.entryPrice;
  }
}
