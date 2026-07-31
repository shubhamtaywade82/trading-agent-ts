export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function parseKlineRows(rows: unknown[][]): Candle[] {
  return rows.map((row) => ({
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  }));
}

export type ConditionType =
  | "rsi_below" | "rsi_above"
  | "price_above_sma" | "price_below_sma"
  | "price_above_ema" | "price_below_ema"
  | "macd_bullish_cross" | "macd_bearish_cross"
  | "bollinger_touch_lower" | "bollinger_touch_upper";

export interface Condition {
  type: ConditionType;
  period?: number;
  value?: number;
}

export interface RiskModel {
  stopPct: number;
  targetPct: number;
}

export interface StrategyConfig {
  direction: "long" | "short";
  entry: Condition[];
  risk: RiskModel;
  feeBps?: number; // Round-trip fee, basis points of notional (default 10 = 0.1%)
  maxHoldBars?: number; // Force-exit after N candles if neither stop nor target hit (default 200)
  symbol?: string; // Symbol name
}

export interface Trade {
  entryIndex: number;
  exitIndex: number;
  entryPrice: number;
  exitPrice: number;
  direction: "long" | "short";
  returnPct: number; // Net of fees
  exitReason: "stop" | "target" | "timeout" | "end-of-data";
  entryTime?: number; // Millisecond timestamp
  exitTime?: number;  // Millisecond timestamp
  symbol?: string;    // Symbol traded
  allocatedCapital?: number; // Capital allocated in portfolio context
  realizedProfit?: number; // Realized profit in currency in portfolio context
}

export interface BacktestMetrics {
  totalTrades: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  expectancyPct: number;
  profitFactor: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  
  // Intraday & Swing specific metrics
  avgDurationBars?: number;           // Average hold time in bars
  avgDurationMs?: number;             // Average hold time in milliseconds
  sharpeRatio?: number;              // Sharpe Ratio (trade-based)
  sortinoRatio?: number;             // Sortino Ratio (trade-based)
  calmarRatio?: number;              // Calmar Ratio (trade-based)
  maxConsecutiveWins?: number;
  maxConsecutiveLosses?: number;
  profitToLossRatio?: number;        // Avg win / avg loss
  winRateByHour?: Record<number, number>; // Hourly win rate distribution
  totalPnlUsd?: number;              // PnL in USD (optional)
}

export interface BacktestResult {
  trades: Trade[];
  metrics: BacktestMetrics;
  equityCurve: number[]; // Cumulative return multiplier per trade, starting at 1
}
