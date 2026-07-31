import type { Config } from "../config/schema.js";
import type { Account, Fill, OrderIntent } from "../domain/types.js";
import type { IBrokerage } from "./IBrokerage.js";

export class PaperBrokerage implements IBrokerage {
  private account: Account;
  private fills = new Map<string, Fill>(); // idempotency store
  private lastPrices = new Map<string, number>();

  constructor(private readonly cfg: Config) {
    this.account = {
      cash: cfg.paper.initialCapital,
      equity: cfg.paper.initialCapital,
      positions: new Map(),
      dailyPnl: 0,
    };
  }

  getAccount(): Account {
    return this.account;
  }

  async submit(intent: OrderIntent): Promise<Fill> {
    // Idempotency: same key => same result, no double execution
    const cached = this.fills.get(intent.idempotencyKey);
    if (cached) return cached;

    const px = this.lastPrices.get(intent.symbol);
    if (px == null) return this.reject(intent, "no_price");

    const exec = intent.side === "BUY"
      ? px * (1 + this.cfg.execution.slippagePct)
      : px * (1 - this.cfg.execution.slippagePct);
    const notional = exec * intent.qty;
    const fee = notional * this.cfg.execution.commissionPct;

    // cash check for buys
    if (intent.side === "BUY" && this.account.cash < notional + fee) {
      return this.reject(intent, "insufficient_cash");
    }

    this.account.cash += (intent.side === "BUY" ? -1 : 1) * notional - fee;
    this.applyPosition(intent, exec);

    const fill: Fill = {
      idempotencyKey: intent.idempotencyKey,
      status: "FILLED",
      avgPrice: exec,
      filledQty: intent.qty,
      fee,
      ts: Date.now(),
    };
    this.fills.set(intent.idempotencyKey, fill);
    return fill;
  }

  async cancel(key: string): Promise<boolean> {
    return !this.fills.has(key);
  }

  markToMarket(prices: Map<string, number>): void {
    this.lastPrices = prices;
    let unreal = 0;
    for (const [sym, pos] of this.account.positions) {
      const px = prices.get(sym) ?? pos.avgEntry;
      unreal += (px - pos.avgEntry) * pos.qty;
      // intraday stop / TP simulation
      if (pos.qty > 0 && pos.stopLoss && px <= pos.stopLoss) {
        this.closeAt(sym, px);
      }
      if (pos.qty > 0 && pos.takeProfit && px >= pos.takeProfit) {
        this.closeAt(sym, px);
      }
    }
    this.account.equity = this.account.cash + unreal;
  }

  private applyPosition(i: OrderIntent, price: number): void {
    const p = this.account.positions.get(i.symbol) ?? {
      symbol: i.symbol,
      qty: 0,
      avgEntry: 0,
      realizedPnl: 0,
    };
    const signed = i.side === "BUY" ? i.qty : -i.qty;

    if (Math.sign(p.qty) === Math.sign(signed) || p.qty === 0) {
      const nq = p.qty + signed;
      p.avgEntry = nq === 0 ? 0 : (p.avgEntry * p.qty + price * signed) / nq;
      p.qty = nq;
    } else {
      const closed = Math.min(Math.abs(p.qty), Math.abs(signed));
      const pnl = (price - p.avgEntry) * closed * Math.sign(p.qty);
      p.realizedPnl += pnl;
      this.account.dailyPnl += pnl;
      p.qty += signed;
      if (Math.sign(p.qty) !== Math.sign(signed) && p.qty !== 0) {
        p.avgEntry = price;
      }
    }

    if (p.qty === 0) {
      this.account.positions.delete(i.symbol);
    } else {
      this.account.positions.set(i.symbol, p);
    }
  }

  private closeAt(sym: string, px: number): void {
    const p = this.account.positions.get(sym);
    if (!p) return;
    this.applyPosition({
      idempotencyKey: `auto:${sym}:${Date.now()}`,
      symbol: sym,
      side: "SELL",
      qty: p.qty,
      type: "MARKET",
    }, px);
  }

  private reject(i: OrderIntent, reason: string): Fill {
    const f: Fill = {
      idempotencyKey: i.idempotencyKey,
      status: "REJECTED",
      avgPrice: 0,
      filledQty: 0,
      fee: 0,
      ts: Date.now(),
      rejectReason: reason,
    };
    this.fills.set(i.idempotencyKey, f);
    return f;
  }
}
