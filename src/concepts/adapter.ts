import {
  TradingConcepts,
  AnalysisResult,
  Candle as ConceptsCandle,
  HTFContext,
  TradingConceptsConfigOverrides,
  calculateVolumeProfile,
  calculateVWAP,
  VolumeProfileConfig,
  VWAPConfig,
} from 'trading-concepts-ts';
import { Candle } from '../backtest/types.js';

// ── Per-bar signals from full analysis ──

export interface PerBarSignals {
  bullishMSS: boolean[];
  bearishMSS: boolean[];
  bullishCHoCH: boolean[];
  bearishCHoCH: boolean[];
  bullishBOS: boolean[];
  bearishBOS: boolean[];
  newBullishOB: boolean[];
  newBearishOB: boolean[];
  newBullishFVG: boolean[];
  newBearishFVG: boolean[];
  newBullishBreaker: boolean[];
  newBearishBreaker: boolean[];
  newBullishInvFVG: boolean[];
  newBearishInvFVG: boolean[];
  sellsideSweep: boolean[];
  buysideSweep: boolean[];
  judasSwingBullish: boolean[];
  judasSwingBearish: boolean[];
  inPremium: boolean[];
  inDiscount: boolean[];
  inOTE: boolean[];
  maxConfluenceScore: number[];
  bestConfluenceDirection: Array<'bullish' | 'bearish' | null>;
  activeSession: string[];

  aboveHVN: boolean[];
  belowHVN: boolean[];
  atPOC: boolean[];
  atLVN: boolean[];
  cvdRising: boolean[];
  cvdFalling: boolean[];
  cvdPositive: boolean[];
  cvdNegative: boolean[];
  aboveVWAP: boolean[];
  belowVWAP: boolean[];
}

export interface ConceptsEngineOptions {
  preset?: TradingConceptsConfigOverrides;
  overrides?: TradingConceptsConfigOverrides;
  htfContext?: HTFContext;
}

// ── Candle type bridge ──

export function adaptConceptsCandle(c: Candle): ConceptsCandle {
  return {
    time: c.openTime,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  };
}

export function adaptConceptsCandles(candles: Candle[]): ConceptsCandle[] {
  return candles.map(adaptConceptsCandle);
}

// ── CVD approximation from OHLCV ──
// Delta = volume * ((close - low) - (high - close)) / (high - low)
// Positive = net buying pressure, Negative = net selling pressure

function computeCvdSeries(candles: Candle[]): number[] {
  return candles.map(c => {
    const range = c.high - c.low;
    if (range <= 0) return 0;
    const buyVol = ((c.close - c.low) / range) * c.volume;
    const sellVol = ((c.high - c.close) / range) * c.volume;
    return buyVol - sellVol;
  });
}

// ── Build per-bar signal arrays from AnalysisResult + indicators ──

