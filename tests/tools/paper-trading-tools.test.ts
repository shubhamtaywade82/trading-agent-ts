import { BinancePaperTradeTool } from "../../src/tools/paper-trading-tools.js";
import { PaperTradingManager } from "../../src/exchange/paper-trading.js";

function fakeManager(overrides: Partial<PaperTradingManager> = {}): PaperTradingManager {
  return {
    open: jest.fn(),
    list: jest.fn().mockReturnValue([]),
    close: jest.fn(),
    ...overrides,
  } as unknown as PaperTradingManager;
}

describe("BinancePaperTradeTool", () => {
  it("opens a position", async () => {
    const position = { id: 1, symbol: "BTCUSDT", direction: "long", entryPrice: 60000, quantity: 1 };
    const manager = fakeManager({ open: jest.fn().mockResolvedValue(position) });
    const tool = new BinancePaperTradeTool(manager);
    const result = await tool.call({ action: "open", symbol: "BTCUSDT", direction: "long", quantity: 1 });
    expect(manager.open).toHaveBeenCalledWith("BTCUSDT", "long", 1, undefined, undefined);
    expect(result).toEqual(position);
  });

  it("rejects an invalid open call", async () => {
    const tool = new BinancePaperTradeTool(fakeManager());
    const result = await tool.call({ action: "open", symbol: "BTCUSDT" });
    expect(result.error).toBe("InvalidArgs");
  });

  it("surfaces an open error from the manager", async () => {
    const manager = fakeManager({ open: jest.fn().mockResolvedValue({ error: "NoPriceYet", message: "no price" }) });
    const tool = new BinancePaperTradeTool(manager);
    const result = await tool.call({ action: "open", symbol: "BTCUSDT", direction: "long", quantity: 1 });
    expect(result.error).toBe("NoPriceYet");
  });

  it("lists positions", async () => {
    const positions = [{ id: 1 }];
    const manager = fakeManager({ list: jest.fn().mockReturnValue(positions) });
    const tool = new BinancePaperTradeTool(manager);
    const result = await tool.call({ action: "list" });
    expect(result.positions).toEqual(positions);
  });

  it("closes a position", async () => {
    const closed = { id: 1, closedAt: 123 };
    const manager = fakeManager({ close: jest.fn().mockReturnValue(closed) });
    const tool = new BinancePaperTradeTool(manager);
    const result = await tool.call({ action: "close", id: 1 });
    expect(result).toEqual(closed);
  });

  it("returns NotFound when closing a nonexistent position", async () => {
    const manager = fakeManager({ close: jest.fn().mockReturnValue(undefined) });
    const tool = new BinancePaperTradeTool(manager);
    const result = await tool.call({ action: "close", id: 999 });
    expect(result.error).toBe("NotFound");
  });

  it("rejects an unknown action", async () => {
    const tool = new BinancePaperTradeTool(fakeManager());
    const result = await tool.call({ action: "nope" });
    expect(result.error).toBe("InvalidAction");
  });
});
