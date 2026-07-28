// Validates the trailing stop engine against the current 6-strategy pool:
// baseline (fixed stop/target) vs trailing, full history + split-sample gate.
// Same shared-engine discipline as every other re-verification this
// session -- everything routes through runFuturesBacktest.
//
// A strategy only gets trailing.enabled: true written into strategies.json
// if trailing survives the SAME split-sample gate as the baseline AND isn't
// a clear regression (per docs/superpowers/specs/2026-07-29-trailing-stop-engine-design.md's
// validation plan). Win rate dropping is expected (winners becoming small
// breakeven trades is the mechanism, not a bug) -- profitFactor and
// totalPnlUsd are what matter.
import { fetchCandlesRange, runFuturesBacktest } from "../src/tools/backtest-tools.js";
import { Candle } from "../src/backtest/types.js";
import { TrailingConfig } from "../src/paper-trading/trailing.js";
import { readFileSync, writeFileSync } from "fs";

const LEVERAGE = 10, MARGIN_PCT = 0.25, RISK_PCT = 0.015, SLIPPAGE_BPS = 3, FEE_BPS = 5, CAP = 10000;
const START = Date.UTC(2023, 6, 16);
const NOW = Date.now();

const DEFAULT_TRIAL: TrailingConfig = {
  enabled: true, breakevenAtrMult: 1.0, breakevenOffsetBps: 5,
  activationAtrMult: 2.0, trailAtrMult: 1.5, minTrailPct: 0.005, maxTrailPct: 0.04,
};

const cfg = JSON.parse(readFileSync("strategies.json", "utf-8"));

interface Row {
  symbol: string; id: string;
  baselineFull: any; baselineTrain: any; baselineTest: any;
  trailingFull: any; trailingTrain: any; trailingTest: any;
  baselineSurvives: boolean; trailingSurvives: boolean;
  recommend: boolean; reason: string;
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

      const run = (c: Candle[], trailing?: TrailingConfig) =>
        runFuturesBacktest(c, s.entry, s.direction, s.risk.stopPct, s.risk.targetPct, FEE_BPS, s.maxHoldBars, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS, undefined, undefined, RISK_PCT, trailing).metrics as any;

      const baselineFull = run(candles), baselineTrain = run(train), baselineTest = run(test);
      const trailingFull = run(candles, DEFAULT_TRIAL), trailingTrain = run(train, DEFAULT_TRIAL), trailingTest = run(test, DEFAULT_TRIAL);

      const baselineSurvives = baselineTrain.totalPnlUsd > 0 && baselineTest.totalPnlUsd > 0;
      const trailingSurvives = trailingTrain.totalPnlUsd > 0 && trailingTest.totalPnlUsd > 0;

      let recommend = false, reason = "";
      if (!trailingSurvives) {
        reason = "fails split-sample with trailing enabled";
      } else if (trailingFull.totalPnlUsd < baselineFull.totalPnlUsd) {
        reason = `lower total PnL with trailing ($${Math.round(trailingFull.totalPnlUsd)} vs $${Math.round(baselineFull.totalPnlUsd)})`;
      } else if (trailingFull.profitFactor < baselineFull.profitFactor * 0.9) {
        reason = `profit factor drops >10% (${trailingFull.profitFactor.toFixed(2)} vs ${baselineFull.profitFactor.toFixed(2)})`;
      } else {
        recommend = true;
        reason = `PF ${baselineFull.profitFactor.toFixed(2)}->${trailingFull.profitFactor.toFixed(2)}, PnL $${Math.round(baselineFull.totalPnlUsd)}->$${Math.round(trailingFull.totalPnlUsd)}`;
      }

      console.log(`${sym} ${s.id}: recommend=${recommend} (${reason})`);
      console.log(`  baseline: trades=${baselineFull.totalTrades} WR=${(baselineFull.winRate*100).toFixed(0)}% PF=${baselineFull.profitFactor.toFixed(2)} PnL=$${Math.round(baselineFull.totalPnlUsd)} maxDD=${(baselineFull.maxDrawdownPct*100).toFixed(1)}%`);
      console.log(`  trailing: trades=${trailingFull.totalTrades} WR=${(trailingFull.winRate*100).toFixed(0)}% PF=${trailingFull.profitFactor.toFixed(2)} PnL=$${Math.round(trailingFull.totalPnlUsd)} maxDD=${(trailingFull.maxDrawdownPct*100).toFixed(1)}%`);

      rows.push({ symbol: sym, id: s.id, baselineFull, baselineTrain, baselineTest, trailingFull, trailingTrain, trailingTest, baselineSurvives, trailingSurvives, recommend, reason });
    }
  }
  writeFileSync("scripts/trailing-validation-output.json", JSON.stringify(rows, null, 2));
  console.log(`\n${rows.filter(r => r.recommend).length}/${rows.length} recommended for trailing.enabled: true`);
}
main().catch(e => { console.error(e); process.exit(1); });
