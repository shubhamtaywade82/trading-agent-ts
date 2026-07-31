import type { OrderRequest } from "../../src/paper-trading/brokerage.js";
import { PaperTradingBrokerageService } from "../../src/paper-trading/brokerage.js";
import { DEFAULT_TRADING_CONFIG } from "../../src/paper-trading/trading-config.js";

describe("PaperTradingBrokerageService", () => {
  let brokerage: PaperTradingBrokerageService;

  beforeEach(() => {
    brokerage = new PaperTradingBrokerageService(DEFAULT_TRADING_CONFIG);
  });

  test("initializes balance from config", async () => {
    const bal = await brokerage.getAccountBalance();
    expect(bal.initialCapital).toBe(10_000);
    expect(bal.cashBalance).toBe(10_000);
  });

  test("executes valid order and updates open positions", async () => {
    const req: OrderRequest = {
      idempotencyKey: "key_1",
      symbol: "BTCUSDT",
      direction: "long",
      quantity: 0.1,
      entryPrice: 50_000,
      stopPrice: 49_000,
      targetPrice: 52_000,
    };

    const res = await brokerage.placeOrder(req);
    expect(res.status).toBe("filled");
    expect(res.commission).toBeGreaterThan(0);

    const positions = await brokerage.getOpenPositions("BTCUSDT");
    expect(positions).toHaveLength(1);
    expect(positions[0].entryPrice).toBe(50_000);
  });

  test("handles duplicate idempotency keys cleanly", async () => {
    const req: OrderRequest = {
      idempotencyKey: "key_dup",
      symbol: "BTCUSDT",
      direction: "long",
      quantity: 0.1,
      entryPrice: 50_000,
    };

    const first = await brokerage.placeOrder(req);
    const second = await brokerage.placeOrder(req);

    expect(first.status).toBe("filled");
    expect(second.status).toBe("duplicate");

    const positions = await brokerage.getOpenPositions();
    expect(positions).toHaveLength(1);
  });

  test("marks to market and auto-closes positions hitting stop loss", async () => {
    await brokerage.placeOrder({
      idempotencyKey: "key_stop",
      symbol: "BTCUSDT",
      direction: "long",
      quantity: 0.1,
      entryPrice: 50_000,
      stopPrice: 49_000,
    });

    brokerage.markToMarket({ BTCUSDT: 48_500 });

    const open = await brokerage.getOpenPositions();
    expect(open).toHaveLength(0);

    const bal = await brokerage.getAccountBalance();
    expect(bal.realizedPnl).toBeLessThan(0);
  });
});
