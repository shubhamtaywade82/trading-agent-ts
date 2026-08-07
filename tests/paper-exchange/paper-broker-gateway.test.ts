import { PaperBrokerGateway } from "../../src/paper-exchange/paper-broker-gateway.js";
import type { InstrumentMetadata, NormalizedTick, OrderIntent } from "../../src/paper-exchange/types.js";

function noInstrument(): InstrumentMetadata | undefined {
  return undefined;
}

function tick(overrides: Partial<NormalizedTick> = {}): NormalizedTick {
  return {
    securityId: "NIFTY-25000-CE",
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
    securityId: "NIFTY-25000-CE",
    exchangeSegment: "NSE_FNO",
    transactionType: "BUY",
    orderType: "MARKET",
    quantity: 75,
    ...overrides,
  };
}

describe("PaperBrokerGateway", () => {
  test("routes a market order through matching into the portfolio, net of fees", () => {
    const gateway = new PaperBrokerGateway({ initialCapital: 100_000 });
    gateway.submitOrder(intent());

    const fills = gateway.onTick(tick());
    expect(fills).toHaveLength(1);

    const snap = gateway.getSnapshot();
    expect(snap.positions).toHaveLength(1);
    expect(snap.positions[0]).toMatchObject({ netQty: 75 });
    expect(snap.cash).toBeLessThan(100_000 - 75 * fills[0]!.fillPrice); // Fees applied
    expect(snap.totalFeesPaid).toBeGreaterThan(0);
  });

  test("marks the position to market on subsequent ticks with no new fills", () => {
    const gateway = new PaperBrokerGateway({ initialCapital: 100_000 });
    gateway.submitOrder(intent());
    gateway.onTick(tick());

    const fills = gateway.onTick(tick({ ltp: 160, bestBid: 159.95, bestAsk: 160.05 }));

    expect(fills).toHaveLength(0);
    expect(gateway.getSnapshot().unrealizedPnl).toBeGreaterThan(0);
  });

  test("cancelOrder prevents a pending order from filling on a later tick", () => {
    const gateway = new PaperBrokerGateway({ initialCapital: 100_000 });
    const order = gateway.submitOrder(intent({ orderType: "LIMIT", price: 140 }));

    expect(gateway.cancelOrder(order.orderId)).toBe(true);
    const fills = gateway.onTick(tick({ ltp: 140, bestAsk: 139.9 }));

    expect(fills).toHaveLength(0);
    expect(gateway.getPendingOrders()).toHaveLength(0);
  });

  test("getOrder looks up an order by id after it has traded", () => {
    const gateway = new PaperBrokerGateway({ initialCapital: 100_000 });
    const order = gateway.submitOrder(intent());
    gateway.onTick(tick());

    expect(gateway.getOrder(order.orderId)?.status).toBe("TRADED");
    expect(gateway.getOrder("missing")).toBeUndefined();
  });

  test("getTrades surfaces fills through the gateway", () => {
    const gateway = new PaperBrokerGateway({ initialCapital: 100_000 });
    gateway.submitOrder(intent());
    const [fill] = gateway.onTick(tick());

    const trades = gateway.getTrades();
    expect(trades).toHaveLength(1);
    expect(trades[0]?.orderId).toBe(fill?.orderId);
  });

  test("rejects orders that fail instrument validation and never fills them", () => {
    const gateway = new PaperBrokerGateway({
      initialCapital: 100_000,
      resolveInstrument: noInstrument,
    });

    const order = gateway.submitOrder(intent());
    expect(order.status).toBe("REJECTED");

    const fills = gateway.onTick(tick());
    expect(fills).toHaveLength(0);
    expect(gateway.getSnapshot().positions).toHaveLength(0);
  });
});
