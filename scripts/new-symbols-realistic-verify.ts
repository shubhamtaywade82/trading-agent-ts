// Realistic-sizing re-verification (5x leverage, 5% margin/trade) of the
// SURVIVES combos from scripts/new-symbols-sweep.ts's screen pass (10x/50%
// screen sizing). Same discipline strategies.json._verification documents
// being burned by skipping — screen-stage PnL numbers (some in the millions
// on $10k capital) are compounding artifacts of aggressive sizing, not real.
import { fetchCandlesRange, runFuturesBacktest } from "../src/tools/backtest-tools.js";

const LEVERAGE = 5;
const MARGIN_PCT = 0.05;
const SLIPPAGE_BPS = 3;
const FEE_BPS = 5;
const INITIAL_CAPITAL = 10000;
const MIN_TRADES = 15;

const PICKS = [
  { symbol: "BTCUSDT", label: "Bearish Liq+FVG Short", direction: "short", entry: [{ type: "bearish_liq_fvg" }], interval: "15m", lookbackDays: 90, stopPct: 0.008, targetPct: 0.01, maxHoldBars: 48 },
  { symbol: "BTCUSDT", label: "Bearish FVG Short", direction: "short", entry: [{ type: "bearish_fvg" }], interval: "15m", lookbackDays: 90, stopPct: 0.008, targetPct: 0.01, maxHoldBars: 48 },
  { symbol: "BTCUSDT", label: "Bearish Liq+FVG Short", direction: "short", entry: [{ type: "bearish_liq_fvg" }], interval: "30m", lookbackDays: 180, stopPct: 0.02, targetPct: 0.03, maxHoldBars: 48 },
  { symbol: "BTCUSDT", label: "Liquidity Sweep Short", direction: "short", entry: [{ type: "bearish_liq_sweep" }], interval: "30m", lookbackDays: 180, stopPct: 0.02, targetPct: 0.03, maxHoldBars: 48 },
  { symbol: "BTCUSDT", label: "Bearish Liq+FVG Short", direction: "short", entry: [{ type: "bearish_liq_fvg" }], interval: "1h", lookbackDays: 365, stopPct: 0.01, targetPct: 0.04, maxHoldBars: 48 },
  { symbol: "BTCUSDT", label: "Bearish FVG Short", direction: "short", entry: [{ type: "bearish_fvg" }], interval: "1h", lookbackDays: 365, stopPct: 0.01, targetPct: 0.02, maxHoldBars: 48 },
  { symbol: "BTCUSDT", label: "Bearish FVG Short", direction: "short", entry: [{ type: "bearish_fvg" }], interval: "4h", lookbackDays: 730, stopPct: 0.03, targetPct: 0.04, maxHoldBars: 42 },

  { symbol: "DOGEUSDT", label: "Bearish Liq+OB Short", direction: "short", entry: [{ type: "bearish_liq_ob" }], interval: "15m", lookbackDays: 90, stopPct: 0.015, targetPct: 0.02, maxHoldBars: 48 },
  { symbol: "DOGEUSDT", label: "Bearish Liq+FVG Short", direction: "short", entry: [{ type: "bearish_liq_fvg" }], interval: "15m", lookbackDays: 90, stopPct: 0.015, targetPct: 0.01, maxHoldBars: 48 },
  { symbol: "DOGEUSDT", label: "Liquidity Sweep Short", direction: "short", entry: [{ type: "bearish_liq_sweep" }], interval: "15m", lookbackDays: 90, stopPct: 0.015, targetPct: 0.03, maxHoldBars: 48 },
  { symbol: "DOGEUSDT", label: "RSI>80 Short MR", direction: "short", entry: [{ type: "rsi_above", period: 14, value: 80 }], interval: "15m", lookbackDays: 90, stopPct: 0.01, targetPct: 0.03, maxHoldBars: 48 },
  { symbol: "DOGEUSDT", label: "Liq+FVG Long (only long survivor)", direction: "long", entry: [{ type: "bullish_liq_fvg" }], interval: "30m", lookbackDays: 180, stopPct: 0.02, targetPct: 0.015, maxHoldBars: 48 },
  { symbol: "DOGEUSDT", label: "Bearish Liq+FVG Short", direction: "short", entry: [{ type: "bearish_liq_fvg" }], interval: "1h", lookbackDays: 365, stopPct: 0.01, targetPct: 0.02, maxHoldBars: 48 },
  { symbol: "DOGEUSDT", label: "Liquidity Sweep Short", direction: "short", entry: [{ type: "bearish_liq_sweep" }], interval: "1h", lookbackDays: 365, stopPct: 0.02, targetPct: 0.02, maxHoldBars: 48 },
  { symbol: "DOGEUSDT", label: "Bearish FVG Short", direction: "short", entry: [{ type: "bearish_fvg" }], interval: "1h", lookbackDays: 365, stopPct: 0.01, targetPct: 0.02, maxHoldBars: 48 },
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
const survivors: any[] = [];
for (const p of PICKS) {
  const candles = await getCandles(p.symbol, p.interval, p.lookbackDays);
  const full: any = runFuturesBacktest(candles, p.entry, p.direction as "long" | "short", p.stopPct, p.targetPct, FEE_BPS, p.maxHoldBars, INITIAL_CAPITAL, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS);
  const mid = Math.floor(candles.length / 2);
  const h1: any = runFuturesBacktest(candles.slice(0, mid), p.entry, p.direction as "long" | "short", p.stopPct, p.targetPct, FEE_BPS, p.maxHoldBars, INITIAL_CAPITAL, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS);
  const h2: any = runFuturesBacktest(candles.slice(mid), p.entry, p.direction as "long" | "short", p.stopPct, p.targetPct, FEE_BPS, p.maxHoldBars, INITIAL_CAPITAL, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS);
  const m = full.metrics;
  const bothHalvesPositive = h1.metrics.totalPnlUsd > 0 && h2.metrics.totalPnlUsd > 0;
  const enoughTrades = m.totalTrades >= MIN_TRADES;
  const verdict = enoughTrades && bothHalvesPositive && m.totalPnlUsd > 0 ? "SURVIVES" : "REGIME_FRAGILE";
  console.log(`${p.symbol} ${p.label} @ ${p.interval} (stop=${(p.stopPct*100).toFixed(1)}% target=${(p.targetPct*100).toFixed(1)}%):`);
  console.log(`  trades=${m.totalTrades} WR=${(m.winRate*100).toFixed(0)}% PF=${m.profitFactor.toFixed(2)} sharpe=${m.sharpeRatio.toFixed(1)} return=${(m.totalReturnPct*100).toFixed(1)}%/yr pnl=$${Math.round(m.totalPnlUsd)} maxDD=${(m.maxDrawdownPct*100).toFixed(1)}%  [H1 $${Math.round(h1.metrics.totalPnlUsd)} | H2 $${Math.round(h2.metrics.totalPnlUsd)}] -> ${verdict}\n`);
  if (verdict === "SURVIVES") survivors.push({ ...p, trades: m.totalTrades, winRate: m.winRate, pf: m.profitFactor, sharpe: m.sharpeRatio, pnlUsd: m.totalPnlUsd, maxDDPct: m.maxDrawdownPct });
}

console.log(`\n${survivors.length}/${PICKS.length} SURVIVE realistic sizing + split-sample.`);
for (const s of survivors) {
  console.log(`  ${s.symbol} ${s.label} @ ${s.interval}: ${s.trades} trades, WR=${(s.winRate*100).toFixed(0)}%, PF=${s.pf.toFixed(2)}, Sharpe=${s.sharpe.toFixed(1)}, PnL=$${Math.round(s.pnlUsd)}, maxDD=${(s.maxDDPct*100).toFixed(1)}%`);
}
