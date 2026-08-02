import type { Instrument, MarketFullEvent, MarketOiEvent, MarketTickerEvent } from "@shubhamtaywade82/dhanhq-ts";

import {
  createInstrumentResolver,
  toInstrumentMetadata,
  toNormalizedTick,
} from "../../src/paper-exchange/dhan-adapter.js";

function fullEvent(overrides: Partial<MarketFullEvent> = {}): MarketFullEvent {
  return {
    type: "full",
    responseCode: 8,
    messageLength: 0,
    exchangeSegmentCode: 2,
    exchangeSegment: "NSE_FNO",
    securityId: "49081",
    ltp: 150,
    ltq: 75,
    ltt: 1_700_000_000_000,
    atp: 149.5,
    volume: 10_000,
    totalSellQuantity: 5000,
    totalBuyQuantity: 5000,
    openInterest: 1000,
    highestOpenInterest: 1200,
    lowestOpenInterest: 900,
    dayOpen: 148,
    dayClose: 149,
    dayHigh: 152,
    dayLow: 147,
    depth: [{ bidPrice: 149.95, askPrice: 150.05, bidQuantity: 75, askQuantity: 75, bidOrders: 1, askOrders: 1 }],
    raw: Buffer.alloc(0),
    ...overrides,
  };
}

function tickerEvent(overrides: Partial<MarketTickerEvent> = {}): MarketTickerEvent {
  return {
    type: "ticker",
    responseCode: 2,
    messageLength: 0,
    exchangeSegmentCode: 2,
    exchangeSegment: "NSE_FNO",
    securityId: "49081",
    ltp: 150,
    ltt: 1_700_000_000_000,
    raw: Buffer.alloc(0),
    ...overrides,
  };
}

describe("toNormalizedTick", () => {
  test("maps a full packet's top-of-book depth to bestBid/bestAsk", () => {
    const tick = toNormalizedTick(fullEvent());
    expect(tick).toStrictEqual({
      securityId: "49081",
      exchangeSegment: "NSE_FNO",
      ltp: 150,
      timestamp: 1_700_000_000_000,
      bestBid: 149.95,
      bestAsk: 150.05,
    });
  });

  test("maps a ticker packet without depth to ltp-only", () => {
    const tick = toNormalizedTick(tickerEvent());
    expect(tick).toStrictEqual({
      securityId: "49081",
      exchangeSegment: "NSE_FNO",
      ltp: 150,
      timestamp: 1_700_000_000_000,
    });
  });

  test("returns null for non-price packets", () => {
    const oiEvent: MarketOiEvent = {
      type: "oi",
      responseCode: 5,
      messageLength: 0,
      exchangeSegmentCode: 2,
      exchangeSegment: "NSE_FNO",
      securityId: "49081",
      openInterest: 1000,
      raw: Buffer.alloc(0),
    };
    expect(toNormalizedTick(oiEvent)).toBeNull();
  });
});

describe("toInstrumentMetadata", () => {
  test("maps a scrip-master row, defaulting missing lot/tick size", () => {
    const instrument: Instrument = {
      securityId: "49081",
      exchangeSegment: "NSE_FNO",
      symbolName: "NIFTY25000CE",
      instrumentType: "OPTIDX",
    };

    expect(toInstrumentMetadata(instrument)).toStrictEqual({
      securityId: "49081",
      exchangeSegment: "NSE_FNO",
      tradingSymbol: "NIFTY25000CE",
      lotSize: 1,
      tickSize: 0.05,
      segment: "OPTIONS",
    });
  });

  test("classifies futures and defaults to equity for anything else", () => {
    const future: Instrument = { securityId: "1", exchangeSegment: "NSE_FNO", instrumentType: "FUTIDX" };
    const equity: Instrument = { securityId: "2", exchangeSegment: "NSE_EQ", instrumentType: "EQUITY" };

    expect(toInstrumentMetadata(future)?.segment).toBe("FUTURES");
    expect(toInstrumentMetadata(equity)?.segment).toBe("EQUITY");
  });

  test("returns null when the row has no exchange segment", () => {
    const instrument: Instrument = { securityId: "49081" };
    expect(toInstrumentMetadata(instrument)).toBeNull();
  });
});

describe("createInstrumentResolver", () => {
  test("resolves instruments by securityId + exchangeSegment", () => {
    const instruments: Instrument[] = [
      { securityId: "49081", exchangeSegment: "NSE_FNO", lotSize: 75, tickSize: 0.05, instrumentType: "OPTIDX" },
    ];
    const resolver = createInstrumentResolver(instruments);

    expect(resolver("49081", "NSE_FNO")).toMatchObject({ lotSize: 75, tickSize: 0.05 });
    expect(resolver("49081", "NSE_EQ")).toBeUndefined();
    expect(resolver("unknown", "NSE_FNO")).toBeUndefined();
  });

  test("skips rows that can't be mapped to metadata", () => {
    const instruments: Instrument[] = [{ securityId: "no_segment" }];
    const resolver = createInstrumentResolver(instruments);
    expect(resolver("no_segment", "NSE_FNO")).toBeUndefined();
  });
});
