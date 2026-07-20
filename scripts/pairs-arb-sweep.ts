// Promotion gate for the stat-arb pairs engine: for each of the 3 possible
// pairs among XRPUSDT/ETHUSDT/SOLUSDT, apply a correlation pre-filter, then
// backtest z-score mean-reversion over the pair's full available history
// with a split-sample check (first half / second half of the window,
// independently net-positive) and a >=15 trade minimum — same discipline as
// scripts/oi-divergence-sweep.ts. Writes scripts/pairs-arb-sweep-output.json.
// Never writes anywhere that would make a pair go live automatically —
// promoting a SURVIVES pair into the daemon's candidate list is a manual,
// reviewed edit (see docs/superpowers/specs/2026-07-21-stat-arb-pairs-design.md).
import { writeFileSync } from "fs";
import { fetchCandlesRange } from "../src/tools/backtest-tools.js";
import { pearsonCorrelation, runPairsBacktest } from "../src/backtest/pairs-engine.js";

const SYMBOLS = ["XRPUSDT", "ETHUSDT", "SOLUSDT"];
const PAIRS: [string, string][] = [];
for (let i = 0; i < SYMBOLS.length; i++) for (let j = i + 1; j < SYMBOLS.length; j++) PAIRS.push([SYMBOLS[i], SYMBOLS[j]]);

const TF = "1h";
const LOOKBACK_DAYS = 365;
const MIN_CORRELATION = 0.7;
const MIN_TRADES = 15;
const CONFIG = { lookback: 30, entryZ: 2, exitZ: 0.5, stopZ: 3.5, maxHoldBars: 96, notionalPerLeg: 2000, feeBps: 5, slippageBps: 3, initialCapital: 10000 };

interface Result {
  pairA: string; pairB: string; correlation: number;
  trades: number; winRate: number; pf: number; sharpe: number; pnlUsd: number;
  h1: { trades: number; pnlUsd: number }; h2: { trades: number; pnlUsd: number };
  verdict: "SURVIVES" | "REGIME_FRAGILE" | "LOW_CORRELATION" | "TOO_FEW_TRADES";
}

async function main() {
  const endTime = Date.now();
  const startTime = endTime - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const results: Result[] = [];

  for (const [symA, symB] of PAIRS) {
    const [candlesAResult, candlesBResult] = await Promise.all([
      fetchCandlesRange(symA, TF, startTime, endTime),
      fetchCandlesRange(symB, TF, startTime, endTime),
    ]);
    if ("error" in candlesAResult) { console.error(`${symA}: ${candlesAResult.message}`); continue; }
    if ("error" in candlesBResult) { console.error(`${symB}: ${candlesBResult.message}`); continue; }
    const candlesA = candlesAResult.candles, candlesB = candlesBResult.candles;

    const n = Math.min(candlesA.length, candlesB.length);
    const correlation = pearsonCorrelation(candlesA.slice(0, n).map(c => c.close), candlesB.slice(0, n).map(c => c.close));
    if (Math.abs(correlation) < MIN_CORRELATION) {
      results.push({ pairA: symA, pairB: symB, correlation, trades: 0, winRate: 0, pf: 0, sharpe: 0, pnlUsd: 0, h1: { trades: 0, pnlUsd: 0 }, h2: { trades: 0, pnlUsd: 0 }, verdict: "LOW_CORRELATION" });
      console.log(`${symA}/${symB}: correlation ${correlation.toFixed(2)} below ${MIN_CORRELATION}, skipped`);
      continue;
    }

    const full = runPairsBacktest(candlesA, candlesB, CONFIG);
    if (full.metrics.totalTrades < MIN_TRADES) {
      results.push({ pairA: symA, pairB: symB, correlation, trades: full.metrics.totalTrades, winRate: 0, pf: 0, sharpe: 0, pnlUsd: 0, h1: { trades: 0, pnlUsd: 0 }, h2: { trades: 0, pnlUsd: 0 }, verdict: "TOO_FEW_TRADES" });
      console.log(`${symA}/${symB}: only ${full.metrics.totalTrades} trades (<${MIN_TRADES}), skipped`);
      continue;
    }

    const mid = Math.floor(n / 2);
    const h1 = runPairsBacktest(candlesA.slice(0, mid), candlesB.slice(0, mid), CONFIG);
    const h2 = runPairsBacktest(candlesA.slice(mid), candlesB.slice(mid), CONFIG);
    const bothHalvesPositive = h1.metrics.totalPnlUsd > 0 && h2.metrics.totalPnlUsd > 0;

    const result: Result = {
      pairA: symA, pairB: symB, correlation,
      trades: full.metrics.totalTrades, winRate: full.metrics.winRate, pf: full.metrics.profitFactor,
      sharpe: full.metrics.sharpeRatio, pnlUsd: full.metrics.totalPnlUsd,
      h1: { trades: h1.metrics.totalTrades, pnlUsd: h1.metrics.totalPnlUsd },
      h2: { trades: h2.metrics.totalTrades, pnlUsd: h2.metrics.totalPnlUsd },
      verdict: full.metrics.totalPnlUsd > 0 && bothHalvesPositive ? "SURVIVES" : "REGIME_FRAGILE",
    };
    results.push(result);
    console.log(`${symA}/${symB}: correlation=${correlation.toFixed(2)}, ${result.trades} trades, PF=${result.pf.toFixed(2)}, Sharpe=${result.sharpe.toFixed(2)}, PnL=$${result.pnlUsd.toFixed(0)} — ${result.verdict}`);
  }

  const survivors = results.filter(r => r.verdict === "SURVIVES");
  console.log(`\n${survivors.length} SURVIVES out of ${PAIRS.length} pairs tested.`);
  writeFileSync("scripts/pairs-arb-sweep-output.json", JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log("Wrote scripts/pairs-arb-sweep-output.json. Review SURVIVES entries and manually add any worth keeping to the daemon's pairs-arb candidate list, per docs/superpowers/specs/2026-07-21-stat-arb-pairs-design.md's promotion gate.");
}

main().catch(e => { console.error(e); process.exit(1); });
