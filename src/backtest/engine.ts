import { Candle, StrategyConfig, Trade, BacktestResult, BacktestMetrics } from "./types.js";
import { buildIndicatorSeries, evaluateAll } from "./conditions.js";

const DEFAULT_MAX_HOLD_BARS = 200;
const DEFAULT_FEE_BPS = 10;

// Simple long-only-or-short-only event-driven backtest: scans candles in
// order, enters when all entry conditions agree, holds until stop, target,
// or maxHoldBars timeout. One position at a time (no pyramiding/overlap) —
// ponytail: add position sizing/overlap if a strategy genuinely needs it.
export function runBacktest(candles: Candle[], config: StrategyConfig): BacktestResult {
  const series = buildIndicatorSeries(candles, config.entry);
  const feeFraction = (config.feeBps ?? DEFAULT_FEE_BPS) / 10000;
  const maxHold = config.maxHoldBars ?? DEFAULT_MAX_HOLD_BARS;
  const trades: Trade[] = [];

  let i = 0;
  while (i < candles.length) {
    if (!evaluateAll(config.entry, series, i)) {
      i++;
      continue;
    }

    const entryIndex = i;
    const entryPrice = candles[entryIndex].close;
    const stopPrice = config.direction === "long" ? entryPrice * (1 - config.risk.stopPct) : entryPrice * (1 + config.risk.stopPct);
    const targetPrice = config.direction === "long" ? entryPrice * (1 + config.risk.targetPct) : entryPrice * (1 - config.risk.targetPct);

    let exitIndex = candles.length - 1;
    let exitPrice = candles[exitIndex].close;
    let exitReason: Trade["exitReason"] = "end-of-data";

    for (let j = entryIndex + 1; j < candles.length && j <= entryIndex + maxHold; j++) {
      const bar = candles[j];
      const hitStop = config.direction === "long" ? bar.low <= stopPrice : bar.high >= stopPrice;
      const hitTarget = config.direction === "long" ? bar.high >= targetPrice : bar.low <= targetPrice;

      // Conservative: if both stop and target are inside the same bar's
      // range, assume the worse outcome (stop) rather than guessing intrabar order.
      if (hitStop) {
        exitIndex = j;
        exitPrice = stopPrice;
        exitReason = "stop";
        break;
      }
      if (hitTarget) {
        exitIndex = j;
        exitPrice = targetPrice;
        exitReason = "target";
        break;
      }
      if (j === entryIndex + maxHold) {
        exitIndex = j;
        exitPrice = bar.close;
        exitReason = "timeout";
      }
    }

    const rawReturn = config.direction === "long" ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
    const returnPct = rawReturn - feeFraction;

    trades.push({ entryIndex, exitIndex, entryPrice, exitPrice, direction: config.direction, returnPct, exitReason });
    i = exitIndex + 1;
  }

  return { trades, metrics: computeMetrics(trades), equityCurve: computeEquityCurve(trades) };
}

export function computeEquityCurve(trades: Trade[]): number[] {
  let equity = 1;
  const curve: number[] = [];
  for (const t of trades) {
    equity *= 1 + t.returnPct;
    curve.push(equity);
  }
  return curve;
}

export function computeMetrics(trades: Trade[]): BacktestMetrics {
  if (trades.length === 0) {
    return { totalTrades: 0, winRate: 0, avgWinPct: 0, avgLossPct: 0, expectancyPct: 0, profitFactor: 0, totalReturnPct: 0, maxDrawdownPct: 0 };
  }

  const wins = trades.filter((t) => t.returnPct > 0);
  const losses = trades.filter((t) => t.returnPct <= 0);
  const winRate = wins.length / trades.length;
  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.returnPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((s, t) => s + t.returnPct, 0) / losses.length : 0;
  const expectancyPct = winRate * avgWinPct + (1 - winRate) * avgLossPct;

  const grossProfit = wins.reduce((s, t) => s + t.returnPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.returnPct, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const curve = computeEquityCurve(trades);
  const totalReturnPct = curve[curve.length - 1] - 1;

  let peak = 1;
  let maxDrawdownPct = 0;
  for (const equity of curve) {
    if (equity > peak) peak = equity;
    const drawdown = (peak - equity) / peak;
    if (drawdown > maxDrawdownPct) maxDrawdownPct = drawdown;
  }

  return { totalTrades: trades.length, winRate, avgWinPct, avgLossPct, expectancyPct, profitFactor, totalReturnPct, maxDrawdownPct };
}
