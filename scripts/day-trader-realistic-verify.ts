import { fetchCandlesRange, runFuturesBacktest } from "../src/tools/backtest-tools.js";

const LEVERAGE = 5;
const MARGIN_PCT = 0.05;
const SLIPPAGE_BPS = 3;
const FEE_BPS = 5;
const INITIAL_CAPITAL = 10000;

// Best (symbol, signal, interval, stop, target) picks from the day-trader sweep,
// prioritizing trade count (statistical reliability) among Sharpe-ranked survivors.
const PICKS = [
  { symbol: "XRPUSDT", label: "Bearish FVG Short", direction: "short", entry: [{ type: "bearish_fvg" }], interval: "1h", lookbackDays: 365, stopPct: 0.03, targetPct: 0.06, maxHoldBars: 48 },
  { symbol: "XRPUSDT", label: "Liquidity Sweep Short", direction: "short", entry: [{ type: "bearish_liq_sweep" }], interval: "1h", lookbackDays: 365, stopPct: 0.03, targetPct: 0.06, maxHoldBars: 48 },
  { symbol: "XRPUSDT", label: "Liq Sweep + FVG Short", direction: "short", entry: [{ type: "bearish_liq_fvg" }], interval: "30m", lookbackDays: 180, stopPct: 0.02, targetPct: 0.04, maxHoldBars: 48 },
  { symbol: "XRPUSDT", label: "ADX-DI Cross Short", direction: "short", entry: [{ type: "adx_di_cross_short", value: 20 }], interval: "30m", lookbackDays: 180, stopPct: 0.02, targetPct: 0.04, maxHoldBars: 48 },
  { symbol: "XRPUSDT", label: "Liq Sweep + FVG Long", direction: "long", entry: [{ type: "bullish_liq_fvg" }], interval: "1h", lookbackDays: 365, stopPct: 0.01, targetPct: 0.04, maxHoldBars: 48 },

  { symbol: "ETHUSDT", label: "Liq Sweep + FVG Long", direction: "long", entry: [{ type: "bullish_liq_fvg" }], interval: "4h", lookbackDays: 730, stopPct: 0.02, targetPct: 0.04, maxHoldBars: 42 },
  { symbol: "ETHUSDT", label: "Bearish FVG Short", direction: "short", entry: [{ type: "bearish_fvg" }], interval: "1h", lookbackDays: 365, stopPct: 0.02, targetPct: 0.02, maxHoldBars: 48 },
  { symbol: "ETHUSDT", label: "Liq Sweep + FVG Short", direction: "short", entry: [{ type: "bearish_liq_fvg" }], interval: "30m", lookbackDays: 180, stopPct: 0.008, targetPct: 0.04, maxHoldBars: 48 },
  { symbol: "ETHUSDT", label: "RSI>80 Short MR", direction: "short", entry: [{ type: "rsi_above", period: 14, value: 80 }], interval: "1h", lookbackDays: 365, stopPct: 0.03, targetPct: 0.06, maxHoldBars: 48 },

  { symbol: "SOLUSDT", label: "Bearish FVG Short", direction: "short", entry: [{ type: "bearish_fvg" }], interval: "1h", lookbackDays: 365, stopPct: 0.01, targetPct: 0.02, maxHoldBars: 48 },
  { symbol: "SOLUSDT", label: "Liq Sweep + FVG Long", direction: "long", entry: [{ type: "bullish_liq_fvg" }], interval: "1h", lookbackDays: 365, stopPct: 0.01, targetPct: 0.02, maxHoldBars: 48 },
  { symbol: "SOLUSDT", label: "Liq Sweep + FVG Short", direction: "short", entry: [{ type: "bearish_liq_fvg" }], interval: "1h", lookbackDays: 365, stopPct: 0.01, targetPct: 0.02, maxHoldBars: 48 },
  { symbol: "SOLUSDT", label: "Liquidity Sweep Short", direction: "short", entry: [{ type: "bearish_liq_sweep" }], interval: "1h", lookbackDays: 365, stopPct: 0.02, targetPct: 0.06, maxHoldBars: 48 },
];

const cache: Record<string, any[]> = {};
async function getCandles(symbol: string, interval: string, lookbackDays: number) {
  const key = `${symbol}:${interval}:${lookbackDays}`;
  if (cache[key]) return cache[key];
  const endTime = Date.now();
  const startTime = endTime - lookbackDays * 24 * 60 * 60 * 1000;
  const fetched = await fetchCandlesRange(symbol, interval, startTime, endTime);
  if ("error" in fetched) throw new Error(fetched.message);
  cache[key] = fetched.candles;
  return fetched.candles;
}

console.log("=== Realistic-sizing verification (5x leverage, 5% margin/trade) ===\n");
for (const p of PICKS) {
  const candles = await getCandles(p.symbol, p.interval, p.lookbackDays);
  const full: any = runFuturesBacktest(candles, p.entry, p.direction as "long" | "short", p.stopPct, p.targetPct, FEE_BPS, p.maxHoldBars, INITIAL_CAPITAL, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS);
  const mid = candles.length > 0 ? Math.floor(candles.length / 2) : 0;
  const h1: any = runFuturesBacktest(candles.slice(0, mid), p.entry, p.direction as "long" | "short", p.stopPct, p.targetPct, FEE_BPS, p.maxHoldBars, INITIAL_CAPITAL, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS);
  const h2: any = runFuturesBacktest(candles.slice(mid), p.entry, p.direction as "long" | "short", p.stopPct, p.targetPct, FEE_BPS, p.maxHoldBars, INITIAL_CAPITAL, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS);
  const bothHalvesPositive = h1.metrics.totalPnlUsd > 0 && h2.metrics.totalPnlUsd > 0;
  const m = full.metrics;
  console.log(`${p.symbol} ${p.label} @ ${p.interval} (stop=${(p.stopPct*100).toFixed(1)}% target=${(p.targetPct*100).toFixed(1)}%):`);
  console.log(`  trades=${m.totalTrades} WR=${(m.winRate*100).toFixed(0)}% PF=${m.profitFactor.toFixed(2)} sharpe=${m.sharpeRatio.toFixed(1)} return=${(m.totalReturnPct*100).toFixed(1)}%/yr pnl=$${Math.round(m.totalPnlUsd)} maxDD=${(m.maxDrawdownPct*100).toFixed(1)}%  [H1 $${Math.round(h1.metrics.totalPnlUsd)} | H2 $${Math.round(h2.metrics.totalPnlUsd)}] -> ${bothHalvesPositive ? "SURVIVES" : "REGIME_FRAGILE"}\n`);
}
