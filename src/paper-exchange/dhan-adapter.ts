import type { Instrument, MarketFeedEvent } from "@shubhamtaywade82/dhanhq-ts";

import type { InstrumentResolver } from "./order-matcher.js";
import type { InstrumentMetadata, InstrumentSegment, NormalizedTick } from "./types.js";

const DEFAULT_LOT_SIZE = 1;
const DEFAULT_TICK_SIZE = 0.05;

const OPTION_TYPES = new Set(["OPTIDX", "OPTSTK", "OPTCUR", "OPTFUT"]);
const FUTURE_TYPES = new Set(["FUTIDX", "FUTSTK", "FUTCUR", "FUTCOM"]);

// Converts a raw dhanhq-ts market feed packet into the paper exchange's
// NormalizedTick. Ticker/quote packets carry no depth, so bestBid/bestAsk
// Are only populated for "full" packets; disconnect/prev-close/OI packets
// Aren't price updates and are skipped.
export function toNormalizedTick(event: MarketFeedEvent): NormalizedTick | null {
  if (event.type === "disconnect" || event.type === "prev-close" || event.type === "oi") {
    return null;
  }

  const tick: NormalizedTick = {
    securityId: event.securityId,
    exchangeSegment: event.exchangeSegment,
    ltp: event.ltp,
    timestamp: event.ltt,
  };

  const top = event.type === "full" ? event.depth[0] : undefined;
  if (!top) return tick;

  return { ...tick, bestBid: top.bidPrice, bestAsk: top.askPrice };
}

// Maps a dhanhq-ts scrip-master Instrument row into the metadata the order
// Matcher needs (lot size, tick size). Falls back to sane defaults when the
// CSV row omits them, which happens for some non-derivative rows. Returns
// Null when the row can't be placed on an exchange segment at all.
export function toInstrumentMetadata(instrument: Instrument): InstrumentMetadata | null {
  if (!instrument.exchangeSegment) return null;

  return {
    securityId: instrument.securityId,
    exchangeSegment: instrument.exchangeSegment,
    tradingSymbol: instrument.symbolName ?? instrument.displayName ?? instrument.securityId,
    lotSize: instrument.lotSize ?? DEFAULT_LOT_SIZE,
    tickSize: instrument.tickSize ?? DEFAULT_TICK_SIZE,
    segment: toInstrumentSegment(instrument.instrumentType),
  };
}

function toInstrumentSegment(instrumentType: string | undefined): InstrumentSegment {
  if (instrumentType && OPTION_TYPES.has(instrumentType)) return "OPTIONS";
  if (instrumentType && FUTURE_TYPES.has(instrumentType)) return "FUTURES";
  return "EQUITY";
}

// Builds a PaperOrderMatcher-compatible InstrumentResolver from a scrip
// Master snapshot (e.g. `instruments.getAll()` from dhanhq-ts), so the
// Matcher can validate lot sizes and price with the real tick size.
export function createInstrumentResolver(instruments: readonly Instrument[]): InstrumentResolver {
  const byKey = new Map<string, InstrumentMetadata>();
  for (const instrument of instruments) {
    const metadata = toInstrumentMetadata(instrument);
    if (metadata) byKey.set(resolverKey(metadata.securityId, metadata.exchangeSegment), metadata);
  }

  return (securityId, exchangeSegment) => byKey.get(resolverKey(securityId, exchangeSegment));
}

function resolverKey(securityId: string, exchangeSegment: string): string {
  return `${exchangeSegment}:${securityId}`;
}
