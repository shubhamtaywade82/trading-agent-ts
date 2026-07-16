// WARNING (2026-07-16): output from this script is NOT trustworthy — do not
// feed it back into strategies.json. It imports runFuturesBacktest but never
// calls it, reimplementing its own liquidity-sweep/Ichimoku/FVG signal logic
// from scratch (inconsistent with the validated smcBearishLiqSweep/etc in
// src/tools/backtest-tools.ts), has NO split-sample or out-of-sample check,
// and picks the best Sharpe out of a large stop/target grid evaluated on the
// SAME window it reports results for (selection-bias overfitting). Spot
// check: its top claim (XRP "Liq Sweep + Ichimoku 2h": 19 trades/95% WR/
// Sharpe 137.6) reruns through the real engine at 13 trades/46% WR/Sharpe
// 18.0 (see scripts/megasweep-spotcheck.ts). Use scripts/day-trader-sweep.ts
// + scripts/day-trader-realistic-verify.ts instead — same idea, real engine,
// real split-sample validation.
import { ichimokuSeries, adxSeries, bollingerSeries, emaSeries, smaSeries, rsiSeries, superTrendSeries } from "../src/tools/indicators.js";
import type { CandleHL } from "../src/tools/indicators.js";
import { parseKlineRows, type Candle } from "../src/backtest/types.js";
import { runFuturesBacktest } from "../src/tools/backtest-tools.js";

// ====== FETCH ======
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

// ====== BACKTEST (custom, same engine as runFuturesBacktest) ======
interface BTInput {
  candles: Candle[];
  signals: Array<{ idx: number; side: "long" | "short" }>;
  stopPct: number;
  targetPct: number;
  maxHoldBars: number;
  initialCapital: number;
  leverage: number;
  marginPerTrade: number;
}
function runBT(inp: BTInput) {
  const { candles, signals, stopPct, targetPct, maxHoldBars, initialCapital, leverage, marginPerTrade } = inp;
  const feeFrac = 5 / 10000;
  let capital = initialCapital;
  const used = new Set<number>();
  const returns: number[] = [];
  const eq: number[] = [capital];
  let trades = 0, wins = 0, grossProfit = 0, grossLoss = 0;

  for (const sig of signals) {
    if (used.has(sig.idx) || capital <= 0) continue;
    const i = sig.idx;
    const entryPrice = candles[i].close;
    const margin = capital * marginPerTrade;
    const notional = margin * leverage;
    const qty = notional / entryPrice;
    const stopPrice = sig.side === "long" ? entryPrice * (1 - stopPct) : entryPrice * (1 + stopPct);
    const targetPrice = sig.side === "long" ? entryPrice * (1 + targetPct) : entryPrice * (1 - targetPct);
    const liqPrice = sig.side === "long" ? entryPrice * (1 - 1/leverage + 0.005) : entryPrice * (1 + 1/leverage - 0.005);

    let exitIdx = candles.length - 1;
    let exitPrice = candles[exitIdx].close;
    for (let j = i + 1; j < candles.length && j <= i + maxHoldBars; j++) {
      const b = candles[j];
      if (sig.side === "long" ? b.low <= liqPrice : b.high >= liqPrice) { exitIdx = j; exitPrice = liqPrice; break; }
      if (sig.side === "long" ? b.high >= targetPrice : b.low <= targetPrice) { exitIdx = j; exitPrice = targetPrice; break; }
      if (sig.side === "long" ? b.low <= stopPrice : b.high >= stopPrice) { exitIdx = j; exitPrice = stopPrice; break; }
      if (j === i + maxHoldBars) { exitIdx = j; exitPrice = b.close; break; }
    }
    const rawPnl = (exitPrice - entryPrice) * (sig.side === "long" ? 1 : -1) * qty;
    const pnl = rawPnl - notional * feeFrac;
    capital += pnl; eq.push(capital); returns.push(pnl / margin);
    trades++; if (pnl > 0) { wins++; grossProfit += pnl; } else grossLoss += Math.abs(pnl);
    for (let k = i; k <= exitIdx; k++) used.add(k);
  }

  const winRate = trades > 0 ? wins / trades : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const totalPnl = capital - initialCapital;
  const avgR = returns.length > 0 ? returns.reduce((s, v) => s + v, 0) / returns.length : 0;
  const variance = returns.length > 1 ? returns.reduce((s, v) => s + (v - avgR)**2, 0) / (returns.length - 1) : 0;
  const sharpe = Math.sqrt(365 * 24) * avgR / (Math.sqrt(variance) || 1);
  const totalRet = totalPnl / initialCapital;
  let peak = initialCapital, mdd = 0;
  for (const e of eq) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > mdd) mdd = dd; }
  return { trades, wins, winRate, profitFactor, totalPnl, sharpe, totalRet, maxDD: mdd, returns, eq };
}

