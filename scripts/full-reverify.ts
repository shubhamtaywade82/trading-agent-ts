import { fetchCandlesRange, runFuturesBacktest } from "../src/tools/backtest-tools.js";
import { ConceptsEngine } from "../src/concepts/adapter.js";
import { Candle } from "../src/backtest/types.js";
import { HTFContext } from "trading-concepts-ts";
import { readFileSync, writeFileSync } from "fs";

// Full reverification of strategies.json's SOL/ETH/XRP pool (Pass A), a curated
// confluence-combo sweep of ConceptsEngine flags on top of the proven base
// signals (Pass B), and a $100-account leverage/margin sweep for every
// survivor (Pass C). Everything runs through runFuturesBacktest — no
// duplicate simulation logic, matching this repo's validation culture (see
// strategies.json._verification for why that rule exists). Prints + writes
// scripts/full-reverify-output.json — never writes strategies.json.

const LEVERAGE = 5, MARGIN_PCT = 0.05, SLIPPAGE_BPS = 3, FEE_BPS = 5, CAP = 10000;
const TRAIN_START = Date.UTC(2023, 6, 16);
const FORWARD_START = Date.UTC(2026, 0, 1);
const NOW = Date.now();
const HTF_FOR_TF: Record<string, string> = { "30m": "4h", "1h": "4h", "2h": "1d", "4h": "1d" };
const MIN_TRADES_PER_HALF = 15;

const cfg = JSON.parse(readFileSync("strategies.json", "utf-8"));

const cache: Record<string, Candle[]> = {};
async function getCandles(symbol: string, tf: string, start = TRAIN_START, end = NOW): Promise<Candle[]> {
  const key = `${symbol}:${tf}`;
  if (cache[key]) return cache[key];
  const f = await fetchCandlesRange(symbol, tf, start, end);
  if ("error" in f) throw new Error(`${key}: ${f.message}`);
  cache[key] = f.candles;
  return f.candles;
}

function holdStats(trades: { holdMs: number }[], daysCovered: number) {
  if (trades.length === 0) return { minHoldHours: 0, maxHoldHours: 0, avgHoldHours: 0, daysCovered, intradayPct: 0, swingPct: 0 };
  const hours = trades.map(t => t.holdMs / 3.6e6);
  const intraday = trades.filter(t => t.holdMs < 8.64e7).length;
  return {
    minHoldHours: Math.min(...hours), maxHoldHours: Math.max(...hours),
    avgHoldHours: hours.reduce((s, h) => s + h, 0) / hours.length, daysCovered,
    intradayPct: intraday / trades.length, swingPct: 1 - intraday / trades.length,
  };
}

function pctDelta(newV: number, oldV: number): number { return oldV === 0 ? (newV === 0 ? 0 : Infinity) : (newV - oldV) / oldV; }

// ─────────────────────────── Pass A: pool reproduction ───────────────────────────

interface PassARow { symbol: string; id: string; label: string; tf: string; direction: "long" | "short"; entry: any[]; risk: any; recorded: any; full: any; train: any; forward: any; verdict: string; reconciliation: string; deltas: any; holdStats: any }

