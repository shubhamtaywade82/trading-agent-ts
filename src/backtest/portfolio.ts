import { Candle, StrategyConfig, Trade, BacktestMetrics } from "./types.js";
import { runBacktest, computeMetrics } from "./engine.js";

export interface PortfolioConfig {
  initialCapital?: number;
  maxConcurrentPositions?: number;
  allocationPerTradePct?: number; // fraction, e.g. 0.10 for 10%
  strategy: StrategyConfig;
}

export interface PortfolioResult {
  trades: Trade[];
  metrics: BacktestMetrics;
  equityCurve: number[]; // capital balance over time
  initialCapital: number;
  finalCapital: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
}

/**
 * Runs a chronological portfolio-level backtest across multiple symbols.
 * Combines candidate trades chronologically, respecting capital constraints and position sizing.
 */
export function runPortfolioBacktest(
  symbolsData: Record<string, Candle[]>,
  config: PortfolioConfig
): PortfolioResult {
  const initialCapital = config.initialCapital ?? 10000;
  const maxPositions = config.maxConcurrentPositions ?? 5;
  const allocationPct = config.allocationPerTradePct ?? 0.10;
  const strategy = config.strategy;

  // 1. Generate candidate trades for each symbol
  let candidates: Trade[] = [];
  for (const [symbol, candles] of Object.entries(symbolsData)) {
    // Add symbol to strategy config if needed
    const symbolConfig = { ...strategy, symbol };
    const singleResult = runBacktest(candles, symbolConfig);
    // Add symbol tag to candidates
    const taggedTrades = singleResult.trades.map((t) => ({
      ...t,
      symbol,
    }));
    candidates = candidates.concat(taggedTrades);
  }

  // 2. Sort candidates chronologically by entryTime
  candidates.sort((a, b) => {
    const aTime = a.entryTime ?? 0;
    const bTime = b.entryTime ?? 0;
    return aTime - bTime;
  });

  // 3. Chronological simulation
  let currentCapital = initialCapital;
  let peakCapital = initialCapital;
  let maxDrawdownPct = 0;

  const activePositions: Array<{
    trade: Trade;
    allocatedCapital: number;
    exitTime: number;
  }> = [];

  const executedTrades: Trade[] = [];
  const equityCurve: number[] = [initialCapital];

  const updateDrawdown = (cap: number) => {
    if (cap > peakCapital) peakCapital = cap;
    const dd = (peakCapital - cap) / peakCapital;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  };

  for (const candidate of candidates) {
    const entryTime = candidate.entryTime ?? 0;

    // A. Close positions whose exitTime is <= entryTime of current candidate
    // Process them in order of exitTime
    activePositions.sort((a, b) => a.exitTime - b.exitTime);
    
    let p = 0;
    while (p < activePositions.length) {
      const pos = activePositions[p];
      if (pos.exitTime <= entryTime) {
        const returnVal = pos.allocatedCapital * (1 + pos.trade.returnPct);
        const profit = returnVal - pos.allocatedCapital;
        
        pos.trade.allocatedCapital = pos.allocatedCapital;
        pos.trade.realizedProfit = profit;
        
        currentCapital += returnVal;
        executedTrades.push(pos.trade);
        equityCurve.push(currentCapital);
        updateDrawdown(currentCapital);
        
        activePositions.splice(p, 1);
      } else {
        p++;
      }
    }

    // B. Check if we have capacity to open this position
    const alreadyHoldingSymbol = activePositions.some((p) => p.trade.symbol === candidate.symbol);
    if (activePositions.length < maxPositions && !alreadyHoldingSymbol) {
      const allocation = currentCapital * allocationPct;
      if (allocation <= currentCapital && allocation > 0) {
        currentCapital -= allocation;
        activePositions.push({
          trade: candidate,
          allocatedCapital: allocation,
          exitTime: candidate.exitTime ?? 0,
        });
      }
    }
  }

  // C. Close any remaining open positions at the end of the simulation
  activePositions.sort((a, b) => a.exitTime - b.exitTime);
  for (const pos of activePositions) {
    const returnVal = pos.allocatedCapital * (1 + pos.trade.returnPct);
    const profit = returnVal - pos.allocatedCapital;

    pos.trade.allocatedCapital = pos.allocatedCapital;
    pos.trade.realizedProfit = profit;

    currentCapital += returnVal;
    executedTrades.push(pos.trade);
    equityCurve.push(currentCapital);
    updateDrawdown(currentCapital);
  }

  // 4. Compute metrics based on executed trades
  const baseMetrics = computeMetrics(executedTrades);

  // Override totalReturnPct and maxDrawdownPct with portfolio-level capital metrics
  const portfolioReturnPct = (currentCapital - initialCapital) / initialCapital;

  const metrics: BacktestMetrics = {
    ...baseMetrics,
    totalReturnPct: portfolioReturnPct,
    maxDrawdownPct,
    calmarRatio: maxDrawdownPct > 0 ? portfolioReturnPct / maxDrawdownPct : 0,
  };

  return {
    trades: executedTrades,
    metrics,
    equityCurve,
    initialCapital,
    finalCapital: currentCapital,
    totalReturnPct: portfolioReturnPct,
    maxDrawdownPct,
  };
}
