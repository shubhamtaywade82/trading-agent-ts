import { smaSeries, emaSeries, rsiSeries, macdSeries, bollingerSeries } from "../tools/indicators.js";
import { Candle, Condition } from "./types.js";

export interface IndicatorSeries {
  closes: number[];
  sma: Map<number, number[]>;
  ema: Map<number, number[]>;
  rsi: Map<number, number[]>;
  macd: Array<{ macd: number; signal: number; histogram: number }>;
  bollinger: Array<{ upper: number; middle: number; lower: number }>;
}

const DEFAULT_SMA_EMA_PERIOD = 20;
const DEFAULT_RSI_PERIOD = 14;

// Precomputes every series a condition set might reference, keyed by the
// periods actually requested (avoids recomputing a full series per-candle).
export function buildIndicatorSeries(candles: Candle[], conditions: Condition[]): IndicatorSeries {
  const closes = candles.map((c) => c.close);
  const smaPeriods = new Set<number>();
  const emaPeriods = new Set<number>();
  const rsiPeriods = new Set<number>();
  let needsMacd = false;
  let needsBollinger = false;

  for (const c of conditions) {
    if (c.type === "price_above_sma" || c.type === "price_below_sma") smaPeriods.add(c.period ?? DEFAULT_SMA_EMA_PERIOD);
    if (c.type === "price_above_ema" || c.type === "price_below_ema") emaPeriods.add(c.period ?? DEFAULT_SMA_EMA_PERIOD);
    if (c.type === "rsi_below" || c.type === "rsi_above") rsiPeriods.add(c.period ?? DEFAULT_RSI_PERIOD);
    if (c.type === "macd_bullish_cross" || c.type === "macd_bearish_cross") needsMacd = true;
    if (c.type === "bollinger_touch_lower" || c.type === "bollinger_touch_upper") needsBollinger = true;
  }

  const sma = new Map<number, number[]>();
  for (const p of smaPeriods) sma.set(p, smaSeries(closes, p));
  const ema = new Map<number, number[]>();
  for (const p of emaPeriods) ema.set(p, emaSeriesPadded(closes, p));
  const rsi = new Map<number, number[]>();
  for (const p of rsiPeriods) rsi.set(p, rsiSeries(closes, p));

  return {
    closes,
    sma,
    ema,
    rsi,
    macd: needsMacd ? macdSeries(closes) : [],
    bollinger: needsBollinger ? bollingerSeries(closes) : [],
  };
}

// emaSeries() only returns the post-warmup tail; pad the front with NaN so
// index i in the padded array lines up with candle i, matching the other series.
function emaSeriesPadded(values: number[], period: number): number[] {
  const raw = emaSeries(values, period);
  const padCount = values.length - raw.length;
  return [...Array(Math.max(0, padCount)).fill(NaN), ...raw];
}

export function evaluateCondition(cond: Condition, series: IndicatorSeries, i: number): boolean {
  switch (cond.type) {
    case "rsi_below": {
      const v = series.rsi.get(cond.period ?? DEFAULT_RSI_PERIOD)?.[i];
      return v !== undefined && !Number.isNaN(v) && v < (cond.value ?? 30);
    }
    case "rsi_above": {
      const v = series.rsi.get(cond.period ?? DEFAULT_RSI_PERIOD)?.[i];
      return v !== undefined && !Number.isNaN(v) && v > (cond.value ?? 70);
    }
    case "price_above_sma": {
      const v = series.sma.get(cond.period ?? DEFAULT_SMA_EMA_PERIOD)?.[i];
      return v !== undefined && !Number.isNaN(v) && series.closes[i] > v;
    }
    case "price_below_sma": {
      const v = series.sma.get(cond.period ?? DEFAULT_SMA_EMA_PERIOD)?.[i];
      return v !== undefined && !Number.isNaN(v) && series.closes[i] < v;
    }
    case "price_above_ema": {
      const v = series.ema.get(cond.period ?? DEFAULT_SMA_EMA_PERIOD)?.[i];
      return v !== undefined && !Number.isNaN(v) && series.closes[i] > v;
    }
    case "price_below_ema": {
      const v = series.ema.get(cond.period ?? DEFAULT_SMA_EMA_PERIOD)?.[i];
      return v !== undefined && !Number.isNaN(v) && series.closes[i] < v;
    }
    case "macd_bullish_cross": {
      const cur = series.macd[i];
      const prev = series.macd[i - 1];
      if (!cur || !prev || Number.isNaN(cur.macd) || Number.isNaN(prev.macd)) return false;
      return prev.macd <= prev.signal && cur.macd > cur.signal;
    }
    case "macd_bearish_cross": {
      const cur = series.macd[i];
      const prev = series.macd[i - 1];
      if (!cur || !prev || Number.isNaN(cur.macd) || Number.isNaN(prev.macd)) return false;
      return prev.macd >= prev.signal && cur.macd < cur.signal;
    }
    case "bollinger_touch_lower": {
      const b = series.bollinger[i];
      return !!b && !Number.isNaN(b.lower) && series.closes[i] <= b.lower;
    }
    case "bollinger_touch_upper": {
      const b = series.bollinger[i];
      return !!b && !Number.isNaN(b.upper) && series.closes[i] >= b.upper;
    }
    default:
      return false;
  }
}

export function evaluateAll(conditions: Condition[], series: IndicatorSeries, i: number): boolean {
  return conditions.every((c) => evaluateCondition(c, series, i));
}
