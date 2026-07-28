import { ConceptsEngine, PerBarSignals } from "./adapter.js";
import { Candle } from "../backtest/types.js";
import { OrderBlock } from "trading-concepts-ts";

// One ConceptsEngine per candle array for the lifetime of that array — every
// wrapper below is called once per bar in a loop by both buildSignalEvaluator
// and BinanceSignalFusionTool's precompute block; without this cache each
// call would re-run TradingConcepts.analyze() (an O(n) whole-series pass)
// once per bar, turning an O(n) backtest into O(n^2).
const engineCache = new WeakMap<Candle[], ConceptsEngine>();

function engineFor(candles: Candle[]): ConceptsEngine {
  let engine = engineCache.get(candles);
  if (!engine) {
    engine = new ConceptsEngine(candles);
    engineCache.set(candles, engine);
  }
  return engine;
}

function signalsFor(candles: Candle[]): PerBarSignals {
  return engineFor(candles).getSignals();
}

export function legacyBullishOb(candles: Candle[], i: number): boolean {
  return signalsFor(candles).newBullishOB[i] ?? false;
}

export function legacyBearishOb(candles: Candle[], i: number): boolean {
  return signalsFor(candles).newBearishOB[i] ?? false;
}

export function legacyBullishFvg(candles: Candle[], i: number): boolean {
  return signalsFor(candles).newBullishFVG[i] ?? false;
}

export function legacyBearishFvg(candles: Candle[], i: number): boolean {
  return signalsFor(candles).newBearishFVG[i] ?? false;
}

// Bullish liquidity sweep: price sweeps below a prior swing low then closes
// back above it — the same event ConceptsEngine calls a sellside sweep (the
// resting liquidity below swing lows). Bearish is the mirror (buyside sweep).
export function legacyBullishLiqSweep(candles: Candle[], i: number): boolean {
  return signalsFor(candles).sellsideSweep[i] ?? false;
}

export function legacyBearishLiqSweep(candles: Candle[], i: number): boolean {
  return signalsFor(candles).buysideSweep[i] ?? false;
}

// Displacement: an impulsive candle that closes beyond the prior bar's
// high/low — the same concept ConceptsEngine's Break-of-Structure signals
// already capture. Only `.dir` is ever read downstream, never a strength
// value, so this doesn't compute one.
export function legacyDisplacement(candles: Candle[], i: number): { dir: "up" | "down" } | null {
  const sig = signalsFor(candles);
  if (sig.bullishBOS[i]) return { dir: "up" };
  if (sig.bearishBOS[i]) return { dir: "down" };
  return null;
}

interface RetestArrays { long: boolean[]; short: boolean[] }
const retestCache = new WeakMap<Candle[], RetestArrays>();

// Retest scan ported from the retired src/tools/orderblocks.ts's
// buildObRetestSignals: for a bullish OB, price is expected to pull back
// down into the zone from above — the near/proximal edge on that approach is
// the zone's top, the far/invalidation edge is bottom. Bearish is the mirror.
// First touch of the proximal edge, provided the distal edge hasn't already
// been closed through, fires exactly one signal per zone.
function buildRetestArrays(candles: Candle[], orderBlocks: OrderBlock[]): RetestArrays {
  const n = candles.length;
  const long = new Array<boolean>(n).fill(false);
  const short = new Array<boolean>(n).fill(false);

  for (const ob of orderBlocks) {
    const proximal = ob.type === "bullish" ? ob.top : ob.bottom;
    const distal = ob.type === "bullish" ? ob.bottom : ob.top;
    for (let i = ob.index + 1; i < n; i++) {
      const c = candles[i];
      if (ob.type === "bullish") {
        if (c.close < distal) break;
        if (c.low <= proximal) { long[i] = true; break; }
      } else {
        if (c.close > distal) break;
        if (c.high >= proximal) { short[i] = true; break; }
      }
    }
  }
  return { long, short };
}

function retestArraysFor(candles: Candle[]): RetestArrays {
  let arr = retestCache.get(candles);
  if (!arr) {
    const orderBlocks = engineFor(candles).analyze().orderBlocks;
    arr = buildRetestArrays(candles, orderBlocks);
    retestCache.set(candles, arr);
  }
  return arr;
}

export function legacyObRetestLong(candles: Candle[], i: number): boolean {
  return retestArraysFor(candles).long[i] ?? false;
}

export function legacyObRetestShort(candles: Candle[], i: number): boolean {
  return retestArraysFor(candles).short[i] ?? false;
}
