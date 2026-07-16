import { BinanceFuturesBacktestTool } from "../src/tools/backtest-tools.js";
import { readFileSync } from "fs";

const verified = JSON.parse(readFileSync("scripts/reverify-output.json", "utf-8"));
const tool = new BinanceFuturesBacktestTool();
const endTime = Date.now();
const startTime = endTime - 365 * 24 * 60 * 60 * 1000;

// Realistic day-trader sizing: 5% of capital as margin, 5x leverage —
// ~25% notional exposure per trade, survivable string of losses.
const MARGIN_PCT = 0.05;
const LEVERAGE = 5;
const SLIPPAGE_BPS = 3;

for (const [sym, strats] of Object.entries(verified.symbols) as [string, any[]][]) {
  for (const s of strats) {
    if (s.verdict !== "SURVIVES") continue;
    const r: any = await tool.call({
      symbol: sym, interval: "1h", direction: s.direction, entry: s.entry,
      stopPct: s.risk.stopPct, targetPct: s.risk.targetPct, feeBps: 5, maxHoldBars: 48,
      initialCapital: 10000, leverage: LEVERAGE, marginPerTradePct: MARGIN_PCT,
      startTime, endTime, slippageBps: SLIPPAGE_BPS,
    });
    console.log(`${sym} ${s.label}: trades=${r.totalTrades} WR=${(r.winRate*100).toFixed(0)}% PF=${r.profitFactor?.toFixed(2)} sharpe=${r.sharpeRatio?.toFixed(1)} pnl=$${Math.round(r.totalPnlUsd)} return=${(r.totalReturnPct*100).toFixed(1)}% maxDD=${(r.maxDrawdownPct*100).toFixed(1)}%`);
  }
}
