/**
 * WARNING (2026-07-16): output from this script's original run fed
 * docs/FINAL-REPORT.md with numbers that don't reproduce. Same anti-pattern
 * as scripts/mega-sweep.ts: hand-rolled duplicate signal generators
 * (genLiqSweep, genBearishFVG, etc) inconsistent with the validated ones in
 * src/tools/backtest-tools.ts, no slippage modeled. The walk-forward SPLIT
 * methodology here (train/OOS by bar-index window) is sound and worth
 * reusing, but re-verify through runFuturesBacktest (real engine) instead of
 * runBT (this file's own copy) before trusting any numbers it produces — see
 * scripts/final-report-verify.ts for that redone correctly, and
 * strategies.json for the numbers that actually reproduce.
 *
 * Walk-forward validation for top strategies.
 * Tests parameter stability across 3 out-of-sample windows.
 *
 * Data: 2 years back
 * Folds: 3 windows, each train on ~12-18mo, test on ~4mo
 *
 * Survival criteria: OOS PnL positive in >=2 of 3 windows
 *
 * Usage: npx tsx scripts/walk-forward.ts
 */
import {
  ichimokuSeries, adxSeries, bollingerSeries, emaSeries, smaSeries,
  rsiSeries, superTrendSeries
} from "../src/tools/indicators.js";
import type { CandleHL } from "../src/tools/indicators.js";
import { parseKlineRows, type Candle } from "../src/backtest/types.js";

async function fetchRange(symbol: string, interval: string, days: number) {
  const all: any[] = [];
  let from = Date.now() - days * 24 * 60 * 60 * 1000;
  const end = Date.now();
  while (from < end) {
    const url = new URL("/api/v3/klines", "https://api.binance.com");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("startTime", String(from));
    const resp = await fetch(url);
    const rows = await resp.json() as unknown[][];
    if (rows.length === 0) break;
    all.push(...rows);
    from = Number(rows[rows.length - 1][0]) + 1;
    await new Promise(r => setTimeout(r, 30));
  }
  return parseKlineRows(all);
}

type SignalGen = (candles: Candle[]) => Array<{ idx: number }>;

function runBT(candles: Candle[], signals: Array<{ idx: number }>, stopPct: number, targetPct: number, maxHold: number, cap: number, lev: number, mpt: number, dir: "long"|"short" = "short") {
  const feeFrac = 5 / 10000;
  let capital = cap;
  const used = new Set<number>();
  const returns: number[] = [];
  let trades = 0, wins = 0;

  for (const sig of signals) {
    if (used.has(sig.idx) || capital <= 0) continue;
    const i = sig.idx;
    const ep = candles[i].close;
    const margin = capital * mpt;
    const notional = margin * lev;
    const qty = notional / ep;
    const sp = dir === "short" ? ep * (1 + stopPct) : ep * (1 - stopPct);
    const tp = dir === "short" ? ep * (1 - targetPct) : ep * (1 + targetPct);
    const lq = dir === "short" ? ep * (1 + 1/lev - 0.005) : ep * (1 - 1/lev + 0.005);

    let exitIdx = candles.length - 1, exitP = candles[exitIdx].close;
    for (let j = i + 1; j < candles.length && j <= i + maxHold; j++) {
      const b = candles[j];
      if (dir === "short" ? b.high >= lq : b.low <= lq) { exitIdx = j; exitP = lq; break; }
      if (dir === "short" ? b.low <= tp : b.high >= tp) { exitIdx = j; exitP = tp; break; }
      if (dir === "short" ? b.high >= sp : b.low <= sp) { exitIdx = j; exitP = sp; break; }
      if (j === i + maxHold) { exitIdx = j; exitP = b.close; break; }
    }
    const raw = (exitP - ep) * (dir === "short" ? -1 : 1) * qty;
    const pnl = raw - notional * feeFrac;
    capital += pnl; returns.push(pnl / margin);
    trades++; if (pnl > 0) wins++;
    for (let k = i; k <= exitIdx; k++) used.add(k);
  }
  const avgR = returns.length ? returns.reduce((s, v) => s + v, 0) / returns.length : 0;
  const var_ = returns.length > 1 ? returns.reduce((s, v) => s + (v - avgR)**2, 0) / (returns.length - 1) : 0;
  return { trades, wins, winRate: trades ? wins/trades : 0, totalPnl: capital - cap, sharpe: Math.sqrt(365*24)*avgR/(Math.sqrt(var_)||1) };
}

// ====== SIGNAL GENERATORS ======
function genLiqSweep(c: Candle[]): Array<{idx:number}> {
  const out: Array<{idx:number}> = [];
  for (let i = 10; i < c.length; i++) {
    const lk = 5;
    if (i < lk + 2 || i >= c.length - lk) continue;
    const left = c.slice(i-lk, i), right = c.slice(i+1, i+1+lk);
    if (right.length < lk) continue;
    const lh = Math.max(...left.map(x=>x.high)), rh = Math.max(...right.map(x=>x.high));
    if (c[i].high > lh && c[i].high > rh && c[i].low < c[i-1].low && c[i].close < c[i].open) out.push({idx:i});
  }
  return out;
}

