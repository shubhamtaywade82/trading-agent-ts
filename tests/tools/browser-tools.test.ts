import {
  BrowserNavigateTool, BrowserClickTool, BrowserFillTool,
  BrowserGetTextTool, BrowserScreenshotTool, BrowserEvaluateTool, BrowserCloseTool,
} from "../../src/tools/browser-tools.js";
import { BrowserManager } from "../../src/browser/manager.js";

function fakeManager(overrides: Partial<BrowserManager> = {}): BrowserManager {
  return {
    navigate: jest.fn().mockResolvedValue({ title: "T", url: "https://x" }),
    click: jest.fn().mockResolvedValue(undefined),
    fill: jest.fn().mockResolvedValue(undefined),
    getText: jest.fn().mockResolvedValue("some text"),
    screenshot: jest.fn().mockResolvedValue(Buffer.from("fake-png")),
    evaluate: jest.fn().mockResolvedValue(42),
    close: jest.fn().mockResolvedValue(undefined),
    currentUrl: "https://x",
    ...overrides,
  } as unknown as BrowserManager;
}

describe("BrowserNavigateTool", () => {
  it("returns title and url on success", async () => {
    const manager = fakeManager();
    const tool = new BrowserNavigateTool(manager);
    const result = await tool.call({ url: "https://example.com" });
    expect(manager.navigate).toHaveBeenCalledWith("https://example.com");
    expect(result).toEqual({ title: "T", url: "https://x" });
  });

  it("returns a NavigationError instead of throwing", async () => {
    const manager = fakeManager({ navigate: jest.fn().mockRejectedValue(new Error("net::ERR_NAME_NOT_RESOLVED")) });
    const tool = new BrowserNavigateTool(manager);
    const result = await tool.call({ url: "https://nowhere.invalid" });
    expect(result.error).toBe("NavigationError");
    expect(result.message).toContain("ERR_NAME_NOT_RESOLVED");
  });
});

describe("BrowserClickTool", () => {
  it("clicks and reports the current url", async () => {
    const manager = fakeManager();
    const tool = new BrowserClickTool(manager);
    const result = await tool.call({ selector: "#btn" });
    expect(manager.click).toHaveBeenCalledWith("#btn");
    expect(result).toEqual({ clicked: true, url: "https://x" });
  });

  it("returns a ClickError instead of throwing when the selector isn't found", async () => {
    const manager = fakeManager({ click: jest.fn().mockRejectedValue(new Error("no element")) });
    const tool = new BrowserClickTool(manager);
    const result = await tool.call({ selector: "#missing" });
    expect(result.error).toBe("ClickError");
  });
});

describe("BrowserFillTool", () => {
  it("fills a field", async () => {
    const manager = fakeManager();
    const tool = new BrowserFillTool(manager);
    const result = await tool.call({ selector: "#email", text: "a@b.com" });
    expect(manager.fill).toHaveBeenCalledWith("#email", "a@b.com");
    expect(result).toEqual({ filled: true });
  });
});

describe("BrowserGetTextTool", () => {
  it("gets text scoped to a selector when given", async () => {
    const manager = fakeManager();
    const tool = new BrowserGetTextTool(manager);
    await tool.call({ selector: "#heading" });
    expect(manager.getText).toHaveBeenCalledWith("#heading");
  });

  it("gets the whole page body when no selector is given", async () => {
    const manager = fakeManager();
    const tool = new BrowserGetTextTool(manager);
    await tool.call({});
    expect(manager.getText).toHaveBeenCalledWith(undefined);
  });
});

describe("BrowserScreenshotTool", () => {
  it("returns a base64-encoded PNG", async () => {
    const manager = fakeManager();
    const tool = new BrowserScreenshotTool(manager);
    const result = await tool.call({});
    expect(result.pngBase64).toBe(Buffer.from("fake-png").toString("base64"));
    expect(result.sizeBytes).toBe(8);
  });
});

describe("BrowserEvaluateTool", () => {
  it("returns the evaluation result", async () => {
    const manager = fakeManager();
    const tool = new BrowserEvaluateTool(manager);
    const result = await tool.call({ script: "1+1" });
    expect(manager.evaluate).toHaveBeenCalledWith("1+1");
    expect(result).toEqual({ result: 42 });
  });
});

describe("BrowserCloseTool", () => {
  it("closes the browser", async () => {
    const manager = fakeManager();
    const tool = new BrowserCloseTool(manager);
    const result = await tool.call({});
    expect(manager.close).toHaveBeenCalled();
    expect(result).toEqual({ closed: true });
  });
});
