import { PaperOrderMatcher } from "../../src/paper-exchange/order-matcher.js";
import type { NormalizedTick, OrderIntent } from "../../src/paper-exchange/types.js";

const NIFTY_CE = "NIFTY-25000-CE";

function tick(overrides: Partial<NormalizedTick> = {}): NormalizedTick {
  return {
    securityId: NIFTY_CE,
    exchangeSegment: "NSE_FNO",
    ltp: 150,
    bestBid: 149.95,
    bestAsk: 150.05,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

function intent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    correlationId: "corr_1",
    strategyId: "nifty_momentum",
    signalId: "sig_1",
    securityId: NIFTY_CE,
    exchangeSegment: "NSE_FNO",
    transactionType: "BUY",
    orderType: "MARKET",
    quantity: 75,
    ...overrides,
  };
}

describe("PaperOrderMatcher", () => {
  test("fills a MARKET BUY at bestAsk plus slippage", () => {
    const matcher = new PaperOrderMatcher({ slippageTicks: 1 });
    matcher.submitOrder(intent({ orderType: "MARKET" }));

    const fills = matcher.onTick(tick());

    expect(fills).toHaveLength(1);
    expect(fills[0]?.fillPrice).toBeCloseTo(150.05 + 0.05, 5);
    expect(fills[0]?.fees.total).toBeGreaterThan(0);
    expect(matcher.getPendingOrders()).toHaveLength(0);
  });

  test("does not fill a LIMIT BUY above the market ask", () => {
    const matcher = new PaperOrderMatcher();
    matcher.submitOrder(intent({ orderType: "LIMIT", price: 150 }));

    const fills = matcher.onTick(tick({ bestAsk: 150.05, ltp: 150 }));

    expect(fills).toHaveLength(0);
    expect(matcher.getPendingOrders()).toHaveLength(1);
  });

  test("fills a LIMIT BUY once the market trades through the limit price", () => {
    const matcher = new PaperOrderMatcher();
    matcher.submitOrder(intent({ orderType: "LIMIT", price: 150 }));

    const fills = matcher.onTick(tick({ bestAsk: 149.95, ltp: 149.9 }));

    expect(fills).toHaveLength(1);
    expect(fills[0]?.fillPrice).toBeLessThanOrEqual(150);
    expect(matcher.getPendingOrders()).toHaveLength(0);
  });

  test("SL BUY stays TRIGGER_PENDING until LTP crosses the trigger price", () => {
    const matcher = new PaperOrderMatcher();
    matcher.submitOrder(intent({ orderType: "SL", triggerPrice: 155, price: 155.5 }));

    const noFill = matcher.onTick(tick({ ltp: 150, bestAsk: 150.05 }));
    expect(noFill).toHaveLength(0);

    const fills = matcher.onTick(tick({ ltp: 155.2, bestAsk: 155.25 }));
    expect(fills).toHaveLength(1);
  });

  test("SL-M SELL fills at bestBid minus slippage once triggered", () => {
    const matcher = new PaperOrderMatcher({ slippageTicks: 2 });
    matcher.submitOrder(intent({ transactionType: "SELL", orderType: "SL-M", triggerPrice: 145 }));

    const fills = matcher.onTick(tick({ ltp: 144.5, bestBid: 144.45 }));

    expect(fills).toHaveLength(1);
    expect(fills[0]?.fillPrice).toBeCloseTo(144.45 - 2 * 0.05, 5);
  });

  test("ignores ticks for a different security", () => {
    const matcher = new PaperOrderMatcher();
    matcher.submitOrder(intent({ securityId: "BANKNIFTY-52000-PE" }));

    const fills = matcher.onTick(tick({ securityId: NIFTY_CE }));

    expect(fills).toHaveLength(0);
    expect(matcher.getPendingOrders()).toHaveLength(1);
  });

  test("cancelOrder removes a pending order and prevents future fills", () => {
    const matcher = new PaperOrderMatcher();
    const order = matcher.submitOrder(intent({ orderType: "LIMIT", price: 160 }));

    expect(matcher.cancelOrder(order.orderId)).toBe(true);
    expect(matcher.getPendingOrders()).toHaveLength(0);

    const fills = matcher.onTick(tick({ ltp: 160, bestAsk: 159.9 }));
    expect(fills).toHaveLength(0);
  });

  test("uses per-instrument tick size when a resolver is provided", () => {
    const matcher = new PaperOrderMatcher({
      slippageTicks: 1,
      resolveInstrument: () => ({
        securityId: NIFTY_CE,
        exchangeSegment: "NSE_FNO",
        tradingSymbol: "NIFTY25000CE",
        lotSize: 75,
        tickSize: 0.5,
        segment: "OPTIONS",
      }),
    });
    matcher.submitOrder(intent({ orderType: "MARKET" }));

    const fills = matcher.onTick(tick({ bestAsk: 150 }));

    expect(fills[0]?.fillPrice).toBeCloseTo(150.5, 5);
  });
});