// ====== CONFLUENCE SIGNAL GENERATORS ======
function ichimokuBelowShort(candles: Candle[]): Array<{ idx: number; side: "long" | "short" }> {
  const ichi = ichimokuSeries(candles as CandleHL[]);
  const out: Array<{ idx: number; side: "long" | "short" }> = [];
  for (let i = 52; i < ichi.length; i++) {
    if (ichi[i]?.cloud === "below") out.push({ idx: i, side: "short" });
  }
  return out;
}

function adxDiCrossShort(candles: Candle[], period = 14, adxThresh = 20): Array<{ idx: number; side: "long" | "short" }> {
  const adx = adxSeries(candles as CandleHL[], period);
  const out: Array<{ idx: number; side: "long" | "short" }> = [];
  for (let i = period + 2; i < adx.length; i++) {
    const cur = adx[i], prev = adx[i - 1];
    if (cur && prev && cur.adx > adxThresh && cur.minusDI > cur.plusDI && prev.minusDI <= prev.plusDI) {
      out.push({ idx: i, side: "short" });
    }
  }
  return out;
}

function volumeSpikeShort(candles: Candle[], volMult = 2, volPeriod = 20): Array<{ idx: number; side: "long" | "short" }> {
  const opens = candles.map(c => c.open);
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const volSma = smaSeries(volumes, volPeriod);
  const out: Array<{ idx: number; side: "long" | "short" }> = [];
  for (let i = volPeriod + 1; i < candles.length; i++) {
    if (volumes[i] > volSma[i] * volMult && closes[i] < opens[i]) {
      out.push({ idx: i, side: "short" });
    }
  }
  return out;
}

function liqSweepShort(candles: Candle[]): Array<{ idx: number; side: "long" | "short" }> {
  const result: Array<{ idx: number; side: "long" | "short" }> = [];
  for (let i = 10; i < candles.length; i++) {
    const look = 5;
    const left = candles.slice(i - look, i);
    const right = candles.slice(i + 1, i + 1 + look);
    if (left.length < look || right.length < look) continue;
    const leftHigh = Math.max(...left.map(c => c.high));
    const leftLow = Math.min(...left.map(c => c.low));
    const rightHigh = Math.max(...right.map(c => c.high));
    // swing high: current bar high > all left + right highs
    if (candles[i].high > leftHigh && candles[i].high > rightHigh) {
      // liq sweep: price dips below previous bar low then closes lower
      if (candles[i].low < candles[i - 1].low && candles[i].close < candles[i].open) {
        result.push({ idx: i, side: "short" });
      }
    }
  }
  return result;
}

function bearishFvgShort(candles: Candle[]): Array<{ idx: number; side: "long" | "short" }> {
  const out: Array<{ idx: number; side: "long" | "short" }> = [];
  for (let i = 2; i < candles.length; i++) {
    // FVG: candle[i-2].low > candle[i].high (gap between body 2 bars ago and current bar)
    if (candles[i - 2].low > candles[i].high) {
      out.push({ idx: i, side: "short" });
    }
  }
  return out;
}

function liqFvgLong(candles: Candle[]): Array<{ idx: number; side: "long" | "short" }> {
  const out: Array<{ idx: number; side: "long" | "short" }> = [];
  for (let i = 10; i < candles.length; i++) {
    const look = 5;
    const left = candles.slice(i - look, i);
    if (left.length < look) continue;
    const leftLow = Math.min(...left.map(c => c.low));
    if (candles[i].low < leftLow && candles[i].close > candles[i].open) {
      // check for FVG after sweep
      for (let j = i + 1; j < Math.min(i + 5, candles.length); j++) {
        if (candles[i].low > candles[j].high) {
          out.push({ idx: j, side: "long" });
          break;
        }
      }
    }
  }
  return out;
}

