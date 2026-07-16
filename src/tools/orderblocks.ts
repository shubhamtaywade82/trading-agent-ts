import { Candle } from "../backtest/types.js";
import { atrSeries, smaSeries } from "./indicators.js";

// SMC Order Block zone detection — ATR-adaptive displacement, body-ratio
// filter, 2-bar structure-break confirmation, proximal/distal zone levels,
// lookahead-free strength score (rolling volume average at detection time,
// not whole-series average).
//
// Entry model: NOT at the impulse bar (that's what the existing
// bullish_ob/bearish_ob signals do — chasing displacement). Zones are
// detected at the impulse, then traded on the RETEST: first touch of the
// proximal level after the impulse, provided the zone hasn't been
// invalidated (close through distal) first. Fresh zones only — one signal
// per zone.

export interface OrderBlockZone {
  type: "bullish" | "bearish";
  proximal: number;   // zone edge closest to the impulse
  distal: number;     // opposite extreme (stop side)
  obIndex: number;    // index of the order block candle
  impulseIndex: number;
  strength: number;   // (impulse body / ATR) × (OB volume / rolling avg volume)
}

export interface ObDetectorOptions {
  atrPeriod?: number;
  impulseThreshold?: number;  // impulse body must exceed this × ATR
  minBodyRatio?: number;      // impulse body / range floor
  minStrength?: number;       // drop zones weaker than this
}

export function detectOrderBlockZones(candles: Candle[], opts: ObDetectorOptions = {}): OrderBlockZone[] {
  const { atrPeriod = 14, impulseThreshold = 1.5, minBodyRatio = 0.6, minStrength = 2.0 } = opts;
  const atr = atrSeries(candles, atrPeriod);
  const volAvg = smaSeries(candles.map(c => c.volume), 20); // rolling — no lookahead
  const zones: OrderBlockZone[] = [];

  for (let i = 2; i < candles.length; i++) {
    const cur = candles[i];
    const prev2 = candles[i - 2];
    const body = Math.abs(cur.close - cur.open);
    const range = cur.high - cur.low;
    const a = atr[i];
    if (Number.isNaN(a) || a <= 0 || range <= 0) continue;
    const bodyRatio = body / range;

    const bullImpulse = cur.close > cur.open && body > impulseThreshold * a && bodyRatio > minBodyRatio && cur.close > prev2.high;
    const bearImpulse = cur.close < cur.open && body > impulseThreshold * a && bodyRatio > minBodyRatio && cur.close < prev2.low;
    if (!bullImpulse && !bearImpulse) continue;

    const ob = candles[i - 1];
    const obRange = ob.high - ob.low;
    const obBodyRatio = obRange > 0 ? Math.abs(ob.close - ob.open) / obRange : 0;
    const va = volAvg[i - 1];
    const volFactor = Number.isNaN(va) || va <= 0 ? 1 : ob.volume / va;
    const strength = (body / a) * volFactor;
    if (strength < minStrength) continue;

    if (bullImpulse && (ob.close <= ob.open || obBodyRatio < 0.4)) {
      zones.push({
        type: "bullish",
        proximal: Math.max(ob.open, ob.close),
        distal: Math.min(ob.open, ob.close),
        obIndex: i - 1, impulseIndex: i, strength,
      });
    } else if (bearImpulse && (ob.close >= ob.open || obBodyRatio < 0.4)) {
      zones.push({
        type: "bearish",
        proximal: Math.min(ob.open, ob.close),
        distal: Math.max(ob.open, ob.close),
        obIndex: i - 1, impulseIndex: i, strength,
      });
    }
  }
  return zones;
}

// Per-candle retest entry signals. For each fresh zone, scanning forward from
// the bar after the impulse: invalidation (close through distal) kills the
// zone; otherwise the first touch of proximal fires exactly one signal.
export function buildObRetestSignals(candles: Candle[], zones: OrderBlockZone[]): { long: boolean[]; short: boolean[] } {
  const n = candles.length;
  const long = new Array<boolean>(n).fill(false);
  const short = new Array<boolean>(n).fill(false);

  for (const z of zones) {
    for (let i = z.impulseIndex + 1; i < n; i++) {
      const c = candles[i];
      if (z.type === "bullish") {
        if (c.close < z.distal) break;            // zone broken — invalid
        if (c.low <= z.proximal) { long[i] = true; break; }  // first mitigation
      } else {
        if (c.close > z.distal) break;
        if (c.high >= z.proximal) { short[i] = true; break; }
      }
    }
  }
  return { long, short };
}
