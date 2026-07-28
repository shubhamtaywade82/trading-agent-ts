// Re-verifies the ENTIRE strategies.json pool (all 9 current entries, every
// symbol) at leverage=10 with RISK-BASED sizing: riskPerTradePct=0.015 (a
// stop-out costs 1.5% of capital regardless of stopPct), marginPerTradePct=0.25
// kept as a hard ceiling, not the sizing driver. The flat-25%-margin version
// of this script (first run) produced 40-92% max drawdowns even on net-positive
// strategies -- see docs/superpowers/specs for the writeup. Same shared-engine
// discipline as scripts/smc-migration-reverify.ts. Flags (does not auto-remove)
// any survivor with maxDrawdownPct > 0.40.
import { fetchCandlesRange, runFuturesBacktest } from "../src/tools/backtest-tools.js";
import { Candle } from "../src/backtest/types.js";
import { readFileSync, writeFileSync } from "fs";

const LEVERAGE = 10, MARGIN_PCT = 0.25, RISK_PCT = 0.015, SLIPPAGE_BPS = 3, FEE_BPS = 5, CAP = 10000;
const START = Date.UTC(2023, 6, 16);
const NOW = Date.now();
const DD_FLAG_THRESHOLD = 0.40;

const cfg = JSON.parse(readFileSync("strategies.json", "utf-8"));

interface Row {
  symbol: string; id: string; oldMetrics: any;
  fullMetrics: any; trainMetrics: any; testMetrics: any;
  survives: boolean; ddFlagged: boolean;
}

async function main() {
  const rows: Row[] = [];
  for (const [sym, strats] of Object.entries(cfg.symbols) as [string, any[]][]) {
    for (const s of strats) {
      const f = await fetchCandlesRange(sym, s.tf, START, NOW);
      if ("error" in f) { console.error(sym, s.id, f.message); continue; }
      const candles: Candle[] = f.candles;
      const half = Math.floor(candles.length / 2);
      const train = candles.slice(0, half), test = candles.slice(half);

      const run = (c: Candle[]) => runFuturesBacktest(c, s.entry, s.direction, s.risk.stopPct, s.risk.targetPct, FEE_BPS, s.maxHoldBars, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS, undefined, undefined, RISK_PCT).metrics as any;
      const fullMetrics = run(candles), trainMetrics = run(train), testMetrics = run(test);
      const survives = trainMetrics.totalPnlUsd > 0 && testMetrics.totalPnlUsd > 0;
      const ddFlagged = survives && fullMetrics.maxDrawdownPct > DD_FLAG_THRESHOLD;

      console.log(`${sym} ${s.id}: survives=${survives}${ddFlagged ? " [DD-FLAGGED]" : ""} trades=${fullMetrics.totalTrades} WR=${(fullMetrics.winRate * 100).toFixed(0)}% PF=${fullMetrics.profitFactor.toFixed(2)} maxDD=${(fullMetrics.maxDrawdownPct * 100).toFixed(1)}% (was: WR=${(s.metrics.winRate * 100).toFixed(0)}% PF=${s.metrics.pf.toFixed(2)} maxDD=${(s.metrics.maxDDPct * 100).toFixed(1)}% @5x/5%)`);
      rows.push({ symbol: sym, id: s.id, oldMetrics: s.metrics, fullMetrics, trainMetrics, testMetrics, survives, ddFlagged });
    }
  }
  writeFileSync("scripts/margin25-reverify-output.json", JSON.stringify(rows, null, 2));
  console.log(`\n${rows.filter(r => r.survives).length}/${rows.length} survive at 10x/25%. ${rows.filter(r => r.ddFlagged).length} DD-flagged (>${DD_FLAG_THRESHOLD * 100}%).`);
}
main().catch(e => { console.error(e); process.exit(1); });