function superTrendShort(candles: Candle[], period = 10, mult = 1): Array<{ idx: number; side: "long" | "short" }> {
  const st = superTrendSeries(candles as CandleHL[], period, mult);
  const out: Array<{ idx: number; side: "long" | "short" }> = [];
  for (let i = period + 2; i < st.length; i++) {
    if (st[i].trend === "down" && st[i - 1].trend !== "down") out.push({ idx: i, side: "short" });
  }
  return out;
}

function superTrendLong(candles: Candle[], period = 10, mult = 1): Array<{ idx: number; side: "long" | "short" }> {
  const st = superTrendSeries(candles as CandleHL[], period, mult);
  const out: Array<{ idx: number; side: "long" | "short" }> = [];
  for (let i = period + 2; i < st.length; i++) {
    if (st[i].trend === "up" && st[i - 1].trend !== "up") out.push({ idx: i, side: "long" });
  }
  return out;
}

function rsiMrShort(candles: Candle[], period = 14, thresh = 80): Array<{ idx: number; side: "long" | "short" }> {
  const closes = candles.map(c => c.close);
  const r = rsiSeries(closes, period);
  const out: Array<{ idx: number; side: "long" | "short" }> = [];
  for (let i = period + 2; i < r.length; i++) {
    if (!isNaN(r[i]) && r[i] > thresh && r[i - 1] <= thresh) out.push({ idx: i, side: "short" });
  }
  return out;
}

function emaTrendShort(candles: Candle[], p1 = 20, p2 = 50): Array<{ idx: number; side: "long" | "short" }> {
  const closes = candles.map(c => c.close);
  const e1 = [...Array(closes.length - p1).fill(NaN), ...emaSeries(closes, p1)];
  const e2 = [...Array(closes.length - p2).fill(NaN), ...emaSeries(closes, p2)];
  const out: Array<{ idx: number; side: "long" | "short" }> = [];
  for (let i = p2 + 1; i < candles.length; i++) {
    if (closes[i] < e1[i] && closes[i] < e2[i] && e1[i] < e2[i]) out.push({ idx: i, side: "short" });
  }
  return out;
}

function emaTrendLong(candles: Candle[], p1 = 20, p2 = 50): Array<{ idx: number; side: "long" | "short" }> {
  const closes = candles.map(c => c.close);
  const e1 = [...Array(closes.length - p1).fill(NaN), ...emaSeries(closes, p1)];
  const e2 = [...Array(closes.length - p2).fill(NaN), ...emaSeries(closes, p2)];
  const out: Array<{ idx: number; side: "long" | "short" }> = [];
  for (let i = p2 + 1; i < candles.length; i++) {
    if (closes[i] > e1[i] && closes[i] > e2[i] && e1[i] > e2[i]) out.push({ idx: i, side: "long" });
  }
  return out;
}

function bollingerBounceShort(candles: Candle[], period = 20, k = 2): Array<{ idx: number; side: "long" | "short" }> {
  const closes = candles.map(c => c.close);
  const bb = bollingerSeries(closes, period, k);
  const out: Array<{ idx: number; side: "long" | "short" }> = [];
  for (let i = period + 1; i < candles.length; i++) {
    if (!isNaN(bb[i].upper) && closes[i] >= bb[i].upper && closes[i - 1] < bb[i - 1].upper) {
      out.push({ idx: i, side: "short" });
    }
  }
  return out;
}

function bollingerBounceLong(candles: Candle[], period = 20, k = 2): Array<{ idx: number; side: "long" | "short" }> {
  const closes = candles.map(c => c.close);
  const bb = bollingerSeries(closes, period, k);
  const out: Array<{ idx: number; side: "long" | "short" }> = [];
  for (let i = period + 1; i < candles.length; i++) {
    if (!isNaN(bb[i].lower) && closes[i] <= bb[i].lower && closes[i - 1] > bb[i - 1].lower) {
      out.push({ idx: i, side: "long" });
    }
  }
  return out;
}

