import type { Candle } from "../backtest/types.js";

// Canonical types for the Binance pipeline (src/exchange/binance,
// Src/market-state, and later phases per
// Docs/superpowers/specs/2026-08-02-binance-pipeline-architecture-design.md).
// Candle stays the one OHLCV shape everywhere -- this file extends it, never
// Redefines it.

export type Timeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" | "1w";

export interface FuturesCandle extends Candle {
  closeTime: number;
}

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";
export type TimeInForce = "GTC" | "IOC" | "FOK" | "GTX";

export interface OrderParams {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  stopPrice?: number;
  timeInForce?: TimeInForce;
  reduceOnly?: boolean;
  closePosition?: boolean;
  newClientOrderId?: string;
}

export interface OrderResult {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  status: string;
  side: string;
  type: string;
  avgPrice: number;
  origQty: number;
  executedQty: number;
}

export interface FuturesTicker {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  lastFundingRate: number;
  nextFundingTime: number;
}

export interface OpenInterest {
  symbol: string;
  openInterest: number;
  time: number;
}

export interface FundingRateEntry {
  symbol: string;
  fundingRate: number;
  fundingTime: number;
}

export interface PositionRisk {
  symbol: string;
  positionAmt: number; // Signed: + long, - short
  entryPrice: number;
  markPrice: number;
  unrealizedProfit: number;
  liquidationPrice: number;
  leverage: number;
  positionSide: string;
}