function genBearishFVG(c: Candle[]): Array<{idx:number}> {
  const out: Array<{idx:number}> = [];
  for (let i = 2; i < c.length; i++) if (c[i-2].low > c[i].high) out.push({idx:i});
  return out;
}

function genIchimokuBelow(c: Candle[]): Array<{idx:number}> {
  const ichi = ichimokuSeries(c as CandleHL[]);
  const out: Array<{idx:number}> = [];
  for (let i = 52; i < c.length; i++) if (ichi[i]?.cloud === "below") out.push({idx:i});
  return out;
}

function genVolumeSpike(c: Candle[], mult=2, period=20): Array<{idx:number}> {
  const vol = c.map(x=>x.volume), vs = smaSeries(vol, period);
  const out: Array<{idx:number}> = [];
  for (let i = period+1; i < c.length; i++) if (vol[i] > vs[i] * mult && c[i].close < c[i].open) out.push({idx:i});
  return out;
}

function genADXDiCross(c: Candle[], period=14, thresh=20): Array<{idx:number}> {
  const a = adxSeries(c as CandleHL[], period);
  const out: Array<{idx:number}> = [];
  for (let i = period+2; i < a.length; i++) {
    const cur = a[i], prv = a[i-1];
    if (cur && prv && cur.adx > thresh && cur.minusDI > cur.plusDI && prv.minusDI <= prv.plusDI) out.push({idx:i});
  }
  return out;
}

function genSTShort(c: Candle[], period=7, mult=1): Array<{idx:number}> {
  const st = superTrendSeries(c as CandleHL[], period, mult);
  const out: Array<{idx:number}> = [];
  for (let i = period+2; i < st.length; i++) if (st[i].trend === "down" && st[i-1].trend !== "down") out.push({idx:i});
  return out;
}

function genRSIMR(c: Candle[], period=14, thresh=80): Array<{idx:number}> {
  const r = rsiSeries(c.map(x=>x.close), period);
  const out: Array<{idx:number}> = [];
  for (let i = period+2; i < r.length; i++) if (!isNaN(r[i]) && r[i] > thresh && r[i-1] <= thresh) out.push({idx:i});
  return out;
}

// ====== STRATEGY DEFINITIONS ======
interface WFStrategy {
  name: string; symbol: string; tf: string; gen: SignalGen;
  paramGrid?: Array<Record<string,any>>;
  getParams?: (g: SignalGen, c: Candle[]) => Record<string,any>;
}

const STRATS: WFStrategy[] = [
  // XRP
  { name: "Liq Sweep Short", symbol: "XRPUSDT", tf: "1h", gen: genLiqSweep },
  { name: "Liq Sweep Short 2h", symbol: "XRPUSDT", tf: "2h", gen: genLiqSweep },
  { name: "Bearish FVG Short", symbol: "XRPUSDT", tf: "1h", gen: genBearishFVG },
  { name: "Ichimoku Below Short", symbol: "XRPUSDT", tf: "4h", gen: genIchimokuBelow },
  { name: "Vol Spike Short", symbol: "XRPUSDT", tf: "4h", gen: (c) => genVolumeSpike(c, 3, 20) },
  { name: "ADX-DI Cross Short", symbol: "XRPUSDT", tf: "30m", gen: (c) => genADXDiCross(c, 14, 25) },
  { name: "ST Short 1d", symbol: "XRPUSDT", tf: "1d", gen: (c) => genSTShort(c, 7, 1) },
  // ETH
  { name: "Liq Sweep Short 2h", symbol: "ETHUSDT", tf: "2h", gen: genLiqSweep },
  { name: "Vol Spike Short 4h", symbol: "ETHUSDT", tf: "4h", gen: (c) => genVolumeSpike(c, 3, 15) },
  { name: "Vol Spike Short 1d", symbol: "ETHUSDT", tf: "1d", gen: (c) => genVolumeSpike(c, 1.5, 20) },
  { name: "ST Short 1d", symbol: "ETHUSDT", tf: "1d", gen: (c) => genSTShort(c, 10, 1.2) },
  { name: "Bearish FVG Short", symbol: "ETHUSDT", tf: "2h", gen: genBearishFVG },
  // SOL
  { name: "Liq Sweep Short 2h", symbol: "SOLUSDT", tf: "2h", gen: genLiqSweep },
  { name: "Vol Spike Short 1d", symbol: "SOLUSDT", tf: "1d", gen: (c) => genVolumeSpike(c, 1.5, 20) },
  { name: "Ichimoku Below Short", symbol: "SOLUSDT", tf: "4h", gen: genIchimokuBelow },
  { name: "ADX-DI Cross Short", symbol: "SOLUSDT", tf: "4h", gen: (c) => genADXDiCross(c, 14, 25) },
  { name: "ST Long 4h", symbol: "SOLUSDT", tf: "4h", gen: (c) => genSTShort(c, 14, 1.2) },
];

