import { fetchCandlesRange, runFuturesBacktest } from "../src/tools/backtest-tools.js";

const LEVERAGE = 5, MARGIN_PCT = 0.05, SLIPPAGE_BPS = 3, FEE_BPS = 5, INITIAL_CAPITAL = 10000, DAYS = 730;

// Only the strategies that passed BOTH full-window-positive AND >=2/3 OOS-positive
// on the real engine (scripts/final-report-verify.ts), re-checked at realistic sizing.
const SURVIVORS = [
  { symbol: "XRPUSDT", label: "Liq Sweep Short", tf: "2h", entry: [{ type: "bearish_liq_sweep" }], stopPct: 0.02, targetPct: 0.06, direction: "short" },
  { symbol: "XRPUSDT", label: "Liq Sweep Short", tf: "1h", entry: [{ type: "bearish_liq_sweep" }], stopPct: 0.01, targetPct: 0.03, direction: "short" },
  { symbol: "XRPUSDT", label: "Bearish FVG Short", tf: "1h", entry: [{ type: "bearish_fvg" }], stopPct: 0.02, targetPct: 0.06, direction: "short" },
  { symbol: "XRPUSDT", label: "ADX-DI Cross Short", tf: "30m", entry: [{ type: "adx_di_cross_short", value: 20 }], stopPct: 0.02, targetPct: 0.06, direction: "short" },
  { symbol: "ETHUSDT", label: "Liq Sweep Short", tf: "2h", entry: [{ type: "bearish_liq_sweep" }], stopPct: 0.01, targetPct: 0.03, direction: "short" },
  { symbol: "SOLUSDT", label: "Ichimoku Below Cloud Short", tf: "4h", entry: [{ type: "ichimoku_below_cloud_short" }], stopPct: 0.03, targetPct: 0.06, direction: "short" },
  { symbol: "SOLUSDT", label: "Liq Sweep Short", tf: "2h", entry: [{ type: "bearish_liq_sweep" }], stopPct: 0.03, targetPct: 0.05, direction: "short" },
];

function maxHold(tf: string) {
  if (["5m", "15m", "30m", "1h"].includes(tf)) return 48;
  if (tf === "2h") return 36;
  if (tf === "4h") return 24;
  return 20;
}

for (const s of SURVIVORS) {
  const endTime = Date.now();
  const startTime = endTime - DAYS * 24 * 60 * 60 * 1000;
  const fetched = await fetchCandlesRange(s.symbol, s.tf, startTime, endTime);
  if ("error" in fetched) { console.log(`${s.symbol} ${s.tf}: FETCH ERROR`); continue; }
  const candles = fetched.candles;
  const n = candles.length;
  const mh = maxHold(s.tf);

  const full: any = runFuturesBacktest(candles, s.entry, s.direction as any, s.stopPct, s.targetPct, FEE_BPS, mh, INITIAL_CAPITAL, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS);
  const splits = [[0.50, 0.67], [0.60, 0.77], [0.70, 0.87]];
  const folds: any[] = [];
  for (const [a, b] of splits) {
    const testData = candles.slice(Math.floor(n * a), Math.floor(n * b));
    const r: any = runFuturesBacktest(testData, s.entry, s.direction as any, s.stopPct, s.targetPct, FEE_BPS, mh, INITIAL_CAPITAL, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS);
    folds.push({ trades: r.metrics.totalTrades, pnl: Math.round(r.metrics.totalPnlUsd) });
  }
  const m = full.metrics;
  // Annualize: full window is 2yr, so /2 for per-year figures
  console.log(`${s.symbol} ${s.label} @ ${s.tf} (stop=${(s.stopPct*100)}% target=${(s.targetPct*100)}%) [realistic 5x/5%]:`);
  console.log(`  2yr full: trades=${m.totalTrades} WR=${(m.winRate*100).toFixed(0)}% PF=${m.profitFactor.toFixed(2)} sharpe=${m.sharpeRatio.toFixed(1)} pnl=$${Math.round(m.totalPnlUsd)} (~$${Math.round(m.totalPnlUsd/2)}/yr) maxDD=${(m.maxDrawdownPct*100).toFixed(1)}%`);
  console.log(`  OOS folds: ${folds.map(f => `[${f.trades}tr $${f.pnl}]`).join(" ")}\n`);
}
