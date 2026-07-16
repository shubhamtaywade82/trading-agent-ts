import { fetchCandlesRange, runFuturesBacktest } from "../src/tools/backtest-tools.js";
import { emaSeries } from "../src/tools/indicators.js";
import { writeFileSync } from "fs";

// Multi-timeframe test: HTF (4h) regime bias gating LTF (5m/15m) execution.
// Bias = 4h close vs EMA50: below → bearish regime (shorts allowed),
// above → bullish regime (longs allowed). Mask built from CLOSED 4h bars only
// (bias for an LTF candle comes from the last 4h bar that fully closed
// before that candle opened — no lookahead).
const LEVERAGE = 5, MARGIN_PCT = 0.05, SLIPPAGE_BPS = 3, FEE_BPS = 5, CAP = 10000;
const HTF_MS = 4 * 60 * 60 * 1000;
const SYMBOLS = ["XRPUSDT", "ETHUSDT", "SOLUSDT"];

// ponytail: one stop/target per LTF (taken from earlier validated sweep grids), not re-optimized
const LTF_CFG: Record<string, { lookbackDays: number; stopPct: number; targetPct: number; maxHoldBars: number }> = {
  "5m": { lookbackDays: 45, stopPct: 0.005, targetPct: 0.015, maxHoldBars: 48 },
  "15m": { lookbackDays: 90, stopPct: 0.01, targetPct: 0.02, maxHoldBars: 48 },
};

const SIGNALS = [
  { id: "bearish_liq_sweep", direction: "short" as const, entry: [{ type: "bearish_liq_sweep" }] },
  { id: "bearish_fvg", direction: "short" as const, entry: [{ type: "bearish_fvg" }] },
  { id: "bullish_liq_fvg", direction: "long" as const, entry: [{ type: "bullish_liq_fvg" }] },
];

function buildBiasMask(ltf: any[], htf: any[], htfBearish: boolean[], direction: "long" | "short"): boolean[] {
  // htfBearish[j] = bias state OF bar j (uses bar j's own close — only usable after j closes)
  const mask = new Array<boolean>(ltf.length).fill(false);
  let j = 0;
  for (let i = 0; i < ltf.length; i++) {
    const t = ltf[i].openTime;
    while (j + 1 < htf.length && htf[j + 1].openTime + HTF_MS <= t) j++;
    if (htf[j].openTime + HTF_MS > t) continue; // no closed HTF bar yet
    mask[i] = direction === "short" ? htfBearish[j] : !htfBearish[j];
  }
  return mask;
}

const out: any[] = [];

for (const symbol of SYMBOLS) {
  console.log(`\n########## ${symbol} ##########`);
  for (const [ltfName, cfg] of Object.entries(LTF_CFG)) {
    const endTime = Date.now();
    const startTime = endTime - cfg.lookbackDays * 24 * 60 * 60 * 1000;
    // HTF window starts earlier so EMA50 is warm at LTF window start
    const htfFetch = await fetchCandlesRange(symbol, "4h", startTime - 60 * 24 * 60 * 60 * 1000, endTime);
    const ltfFetch = await fetchCandlesRange(symbol, ltfName, startTime, endTime);
    if ("error" in htfFetch || "error" in ltfFetch) { console.log(`  ${ltfName}: FETCH ERROR`); continue; }
    const htf = htfFetch.candles, ltf = ltfFetch.candles;
    const closes = htf.map(c => c.close);
    const rawEma = emaSeries(closes, 50);
    const ema = [...Array(closes.length - rawEma.length).fill(NaN), ...rawEma];
    const htfBearish = htf.map((c, j) => !Number.isNaN(ema[j]) && c.close < ema[j]);
    const mid = Math.floor(ltf.length / 2);

    console.log(`\n=== ${symbol} exec@${ltfName} (${ltf.length} candles, ${cfg.lookbackDays}d) bias@4h-EMA50 ===`);
    for (const sig of SIGNALS) {
      const mask = buildBiasMask(ltf, htf, htfBearish, sig.direction);
      const run = (candles: any[], m?: boolean[]) =>
        runFuturesBacktest(candles, sig.entry, sig.direction, cfg.stopPct, cfg.targetPct, FEE_BPS, cfg.maxHoldBars, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS, m) as any;

      const ungated = run(ltf);
      const gated = run(ltf, mask);
      const gH1 = run(ltf.slice(0, mid), mask.slice(0, mid));
      const gH2 = run(ltf.slice(mid), mask.slice(mid));
      const both = gH1.metrics.totalPnlUsd > 0 && gH2.metrics.totalPnlUsd > 0;
      const g = gated.metrics, u = ungated.metrics;
      const verdict = g.totalTrades < 15 ? "LOW_SAMPLE" : g.totalPnlUsd <= 0 ? "NET_NEGATIVE" : !both ? "REGIME_FRAGILE" : "SURVIVES";
      console.log(`  ${sig.id} (${sig.direction}):`);
      console.log(`    ungated: trades=${u.totalTrades} WR=${(u.winRate*100).toFixed(0)}% PF=${u.profitFactor.toFixed(2)} sharpe=${u.sharpeRatio.toFixed(1)} pnl=$${Math.round(u.totalPnlUsd)} maxDD=${(u.maxDrawdownPct*100).toFixed(1)}%`);
      console.log(`    4h-gated: trades=${g.totalTrades} WR=${(g.winRate*100).toFixed(0)}% PF=${g.profitFactor.toFixed(2)} sharpe=${g.sharpeRatio.toFixed(1)} pnl=$${Math.round(g.totalPnlUsd)} maxDD=${(g.maxDrawdownPct*100).toFixed(1)}% [H1 $${Math.round(gH1.metrics.totalPnlUsd)} | H2 $${Math.round(gH2.metrics.totalPnlUsd)}] -> ${verdict}`);
      out.push({ symbol, ltf: ltfName, signal: sig.id, direction: sig.direction,
        ungated: { trades: u.totalTrades, wr: u.winRate, pf: u.profitFactor, sharpe: u.sharpeRatio, pnl: Math.round(u.totalPnlUsd), maxDD: u.maxDrawdownPct },
        gated: { trades: g.totalTrades, wr: g.winRate, pf: g.profitFactor, sharpe: g.sharpeRatio, pnl: Math.round(g.totalPnlUsd), maxDD: g.maxDrawdownPct, h1: Math.round(gH1.metrics.totalPnlUsd), h2: Math.round(gH2.metrics.totalPnlUsd), verdict } });
    }
  }
}

writeFileSync("scripts/mtf-bias-output.json", JSON.stringify(out, null, 2));
console.log("\nWrote scripts/mtf-bias-output.json");
