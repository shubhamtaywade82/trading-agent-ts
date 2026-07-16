import {
  fetchCandlesRange, runFuturesBacktest,
  smcSwingHighs, smcSwingLows, smcBullishLiqSweep, smcBearishLiqSweep,
} from "../src/tools/backtest-tools.js";
import { emaSeries } from "../src/tools/indicators.js";
import { writeFileSync } from "fs";

// Tests the OB zone-retest entry model (SMC mitigation entry) in 3 variants,
// mapped from the pasted approach + system doc's setup types:
//   A. ob_retest naked            — the pasted OB approach as-is
//   B. ob_retest + 4h EMA50 bias  — doc §19.1 Trend Continuation (HTF alignment)
//   C. ob_retest + recent sweep   — doc §19.2 Liquidity Sweep Reversal
//      (sweep within last 20 bars BEFORE the retest — temporal sequence,
//       not the same-bar AND that already failed in earlier testing)
// Baseline: existing bearish_ob/bullish_ob impulse-bar entry.
const LEVERAGE = 5, MARGIN_PCT = 0.05, SLIPPAGE_BPS = 3, FEE_BPS = 5, CAP = 10000;
const HTF_MS = 4 * 60 * 60 * 1000;
const SYMBOLS = ["XRPUSDT", "ETHUSDT", "SOLUSDT"];
const TF_CFG: Record<string, { lookbackDays: number; combos: { stop: number; tgt: number }[] }> = {
  "1h": { lookbackDays: 365, combos: [{ stop: 0.02, tgt: 0.04 }, { stop: 0.02, tgt: 0.06 }] },
  "15m": { lookbackDays: 90, combos: [{ stop: 0.01, tgt: 0.02 }] },
};
const MAX_HOLD = 48;

function sweepRecencyMask(candles: any[], direction: "long" | "short", within = 20): boolean[] {
  const closes = candles.map(c => c.close);
  const sh = smcSwingHighs(closes, 5);
  const sl = smcSwingLows(closes, 5);
  const fired = candles.map((_, i) =>
    direction === "short" ? smcBearishLiqSweep(candles, sh, i, 20) : smcBullishLiqSweep(candles, sl, i, 20));
  const mask = new Array<boolean>(candles.length).fill(false);
  let last = -Infinity;
  for (let i = 0; i < candles.length; i++) {
    if (fired[i]) last = i;
    mask[i] = i - last <= within;
  }
  return mask;
}

function htfBiasMask(ltf: any[], htf: any[], direction: "long" | "short"): boolean[] {
  const closes = htf.map(c => c.close);
  const raw = emaSeries(closes, 50);
  const ema = [...Array(closes.length - raw.length).fill(NaN), ...raw];
  const bearish = htf.map((c, j) => !Number.isNaN(ema[j]) && c.close < ema[j]);
  const mask = new Array<boolean>(ltf.length).fill(false);
  let j = 0;
  for (let i = 0; i < ltf.length; i++) {
    const t = ltf[i].openTime;
    while (j + 1 < htf.length && htf[j + 1].openTime + HTF_MS <= t) j++;
    if (htf[j].openTime + HTF_MS > t) continue;
    mask[i] = direction === "short" ? bearish[j] : !bearish[j];
  }
  return mask;
}

const out: any[] = [];
for (const symbol of SYMBOLS) {
  console.log(`\n########## ${symbol} ##########`);
  for (const [tf, cfg] of Object.entries(TF_CFG)) {
    const endTime = Date.now();
    const startTime = endTime - cfg.lookbackDays * 24 * 60 * 60 * 1000;
    const [ltfF, htfF] = await Promise.all([
      fetchCandlesRange(symbol, tf, startTime, endTime),
      fetchCandlesRange(symbol, "4h", startTime - 60 * 24 * 60 * 60 * 1000, endTime),
    ]);
    if ("error" in ltfF || "error" in htfF) { console.log(`  ${tf}: FETCH ERROR`); continue; }
    const candles = ltfF.candles, htf = htfF.candles;
    const mid = Math.floor(candles.length / 2);

    for (const direction of ["short", "long"] as const) {
      const retestType = direction === "short" ? "ob_retest_short" : "ob_retest_long";
      const impulseType = direction === "short" ? "bearish_ob" : "bullish_ob";
      const biasMask = htfBiasMask(candles, htf, direction);
      const sweepMask = sweepRecencyMask(candles, direction);

      for (const { stop, tgt } of cfg.combos) {
        const run = (entry: any[], mask?: boolean[]) => {
          const full: any = runFuturesBacktest(candles, entry, direction, stop, tgt, FEE_BPS, MAX_HOLD, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS, mask);
          const h1: any = runFuturesBacktest(candles.slice(0, mid), entry, direction, stop, tgt, FEE_BPS, MAX_HOLD, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS, mask?.slice(0, mid));
          const h2: any = runFuturesBacktest(candles.slice(mid), entry, direction, stop, tgt, FEE_BPS, MAX_HOLD, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS, mask?.slice(mid));
          return { full, h1, h2 };
        };
        const fmt = (label: string, r: any) => {
          const m = r.full.metrics;
          const both = r.h1.metrics.totalPnlUsd > 0 && r.h2.metrics.totalPnlUsd > 0;
          const verdict = m.totalTrades < 15 ? "LOW_SAMPLE" : m.totalPnlUsd <= 0 ? "NET_NEG" : !both ? "FRAGILE" : "SURVIVES";
          console.log(`    ${label}: tr=${m.totalTrades} WR=${(m.winRate*100).toFixed(0)}% PF=${m.profitFactor.toFixed(2)} SR=${m.sharpeRatio.toFixed(1)} pnl=$${Math.round(m.totalPnlUsd)} DD=${(m.maxDrawdownPct*100).toFixed(1)}% [H1 $${Math.round(r.h1.metrics.totalPnlUsd)}|H2 $${Math.round(r.h2.metrics.totalPnlUsd)}] ${verdict}`);
          out.push({ symbol, tf, direction, stop, tgt, variant: label, trades: m.totalTrades, wr: m.winRate, pf: m.profitFactor, sharpe: m.sharpeRatio, pnl: Math.round(m.totalPnlUsd), maxDD: m.maxDrawdownPct, verdict });
        };
        console.log(`  ${tf} ${direction} stop=${stop*100}% tgt=${tgt*100}%:`);
        fmt("baseline impulse-OB", run([{ type: impulseType }]));
        fmt("A retest naked     ", run([{ type: retestType }]));
        fmt("B retest+4h bias   ", run([{ type: retestType }], biasMask));
        fmt("C retest+sweep<=20 ", run([{ type: retestType }], sweepMask));
      }
    }
  }
}
writeFileSync("scripts/ob-retest-output.json", JSON.stringify(out, null, 2));
console.log("\nWrote scripts/ob-retest-output.json");
