import { BinanceFuturesBacktestTool } from "../src/tools/backtest-tools.js";

const tool = new BinanceFuturesBacktestTool();
const endTime = Date.now();
const startTime = endTime - 365 * 24 * 60 * 60 * 1000;

const r: any = await tool.call({
  symbol: "XRPUSDT", interval: "1h", direction: "short",
  entry: [{ type: "ichimoku_bearish_breakout" }],
  stopPct: 0.02, targetPct: 0.04, feeBps: 5, maxHoldBars: 48,
  initialCapital: 10000, leverage: 5, marginPerTradePct: 0.05,
  startTime, endTime, slippageBps: 3,
});
console.log(`XRP Ichimoku Bearish Breakout Short: trades=${r.totalTrades} WR=${(r.winRate*100).toFixed(0)}% PF=${r.profitFactor?.toFixed(2)} sharpe=${r.sharpeRatio?.toFixed(1)} pnl=$${Math.round(r.totalPnlUsd)} return=${(r.totalReturnPct*100).toFixed(1)}% maxDD=${(r.maxDrawdownPct*100).toFixed(1)}%`);