// ====== CONFLUENCE COMBOS ======
// Combine multiple signal generators: signal fires when ALL generators fire on same bar
function confluenceSignals(generators: Array<(c: Candle[]) => Array<{ idx: number; side: "long" | "short" }>>, candles: Candle[]): Array<{ idx: number; side: "long" | "short" }> {
  const allSets = generators.map(gen => gen(candles));
  if (allSets.length === 0) return [];
  // Build a map of {idx -> count} for each set
  const counts = new Map<number, number>();
  for (const set of allSets) {
    const seen = new Set<number>();
    for (const s of set) {
      if (!seen.has(s.idx)) {
        counts.set(s.idx, (counts.get(s.idx) || 0) + 1);
        seen.add(s.idx);
      }
    }
  }
  const out: Array<{ idx: number; side: "long" | "short" }> = [];
  for (const [idx, count] of counts) {
    if (count === allSets.length) out.push({ idx, side: "short" });
  }
  return out;
}

// ====== MAIN ======
interface SweepResult {
  symbol: string;
  tf: string;
  strategy: string;
  params: string;
  trades: number;
  winRate: number;
  sharpe: number;
  totalPnl: number;
  profitFactor: number;
  maxDD: number;
}

function sortKey(r: SweepResult) {
  // Sort by Sharpe, but penalize <20 trades or >50% DD
  if (r.trades < 15 || r.maxDD > 0.5 || r.totalPnl < 0) return -Infinity;
  return r.sharpe;
}

// TF configs
const TF_CONFIGS: Array<{ tf: string; days: number; stops: number[]; targets: number[]; maxHold: number }> = [
  { tf: "5m",  days: 60,  stops: [0.003, 0.005, 0.008, 0.01],   targets: [0.005, 0.01, 0.015, 0.02, 0.03],  maxHold: 48 },
  { tf: "15m", days: 120, stops: [0.005, 0.008, 0.01, 0.015],  targets: [0.01, 0.015, 0.02, 0.03, 0.04],   maxHold: 48 },
  { tf: "30m", days: 180, stops: [0.005, 0.01, 0.015, 0.02],   targets: [0.01, 0.02, 0.03, 0.04, 0.06],   maxHold: 48 },
  { tf: "1h",  days: 365, stops: [0.01, 0.015, 0.02, 0.03],    targets: [0.02, 0.03, 0.04, 0.06, 0.08],   maxHold: 48 },
  { tf: "2h",  days: 365, stops: [0.01, 0.02, 0.03, 0.04],     targets: [0.02, 0.04, 0.06, 0.08, 0.12],   maxHold: 36 },
  { tf: "4h",  days: 365, stops: [0.015, 0.02, 0.03, 0.04],    targets: [0.03, 0.04, 0.06, 0.08, 0.12],   maxHold: 24 },
  { tf: "1d",  days: 730, stops: [0.02, 0.03, 0.05, 0.08],     targets: [0.04, 0.06, 0.1, 0.15, 0.2],     maxHold: 20 },
];

