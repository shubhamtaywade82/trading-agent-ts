import { fetchCandlesRange, runFuturesBacktest } from "../src/tools/backtest-tools.js";
import { writeFileSync } from "fs";

// Re-verifies every claim in docs/FINAL-REPORT.md against the REAL engine
// (runFuturesBacktest — SMC/LuxAlgo/volume signals all wired in already),
// using the SAME 3-fold walk-forward window definition FINAL-REPORT claims
// to have used (test on 50-67%, 60-77%, 70-87% of a 2yr window), but with
// the exact (tf, stop, target) FINAL-REPORT claims as the fixed strategy —
// no re-optimization, this checks reproducibility of the claim as stated.
const LEVERAGE = 10, MARGIN_PCT = 0.10, SLIPPAGE_BPS = 3, FEE_BPS = 5, INITIAL_CAPITAL = 10000;
const DAYS = 730;

const CLAIMS = [
  // XRP
  { symbol: "XRPUSDT", label: "ADX-DI Cross Short", tf: "30m", entry: [{ type: "adx_di_cross_short", value: 20 }], stopPct: 0.02, targetPct: 0.06, direction: "short", claimed: { trades: 127, wr: 0.56, sharpe: 27.2, oosPnl: 3590, maxDD: 0.12 } },
  { symbol: "XRPUSDT", label: "Liq Sweep Short", tf: "2h", entry: [{ type: "bearish_liq_sweep" }], stopPct: 0.02, targetPct: 0.06, direction: "short", claimed: { trades: 37, wr: 0.89, sharpe: 94.7, oosPnl: 2820, maxDD: 0.04 } },
  { symbol: "XRPUSDT", label: "Liq Sweep Short", tf: "1h", entry: [{ type: "bearish_liq_sweep" }], stopPct: 0.01, targetPct: 0.03, direction: "short", claimed: { trades: 70, wr: 0.69, sharpe: 58.0, oosPnl: 2379, maxDD: 0.03 } },
  { symbol: "XRPUSDT", label: "Bearish FVG Short", tf: "1h", entry: [{ type: "bearish_fvg" }], stopPct: 0.02, targetPct: 0.06, direction: "short", claimed: { trades: 200, wr: 0.52, sharpe: 16.9, oosPnl: 2405, maxDD: 0.21 } },
  { symbol: "XRPUSDT", label: "Ichimoku Below Cloud Short", tf: "4h", entry: [{ type: "ichimoku_below_cloud_short" }], stopPct: 0.01, targetPct: 0.03, direction: "short", claimed: { trades: 188, wr: 0.45, sharpe: 19.1, oosPnl: 1193, maxDD: 0.25 } },
  { symbol: "XRPUSDT", label: "SuperTrend Flip Short", tf: "1d", entry: [{ type: "supertrend_bearish_flip" }], stopPct: 0.05, targetPct: 0.10, direction: "short", claimed: { trades: 30, wr: 0.73, sharpe: 65.0, oosPnl: 353, maxDD: 0.18 } },
  { symbol: "XRPUSDT", label: "Volume Spike Short", tf: "4h", entry: [{ type: "volume_spike_short" }], stopPct: 0.03, targetPct: 0.06, direction: "short", claimed: { trades: 16, wr: 0.63, sharpe: 48.7, oosPnl: 106, maxDD: 0.08 } },
  // ETH
  { symbol: "ETHUSDT", label: "Volume Spike Short", tf: "1d", entry: [{ type: "volume_spike_short" }], stopPct: 0.03, targetPct: 0.05, direction: "short", claimed: { trades: 38, wr: 0.74, sharpe: 41.9, oosPnl: 1846, maxDD: 0.12 } },
  { symbol: "ETHUSDT", label: "SuperTrend Flip Short", tf: "1d", entry: [{ type: "supertrend_bearish_flip" }], stopPct: 0.01, targetPct: 0.03, direction: "short", claimed: { trades: 30, wr: 0.70, sharpe: 53.1, oosPnl: 718, maxDD: 0.03 } },
  { symbol: "ETHUSDT", label: "Liq Sweep Short", tf: "2h", entry: [{ type: "bearish_liq_sweep" }], stopPct: 0.01, targetPct: 0.03, direction: "short", claimed: { trades: 44, wr: 0.59, sharpe: 45.3, oosPnl: 679, maxDD: 0.02 } },
  { symbol: "ETHUSDT", label: "Volume Spike Short", tf: "4h", entry: [{ type: "volume_spike_short" }], stopPct: 0.01, targetPct: 0.03, direction: "short", claimed: { trades: 22, wr: 0.77, sharpe: 52.0, oosPnl: 624, maxDD: 0.08 } },
  // SOL
  { symbol: "SOLUSDT", label: "Ichimoku Below Cloud Short", tf: "4h", entry: [{ type: "ichimoku_below_cloud_short" }], stopPct: 0.03, targetPct: 0.06, direction: "short", claimed: { trades: 268, wr: 0.41, sharpe: 11.3, oosPnl: 1336, maxDD: 0.27 } },
  { symbol: "SOLUSDT", label: "ADX-DI Cross Short", tf: "4h", entry: [{ type: "adx_di_cross_short", value: 20 }], stopPct: 0.03, targetPct: 0.05, direction: "short", claimed: { trades: 56, wr: 0.64, sharpe: 24.2, oosPnl: 1247, maxDD: 0.12 } },
  { symbol: "SOLUSDT", label: "Volume Spike Short", tf: "1d", entry: [{ type: "volume_spike_short" }], stopPct: 0.01, targetPct: 0.03, direction: "short", claimed: { trades: 33, wr: 0.64, sharpe: 56.5, oosPnl: 906, maxDD: 0.06 } },
  { symbol: "SOLUSDT", label: "Liq Sweep Short", tf: "2h", entry: [{ type: "bearish_liq_sweep" }], stopPct: 0.03, targetPct: 0.05, direction: "short", claimed: { trades: 32, wr: 0.72, sharpe: 75.6, oosPnl: 181, maxDD: 0.02 } },
];