// ====== STOP/TARGET GRID ======
const STOP_TARGETS: Array<{stop:number;target:number}> = [
  {stop:0.01, target:0.03}, {stop:0.01, target:0.04}, {stop:0.01, target:0.06},
  {stop:0.02, target:0.04}, {stop:0.02, target:0.06}, {stop:0.02, target:0.08},
  {stop:0.03, target:0.05}, {stop:0.03, target:0.06}, {stop:0.03, target:0.08},
  {stop:0.04, target:0.06}, {stop:0.04, target:0.08}, {stop:0.04, target:0.12},
  {stop:0.05, target:0.10}, {stop:0.05, target:0.15}, {stop:0.08, target:0.15},
];

function maxHold(tf: string): number {
  if (tf === "5m") return 48; if (tf === "15m") return 48; if (tf === "30m") return 48;
  if (tf === "1h") return 48; if (tf === "2h") return 36; if (tf === "4h") return 24;
  return 20;
}

async function main() {
  const DAYS = 730; // 2 years

  interface FoldResult { window: number; OOS_trades: number; OOS_sharpe: number; OOS_pnl: number; }

  for (const strat of STRATS) {
    console.log(`\n=== ${strat.symbol} ${strat.tf} — ${strat.name} ===`);
    const allCandles = await fetchRange(strat.symbol, strat.tf, DAYS);
    const n = allCandles.length;
    console.log(`Total candles: ${n}`);
    if (n < 200) continue;

    // 3-fold walk-forward by bar index
    // Fold 1: train 0..50%, test 50..67%
    // Fold 2: train 0..60%, test 60..77%
    // Fold 3: train 0..70%, test 70..87%
    const splits = [
      [0.50, 0.67],
      [0.60, 0.77],
      [0.70, 0.87],
    ];
    const foldResults: FoldResult[] = [];

    for (let f = 0; f < splits.length; f++) {
      const [trainSplit, testEndSplit] = splits[f];
      const trainEnd = Math.floor(n * trainSplit);
      const testStart = trainEnd;
      const testEnd = Math.floor(n * testEndSplit);

      if (trainEnd < 60 || testEnd > n) continue;

      const trainData = allCandles.slice(0, trainEnd);
      const testData = allCandles.slice(testStart, testEnd);
      if (testData.length < 20) continue;

      // Determine direction from strategy name
      const isLong = strat.name.toLowerCase().includes("long");

      // Find best stop/target on TRAINING data
      const trainSignals = strat.gen(trainData);
      if (trainSignals.length < 5) continue;

      let bestSharpe = -Infinity, bestStop = 0, bestTarget = 0;
      for (const st of STOP_TARGETS) {
        if (st.stop > st.target * 0.7) continue;
        const mh = maxHold(strat.tf);
        const r = runBT(trainData, trainSignals, st.stop, st.target, mh, 10000, 10, 0.1, isLong ? "long" : "short");
        if (r.trades >= 3 && r.sharpe > bestSharpe) {
          bestSharpe = r.sharpe;
          bestStop = st.stop;
          bestTarget = st.target;
        }
      }

      if (bestSharpe === -Infinity || bestStop === 0) continue;

      // Test on OOS data
      const testSignals = strat.gen(testData);
      const oos = runBT(testData, testSignals, bestStop, bestTarget, maxHold(strat.tf), 10000, 10, 0.1, isLong ? "long" : "short");

      foldResults.push({
        window: f + 1,
        OOS_trades: oos.trades,
        OOS_sharpe: oos.sharpe,
        OOS_pnl: oos.totalPnl,
      });

      console.log(`  Fold ${f+1}: IS SR=${bestSharpe.toFixed(1)} stop=${(bestStop*100).toFixed(0)}% tgt=${(bestTarget*100).toFixed(0)}% → OOS ${oos.trades}tr SR=${oos.sharpe.toFixed(1)} PnL=$${oos.totalPnl.toFixed(0)}`);
    }

    // Summary
    const posWindows = foldResults.filter(r => r.OOS_pnl > 0).length;
    const avgOOSpnl = foldResults.length ? foldResults.reduce((s, r) => s + r.OOS_pnl, 0) / foldResults.length : 0;
    const totalOOSpnl = foldResults.reduce((s, r) => s + r.OOS_pnl, 0);
    const survived = posWindows >= 2 && foldResults.length >= 2 && totalOOSpnl > 0;
    console.log(`  => ${posWindows}/${foldResults.length} OOS windows profitable. Total OOS: $${totalOOSpnl.toFixed(0)}. ${survived ? "✓ SURVIVED" : "✗ FAILED"}`);
  }
}
main().catch(console.error);