async function runPassA(): Promise<PassARow[]> {
  const rows: PassARow[] = [];
  for (const [sym, strats] of Object.entries(cfg.symbols) as [string, any[]][]) {
    console.log(`\n########## PASS A: ${sym} ##########`);
    for (const s of strats) {
      const tf = s.tf ?? "1h";
      const mh = s.maxHoldBars ?? 48;
      const all = await getCandles(sym, tf);
      const train = all.filter(c => c.openTime < FORWARD_START);
      const forward = all.filter(c => c.openTime >= FORWARD_START);

      const run = (candles: Candle[]) => runFuturesBacktest(candles, s.entry, s.direction, s.risk.stopPct, s.risk.targetPct, FEE_BPS, mh, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS) as any;
      const full = run(all), tr = run(train), fwd = run(forward);
      const days = all.length > 0 ? (all[all.length - 1].openTime - all[0].openTime) / 8.64e7 : 0;
      const hs = holdStats(full.trades, days);

      const rec = s.metrics;
      const deltas = {
        winRate: pctDelta(full.metrics.winRate, rec.winRate),
        pf: pctDelta(full.metrics.profitFactor, rec.pf),
        returnPct: pctDelta(full.metrics.totalReturnPct, rec.returnPct),
      };
      const reconciliation = Math.abs(deltas.winRate) <= 0.2 && Math.abs(deltas.pf) <= 0.2 && Math.abs(deltas.returnPct) <= 0.2 ? "PASS" : "FLAG";
      const verdict = tr.metrics.totalPnlUsd > 0 && fwd.metrics.totalPnlUsd > 0 && fwd.metrics.profitFactor > 1 ? "HOLDS"
        : tr.metrics.totalPnlUsd > 0 && fwd.metrics.totalPnlUsd <= 0 ? "FWD_FAIL"
        : tr.metrics.totalPnlUsd <= 0 ? "TRAIN_FAIL" : "MARGINAL";

      console.log(`  ${s.id}: verdict=${verdict} reconciliation=${reconciliation} full WR=${(full.metrics.winRate*100).toFixed(0)}% PF=${full.metrics.profitFactor.toFixed(2)} trades=${full.metrics.totalTrades} (recorded WR=${(rec.winRate*100).toFixed(0)}% PF=${rec.pf.toFixed(2)} trades=${rec.trades})`);

      rows.push({
        symbol: sym, id: s.id, label: s.label, tf, direction: s.direction, entry: s.entry, risk: s.risk,
        recorded: rec,
        full: full.metrics, train: tr.metrics, forward: fwd.metrics,
        verdict, reconciliation, deltas, holdStats: hs,
      });
    }
  }
  return rows;
}

// ─────────────────────────── Pass B: confluence combo sweep ───────────────────────────

type Direction = "long" | "short";
type Base = "concepts_bullish_fvg" | "concepts_bearish_fvg" | "concepts_buyside_sweep" | "concepts_sellside_sweep";

interface Candidate { symbol: string; tf: string; direction: Direction; base: Base; stopPct: number; targetPct: number; maxHoldBars: number; sourceStrategyId: string }

const CANDIDATES: Candidate[] = [
  { symbol: "XRPUSDT", tf: "1h", direction: "short", base: "concepts_bearish_fvg", stopPct: 0.03, targetPct: 0.06, maxHoldBars: 48, sourceStrategyId: "xrp-bearish-fvg-1h" },
  { symbol: "XRPUSDT", tf: "1h", direction: "short", base: "concepts_sellside_sweep", stopPct: 0.03, targetPct: 0.06, maxHoldBars: 48, sourceStrategyId: "xrp-liq-sweep-short-1h" },
  { symbol: "XRPUSDT", tf: "30m", direction: "short", base: "concepts_bearish_fvg", stopPct: 0.02, targetPct: 0.04, maxHoldBars: 48, sourceStrategyId: "xrp-liq-fvg-short-30m" },
  { symbol: "XRPUSDT", tf: "1h", direction: "long", base: "concepts_bullish_fvg", stopPct: 0.01, targetPct: 0.04, maxHoldBars: 48, sourceStrategyId: "xrp-liq-fvg-long-1h" },
  { symbol: "XRPUSDT", tf: "2h", direction: "short", base: "concepts_sellside_sweep", stopPct: 0.02, targetPct: 0.06, maxHoldBars: 36, sourceStrategyId: "xrp-liq-sweep-short-2h" },
  { symbol: "ETHUSDT", tf: "4h", direction: "long", base: "concepts_bullish_fvg", stopPct: 0.02, targetPct: 0.04, maxHoldBars: 42, sourceStrategyId: "eth-liq-fvg-long-4h" },
  { symbol: "ETHUSDT", tf: "1h", direction: "short", base: "concepts_bearish_fvg", stopPct: 0.02, targetPct: 0.02, maxHoldBars: 48, sourceStrategyId: "eth-bearish-fvg-1h" },
  { symbol: "ETHUSDT", tf: "30m", direction: "short", base: "concepts_bearish_fvg", stopPct: 0.008, targetPct: 0.04, maxHoldBars: 48, sourceStrategyId: "eth-liq-fvg-short-30m" },
  { symbol: "SOLUSDT", tf: "1h", direction: "short", base: "concepts_bearish_fvg", stopPct: 0.01, targetPct: 0.02, maxHoldBars: 48, sourceStrategyId: "sol-bearish-fvg-1h" },
  { symbol: "SOLUSDT", tf: "1h", direction: "short", base: "concepts_sellside_sweep", stopPct: 0.02, targetPct: 0.06, maxHoldBars: 48, sourceStrategyId: "sol-liq-sweep-short-1h" },
  { symbol: "SOLUSDT", tf: "1h", direction: "long", base: "concepts_bullish_fvg", stopPct: 0.01, targetPct: 0.02, maxHoldBars: 48, sourceStrategyId: "sol-liq-fvg-long-1h" },
  { symbol: "SOLUSDT", tf: "2h", direction: "short", base: "concepts_sellside_sweep", stopPct: 0.03, targetPct: 0.05, maxHoldBars: 36, sourceStrategyId: "sol-liq-sweep-short-2h" },
];

