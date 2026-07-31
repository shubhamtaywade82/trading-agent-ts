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
  takeProfitPct: 0.04, // Initial 1-5% scalp target range default
  commissionRatePct: 0.0005,
  maxMarginUtilizationPct: 0.5,
  leverage: 10,
};

export interface AdaptiveTargetMilestones {
  scalpTargetPct: number;    // 0.01 - 0.05 (1% to 5%)
  intradayTargetPct: number; // 0.10 (10%)
  swingTargetPct: number;    // 0.20 (20%)
}

export const DEFAULT_ADAPTIVE_TARGETS: AdaptiveTargetMilestones = {
  scalpTargetPct: 0.03,    // 3% default scalp target (1-5% range)
  intradayTargetPct: 0.10, // 10% intraday target
  swingTargetPct: 0.20,    // 20% swing target
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
