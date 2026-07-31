import { PaperTradingBrokerageService, OrderRequest } from "../../src/paper-trading/brokerage.js";
import { DEFAULT_TRADING_CONFIG } from "../../src/paper-trading/trading-config.js";

describe("PaperTradingBrokerageService", () => {
  let brokerage: PaperTradingBrokerageService;

  beforeEach(() => {
    brokerage = new PaperTradingBrokerageService(DEFAULT_TRADING_CONFIG);
  });

  test("initializes balance from config", async () => {
    const bal = await brokerage.getAccountBalance();
    expect(bal.initialCapital).toBe(10000);
    expect(bal.cashBalance).toBe(10000);
  });

  test("executes valid order and updates open positions", async () => {
    const req: OrderRequest = {
      idempotencyKey: "key_1",
      symbol: "BTCUSDT",
      direction: "long",
      quantity: 0.1,
      entryPrice: 50000,
      stopPrice: 49000,
      targetPrice: 52000,
    };

    const res = await brokerage.placeOrder(req);
    expect(res.status).toBe("filled");
    expect(res.commission).toBeGreaterThan(0);

    const positions = await brokerage.getOpenPositions("BTCUSDT");
    expect(positions.length).toBe(1);
    expect(positions[0].entryPrice).toBe(50000);
  });

  test("handles duplicate idempotency keys cleanly", async () => {
    const req: OrderRequest = {
      idempotencyKey: "key_dup",
      symbol: "BTCUSDT",
      direction: "long",
      quantity: 0.1,
      entryPrice: 50000,
    };

    const first = await brokerage.placeOrder(req);
    const second = await brokerage.placeOrder(req);

    expect(first.status).toBe("filled");
    expect(second.status).toBe("duplicate");

    const positions = await brokerage.getOpenPositions();
    expect(positions.length).toBe(1);
  });

  test("marks to market and auto-closes positions hitting stop loss", async () => {
    await brokerage.placeOrder({
      idempotencyKey: "key_stop",
      symbol: "BTCUSDT",
      direction: "long",
      quantity: 0.1,
      entryPrice: 50000,
      stopPrice: 49000,
    });

    brokerage.markToMarket({ BTCUSDT: 48500 });

    const open = await brokerage.getOpenPositions();
    expect(open.length).toBe(0);

    const bal = await brokerage.getAccountBalance();
    expect(bal.realizedPnl).toBeLessThan(0);
  });
});