function htfContextFor(htfCandles: Candle[], asOfTime: number): HTFContext {
  const visible = htfCandles.filter(c => c.openTime <= asOfTime);
  return visible.length === 0 ? {} : new ConceptsEngine(visible).toHTFContext();
}

interface PassBRow { symbol: string; tf: string; direction: string; base: string; variant: string; sourceStrategyId: string; train: any; test: any; passes: boolean; evalForFull?: (candles: Candle[]) => (i: number) => boolean; candidate?: Candidate }

async function runPassB(): Promise<PassBRow[]> {
  const rows: PassBRow[] = [];
  for (const c of CANDIDATES) {
    const ltf = await getCandles(c.symbol, c.tf);
    const htfTf = HTF_FOR_TF[c.tf] ?? "4h";
    const htf = await getCandles(c.symbol, htfTf);
    const half = Math.floor(ltf.length / 2);
    const train = ltf.slice(0, half), test = ltf.slice(half);
    const modDir = c.direction === "long" ? "bullish" : "bearish";
    const zoneMod = c.direction === "short" ? "concepts_in_premium" : "concepts_in_discount";
    const cvdMod = c.direction === "short" ? "concepts_cvd_falling" : "concepts_cvd_rising";
    const vwapMod = c.direction === "short" ? "concepts_below_vwap" : "concepts_above_vwap";

    console.log(`\n########## PASS B: ${c.symbol} ${c.tf} ${c.direction} (${c.base}, risk from ${c.sourceStrategyId}) ##########`);

    const variants: { label: string; evalFor: (candles: Candle[]) => (i: number) => boolean }[] = [
      { label: "baseline", evalFor: (candles) => new ConceptsEngine(candles).evaluator([{ type: c.base }]) },
      { label: `+htf_aligned_${modDir}`, evalFor: (candles) => {
        const asOf = candles[candles.length - 1]?.openTime ?? 0;
        const htfContext = htfContextFor(htf, asOf);
        return new ConceptsEngine(candles, { htfContext }).evaluator([{ type: c.base }, { type: `concepts_htf_aligned_${modDir}` }]);
      } },
      { label: "+liquidity_swept_near", evalFor: (candles) => new ConceptsEngine(candles).evaluator([{ type: c.base }, { type: "concepts_liquidity_swept_near" }]) },
      { label: `+${zoneMod.replace("concepts_", "")}`, evalFor: (candles) => new ConceptsEngine(candles).evaluator([{ type: c.base }, { type: zoneMod }]) },
      { label: "+confluence_gte65", evalFor: (candles) => new ConceptsEngine(candles).evaluator([{ type: c.base }, { type: "concepts_confluence_gte", value: 65 }]) },
      { label: `+${cvdMod.replace("concepts_", "")}`, evalFor: (candles) => new ConceptsEngine(candles).evaluator([{ type: c.base }, { type: cvdMod }]) },
      { label: `+${vwapMod.replace("concepts_", "")}`, evalFor: (candles) => new ConceptsEngine(candles).evaluator([{ type: c.base }, { type: vwapMod }]) },
      { label: "+judas_swing", evalFor: (candles) => new ConceptsEngine(candles).evaluator([{ type: c.base }, { type: "concepts_judas_swing" }]) },
    ];

    for (const v of variants) {
      const trM = runFuturesBacktest(train, v.evalFor(train), c.direction, c.stopPct, c.targetPct, FEE_BPS, c.maxHoldBars, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS).metrics as any;
      const teM = runFuturesBacktest(test, v.evalFor(test), c.direction, c.stopPct, c.targetPct, FEE_BPS, c.maxHoldBars, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS).metrics as any;
      const passes = trM.totalPnlUsd > 0 && teM.totalPnlUsd > 0 && trM.totalTrades >= MIN_TRADES_PER_HALF && teM.totalTrades >= MIN_TRADES_PER_HALF;
      console.log(`  ${v.label}: train trades=${trM.totalTrades} WR=${(trM.winRate*100).toFixed(0)}% PF=${trM.profitFactor.toFixed(2)} | test trades=${teM.totalTrades} WR=${(teM.winRate*100).toFixed(0)}% PF=${teM.profitFactor.toFixed(2)} | PASS=${passes}`);
      rows.push({ symbol: c.symbol, tf: c.tf, direction: c.direction, base: c.base, variant: v.label, sourceStrategyId: c.sourceStrategyId, train: trM, test: teM, passes, evalForFull: v.evalFor, candidate: c });
    }
  }
  return rows;
}

