export type Side = "BUY" | "SELL";

export interface MarketBar {
  symbol: string;
  ts: number; // epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  atr?: number; // precomputed by data feed
}

export type SignalKind = "ENTRY" | "EXIT";

export interface Signal {
  id: string;
  symbol: string;
  side: Side;
  kind: SignalKind;
  reason: string; // rule audit details
  strength: number; // 0..1
  ts: number;
  meta?: Record<string, number>;
}

export interface OrderIntent {
  idempotencyKey: string;
  symbol: string;
  side: Side;
  qty: number;
  type: "MARKET" | "LIMIT";
  limitPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
}

export type OrderStatus = "PENDING" | "FILLED" | "PARTIAL" | "CANCELED" | "REJECTED";

export interface Fill {
  idempotencyKey: string;
  status: OrderStatus;
  avgPrice: number;
  filledQty: number;
  fee: number;
  ts: number;
  rejectReason?: string;
}

export interface Position {
  symbol: string;
  qty: number; // signed: + long, - short
  avgEntry: number;
  stopLoss?: number;
  takeProfit?: number;
  realizedPnl: number;
}

export interface Account {
  cash: number;
  equity: number; // cash + sum(unrealized)
  positions: Map<string, Position>;
  dailyPnl: number;
}
