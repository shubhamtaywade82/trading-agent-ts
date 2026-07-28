// Re-verifies every strategies.json entry affected by the SMC engine
// consolidation, at 10x leverage (this pool was last verified at 5x — see
// docs/superpowers/specs/2026-07-28-smc-engine-consolidation-design.md for
// why 10x, not a revert to 5x). Everything routes through
// runFuturesBacktest — no second simulation loop.
import { fetchCandlesRange, runFuturesBacktest } from "../src/tools/backtest-tools.js";
import { Candle } from "../src/backtest/types.js";
import { readFileSync, writeFileSync } from "fs";

const LEVERAGE = 10, MARGIN_PCT = 0.05, SLIPPAGE_BPS = 3, FEE_BPS = 5, CAP = 10000;
const START = Date.UTC(2023, 6, 16);
const NOW = Date.now();
const AFFECTED_TYPES = new Set(["bearish_fvg", "bearish_liq_sweep", "bearish_liq_fvg", "bullish_liq_fvg", "bearish_liq_ob", "ob_retest_short"]);

const cfg = JSON.parse(readFileSync("strategies.json", "utf-8"));

interface Row { symbol: string; id: string; oldMetrics: any; fullMetrics: any; trainMetrics: any; testMetrics: any; survives: boolean }

async function main() {
  const rows: Row[] = [];
  for (const [sym, strats] of Object.entries(cfg.symbols) as [string, any[]][]) {
    for (const s of strats) {
      if (!s.entry.some((e: any) => AFFECTED_TYPES.has(e.type))) continue;
      const f = await fetchCandlesRange(sym, s.tf, START, NOW);
      if ("error" in f) { console.error(sym, s.id, f.message); continue; }
      const candles: Candle[] = f.candles;
      const half = Math.floor(candles.length / 2);
      const train = candles.slice(0, half), test = candles.slice(half);

      const run = (c: Candle[]) => runFuturesBacktest(c, s.entry, s.direction, s.risk.stopPct, s.risk.targetPct, FEE_BPS, s.maxHoldBars, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS).metrics as any;
      const fullMetrics = run(candles), trainMetrics = run(train), testMetrics = run(test);
      const survives = trainMetrics.totalPnlUsd > 0 && testMetrics.totalPnlUsd > 0;

      console.log(`${sym} ${s.id}: survives=${survives} full trades=${fullMetrics.totalTrades} WR=${(fullMetrics.winRate * 100).toFixed(0)}% PF=${fullMetrics.profitFactor.toFixed(2)} (was: trades=${s.metrics.trades} WR=${(s.metrics.winRate * 100).toFixed(0)}% PF=${s.metrics.pf.toFixed(2)} @5x)`);
      rows.push({ symbol: sym, id: s.id, oldMetrics: s.metrics, fullMetrics, trainMetrics, testMetrics, survives });
    }
  }
  writeFileSync("scripts/smc-migration-reverify-output.json", JSON.stringify(rows, null, 2));
  console.log(`\n${rows.filter(r => r.survives).length}/${rows.length} survive re-verification at 10x`);
}
main().catch(e => { console.error(e); process.exit(1); });