// ─────────────────────────── Pass C: $100-account leverage sweep ───────────────────────────

const LEV_GRID = [1, 2, 3, 5, 8, 10, 15, 20, 25];
const MARGIN_GRID = [0.10, 0.25, 0.50, 1.0];
const CAP_100 = 100;

interface SweepCell { leverage: number; marginPct: number; totalReturnPct: number; maxDrawdownPct: number; finalCapital: number; ruin: boolean }
interface PassCRow { symbol: string; id: string; stopPct: number; sweep: SweepCell[]; bestNonRuin: SweepCell | null; liquidationSafeLeverageCeiling: number; kelly: { fraction: number; halfFraction: number } }

function kellyFraction(winRate: number, avgWinPct: number, avgLossPct: number): number {
  const b = avgLossPct === 0 ? 0 : avgWinPct / Math.abs(avgLossPct);
  if (!isFinite(b) || b <= 0) return 0;
  const k = winRate - (1 - winRate) / b;
  return Math.max(0, Math.min(1, k));
}

async function runPassC(passA: PassARow[], passB: PassBRow[]): Promise<PassCRow[]> {
  const rows: PassCRow[] = [];
  console.log(`\n########## PASS C: $100-account leverage sweep ##########`);

  for (const a of passA.filter(r => r.verdict === "HOLDS")) {
    const candles = await getCandles(a.symbol, a.tf);
    const sweep: SweepCell[] = [];
    for (const lev of LEV_GRID) for (const mp of MARGIN_GRID) {
      const m = runFuturesBacktest(candles, a.entry, a.direction, a.risk.stopPct, a.risk.targetPct, FEE_BPS, cfg.symbols[a.symbol].find((s: any) => s.id === a.id).maxHoldBars, CAP_100, lev, mp, SLIPPAGE_BPS).metrics as any;
      const ruin = m.maxDrawdownPct >= 0.9 || CAP_100 + m.totalPnlUsd <= 0;
      sweep.push({ leverage: lev, marginPct: mp, totalReturnPct: m.totalReturnPct, maxDrawdownPct: m.maxDrawdownPct, finalCapital: CAP_100 + m.totalPnlUsd, ruin });
    }
    const nonRuin = sweep.filter(c => !c.ruin);
    const best = nonRuin.length > 0 ? nonRuin.reduce((a, b) => (b.totalReturnPct > a.totalReturnPct ? b : a)) : null;
    const ceiling = 1 / (a.risk.stopPct + 0.005);
    const kelly = kellyFraction(a.full.winRate, a.full.avgWinPct, a.full.avgLossPct);
    console.log(`  ${a.id}: bestNonRuin=${best ? `${best.leverage}x/${(best.marginPct*100).toFixed(0)}% ret=${(best.totalReturnPct*100).toFixed(0)}% DD=${(best.maxDrawdownPct*100).toFixed(0)}%` : "NONE (all ruin)"} liqSafeCeiling=${ceiling.toFixed(1)}x kelly=${(kelly*100).toFixed(1)}%`);
    rows.push({ symbol: a.symbol, id: a.id, stopPct: a.risk.stopPct, sweep, bestNonRuin: best, liquidationSafeLeverageCeiling: ceiling, kelly: { fraction: kelly, halfFraction: kelly / 2 } });
  }

  for (const b of passB.filter(r => r.passes)) {
    const candles = await getCandles(b.symbol, b.tf);
    const c = b.candidate!;
    const evalFn = b.evalForFull!(candles);
    const sweep: SweepCell[] = [];
    for (const lev of LEV_GRID) for (const mp of MARGIN_GRID) {
      const m = runFuturesBacktest(candles, evalFn, c.direction, c.stopPct, c.targetPct, FEE_BPS, c.maxHoldBars, CAP_100, lev, mp, SLIPPAGE_BPS).metrics as any;
      const ruin = m.maxDrawdownPct >= 0.9 || CAP_100 + m.totalPnlUsd <= 0;
      sweep.push({ leverage: lev, marginPct: mp, totalReturnPct: m.totalReturnPct, maxDrawdownPct: m.maxDrawdownPct, finalCapital: CAP_100 + m.totalPnlUsd, ruin });
    }
    const nonRuin = sweep.filter(c => !c.ruin);
    const best = nonRuin.length > 0 ? nonRuin.reduce((a, b2) => (b2.totalReturnPct > a.totalReturnPct ? b2 : a)) : null;
    const ceiling = 1 / (c.stopPct + 0.005);
    const fullMetrics = runFuturesBacktest(candles, evalFn, c.direction, c.stopPct, c.targetPct, FEE_BPS, c.maxHoldBars, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS).metrics as any;
    const kelly = kellyFraction(fullMetrics.winRate, fullMetrics.avgWinPct, fullMetrics.avgLossPct);
    const id = `${b.symbol}-${b.base.replace("concepts_", "")}-${b.variant}-${b.tf}`;
    console.log(`  ${id}: bestNonRuin=${best ? `${best.leverage}x/${(best.marginPct*100).toFixed(0)}% ret=${(best.totalReturnPct*100).toFixed(0)}% DD=${(best.maxDrawdownPct*100).toFixed(0)}%` : "NONE (all ruin)"} liqSafeCeiling=${ceiling.toFixed(1)}x kelly=${(kelly*100).toFixed(1)}%`);
    rows.push({ symbol: b.symbol, id, stopPct: c.stopPct, sweep, bestNonRuin: best, liquidationSafeLeverageCeiling: ceiling, kelly: { fraction: kelly, halfFraction: kelly / 2 } });
  }
  return rows;
}

// ─────────────────────────── main ───────────────────────────

async function main() {
  const passA = await runPassA();
  const passB = await runPassB();
  const passC = await runPassC(passA, passB);

  const passBOut = passB.map(({ evalForFull, candidate, ...rest }) => rest);

  writeFileSync("scripts/full-reverify-output.json", JSON.stringify({ generatedAt: new Date().toISOString(), passA, passB: passBOut, passC }, null, 2));
  console.log("\nWrote scripts/full-reverify-output.json");

  console.log("\n\n═══ SUMMARY ═══");
  console.log(`Pass A: ${passA.filter(r => r.verdict === "HOLDS").length}/${passA.length} strategies HOLD; reconciliation PASS=${passA.filter(r => r.reconciliation === "PASS").length}/${passA.length}`);
  console.log(`Pass B: ${passB.filter(r => r.passes).length}/${passB.length} combo variants cleared the split-sample gate`);
  console.log("Pass B survivors:");
  for (const r of passB.filter(r => r.passes)) console.log(`  ${r.symbol} ${r.tf} ${r.base} ${r.variant} (risk from ${r.sourceStrategyId})`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