// Strategy definitions
interface StrategyDef {
  name: string;
  paramsList: Record<string, any[]>;
  gen: (c: Candle[], params: Record<string, any>) => Array<{ idx: number; side: "long" | "short" }>;
}
const STRATEGIES: StrategyDef[] = [
  {
    name: "ichi-below-short",
    paramsList: {},
    gen: (_c, _p) => ichimokuBelowShort(_c),
  },
  {
    name: "adx-di-cross-short",
    paramsList: { period: [9, 14], adxThresh: [15, 20, 25] },
    gen: (c, p) => adxDiCrossShort(c, p.period, p.adxThresh),
  },
  {
    name: "vol-spike-short",
    paramsList: { volMult: [1.5, 2, 3], volPeriod: [15, 20] },
    gen: (c, p) => volumeSpikeShort(c, p.volMult, p.volPeriod),
  },
  {
    name: "liq-sweep-short",
    paramsList: {},
    gen: (c, _p) => liqSweepShort(c),
  },
  {
    name: "bearish-fvg-short",
    paramsList: {},
    gen: (c, _p) => bearishFvgShort(c),
  },
  {
    name: "liq-fvg-long",
    paramsList: {},
    gen: (c, _p) => liqFvgLong(c),
  },
  {
    name: "st-short",
    paramsList: { period: [7, 10, 14], mult: [1, 1.2] },
    gen: (c, p) => superTrendShort(c, p.period, p.mult),
  },
  {
    name: "st-long",
    paramsList: { period: [7, 10, 14], mult: [1, 1.2] },
    gen: (c, p) => superTrendLong(c, p.period, p.mult),
  },
  {
    name: "rsi-mr-short",
    paramsList: { period: [7, 14], thresh: [75, 80, 85] },
    gen: (c, p) => rsiMrShort(c, p.period, p.thresh),
  },
  {
    name: "ema-trend-short",
    paramsList: { p1: [10, 20], p2: [30, 50] },
    gen: (c, p) => emaTrendShort(c, p.p1, p.p2),
  },
  {
    name: "ema-trend-long",
    paramsList: { p1: [10, 20], p2: [30, 50] },
    gen: (c, p) => emaTrendLong(c, p.p1, p.p2),
  },
  {
    name: "bb-bounce-short",
    paramsList: { period: [15, 20], k: [2, 2.5] },
    gen: (c, p) => bollingerBounceShort(c, p.period, p.k),
  },
  {
    name: "bb-bounce-long",
    paramsList: { period: [15, 20], k: [2, 2.5] },
    gen: (c, p) => bollingerBounceLong(c, p.period, p.k),
  },
  // Confluence combos
  {
    name: "CONFLUENCE: liq-sweep+fvg-short",
    paramsList: {},
    gen: (c, _p) => confluenceSignals([liqSweepShort, bearishFvgShort], c),
  },
  {
    name: "CONFLUENCE: liq-sweep+vol-spike-short",
    paramsList: { volMult: [2], volPeriod: [20] },
    gen: (c, p) => confluenceSignals([liqSweepShort, (cc) => volumeSpikeShort(cc, p.volMult, p.volPeriod)], c),
  },
  {
    name: "CONFLUENCE: ichi+adx-short",
    paramsList: { period: [14], adxThresh: [20] },
    gen: (c, p) => confluenceSignals([ichimokuBelowShort, (cc) => adxDiCrossShort(cc, p.period, p.adxThresh)], c),
  },
  {
    name: "CONFLUENCE: ichi+vol-short",
    paramsList: { volMult: [2], volPeriod: [20] },
    gen: (c, p) => confluenceSignals([ichimokuBelowShort, (cc) => volumeSpikeShort(cc, p.volMult, p.volPeriod)], c),
  },
  {
    name: "CONFLUENCE: adx+vol-short",
    paramsList: { period: [14], adxThresh: [20], volMult: [2], volPeriod: [20] },
    gen: (c, p) => confluenceSignals([(cc) => adxDiCrossShort(cc, p.period, p.adxThresh), (cc) => volumeSpikeShort(cc, p.volMult, p.volPeriod)], c),
  },
  {
    name: "CONFLUENCE: liq-sweep+ichi-short",
    paramsList: {},
    gen: (c, _p) => confluenceSignals([liqSweepShort, ichimokuBelowShort], c),
  },
  {
    name: "CONFLUENCE: fvg+vol-short",
    paramsList: { volMult: [2], volPeriod: [20] },
    gen: (c, p) => confluenceSignals([bearishFvgShort, (cc) => volumeSpikeShort(cc, p.volMult, p.volPeriod)], c),
  },
];

function cartesianProduct<T>(...arrays: T[][]): T[][] {
  return arrays.reduce<T[][]>((acc, curr) =>
    acc.flatMap(a => curr.map(b => [...a, b])), [[]]);
}

function expandParams(def: StrategyDef): Record<string, any>[] {
  const keys = Object.keys(def.paramsList);
  if (keys.length === 0) return [{}];
  const values = keys.map(k => def.paramsList[k]);
  const combos = cartesianProduct(...values);
  return combos.map(combo => {
    const obj: Record<string, any> = {};
    keys.forEach((k, i) => obj[k] = combo[i]);
    return obj;
  });
}

