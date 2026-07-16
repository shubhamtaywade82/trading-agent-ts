export function sma(values: number[], period: number): number {
  const slice = values.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / slice.length;
}

export function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const seed = sma(values.slice(0, period), period);
  const out: number[] = [seed];
  for (const value of values.slice(period)) {
    out.push(value * k + out[out.length - 1] * (1 - k));
  }
  return out;
}

export function ema(values: number[], period: number): number {
  const series = emaSeries(values, period);
  return series[series.length - 1];
}

// Wilder's RSI.
export function rsi(values: number[], period = 14): number {
  const changes = values.slice(1).map((v, i) => v - values[i]);
  let avgGain = changes.slice(0, period).filter((c) => c > 0).reduce((s, c) => s + c, 0) / period;
  let avgLoss = changes.slice(0, period).filter((c) => c < 0).reduce((s, c) => s - c, 0) / period;

  for (const change of changes.slice(period)) {
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): { macd: number; signal: number; histogram: number } {
  const fastSeries = emaSeries(values, fast);
  const slowSeries = emaSeries(values, slow);
  // Align series (fastSeries is longer since it starts earlier) to the tail shared by both.
  const offset = fastSeries.length - slowSeries.length;
  const macdSeries = slowSeries.map((slowVal, i) => fastSeries[i + offset] - slowVal);
  const signalSeries = emaSeries(macdSeries, signalPeriod);
  const macdValue = macdSeries[macdSeries.length - 1];
  const signalValue = signalSeries[signalSeries.length - 1];
  return { macd: macdValue, signal: signalValue, histogram: macdValue - signalValue };
}

export function bollingerBands(values: number[], period = 20, k = 2): { upper: number; middle: number; lower: number } {
  const slice = values.slice(-period);
  const middle = sma(slice, period);
  const variance = slice.reduce((sum, v) => sum + (v - middle) ** 2, 0) / slice.length;
  const stdDev = Math.sqrt(variance);
  return { upper: middle + k * stdDev, middle, lower: middle - k * stdDev };
}

// --- Per-index series variants, for walking a strategy candle-by-candle (backtesting). ---
// Each series[i] corresponds to values[i]; indices before the warmup period are NaN.

export function smaSeries(values: number[], period: number): number[] {
  return values.map((_, i) => (i + 1 >= period ? sma(values.slice(0, i + 1), period) : NaN));
}

export function rsiSeries(values: number[], period = 14): number[] {
  return values.map((_, i) => (i + 1 >= period + 1 ? rsi(values.slice(0, i + 1), period) : NaN));
}

export function macdSeries(
  values: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
): Array<{ macd: number; signal: number; histogram: number }> {
  const warmup = slow + signalPeriod;
  return values.map((_, i) => (i + 1 >= warmup ? macd(values.slice(0, i + 1), fast, slow, signalPeriod) : { macd: NaN, signal: NaN, histogram: NaN }));
}

export function bollingerSeries(values: number[], period = 20, k = 2): Array<{ upper: number; middle: number; lower: number }> {
  return values.map((_, i) =>
    i + 1 >= period ? bollingerBands(values.slice(0, i + 1), period, k) : { upper: NaN, middle: NaN, lower: NaN }
  );
}

// --- ATR (Average True Range) ---
export type CandleHL = { high: number; low: number; close: number };

export function atrSeries(candles: CandleHL[], period = 14): number[] {
  const tr: number[] = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const out: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) { out.push(NaN); continue; }
    if (i === period - 1) {
      out.push(tr.slice(0, period).reduce((s, v) => s + v, 0) / period);
    } else {
      out.push((out[i - 1] * (period - 1) + tr[i]) / period);
    }
  }
  return out;
}

// --- SuperTrend (standard Pine Script `up`/`dn` band algorithm) ---
// `lower` (support) only ratchets UP while price holds above it; `upper`
// (resistance) only ratchets DOWN while price holds below it — each band is
// evaluated against the PRIOR bar's band value, not recomputed fresh every
// bar (a from-scratch hl2±mult*ATR band is almost never crossed by a single
// bar's close, which silently produces zero trend flips ever).
// Trend flips bullish when price closes above the prior resistance band,
// bearish when it closes below the prior support band.
export interface SuperTrendResult { trend: "up" | "down"; upper: number; lower: number; }
export function superTrendSeries(candles: CandleHL[], atrPeriod = 10, multiplier = 3): SuperTrendResult[] {
  const atr = atrSeries(candles, atrPeriod);
  const out: SuperTrendResult[] = [];
  let prevUpper = NaN, prevLower = NaN, trend: "up" | "down" = "up";
  for (let i = 0; i < candles.length; i++) {
    if (i < atrPeriod || isNaN(atr[i])) {
      out.push({ trend: "up", upper: NaN, lower: NaN });
      continue;
    }
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const band = atr[i] * multiplier;
    let lower = hl2 - band;
    let upper = hl2 + band;

    if (!isNaN(prevLower) && candles[i - 1].close > prevLower) lower = Math.max(lower, prevLower);
    if (!isNaN(prevUpper) && candles[i - 1].close < prevUpper) upper = Math.min(upper, prevUpper);

    if (trend === "down" && candles[i].close > (isNaN(prevUpper) ? upper : prevUpper)) trend = "up";
    else if (trend === "up" && candles[i].close < (isNaN(prevLower) ? lower : prevLower)) trend = "down";

    out.push({ trend, upper, lower });
    prevUpper = upper; prevLower = lower;
  }
  return out;
}

