import type { Candle } from "../backtest/types.js";
import {
  legacyBullishOb, legacyBearishOb, legacyBullishFvg, legacyBearishFvg,
  legacyBullishLiqSweep, legacyBearishLiqSweep, legacyDisplacement,
  legacyObRetestLong, legacyObRetestShort,
} from "../concepts/legacy-conditions.js";

import { smaSeries, emaSeries, rsiSeries, macdSeries, bollingerSeries, superTrendSeries, adxSeries, ichimokuSeries } from "./indicators.js";

// ── Shared signal evaluator ──
// Precomputes every indicator array an entry-condition set might need, then
// Returns a per-bar (i) => boolean check. This is THE single source of truth
// For "does this strategy's entry condition fire on bar i" — used by
// RunFuturesBacktest below AND by the live paper-trading runner
// (src/paper-trading/live-runner.ts). Every prior round of this research hit
// The same bug repeatedly: a second, hand-rolled copy of this logic
// (mega-sweep.ts, walk-forward.ts, signal-scanner.ts, new-strats-backtest.ts)
// Drifting from this one and producing numbers that don't reproduce. Do not
// Reimplement this switch anywhere else — import buildSignalEvaluator.
export function buildSignalEvaluator(
  candles: Candle[],
  entryConditions: Array<{ type: string; period?: number; value?: number }>,
  extraSeries?: { oi?: number[] },
): (i: number) => boolean {
  const closes = candles.map(c => c.close);
  const smaP = new Set<number>(); const emaP = new Set<number>(); const rsiP = new Set<number>();
  let needMacd = false; let needBB = false; let needSmc = false;
  let needSuperTrend = false; let needAdx = false; let needIchimoku = false;
  const condTypes = entryConditions.map(c => c.type);
  const SMC_TYPES = new Set([
    "bearish_ob", "bullish_ob", "bearish_fvg", "bullish_fvg",
    "bearish_liq_sweep", "bullish_liq_sweep", "bearish_displacement", "bullish_displacement",
    "bearish_liq_ob", "bullish_liq_ob", "bearish_liq_fvg", "bullish_liq_fvg",
    "bearish_bos_displacement", "bullish_bos_displacement",
    "bearish_htf_trend_short", "bullish_htf_trend_long",
  ]);
  const SUPERTREND_TYPES = new Set(["supertrend_bullish_flip", "supertrend_bearish_flip"]);
  const ADX_TYPES = new Set(["adx_bullish_trend", "adx_bearish_trend", "adx_di_cross_long", "adx_di_cross_short"]);
  const ICHIMOKU_TYPES = new Set(["ichimoku_bullish_breakout", "ichimoku_bearish_breakout", "ichimoku_above_cloud_long", "ichimoku_below_cloud_short"]);
  let needVolume = false;
  for (const t of condTypes) {
    if (t.includes("sma")) smaP.add(entryConditions.find(c => c.type === t)?.period ?? 20);
    if (t.includes("ema")) emaP.add(entryConditions.find(c => c.type === t)?.period ?? 20);
    if (t.includes("rsi")) rsiP.add(entryConditions.find(c => c.type === t)?.period ?? 14);
    if (t.includes("macd")) needMacd = true;
    if (t.includes("bollinger")) needBB = true;
    if (SMC_TYPES.has(t)) needSmc = true;
    if (SUPERTREND_TYPES.has(t)) needSuperTrend = true;
    if (ADX_TYPES.has(t)) needAdx = true;
    if (ICHIMOKU_TYPES.has(t)) needIchimoku = true;
    if (t === "volume_spike_long" || t === "volume_spike_short") needVolume = true;
  }
  const smaMap = new Map<number, number[]>();
  const emaMap = new Map<number, number[]>();
  const rsiMap = new Map<number, number[]>();
  for (const p of smaP) smaMap.set(p, smaSeries(closes, p));
  for (const p of emaP) { const raw = emaSeries(closes, p); emaMap.set(p, [...Array.from({ length: Math.max(0, closes.length - raw.length) }, () => NaN), ...raw]); }
  for (const p of rsiP) rsiMap.set(p, rsiSeries(closes, p));
  const macdArr = needMacd ? macdSeries(closes) : [];
  const bbArr = needBB ? bollingerSeries(closes) : [];

  // SMC/ICT precompute — same detectors the signal-fusion tool uses, wired
  // In here so single-strategy standalone backtests can actually test them
  // (previously only reachable inside BinanceSignalFusionTool).
  const n = closes.length;
  let ob_bull: boolean[] = [], ob_bear: boolean[] = [], fvg_bull: boolean[] = [], fvg_bear: boolean[] = [];
  let disp_bull: boolean[] = [], disp_bear: boolean[] = [], liq_bull: boolean[] = [], liq_bear: boolean[] = [];
  let liqob_bull: boolean[] = [], liqob_bear: boolean[] = [], liqfvg_bull: boolean[] = [], liqfvg_bear: boolean[] = [];
  let htfShort: boolean[] = [], htfLong: boolean[] = [];
  if (needSmc) {
    ob_bull = new Array(n).fill(false); ob_bear = new Array(n).fill(false);
    fvg_bull = new Array(n).fill(false); fvg_bear = new Array(n).fill(false);
    disp_bull = new Array(n).fill(false); disp_bear = new Array(n).fill(false);
    liq_bull = new Array(n).fill(false); liq_bear = new Array(n).fill(false);
    liqob_bull = new Array(n).fill(false); liqob_bear = new Array(n).fill(false);
    liqfvg_bull = new Array(n).fill(false); liqfvg_bear = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      const oB = legacyBullishOb(candles, i);
      const oS = legacyBearishOb(candles, i);
      ob_bull[i] = oB; ob_bear[i] = oS;
      fvg_bull[i] = legacyBullishFvg(candles, i);
      fvg_bear[i] = legacyBearishFvg(candles, i);
      const d = legacyDisplacement(candles, i);
      disp_bull[i] = d?.dir === "up"; disp_bear[i] = d?.dir === "down";
      liq_bull[i] = legacyBullishLiqSweep(candles, i);
      liq_bear[i] = legacyBearishLiqSweep(candles, i);
      const lb = liq_bull[i];
      if (lb === undefined) continue;
      liqob_bull[i] = lb && oB;
      const ls = liq_bear[i];
      if (ls === undefined) continue;
      liqob_bear[i] = ls && oS;
      const fb = fvg_bull[i];
      if (fb === undefined) continue;
      liqfvg_bull[i] = lb && fb;
      const fs = fvg_bear[i];
      if (fs === undefined) continue;
      liqfvg_bear[i] = ls && fs;
    }
    if (condTypes.includes("bearish_htf_trend_short")) {
      htfShort = new Array(n).fill(false);
      for (let i = 50; i < n; i++) {
        const c1 = closes[i - 1], c2 = closes[i - 2], c3 = closes[i - 3], c4 = closes[i - 4], c5 = closes[i - 5];
        if (c1 === undefined || c2 === undefined || c3 === undefined || c4 === undefined || c5 === undefined) continue;
        const ci = closes[i];
        if (ci === undefined) continue;
        const ob = ob_bear[i];
        if (ob === undefined) continue;
        const avg = (c1 + c2 + c3 + c4 + c5) / 5;
        htfShort[i] = ci < avg * 0.98 && ob;
      }
    }
    if (condTypes.includes("bullish_htf_trend_long")) {
      htfLong = new Array(n).fill(false);
      for (let i = 50; i < n; i++) {
        const c1 = closes[i - 1], c2 = closes[i - 2], c3 = closes[i - 3], c4 = closes[i - 4], c5 = closes[i - 5];
        if (c1 === undefined || c2 === undefined || c3 === undefined || c4 === undefined || c5 === undefined) continue;
        const ci = closes[i];
        if (ci === undefined) continue;
        const ob = ob_bull[i];
        if (ob === undefined) continue;
        const avg = (c1 + c2 + c3 + c4 + c5) / 5;
        htfLong[i] = ci > avg * 1.02 && ob;
      }
    }
  }

  // LuxAlgo-style trend indicators — SuperTrend (ATR-trailed flip), ADX/DMI
  // (trend strength + direction), Ichimoku Cloud (kumo breakout).
  const superTrend = needSuperTrend ? superTrendSeries(candles, 10, 3) : [];
  const adx = needAdx ? adxSeries(candles, 14) : [];
  const ichimoku = needIchimoku ? ichimokuSeries(candles) : [];
  const volSma20 = needVolume ? smaSeries(candles.map(c => c.volume), 20) : [];

  return (i: number) => entryConditions.every(c => {
      const val = (m: Map<number, number[]>, p: number) => m.get(p)?.[i];
      switch (c.type) {
        case "rsi_below": { const x = val(rsiMap, c.period ?? 14); return x !== undefined && !Number.isNaN(x) && x < (c.value ?? 30); }
        case "rsi_above": { const x = val(rsiMap, c.period ?? 14); return x !== undefined && !Number.isNaN(x) && x > (c.value ?? 70); }
        case "price_above_sma": { const x = val(smaMap, c.period ?? 20); const ci = closes[i]; return ci !== undefined && x !== undefined && !Number.isNaN(x) && ci > x; }
        case "price_below_sma": { const x = val(smaMap, c.period ?? 20); const ci = closes[i]; return ci !== undefined && x !== undefined && !Number.isNaN(x) && ci < x; }
        case "price_above_ema": { const x = val(emaMap, c.period ?? 20); const ci = closes[i]; return ci !== undefined && x !== undefined && !Number.isNaN(x) && ci > x; }
        case "price_below_ema": { const x = val(emaMap, c.period ?? 20); const ci = closes[i]; return ci !== undefined && x !== undefined && !Number.isNaN(x) && ci < x; }
        case "macd_bullish_cross": { const cur = macdArr[i]; const prev = macdArr[i-1]; return !!cur && !!prev && !Number.isNaN(cur.macd) && !Number.isNaN(prev.macd) && prev.macd <= prev.signal && cur.macd > cur.signal; }
        case "macd_bearish_cross": { const cur = macdArr[i]; const prev = macdArr[i-1]; return !!cur && !!prev && !Number.isNaN(cur.macd) && !Number.isNaN(prev.macd) && prev.macd >= prev.signal && cur.macd < cur.signal; }
        case "bollinger_touch_lower": { const b = bbArr[i]; const ci = closes[i]; return ci !== undefined && !!b && !Number.isNaN(b.lower) && ci <= b.lower; }
        case "bollinger_touch_upper": { const b = bbArr[i]; const ci = closes[i]; return ci !== undefined && !!b && !Number.isNaN(b.upper) && ci >= b.upper; }
        case "bearish_ob": { return ob_bear[i];
        }
        case "bullish_ob": { return ob_bull[i];
        }
        case "bearish_fvg": { return fvg_bear[i];
        }
        case "bullish_fvg": { return fvg_bull[i];
        }
        case "bearish_liq_sweep": { return liq_bear[i];
        }
        case "bullish_liq_sweep": { return liq_bull[i];
        }
        case "bearish_displacement": case "bearish_bos_displacement": { return disp_bear[i];
 }
        case "bullish_displacement": case "bullish_bos_displacement": { return disp_bull[i];
 }
        case "bearish_liq_ob": { return liqob_bear[i];
        }
        case "bullish_liq_ob": { return liqob_bull[i];
        }
        case "bearish_liq_fvg": { return liqfvg_bear[i];
        }
        case "bullish_liq_fvg": { return liqfvg_bull[i];
        }
        case "bearish_htf_trend_short": { return htfShort[i] ?? false;
        }
        case "bullish_htf_trend_long": { return htfLong[i] ?? false;
        }
        case "supertrend_bullish_flip": { return i > 0 && superTrend[i]?.trend === "up" && superTrend[i - 1]?.trend === "down";
        }
        case "supertrend_bearish_flip": { return i > 0 && superTrend[i]?.trend === "down" && superTrend[i - 1]?.trend === "up";
        }
        case "adx_bullish_trend": { const a = adx[i]; return !!a && !Number.isNaN(a.adx) && a.adx > (c.value ?? 25) && a.plusDI > a.minusDI; }
        case "adx_bearish_trend": { const a = adx[i]; return !!a && !Number.isNaN(a.adx) && a.adx > (c.value ?? 25) && a.minusDI > a.plusDI; }
        case "ichimoku_bullish_breakout": { return i > 0 && ichimoku[i]?.cloud === "above" && ichimoku[i - 1]?.cloud !== "above";
        }
        case "ichimoku_bearish_breakout": { return i > 0 && ichimoku[i]?.cloud === "below" && ichimoku[i - 1]?.cloud !== "below";
        }
        case "ichimoku_above_cloud_long": { return ichimoku[i]?.cloud === "above";
        }
        case "ichimoku_below_cloud_short": { return ichimoku[i]?.cloud === "below";
        }
        case "adx_di_cross_long": { const a = adx[i]; const pv = adx[i - 1]; return i > 0 && !!a && !!pv && !Number.isNaN(a.adx) && a.adx > (c.value ?? 20) && a.plusDI > a.minusDI && pv.plusDI <= pv.minusDI; }
        case "adx_di_cross_short": { const a = adx[i]; const pv = adx[i - 1]; return i > 0 && !!a && !!pv && !Number.isNaN(a.adx) && a.adx > (c.value ?? 20) && a.minusDI > a.plusDI && pv.minusDI <= pv.plusDI; }
        case "volume_spike_long": {
          const vol = volSma20[i];
          const candle = candles[i];
          if (vol === undefined || candle === undefined) return false;
          return !Number.isNaN(vol) && candle.volume > vol * 2 && candle.close > candle.open;
        }
        case "volume_spike_short": {
          const vol = volSma20[i];
          const candle = candles[i];
          if (vol === undefined || candle === undefined) return false;
          return !Number.isNaN(vol) && candle.volume > vol * 2 && candle.close < candle.open;
        }
        case "ob_retest_long": { return legacyObRetestLong(candles, i);
        }
        case "ob_retest_short": { return legacyObRetestShort(candles, i);
        }
        case "oi_bearish_divergence": {
          const oi = extraSeries?.oi;
          const period = c.period ?? 10;
          if (!oi || i < period) return false;
          const oiNow = oi[i], oiPast = oi[i - period];
          if (oiNow === undefined || oiPast === undefined || Number.isNaN(oiNow) || Number.isNaN(oiPast) || oiPast === 0) return false;
          const oiChange = (oiNow - oiPast) / oiPast;
          const priorHigh = Math.max(...closes.slice(i - period, i).filter((v): v is number => v !== undefined));
          const ci = closes[i];
          return ci !== undefined && ci > priorHigh && oiChange < -(c.value ?? 0.03);
        }
        case "oi_bullish_divergence": {
          const oi = extraSeries?.oi;
          const period = c.period ?? 10;
          if (!oi || i < period) return false;
          const oiNow = oi[i], oiPast = oi[i - period];
          if (oiNow === undefined || oiPast === undefined || Number.isNaN(oiNow) || Number.isNaN(oiPast) || oiPast === 0) return false;
          const oiChange = (oiNow - oiPast) / oiPast;
          const priorLow = Math.min(...closes.slice(i - period, i).filter((v): v is number => v !== undefined));
          const ci = closes[i];
          return ci !== undefined && ci < priorLow && oiChange < -(c.value ?? 0.03);
        }
        default: { return false;
        }
      }
  });
}