async function main() {
  const symbols = ["XRPUSDT", "ETHUSDT", "SOLUSDT"];
  const allResults: SweepResult[] = [];
  const CAP = 10000, LEV = 10, MPT = 0.1;

  for (const symbol of symbols) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`SYMBOL: ${symbol}`);
    console.log(`=".repeat(80)}`);

    for (const tfc of TF_CONFIGS) {
      console.log(`\n--- ${symbol} ${tfc.tf} (${tfc.days}d) ---`);
      const candles = await fetchRange(symbol, tfc.tf, tfc.days);
      console.log(`Candles: ${candles.length}`);

      for (const strat of STRATEGIES) {
        const paramCombos = expandParams(strat);
        for (const params of paramCombos) {
          const signals = strat.gen(candles, params);
          if (signals.length < 5) continue; // skip if too few signals

          const paramStr = Object.values(params).join(",") || "default";
          let bestSharpe = -Infinity;
          let bestResult: SweepResult | null = null;

          for (const stop of tfc.stops) {
            for (const target of tfc.targets) {
              const r = runBT({ candles, signals, stopPct: stop, targetPct: target, maxHoldBars: tfc.maxHold, initialCapital: CAP, leverage: LEV, marginPerTrade: MPT });
              if (r.trades < 3) continue;
              const sr: SweepResult = {
                symbol, tf: tfc.tf, strategy: strat.name, params: paramStr,
                trades: r.trades, winRate: r.winRate, sharpe: r.sharpe,
                totalPnl: r.totalPnl, profitFactor: r.profitFactor, maxDD: r.maxDD,
              };
              if (r.sharpe > bestSharpe) { bestSharpe = r.sharpe; bestResult = sr; }
            }
          }

          if (bestResult && bestResult.sharpe > 1) {
            allResults.push(bestResult);
            console.log(`  ${strat.name}(${paramStr}): ${bestResult.trades} trades, WR ${(bestResult.winRate*100).toFixed(0)}%, PnL $${bestResult.totalPnl.toFixed(0)}, SR ${bestResult.sharpe.toFixed(1)}, DD ${(bestResult.maxDD*100).toFixed(0)}%`);
          }
        }
      }
    }
  }

  // ====== REPORT ======
  console.log(`\n\n${"=".repeat(100)}`);
  console.log(`TOP RESULTS BY SHARPE (min 15 trades, maxDD < 50%, positive PnL)`);
  console.log(`=".repeat(100)}`);
  
  const filtered = allResults.filter(r => sortKey(r) > -Infinity);
  filtered.sort((a, b) => b.sharpe - a.sharpe);
  
  // Group by strategy
  const byStrat = new Map<string, SweepResult[]>();
  for (const r of filtered) {
    if (!byStrat.has(r.strategy)) byStrat.set(r.strategy, []);
    byStrat.get(r.strategy)!.push(r);
  }

  for (const [strat, results] of byStrat) {
    console.log(`\n--- ${strat} ---`);
    results.slice(0, 5).forEach(r => {
      console.log(`  ${r.symbol} ${r.tf} (${r.params}): ${r.trades} tr, WR ${(r.winRate*100).toFixed(0)}%, $${r.totalPnl.toFixed(0)}, SR ${r.sharpe.toFixed(1)}, DD ${(r.maxDD*100).toFixed(0)}%`);
    });
  }

  // All results sorted
  console.log(`\n\n--- OVERALL TOP 30 ---`);
  filtered.slice(0, 30).forEach((r, i) => {
    console.log(`${(i+1).toString().padStart(2)}. ${r.strategy.padEnd(30)} ${r.symbol.padEnd(8)} ${r.tf.padEnd(4)} ${r.params.padEnd(10)} ${r.trades.toString().padStart(4)} tr  WR ${(r.winRate*100).toFixed(0).padStart(2)}%  $${r.totalPnl.toFixed(0).padStart(6)}  SR ${r.sharpe.toFixed(1).padStart(5)}  DD ${(r.maxDD*100).toFixed(0).padStart(2)}%`);
  });
}
main().catch(console.error);