function buildPerBarSignals(candles: Candle[], ar: AnalysisResult): PerBarSignals {
  const n = candles.length;
  const closes = candles.map(c => c.close);

  const bullishMSS = new Array<boolean>(n).fill(false);
  const bearishMSS = new Array<boolean>(n).fill(false);
  const bullishCHoCH = new Array<boolean>(n).fill(false);
  const bearishCHoCH = new Array<boolean>(n).fill(false);
  const bullishBOS = new Array<boolean>(n).fill(false);
  const bearishBOS = new Array<boolean>(n).fill(false);

  for (const s of ar.structure) {
    if (s.type === 'MSS' && s.direction === 'bullish') bullishMSS[s.index] = true;
    if (s.type === 'MSS' && s.direction === 'bearish') bearishMSS[s.index] = true;
    if (s.type === 'CHoCH' && s.direction === 'bullish') bullishCHoCH[s.index] = true;
    if (s.type === 'CHoCH' && s.direction === 'bearish') bearishCHoCH[s.index] = true;
    if (s.type === 'BOS' && s.direction === 'bullish') bullishBOS[s.index] = true;
    if (s.type === 'BOS' && s.direction === 'bearish') bearishBOS[s.index] = true;
  }

  const newBullishOB = new Array<boolean>(n).fill(false);
  const newBearishOB = new Array<boolean>(n).fill(false);
  for (const ob of ar.orderBlocks) {
    if (!ob.mitigated) {
      if (ob.type === 'bullish') newBullishOB[ob.index] = true;
      else newBearishOB[ob.index] = true;
    }
  }

  const newBullishFVG = new Array<boolean>(n).fill(false);
  const newBearishFVG = new Array<boolean>(n).fill(false);
  for (const fvg of ar.fvgs) {
    if (!fvg.mitigated) {
      if (fvg.type === 'bullish') newBullishFVG[fvg.index] = true;
      else newBearishFVG[fvg.index] = true;
    }
  }

  const newBullishBreaker = new Array<boolean>(n).fill(false);
  const newBearishBreaker = new Array<boolean>(n).fill(false);
  for (const br of ar.breakerBlocks) {
    if (br.type === 'bullish') newBullishBreaker[br.index] = true;
    else newBearishBreaker[br.index] = true;
  }

  const newBullishInvFVG = new Array<boolean>(n).fill(false);
  const newBearishInvFVG = new Array<boolean>(n).fill(false);
  for (const inv of ar.inverseFvgs) {
    if (inv.type === 'bullish') newBullishInvFVG[inv.index] = true;
    else newBearishInvFVG[inv.index] = true;
  }

  const sellsideSweep = new Array<boolean>(n).fill(false);
  const buysideSweep = new Array<boolean>(n).fill(false);
  for (const lz of ar.liquidity) {
    if (lz.swept && lz.sweepIndex !== undefined) {
      if (lz.type === 'sellside') sellsideSweep[lz.sweepIndex] = true;
      if (lz.type === 'buyside') buysideSweep[lz.sweepIndex] = true;
    }
  }

  const judasSwingBullish = new Array<boolean>(n).fill(false);
  const judasSwingBearish = new Array<boolean>(n).fill(false);
  for (const js of ar.judasSwings) {
    if (js.direction === 'bullish') judasSwingBullish[js.sweepIndex] = true;
    else judasSwingBearish[js.sweepIndex] = true;
  }

  const activeSession = new Array<string>(n).fill('');
  for (const kz of ar.killzones) {
    activeSession[kz.index] = kz.session;
  }

  const inPremium = new Array<boolean>(n).fill(false);
  const inDiscount = new Array<boolean>(n).fill(false);
  const inOTE = new Array<boolean>(n).fill(false);
  for (const pdz of ar.premiumDiscountZones) {
    const eq = pdz.equilibrium;
    const oteLo = Math.min(pdz.oteZone.start, pdz.oteZone.end);
    const oteHi = Math.max(pdz.oteZone.start, pdz.oteZone.end);
    for (let i = Math.max(0, pdz.index); i < Math.min(n, pdz.endIndex); i++) {
      const px = closes[i];
      if (pdz.direction === 'bullish') {
        inPremium[i] = inPremium[i] || px > eq;
        inDiscount[i] = inDiscount[i] || px < eq;
      } else {
        inPremium[i] = inPremium[i] || px < eq;
        inDiscount[i] = inDiscount[i] || px > eq;
      }
      inOTE[i] = inOTE[i] || (px >= oteLo && px <= oteHi);
    }
  }

  const maxConfluenceScore = new Array<number>(n).fill(0);
  const bestConfluenceDirection = new Array<'bullish' | 'bearish' | null>(n).fill(null);
  for (const cs of ar.confluenceScores) {
    if (cs.score > maxConfluenceScore[cs.zoneIndex]) {
      maxConfluenceScore[cs.zoneIndex] = cs.score;
      bestConfluenceDirection[cs.zoneIndex] = cs.direction;
    }
  }

  // Volume Profile — fixed range over all candles
  const adaptedCandles = adaptConceptsCandles(candles);
  const vp = calculateVolumeProfile(adaptedCandles, { bins: 24, hvnPercentile: 0.7, lvnPercentile: 0.3 });
  const aboveHVN = new Array<boolean>(n).fill(false);
  const belowHVN = new Array<boolean>(n).fill(false);
  const atPOC = new Array<boolean>(n).fill(false);
  const atLVN = new Array<boolean>(n).fill(false);
  if (vp) {
    const pocLevel = vp.pointOfControl ? (vp.pointOfControl.priceLow + vp.pointOfControl.priceHigh) / 2 : 0;
    const hvnLevels = vp.highVolumeNodes.map(b => (b.priceLow + b.priceHigh) / 2);
    const lvnLevels = vp.lowVolumeNodes.map(b => (b.priceLow + b.priceHigh) / 2);
    const hvnTop = Math.max(...hvnLevels, 0);
    const hvnBot = Math.min(...hvnLevels, Infinity);
    for (let i = 0; i < n; i++) {
      const px = closes[i];
      atPOC[i] = pocLevel > 0 && Math.abs(px - pocLevel) / px < 0.002;
      for (const hl of hvnLevels) {
        aboveHVN[i] = aboveHVN[i] || px > hl;
        belowHVN[i] = belowHVN[i] || px < hl;
      }
      aboveHVN[i] = px > hvnTop;
      belowHVN[i] = px < hvnBot;
      for (const ll of lvnLevels) {
        atLVN[i] = atLVN[i] || Math.abs(px - ll) / px < 0.003;
      }
    }
  }

  // CVD — cumulative volume delta with trend detection
  const cvdPerBar = computeCvdSeries(candles);
  const cvdLookback = 20;
  const cvdRising = new Array<boolean>(n).fill(false);
  const cvdFalling = new Array<boolean>(n).fill(false);
  const cvdPositive = new Array<boolean>(n).fill(false);
  const cvdNegative = new Array<boolean>(n).fill(false);
  for (let i = cvdLookback; i < n; i++) {
    const recent = cvdPerBar.slice(i - cvdLookback, i).reduce((s, v) => s + v, 0);
    const earlier = cvdPerBar.slice(i - cvdLookback * 2, i - cvdLookback).reduce((s, v) => s + v, 0);
    cvdRising[i] = recent > earlier * 1.05;
    cvdFalling[i] = recent < earlier * 0.95;
    cvdPositive[i] = cvdPerBar[i] > 0;
    cvdNegative[i] = cvdPerBar[i] < 0;
  }

  // VWAP
  const vwapArr = calculateVWAP(adaptedCandles, { resetDaily: false, timezoneOffsetMinutes: 0 });
  const aboveVWAP = new Array<boolean>(n).fill(false);
  const belowVWAP = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const v = vwapArr[i];
    if (v !== null && !Number.isNaN(v)) {
      aboveVWAP[i] = closes[i] > v;
      belowVWAP[i] = closes[i] < v;
    }
  }

  return {
    bullishMSS, bearishMSS, bullishCHoCH, bearishCHoCH, bullishBOS, bearishBOS,
    newBullishOB, newBearishOB, newBullishFVG, newBearishFVG,
    newBullishBreaker, newBearishBreaker, newBullishInvFVG, newBearishInvFVG,
    sellsideSweep, buysideSweep,
    judasSwingBullish, judasSwingBearish,
    inPremium, inDiscount, inOTE,
    maxConfluenceScore, bestConfluenceDirection,
    activeSession,
    aboveHVN, belowHVN, atPOC, atLVN,
    cvdRising, cvdFalling, cvdPositive, cvdNegative,
    aboveVWAP, belowVWAP,
  };
}

