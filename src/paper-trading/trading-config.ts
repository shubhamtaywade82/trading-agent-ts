export interface TradingConfig {
  initialCapital: number;
  riskPercentageOfCapital: number;
  stopLossPct: number;
  takeProfitPct: number;
  commissionRatePct: number;
  maxMarginUtilizationPct: number;
  leverage: number;
}

export const DEFAULT_TRADING_CONFIG: TradingConfig = {
  initialCapital: 10_000,
  riskPercentageOfCapital: 0.015,
  stopLossPct: 0.02,
  takeProfitPct: 0.04,
  commissionRatePct: 0.0005,
  maxMarginUtilizationPct: 0.5,
  leverage: 10,
};

export function validateTradingConfig(config: Partial<TradingConfig>): TradingConfig {
  const merged: TradingConfig = { ...DEFAULT_TRADING_CONFIG, ...config };
  if (merged.initialCapital <= 0) {
    throw new Error("initialCapital must be positive");
  }
  if (merged.riskPercentageOfCapital <= 0 || merged.riskPercentageOfCapital > 1) {
    throw new Error("riskPercentageOfCapital must be between 0 and 1");
  }
  if (merged.stopLossPct <= 0) {
    throw new Error("stopLossPct must be positive");
  }
  if (merged.leverage < 1) {
    throw new Error("leverage must be at least 1");
  }
  return merged;
}

// Calculate position quantity based on risk percentage of capital
export function calculatePositionQuantity(
  config: TradingConfig,
  currentEquity: number,
  entryPrice: number,
  stopLossPctOverride?: number,
): number {
  if (currentEquity <= 0 || entryPrice <= 0) return 0;

  const stopPct = stopLossPctOverride ?? config.stopLossPct;
  const riskAmount = currentEquity * config.riskPercentageOfCapital;
  
  // Loss per unit = entryPrice * stopLossPct
  const lossPerUnit = entryPrice * stopPct;
  if (lossPerUnit <= 0) return 0;

  const rawQty = riskAmount / lossPerUnit;
  
  // Cap max position size by leverage and max margin utilization
  const maxNotional = currentEquity * config.leverage * config.maxMarginUtilizationPct;
  const maxQty = maxNotional / entryPrice;

  return Math.min(rawQty, maxQty);
}
