// Shared types for the Dhan paper exchange. These mirror the shapes
// `dhanhq-ts` exposes (NormalizedTick, InstrumentMetadata) so the exchange
// Can later be pointed at the real SDK without changing its own surface.

export type TransactionType = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "SL" | "SL-M";
export type OrderStatus = "PENDING" | "TRIGGER_PENDING" | "PART_TRADED" | "TRADED" | "CANCELLED" | "REJECTED";
export type InstrumentSegment = "EQUITY" | "FUTURES" | "OPTIONS";

export interface NormalizedTick {
  securityId: string;
  exchangeSegment: string;
  ltp: number;
  bestBid?: number;
  bestAsk?: number;
  timestamp: number; // Epoch ms
}

export interface InstrumentMetadata {
  securityId: string;
  exchangeSegment: string;
  tradingSymbol: string;
  lotSize: number;
  tickSize: number;
  segment: InstrumentSegment;
}

export interface OrderIntent {
  correlationId: string;
  strategyId: string;
  signalId: string;
  securityId: string;
  exchangeSegment: string;
  transactionType: TransactionType;
  orderType: OrderType;
  quantity: number;
  price?: number;
  triggerPrice?: number;
}

export interface PaperOrder extends OrderIntent {
  orderId: string;
  status: OrderStatus;
  filledQty: number;
  avgFillPrice: number;
  createdAt: number;
}

export interface FeeBreakdown {
  brokerage: number;
  stt: number;
  exchangeTxnCharges: number;
  sebiTurnoverFee: number;
  stampDuty: number;
  gst: number;
  total: number;
}

export interface FillEvent {
  orderId: string;
  correlationId: string;
  strategyId: string;
  securityId: string;
  exchangeSegment: string;
  transactionType: TransactionType;
  fillQty: number;
  fillPrice: number;
  fees: FeeBreakdown;
  timestamp: number;
}
