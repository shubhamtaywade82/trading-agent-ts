import { fetchCandlesRange, runFuturesBacktest } from "../src/tools/backtest-tools.js";

const LEVERAGE = 5, MARGIN_PCT = 0.05, SLIPPAGE_BPS = 3, FEE_BPS = 5, INITIAL_CAPITAL = 10000;

const TESTS = [
  { symbol: "XRPUSDT", interval: "1h", lookbackDays: 365, direction: "short", stopPct: 0.03, targetPct: 0.06, maxHoldBars: 48,
    solo: [{ type: "bearish_liq_sweep" }], soloLabel: "Liquidity Sweep Short alone",
    combo: [{ type: "bearish_liq_sweep" }, { type: "adx_bearish_trend", value: 20 }], comboLabel: "Liq Sweep + ADX bearish trend confluence" },
  { symbol: "ETHUSDT", interval: "1h", lookbackDays: 365, direction: "short", stopPct: 0.02, targetPct: 0.02, maxHoldBars: 48,
    solo: [{ type: "bearish_fvg" }], soloLabel: "Bearish FVG Short alone",
    combo: [{ type: "bearish_fvg" }, { type: "rsi_above", period: 14, value: 70 }], comboLabel: "Bearish FVG + RSI>70 confluence" },
  { symbol: "SOLUSDT", interval: "1h", lookbackDays: 365, direction: "short", stopPct: 0.02, targetPct: 0.06, maxHoldBars: 48,
    solo: [{ type: "bearish_liq_sweep" }], soloLabel: "Liquidity Sweep Short alone",
    combo: [{ type: "bearish_liq_sweep" }, { type: "bearish_fvg" }], comboLabel: "Liq Sweep + Bearish FVG confluence" },
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

function fmt(m: any, label: string) {
  return `  ${label}: trades=${m.totalTrades} WR=${(m.winRate*100).toFixed(0)}% PF=${m.profitFactor.toFixed(2)} sharpe=${m.sharpeRatio.toFixed(1)} pnl=$${Math.round(m.totalPnlUsd)} maxDD=${(m.maxDrawdownPct*100).toFixed(1)}%`;
}

for (const t of TESTS) {
  const candles = await getCandles(t.symbol, t.interval, t.lookbackDays);
  const solo: any = runFuturesBacktest(candles, t.solo, t.direction as any, t.stopPct, t.targetPct, FEE_BPS, t.maxHoldBars, INITIAL_CAPITAL, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS);
  const combo: any = runFuturesBacktest(candles, t.combo, t.direction as any, t.stopPct, t.targetPct, FEE_BPS, t.maxHoldBars, INITIAL_CAPITAL, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS);
  console.log(`\n=== ${t.symbol} @ ${t.interval} ===`);
  console.log(fmt(solo.metrics, t.soloLabel));
  console.log(fmt(combo.metrics, t.comboLabel));
}
