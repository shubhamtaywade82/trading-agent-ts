import type { Config } from "../config/schema.js";
import type { Account, OrderIntent, Signal } from "../domain/types.js";

export interface RiskDecision {
  ok: boolean;
  intent?: OrderIntent;
  rejectReason?: string;
}

export class RiskManager {
  constructor(private readonly cfg: Config) {}

  decide(signal: Signal, account: Account, price: number, atr: number): RiskDecision {
    const r = this.cfg.risk;

    // Hard gate 1: daily loss circuit breaker
    if (-account.dailyPnl >= account.equity * (r.maxDailyLossPct / 100)) {
      return { ok: false, rejectReason: "daily_loss_limit" };
    }

    // Hard gate 2: too many open positions
    if (account.positions.size >= r.maxOpenPositions && signal.kind === "ENTRY") {
      return { ok: false, rejectReason: "max_positions" };
    }

    if (signal.kind === "EXIT") {
      return { ok: true, intent: this.exitIntent(signal, account) };
    }

    // ENTRY sizing
    const stopDistance = atr * r.defaultStopAtrMult;
    if (stopDistance <= 0) return { ok: false, rejectReason: "invalid_atr" };

    const riskBudget = account.equity * (r.riskPerTradePct / 100); // base currency units at risk
    let qty = Math.floor(riskBudget / stopDistance);
    const maxNotional = account.equity * (r.maxPositionPct / 100);
    qty = Math.min(qty, Math.floor(maxNotional / price));
    if (qty <= 0) return { ok: false, rejectReason: "size_zero" };

    const stopLoss = price - stopDistance;
    const takeProfit = price + stopDistance * r.defaultTakeProfitRR;

    return {
      ok: true,
      intent: {
        idempotencyKey: `${signal.id}:${signal.side}`, // prevents double fills
        symbol: signal.symbol,
        side: signal.side,
        qty,
        type: "MARKET",
        stopLoss,
        takeProfit,
      },
    };
  }

  private exitIntent(signal: Signal, account: Account): OrderIntent {
    const pos = account.positions.get(signal.symbol);
    return {
      idempotencyKey: `${signal.id}:${signal.side}`,
      symbol: signal.symbol,
      side: signal.side,
      qty: pos ? Math.abs(pos.qty) : 0,
      type: "MARKET",
    };
  }
}
