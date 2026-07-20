// Hand-run sanity check: fetch real candles + OI history for one symbol,
// print them side by side so the alignment and divergence math can be
// eyeballed against known values. Not a substitute for the Jest unit tests
// in tests/tools/backtest-tools.test.ts — this is the same "verify against
// real data by hand" step this repo's other scripts/*.ts files use.
import { fetchCandlesRange, fetchOpenInterestHist, alignOiToCandles, buildSignalEvaluator } from "../src/tools/backtest-tools.js";

const SYMBOL = process.argv[2] ?? "BTCUSDT";
const TF = process.argv[3] ?? "1h";

async function main() {
  const endTime = Date.now();
  const startTime = endTime - 25 * 24 * 60 * 60 * 1000; // 25d, safely inside the ~30d OI retention window

  const candlesResult = await fetchCandlesRange(SYMBOL, TF, startTime, endTime);
  if ("error" in candlesResult) throw new Error(`candles: ${candlesResult.message}`);
  const candles = candlesResult.candles;

  const oiResult = await fetchOpenInterestHist(SYMBOL, TF, startTime, endTime);
  if ("error" in oiResult) throw new Error(`oi: ${oiResult.message}`);

  const oiSeries = alignOiToCandles(candles, oiResult.points);
  const nonNan = oiSeries.filter(v => !Number.isNaN(v)).length;
  console.log(`${SYMBOL} ${TF}: ${candles.length} candles, ${oiResult.points.length} OI points, ${nonNan} aligned (non-NaN)`);

  console.log("\nLast 15 bars — close, OI:");
  for (let i = Math.max(0, candles.length - 15); i < candles.length; i++) {
    console.log(`  ${new Date(candles[i].openTime).toISOString()}  close=${candles[i].close}  oi=${oiSeries[i]}`);
  }

  const evalBear = buildSignalEvaluator(candles, [{ type: "oi_bearish_divergence", period: 10, value: 0.03 }], { oi: oiSeries });
  const evalBull = buildSignalEvaluator(candles, [{ type: "oi_bullish_divergence", period: 10, value: 0.03 }], { oi: oiSeries });
  let bearFires = 0, bullFires = 0;
  for (let i = 0; i < candles.length; i++) {
    if (evalBear(i)) bearFires++;
    if (evalBull(i)) bullFires++;
  }
  console.log(`\noi_bearish_divergence fired ${bearFires} times, oi_bullish_divergence fired ${bullFires} times over ${candles.length} bars.`);
}

main().catch(e => { console.error(e); process.exit(1); });
