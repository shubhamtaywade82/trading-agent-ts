import { fetchCandlesRange, runFuturesBacktest } from "../src/tools/backtest-tools.js";
import { readFileSync, writeFileSync } from "fs";

// 3-year train / 2026-YTD forward test of the whole validated pool.
//   Train:   2023-07-16 → 2026-01-01 (~2.5yr, data the strategies were NOT tuned on for most of it)
//   Forward: 2026-01-01 → now (~6.5mo TRUE holdout — every strategy in the pool
//            was selected on windows ending 2026-07; note 2025-07→2026-07 overlaps
//            selection, so the cleanest holdout reading is directional, not absolute)
//   Forward is run twice: native-TF resolution AND 5m sub-bar exit resolution
//   (resolves which of stop/target hit first inside a native bar).
const cfg = JSON.parse(readFileSync("strategies.json", "utf-8"));
const LEVERAGE = 5, MARGIN_PCT = 0.05, SLIPPAGE_BPS = 3, FEE_BPS = 5, CAP = 10000;

const TRAIN_START = Date.UTC(2023, 6, 16);
const FORWARD_START = Date.UTC(2026, 0, 1);
const NOW = Date.now();
const TF_MS: Record<string, number> = { "30m": 1.8e6, "1h": 3.6e6, "2h": 7.2e6, "4h": 1.44e7 };

const cache: Record<string, any[]> = {};
async function get(symbol: string, tf: string, start: number, end: number) {
  const key = `${symbol}:${tf}:${start}`;
  if (cache[key]) return cache[key];
  const f = await fetchCandlesRange(symbol, tf, start, end);
  if ("error" in f) throw new Error(`${key}: ${f.message}`);
  cache[key] = f.candles;
  return f.candles;
}

const rows: any[] = [];
for (const [sym, strats] of Object.entries(cfg.symbols) as [string, any[]][]) {
  console.log(`\n########## ${sym} ##########`);
  const sub5m = await get(sym, "5m", FORWARD_START, NOW);
  for (const s of strats) {
    const tf = s.tf ?? "1h";
    const mh = s.maxHoldBars ?? 48;
    const all = await get(sym, tf, TRAIN_START, NOW);
    const train = all.filter(c => c.openTime < FORWARD_START);
    const fwd = all.filter(c => c.openTime >= FORWARD_START);

    const run = (candles: any[], subs?: any[]) =>
      runFuturesBacktest(candles, s.entry, s.direction, s.risk.stopPct, s.risk.targetPct,
        FEE_BPS, mh, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS, undefined,
        subs ? { candles: subs, barMs: TF_MS[tf] } : undefined) as any;

    const tr = run(train).metrics;
    const fN = run(fwd).metrics;
    const f5 = run(fwd, sub5m).metrics;
    const fwdDays = (NOW - FORWARD_START) / 8.64e7;

    const fmtM = (m: any) => `tr=${m.totalTrades} WR=${(m.winRate*100).toFixed(0)}% PF=${m.profitFactor.toFixed(2)} SR=${m.sharpeRatio.toFixed(1)} pnl=$${Math.round(m.totalPnlUsd)} DD=${(m.maxDrawdownPct*100).toFixed(1)}%`;
    console.log(`${s.id} @ ${tf} stop=${(s.risk.stopPct*100).toFixed(1)}% tgt=${(s.risk.targetPct*100).toFixed(1)}%:`);
    console.log(`  TRAIN 2.5yr:      ${fmtM(tr)} (~$${Math.round(tr.totalPnlUsd/2.46)}/yr)`);
    console.log(`  FWD 2026 native:  ${fmtM(fN)} (~$${Math.round(fN.totalPnlUsd*365/fwdDays)}/yr pace)`);
    console.log(`  FWD 2026 5m-res:  ${fmtM(f5)} (~$${Math.round(f5.totalPnlUsd*365/fwdDays)}/yr pace)`);

    rows.push({
      symbol: sym, id: s.id, label: s.label, tf, direction: s.direction,
      entry: s.entry, risk: s.risk,
      train: { trades: tr.totalTrades, wr: tr.winRate, pf: tr.profitFactor, sharpe: tr.sharpeRatio, pnl: Math.round(tr.totalPnlUsd), maxDD: tr.maxDrawdownPct, pnlPerYr: Math.round(tr.totalPnlUsd/2.46) },
      fwdNative: { trades: fN.totalTrades, wr: fN.winRate, pf: fN.profitFactor, sharpe: fN.sharpeRatio, pnl: Math.round(fN.totalPnlUsd), maxDD: fN.maxDrawdownPct },
      fwd5m: { trades: f5.totalTrades, wr: f5.winRate, pf: f5.profitFactor, sharpe: f5.sharpeRatio, pnl: Math.round(f5.totalPnlUsd), maxDD: f5.maxDrawdownPct, pnlPerYrPace: Math.round(f5.totalPnlUsd*365/fwdDays) },
      verdict: tr.totalPnlUsd > 0 && f5.totalPnlUsd > 0 && f5.profitFactor > 1 ? "HOLDS"
        : tr.totalPnlUsd > 0 && f5.totalPnlUsd <= 0 ? "FWD_FAIL"
        : tr.totalPnlUsd <= 0 ? "TRAIN_FAIL" : "MARGINAL",
    });
  }
}

// Ranked summary per symbol by forward (5m-resolved) PF
console.log("\n\n═══ RANKED (per symbol, by forward-2026 5m-resolved PF) ═══");
for (const sym of Object.keys(cfg.symbols)) {
  console.log(`\n${sym}:`);
  rows.filter(r => r.symbol === sym).sort((a, b) => b.fwd5m.pf - a.fwd5m.pf)
    .forEach((r, i) => console.log(`  ${i+1}. ${r.id} [${r.verdict}] fwd PF=${r.fwd5m.pf.toFixed(2)} fwd pnl=$${r.fwd5m.pnl} train PF=${r.train.pf.toFixed(2)} train $/yr=$${r.train.pnlPerYr}`));
}

writeFileSync("scripts/train-forward-output.json", JSON.stringify(rows, null, 2));
console.log("\nWrote scripts/train-forward-output.json");