// ── ConceptsEngine ──

export class ConceptsEngine {
  private candles: Candle[];
  private adapted: ConceptsCandle[];
  private analysis: AnalysisResult | null = null;
  private signals: PerBarSignals | null = null;
  private tc: TradingConcepts;

  constructor(candles: Candle[], options?: ConceptsEngineOptions) {
    this.candles = candles;
    this.adapted = adaptConceptsCandles(candles);
    const overrides = options?.overrides;
    if (options?.preset) {
      this.tc = TradingConcepts.withPreset(this.adapted, options.preset, overrides);
    } else {
      this.tc = new TradingConcepts(this.adapted, overrides);
    }
    if (options?.htfContext) {
      this.tc.setHTFContext(options.htfContext);
    }
  }

  /** Returns HTF analysis context from this engine's candles for use in lower-timeframe engines. */
  toHTFContext(): HTFContext {
    const ar = this.analyze();
    return {
      orderBlocks: ar.orderBlocks.filter(ob => !ob.mitigated),
      structure: ar.structure,
      premiumDiscountZones: ar.premiumDiscountZones,
      liquidity: ar.liquidity.filter(l => !l.swept),
    };
  }

  analyze(): AnalysisResult {
    if (!this.analysis) {
      this.analysis = this.tc.analyze();
    }
    return this.analysis;
  }

  getSignals(): PerBarSignals {
    if (!this.signals) {
      this.analyze();
      this.signals = buildPerBarSignals(this.candles, this.analysis!);
    }
    return this.signals;
  }

