// Promotion gate for the new oi_bearish_divergence / oi_bullish_divergence
// conditions: runs each against the existing pool's symbols across a small
// stop/target grid, split-samples the ~30d OI window into two ~15d halves,
// and only flags a combo SURVIVES if the full window is net-positive, both
// halves are independently net-positive, and it clears >=8 trades (the
// proportionate equivalent of this repo's usual 15-trade bar, scaled down
// for a ~30d window instead of the usual 1-3yr one — see
// docs/superpowers/specs/2026-07-21-oi-divergence-signal-design.md).
// Writes results to scripts/oi-divergence-sweep-output.json. Never writes
// strategies.json — promoting a SURVIVES combo is a manual, reviewed edit.
import { writeFileSync } from "fs";
import { fetchCandlesRange, fetchOpenInterestHist, alignOiToCandles, buildSignalEvaluator, runFuturesBacktest } from "../src/tools/backtest-tools.js";

const SYMBOLS = ["XRPUSDT", "ETHUSDT", "SOLUSDT"];
const TIMEFRAMES = ["15m", "30m", "1h", "4h"];
const CONDITIONS: { type: string; direction: "long" | "short" }[] = [
  { type: "oi_bearish_divergence", direction: "short" },
  { type: "oi_bullish_divergence", direction: "long" },
];
const STOP_VALUES = [0.01, 0.02, 0.03];
const TARGET_VALUES = [0.02, 0.04, 0.06];
const MIN_TRADES = 8;
const LEVERAGE = 5, MARGIN_PCT = 0.05, SLIPPAGE_BPS = 3, FEE_BPS = 5, CAP = 10000, MAX_HOLD_BARS = 48;

interface Result {
  symbol: string; tf: string; conditionType: string; direction: string;
  stopPct: number; targetPct: number;
  trades: number; winRate: number; pf: number; sharpe: number; pnlUsd: number;
  h1: { trades: number; pnlUsd: number }; h2: { trades: number; pnlUsd: number };
  verdict: "SURVIVES" | "REGIME_FRAGILE";
}

async function main() {
  const endTime = Date.now();
  const startTime = endTime - 25 * 24 * 60 * 60 * 1000; // stay inside ~30d OI retention
  const results: Result[] = [];

  for (const symbol of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      const candlesResult = await fetchCandlesRange(symbol, tf, startTime, endTime);
      if ("error" in candlesResult) { console.error(`${symbol} ${tf}: candles error — ${candlesResult.message}`); continue; }
      const candles = candlesResult.candles;
      if (candles.length < 30) { console.error(`${symbol} ${tf}: too few candles (${candles.length}), skipping`); continue; }

      const oiResult = await fetchOpenInterestHist(symbol, tf, startTime, endTime);
      if ("error" in oiResult) { console.error(`${symbol} ${tf}: OI error — ${oiResult.message}`); continue; }
      const oiSeries = alignOiToCandles(candles, oiResult.points);

      const mid = startTime + (endTime - startTime) / 2;
      const midIdx = candles.findIndex(c => c.openTime >= mid);
      const h1 = candles.slice(0, midIdx < 0 ? candles.length : midIdx);
      const h2 = candles.slice(midIdx < 0 ? candles.length : midIdx);
      const oi1 = oiSeries.slice(0, midIdx < 0 ? oiSeries.length : midIdx);
      const oi2 = oiSeries.slice(midIdx < 0 ? oiSeries.length : midIdx);

      for (const cond of CONDITIONS) {
        for (const sp of STOP_VALUES) {
          for (const tp of TARGET_VALUES) {
            const entry = [{ type: cond.type, period: 10, value: 0.03 }];
            const fullEval = buildSignalEvaluator(candles, entry, { oi: oiSeries });
            const full = runFuturesBacktest(candles, fullEval, cond.direction, sp, tp, FEE_BPS, MAX_HOLD_BARS, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS) as any;
            if (full.metrics.totalTrades < MIN_TRADES) continue;

            const h1Eval = buildSignalEvaluator(h1, entry, { oi: oi1 });
            const h2Eval = buildSignalEvaluator(h2, entry, { oi: oi2 });
            const r1 = runFuturesBacktest(h1, h1Eval, cond.direction, sp, tp, FEE_BPS, MAX_HOLD_BARS, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS) as any;
            const r2 = runFuturesBacktest(h2, h2Eval, cond.direction, sp, tp, FEE_BPS, MAX_HOLD_BARS, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS) as any;
            const bothHalvesPositive = r1.metrics.totalPnlUsd > 0 && r2.metrics.totalPnlUsd > 0;

            results.push({
              symbol, tf, conditionType: cond.type, direction: cond.direction,
              stopPct: sp, targetPct: tp,
              trades: full.metrics.totalTrades, winRate: full.metrics.winRate,
              pf: full.metrics.profitFactor, sharpe: full.metrics.sharpeRatio, pnlUsd: full.metrics.totalPnlUsd,
              h1: { trades: r1.metrics.totalTrades, pnlUsd: r1.metrics.totalPnlUsd },
              h2: { trades: r2.metrics.totalTrades, pnlUsd: r2.metrics.totalPnlUsd },
              verdict: full.metrics.totalPnlUsd > 0 && bothHalvesPositive ? "SURVIVES" : "REGIME_FRAGILE",
            });
          }
        }
      }
      console.log(`${symbol} ${tf}: swept, ${results.filter(r => r.symbol === symbol && r.tf === tf).length} combos with >=${MIN_TRADES} trades`);
    }
  }

  const survivors = results.filter(r => r.verdict === "SURVIVES");
  console.log(`\n${survivors.length} SURVIVES out of ${results.length} combos tested.`);
  for (const s of survivors) {
    console.log(`  ${s.symbol} ${s.tf} ${s.conditionType} stop=${s.stopPct} target=${s.targetPct}: ${s.trades} trades, PF=${s.pf.toFixed(2)}, Sharpe=${s.sharpe.toFixed(1)}, PnL=$${s.pnlUsd.toFixed(0)}`);
  }
  writeFileSync("scripts/oi-divergence-sweep-output.json", JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log("\nWrote scripts/oi-divergence-sweep-output.json. Review SURVIVES entries and manually add any worth keeping to strategies.json with a note flagging the ~25d sample window, per docs/superpowers/specs/2026-07-21-oi-divergence-signal-design.md's promotion gate.");
}

main().catch(e => { console.error(e); process.exit(1); });
