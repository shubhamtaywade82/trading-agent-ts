import type { Account, Fill, OrderIntent } from "../domain/types.js";

export interface IBrokerage {
  getAccount(): Account;
  submit(intent: OrderIntent): Promise<Fill>; // idempotent
  cancel(idempotencyKey: string): Promise<boolean>;
  markToMarket(prices: Map<string, number>): void; // update equity/unrealized PnL
}