// --- ADX (Average Directional Index) + DI+/DI- ---
export interface ADXResult { adx: number; plusDI: number; minusDI: number; }
export function adxSeries(candles: CandleHL[], period = 14): ADXResult[] {
  const n = candles.length;
  const out: ADXResult[] = [{ adx: NaN, plusDI: NaN, minusDI: NaN }];
  if (n < 2) return out;
  const tr = [0]; const up = [0]; const dn = [0];
  for (let i = 1; i < n; i++) {
    const h = candles[i].high; const l = candles[i].low; const pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const u = h - candles[i - 1].high;
    const d = candles[i - 1].low - l;
    up.push(u < 0 || u < d ? 0 : u);
    dn.push(d < 0 || d < u ? 0 : d);
  }
  let sumTR = 0, sumUP = 0, sumDN = 0, sumDX = 0;
  for (let i = 1; i < n; i++) {
    sumTR += tr[i]; sumUP += up[i]; sumDN += dn[i];
    if (i < period) { out.push({ adx: NaN, plusDI: NaN, minusDI: NaN }); continue; }
    if (i > period) {
      sumTR -= tr[i - period]; sumUP -= up[i - period]; sumDN -= dn[i - period];
    }
    const pDI = sumTR > 0 ? 100 * sumUP / sumTR : 0;
    const mDI = sumTR > 0 ? 100 * sumDN / sumTR : 0;
    const dx = (pDI + mDI) > 0 ? 100 * Math.abs(pDI - mDI) / (pDI + mDI) : 0;
    if (i === period) { sumDX = dx; out.push({ adx: dx, plusDI: pDI, minusDI: mDI }); }
    else { sumDX = (sumDX * (period - 1) + dx) / period; out.push({ adx: sumDX, plusDI: pDI, minusDI: mDI }); }
  }
  return out;
}

// --- Ichimoku Cloud (simplified) ---
export interface IchimokuResult {
  tenkan: number; kijun: number; senkouA: number; senkouB: number; cloud: "above" | "below" | "inside";
}
export function ichimokuSeries(candles: CandleHL[]): IchimokuResult[] {
  const n = candles.length;
  const out: IchimokuResult[] = [];
  for (let i = 0; i < n; i++) {
    if (i < 51) { out.push({ tenkan: NaN, kijun: NaN, senkouA: NaN, senkouB: NaN, cloud: "inside" }); continue; }
    const h9 = Math.max(...candles.slice(i - 8, i + 1).map(c => c.high));
    const l9 = Math.min(...candles.slice(i - 8, i + 1).map(c => c.low));
    const tenkan = (h9 + l9) / 2;
    const h26 = Math.max(...candles.slice(i - 25, i + 1).map(c => c.high));
    const l26 = Math.min(...candles.slice(i - 25, i + 1).map(c => c.low));
    const kijun = (h26 + l26) / 2;
    const h52 = Math.max(...candles.slice(i - 51, i + 1).map(c => c.high));
    const l52 = Math.min(...candles.slice(i - 51, i + 1).map(c => c.low));
    const senkouB = (h52 + l52) / 2;
    const senkouA = (tenkan + kijun) / 2;
    let cloud: "above" | "below" | "inside";
    if (i >= 26) {
      const sA = out[i - 26]?.senkouA ?? senkouA;
      const sB = out[i - 26]?.senkouB ?? senkouB;
      cloud = candles[i].close > Math.max(sA, sB) ? "above" : candles[i].close < Math.min(sA, sB) ? "below" : "inside";
    } else {
      cloud = candles[i].close > Math.max(senkouA, senkouB) ? "above" : candles[i].close < Math.min(senkouA, senkouB) ? "below" : "inside";
    }
    out.push({ tenkan, kijun, senkouA, senkouB, cloud });
  }
  return out;
}
