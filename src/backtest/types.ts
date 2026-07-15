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
}

export interface Trade {
  entryIndex: number;
  exitIndex: number;
  entryPrice: number;
  exitPrice: number;
  direction: "long" | "short";
  returnPct: number; // net of fees
  exitReason: "stop" | "target" | "timeout" | "end-of-data";
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
}

export interface BacktestResult {
  trades: Trade[];
  metrics: BacktestMetrics;
  equityCurve: number[]; // cumulative return multiplier per trade, starting at 1
}