function maxHold(tf: string) {
  if (["5m", "15m", "30m", "1h"].includes(tf)) return 48;
  if (tf === "2h") return 36;
  if (tf === "4h") return 24;
  return 20;
}

const out: any[] = [];

for (const c of CLAIMS) {
  const endTime = Date.now();
  const startTime = endTime - DAYS * 24 * 60 * 60 * 1000;
  const fetched = await fetchCandlesRange(c.symbol, c.tf, startTime, endTime);
  if ("error" in fetched) { console.log(`${c.symbol} ${c.tf}: FETCH ERROR`); continue; }
  const candles = fetched.candles;
  const n = candles.length;
  const mh = maxHold(c.tf);

  // Full-window real-engine result (apples-to-apples with the claimed WR/Sharpe/trades)
  const full: any = runFuturesBacktest(candles, c.entry, c.direction as any, c.stopPct, c.targetPct, FEE_BPS, mh, INITIAL_CAPITAL, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS);

  // Same 3-fold OOS windows FINAL-REPORT claims to have used
  const splits = [[0.50, 0.67], [0.60, 0.77], [0.70, 0.87]];
  const foldResults: any[] = [];
  for (const [s, e] of splits) {
    const testStart = Math.floor(n * s), testEnd = Math.floor(n * e);
    if (testEnd - testStart < 10) continue;
    const testData = candles.slice(testStart, testEnd);
    const r: any = runFuturesBacktest(testData, c.entry, c.direction as any, c.stopPct, c.targetPct, FEE_BPS, mh, INITIAL_CAPITAL, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS);
    foldResults.push({ trades: r.metrics.totalTrades, pnl: Math.round(r.metrics.totalPnlUsd), sharpe: Number(r.metrics.sharpeRatio.toFixed(1)) });
  }
  const posWindows = foldResults.filter(f => f.pnl > 0).length;
  const totalOOS = foldResults.reduce((s, f) => s + f.pnl, 0);
  const survived = posWindows >= 2 && foldResults.length >= 2 && totalOOS > 0;

  const m = full.metrics;
  console.log(`\n${c.symbol} ${c.label} @ ${c.tf} (stop=${(c.stopPct*100)}% target=${(c.targetPct*100)}%):`);
  console.log(`  CLAIMED: trades/yr=${c.claimed.trades} WR=${(c.claimed.wr*100).toFixed(0)}% sharpe=${c.claimed.sharpe} OOS_pnl/yr=$${c.claimed.oosPnl} maxDD=${(c.claimed.maxDD*100).toFixed(0)}%`);
  console.log(`  REAL ENGINE (2yr full window): trades=${m.totalTrades} WR=${(m.winRate*100).toFixed(0)}% sharpe=${m.sharpeRatio.toFixed(1)} pnl=$${Math.round(m.totalPnlUsd)} maxDD=${(m.maxDrawdownPct*100).toFixed(0)}%`);
  console.log(`  REAL ENGINE 3-fold OOS: ${foldResults.map(f => `[${f.trades}tr $${f.pnl} SR${f.sharpe}]`).join(" ")}  -> ${posWindows}/${foldResults.length} positive, total OOS $${totalOOS}  ${survived ? "SURVIVES" : "FAILS"}`);

  out.push({ ...c, real: { full: { trades: m.totalTrades, wr: m.winRate, sharpe: m.sharpeRatio, pnl: m.totalPnlUsd, maxDD: m.maxDrawdownPct }, folds: foldResults, posWindows, totalOOS, survived } });
}

writeFileSync("scripts/final-report-verify-output.json", JSON.stringify(out, null, 2));
console.log("\nWrote scripts/final-report-verify-output.json");
