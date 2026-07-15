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
  feeBps?: number; // round-trip fee, basis points of notional (default 10 = 0.1%)
  maxHoldBars?: number; // force-exit after N candles if neither stop nor target hit (default 200)
  symbol?: string; // symbol name
}

export interface Trade {
  entryIndex: number;
  exitIndex: number;
  entryPrice: number;
  exitPrice: number;
  direction: "long" | "short";
  returnPct: number; // net of fees
  exitReason: "stop" | "target" | "timeout" | "end-of-data";
  entryTime?: number; // millisecond timestamp
  exitTime?: number;  // millisecond timestamp
  symbol?: string;    // symbol traded
  allocatedCapital?: number; // capital allocated in portfolio context
  realizedProfit?: number; // realized profit in currency in portfolio context
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
  avgDurationBars?: number;           // average hold time in bars
  avgDurationMs?: number;             // average hold time in milliseconds
  sharpeRatio?: number;              // Sharpe Ratio (trade-based)
  sortinoRatio?: number;             // Sortino Ratio (trade-based)
  calmarRatio?: number;              // Calmar Ratio (trade-based)
  maxConsecutiveWins?: number;
  maxConsecutiveLosses?: number;
  profitToLossRatio?: number;        // avg win / avg loss
  winRateByHour?: Record<number, number>; // hourly win rate distribution
  totalPnlUsd?: number;              // PnL in USD (optional)
}

export interface BacktestResult {
  trades: Trade[];
  metrics: BacktestMetrics;
  equityCurve: number[]; // cumulative return multiplier per trade, starting at 1
}
