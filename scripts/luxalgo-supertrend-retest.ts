import { BinanceFuturesBacktestTool } from "../src/tools/backtest-tools.js";

const tool = new BinanceFuturesBacktestTool();
const endTime = Date.now();
const startTime = endTime - 365 * 24 * 60 * 60 * 1000;
const mid = startTime + (endTime - startTime) / 2;
const SLIPPAGE_BPS = 3;
const SYMBOLS = ["XRPUSDT", "ETHUSDT", "SOLUSDT"];
const CANDIDATES = [
  { label: "SuperTrend Bullish Flip Long", direction: "long", entry: [{ type: "supertrend_bullish_flip" }], stopPct: 0.02, targetPct: 0.04 },
  { label: "SuperTrend Bearish Flip Short", direction: "short", entry: [{ type: "supertrend_bearish_flip" }], stopPct: 0.02, targetPct: 0.04 },
];

for (const sym of SYMBOLS) {
  console.log(`\n=== ${sym} ===`);
  for (const c of CANDIDATES) {
    const [full, h1, h2]: any[] = await Promise.all([
      tool.call({ symbol: sym, interval: "1h", direction: c.direction, entry: c.entry, stopPct: c.stopPct, targetPct: c.targetPct, feeBps: 5, maxHoldBars: 48, initialCapital: 10000, leverage: 10, marginPerTradePct: 0.5, startTime, endTime, slippageBps: SLIPPAGE_BPS }),
      tool.call({ symbol: sym, interval: "1h", direction: c.direction, entry: c.entry, stopPct: c.stopPct, targetPct: c.targetPct, feeBps: 5, maxHoldBars: 48, initialCapital: 10000, leverage: 10, marginPerTradePct: 0.5, startTime, endTime: mid, slippageBps: SLIPPAGE_BPS }),
      tool.call({ symbol: sym, interval: "1h", direction: c.direction, entry: c.entry, stopPct: c.stopPct, targetPct: c.targetPct, feeBps: 5, maxHoldBars: 48, initialCapital: 10000, leverage: 10, marginPerTradePct: 0.5, startTime: mid, endTime, slippageBps: SLIPPAGE_BPS }),
    ]);
    if (full.error) { console.log(`  ${c.label}: ERROR ${full.message}`); continue; }
    const bothHalvesPositive = (h1.totalPnlUsd ?? 0) > 0 && (h2.totalPnlUsd ?? 0) > 0;
    const verdict = full.totalTrades < 20 ? "LOW_SAMPLE" : !bothHalvesPositive ? "REGIME_FRAGILE" : "SURVIVES";
    console.log(`  ${c.label}: trades=${full.totalTrades} WR=${(full.winRate*100).toFixed(0)}% PF=${full.profitFactor?.toFixed(2)} sharpe=${full.sharpeRatio?.toFixed(1)} pnl=$${Math.round(full.totalPnlUsd)} maxDD=${(full.maxDrawdownPct*100).toFixed(1)}%  [H1 $${Math.round(h1.totalPnlUsd)} n=${h1.totalTrades} | H2 $${Math.round(h2.totalPnlUsd)} n=${h2.totalTrades}] -> ${verdict}`);
  }
}
