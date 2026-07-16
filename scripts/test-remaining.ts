import { fetchCandlesRange, runFuturesBacktest } from "../src/tools/backtest-tools.js";
import { superTrendSeries, emaSeries } from "../src/tools/indicators.js";
import type { CandleHL } from "../src/tools/indicators.js";
import type { Candle, StrategyConfig } from "../src/backtest/types.js";

const CAPITAL = 10000, LEVERAGE = 10, FEE = 5, MAX_HOLD = 48;
const endTime = Date.now(), startTime = endTime - 365 * 24 * 60 * 60 * 1000;
const sym = "XRPUSDT";

async function main() {
  const fetched = await fetchCandlesRange(sym, "1h", startTime, endTime);
  if ("error" in fetched) { console.error(fetched.message); return; }
  const candles = fetched.candles;
  const n = candles.length;
  const closes = candles.map(c => c.close);

  // SuperTrend
  const st = superTrendSeries(candles as CandleHL[], 10, 3);
  let stLong = 0, stShort = 0;
  for (let i = 15; i < n; i++) {
    if (st[i]?.trend === "up" && st[i-1]?.trend === "down") stLong++;
    if (st[i]?.trend === "down" && st[i-1]?.trend === "up") stShort++;
  }
  console.log(`SuperTrend flips: long=${stLong}, short=${stShort} out of ${n} candles`);

  // EMA alignment
  const e10 = [...Array(n - 10).fill(NaN), ...emaSeries(closes.slice(0), 10)];
  const e20 = [...Array(n - 20).fill(NaN), ...emaSeries(closes.slice(0), 20)];
  const e50 = [...Array(n - 50).fill(NaN), ...emaSeries(closes.slice(0), 50)];
  let alignLong = 0, alignShort = 0;
  for (let i = 52; i < n; i++) {
    if (closes[i] > e10[i] && e10[i] > e20[i] && e20[i] > e50[i]) alignLong++;
    if (closes[i] < e10[i] && e10[i] < e20[i] && e20[i] < e50[i]) alignShort++;
  }
  console.log(`EMA Alignment: long=${alignLong}, short=${alignShort}`);
}
main().catch(console.error);
