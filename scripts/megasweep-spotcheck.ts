import { fetchCandlesRange, runFuturesBacktest } from "../src/tools/backtest-tools.js";

// Spot-checking the flashiest mega-sweep.ts claim: XRP "Liq Sweep + Ichimoku 2h"
// confluence, claimed 95% WR, Sharpe 137.6, 19 trades, stop=3% target=6%.
const endTime = Date.now();
const startTime = endTime - 365 * 24 * 60 * 60 * 1000;
const fetched = await fetchCandlesRange("XRPUSDT", "2h", startTime, endTime);
if ("error" in fetched) throw new Error(fetched.message);
const candles = fetched.candles;
const mid = Math.floor(candles.length / 2);

const entry = [{ type: "bearish_liq_sweep" }, { type: "ichimoku_bearish_breakout" }];
const full: any = runFuturesBacktest(candles, entry, "short", 0.03, 0.06, 5, 48, 10000, 10, 0.10, 3);
const h1: any = runFuturesBacktest(candles.slice(0, mid), entry, "short", 0.03, 0.06, 5, 48, 10000, 10, 0.10, 3);
const h2: any = runFuturesBacktest(candles.slice(mid), entry, "short", 0.03, 0.06, 5, 48, 10000, 10, 0.10, 3);

console.log("Claimed (mega-sweep.ts, no split-sample, best-of-grid on full window): 19 trades, 95% WR, Sharpe 137.6, PnL $3,725");
console.log(`Real engine (runFuturesBacktest, same params): trades=${full.metrics.totalTrades} WR=${(full.metrics.winRate*100).toFixed(0)}% sharpe=${full.metrics.sharpeRatio.toFixed(1)} pnl=$${Math.round(full.metrics.totalPnlUsd)} maxDD=${(full.metrics.maxDrawdownPct*100).toFixed(1)}%`);
console.log(`  H1: trades=${h1.metrics.totalTrades} pnl=$${Math.round(h1.metrics.totalPnlUsd)}  |  H2: trades=${h2.metrics.totalTrades} pnl=$${Math.round(h2.metrics.totalPnlUsd)}`);
