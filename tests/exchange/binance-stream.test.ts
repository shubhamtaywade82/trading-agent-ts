import { BinanceStreamManager } from "../../src/exchange/binance-stream.js";

// Real WebSocket connection to Binance's public ticker stream, same spirit
// as the real-Chromium browser tests — verify the actual integration.
describe("BinanceStreamManager (real network)", () => {
  let manager: BinanceStreamManager;

  beforeEach(() => {
    manager = new BinanceStreamManager();
  });

  afterEach(() => {
    manager.closeAll();
  });

  it("subscribes and receives real ticks for BTCUSDT", async () => {
    await manager.subscribe("BTCUSDT");
    expect(manager.isSubscribed("BTCUSDT")).toBe(true);

    let tick;
    for (let i = 0; i < 40 && !tick; i++) {
      tick = manager.getLatest("BTCUSDT");
      if (!tick) await new Promise((r) => setTimeout(r, 250));
    }
    expect(tick).toBeDefined();
    expect(tick!.symbol).toBe("BTCUSDT");
    expect(tick!.price).toBeGreaterThan(0);
  }, 20000);

  it("unsubscribe stops tracking the symbol", async () => {
    await manager.subscribe("ETHUSDT");
    expect(manager.unsubscribe("ETHUSDT")).toBe(true);
    expect(manager.isSubscribed("ETHUSDT")).toBe(false);
    expect(manager.getLatest("ETHUSDT")).toBeUndefined();
  }, 20000);

  it("triggers an alert once the live price crosses an always-true threshold", async () => {
    await manager.subscribe("BTCUSDT");
    const alert = manager.addAlert("BTCUSDT", "above", 0); // any positive price trips this
    for (let i = 0; i < 40; i++) {
      if (manager.listAlerts().find((a) => a.id === alert.id)?.triggered) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const found = manager.listAlerts().find((a) => a.id === alert.id);
    expect(found?.triggered).toBe(true);
    expect(found?.triggeredPrice).toBeGreaterThan(0);
  }, 20000);

  it("removeAlert removes it from the list", async () => {
    const alert = manager.addAlert("BTCUSDT", "below", 1);
    expect(manager.removeAlert(alert.id)).toBe(true);
    expect(manager.listAlerts()).toHaveLength(0);
  });

  it("subscribes to the real liquidations stream and buffers events", async () => {
    await manager.subscribeLiquidations();
    expect(manager.isSubscribedToLiquidations()).toBe(true);
    // Liquidations are bursty and unpredictable — just prove the connection
    // opened and the getter doesn't throw; don't wait on a specific event.
    expect(Array.isArray(manager.getLiquidations())).toBe(true);
    expect(manager.unsubscribeLiquidations()).toBe(true);
    expect(manager.isSubscribedToLiquidations()).toBe(false);
  }, 20000);
});
