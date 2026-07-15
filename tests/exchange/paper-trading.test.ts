import { PaperTradingManager } from "../../src/exchange/paper-trading.js";
import { BinanceStreamManager } from "../../src/exchange/binance-stream.js";

// Real WebSocket + real live BTCUSDT price — this manager never touches a
// real exchange (no order placement, no keys), it just marks simulated
// positions against the same live ticker feed the watch/alert tools use.
describe("PaperTradingManager (real network)", () => {
  let stream: BinanceStreamManager;
  let paper: PaperTradingManager;

  beforeEach(() => {
    stream = new BinanceStreamManager();
    paper = new PaperTradingManager(stream);
  });

  afterEach(() => {
    stream.closeAll();
  });

  it("opens a position at the current live price", async () => {
    const result = await paper.open("BTCUSDT", "long", 1);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.entryPrice).toBeGreaterThan(0);
      expect(result.closedAt).toBeNull();
    }
  }, 20000);

  it("lists open positions with mark-to-market applied", async () => {
    await paper.open("BTCUSDT", "long", 1);
    const positions = paper.list(true);
    expect(positions).toHaveLength(1);
    expect(positions[0].closedAt).toBeNull();
  }, 20000);

  it("closes a position manually at the current live price", async () => {
    const opened = await paper.open("ETHUSDT", "short", 1);
    if ("error" in opened) throw new Error(opened.message);
    const closed = paper.close(opened.id);
    expect(closed?.closedAt).not.toBeNull();
    expect(closed?.closeReason).toBe("manual");
    expect(typeof closed?.realizedPnlPct).toBe("number");
  }, 20000);

  it("auto-closes a position whose stop is already behind the live price", async () => {
    const opened = await paper.open("BTCUSDT", "long", 1);
    if ("error" in opened) throw new Error(opened.message);
    const tick = stream.getLatest("BTCUSDT")!;
    // Stop set just above the current price guarantees an immediate trigger on the next mark.
    const withStop = await paper.open("BTCUSDT", "long", 1, tick.price * 1.5);
    if ("error" in withStop) throw new Error(withStop.message);
    const positions = paper.list();
    const found = positions.find((p) => p.id === withStop.id);
    expect(found?.closedAt).not.toBeNull();
    expect(found?.closeReason).toBe("stop");
  }, 20000);
});