  /** Build an entry-mask from this engine for use as an HTF bias filter.
   *  Returns a boolean[] where `true` means the HTF bias aligns with the given trade direction.
   *  For longs: HTF must have bullish structure or bullish OB activity.
   *  For shorts: HTF must have bearish structure or bearish OB activity.
   *  Returns null when there isn't enough data to establish a bias.
   */
  buildEntryMask(direction: 'long' | 'short', minConfidence = 60): boolean[] | null {
    const sig = this.getSignals();
    const n = this.candles.length;
    const mask = new Array<boolean>(n).fill(false);

    for (let i = 50; i < n; i++) {
      if (direction === 'long') {
        const hasBullishStructure = sig.bullishMSS[i] || sig.bullishCHoCH[i] || sig.bullishBOS[i];
        const hasBullishOB = sig.newBullishOB[i];
        const hasConfluence = sig.maxConfluenceScore[i] >= minConfidence && sig.bestConfluenceDirection[i] === 'bullish';
        mask[i] = hasBullishStructure || hasBullishOB || hasConfluence;
      } else {
        const hasBearishStructure = sig.bearishMSS[i] || sig.bearishCHoCH[i] || sig.bearishBOS[i];
        const hasBearishOB = sig.newBearishOB[i];
        const hasConfluence = sig.maxConfluenceScore[i] >= minConfidence && sig.bestConfluenceDirection[i] === 'bearish';
        mask[i] = hasBearishStructure || hasBearishOB || hasConfluence;
      }
    }

    const activeCount = mask.filter(Boolean).length;
    if (activeCount < 5) return null;

    return mask;
  }

  evaluator(conditions: { type: string; period?: number; value?: number }[]): (i: number) => boolean {
    const sig = this.getSignals();

    return (i: number) => conditions.every(c => {
      switch (c.type) {
        case 'concepts_bullish_mss': return sig.bullishMSS[i] ?? false;
        case 'concepts_bearish_mss': return sig.bearishMSS[i] ?? false;
        case 'concepts_bullish_choch': return sig.bullishCHoCH[i] ?? false;
        case 'concepts_bearish_choch': return sig.bearishCHoCH[i] ?? false;
        case 'concepts_bullish_bos': return sig.bullishBOS[i] ?? false;
        case 'concepts_bearish_bos': return sig.bearishBOS[i] ?? false;
        case 'concepts_bullish_ob': return sig.newBullishOB[i] ?? false;
        case 'concepts_bearish_ob': return sig.newBearishOB[i] ?? false;
        case 'concepts_bullish_fvg': return sig.newBullishFVG[i] ?? false;
        case 'concepts_bearish_fvg': return sig.newBearishFVG[i] ?? false;
        case 'concepts_bullish_breaker': return sig.newBullishBreaker[i] ?? false;
        case 'concepts_bearish_breaker': return sig.newBearishBreaker[i] ?? false;
        case 'concepts_bullish_invfvg': return sig.newBullishInvFVG[i] ?? false;
        case 'concepts_bearish_invfvg': return sig.newBearishInvFVG[i] ?? false;
        case 'concepts_buyside_sweep': return sig.buysideSweep[i] ?? false;
        case 'concepts_sellside_sweep': return sig.sellsideSweep[i] ?? false;
        case 'concepts_judas_swing': return sig.judasSwingBullish[i] || sig.judasSwingBearish[i];
        case 'concepts_in_premium': return sig.inPremium[i] ?? false;
        case 'concepts_in_discount': return sig.inDiscount[i] ?? false;
        case 'concepts_in_ote': return sig.inOTE[i] ?? false;
        case 'concepts_confluence_gte': {
          const threshold = c.value ?? 65;
          return sig.maxConfluenceScore[i] >= threshold;
        }
        case 'concepts_cvd_rising': return sig.cvdRising[i] ?? false;
        case 'concepts_cvd_falling': return sig.cvdFalling[i] ?? false;
        case 'concepts_cvd_positive': return sig.cvdPositive[i] ?? false;
        case 'concepts_cvd_negative': return sig.cvdNegative[i] ?? false;
        case 'concepts_above_vwap': return sig.aboveVWAP[i] ?? false;
        case 'concepts_below_vwap': return sig.belowVWAP[i] ?? false;
        case 'concepts_above_hvn': return sig.aboveHVN[i] ?? false;
        case 'concepts_below_hvn': return sig.belowHVN[i] ?? false;
        case 'concepts_at_poc': return sig.atPOC[i] ?? false;
        case 'concepts_at_lvn': return sig.atLVN[i] ?? false;
        default:
          return false;
      }
    });
  }
}
