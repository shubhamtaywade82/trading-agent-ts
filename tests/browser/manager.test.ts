import { BrowserManager } from "../../src/browser/manager.js";

// Real Chromium, real navigation — data: URLs keep it offline/deterministic,
// same spirit as the real-process LSP client tests (verify the actual
// integration, not a mock of it).
const PAGE = `data:text/html,<html><head><title>Test Page</title></head><body>
  <h1 id="heading">Hello</h1>
  <input id="name" />
  <button id="btn" onclick="document.getElementById('heading').textContent='Clicked'">Click me</button>
</body></html>`;

describe("BrowserManager", () => {
  let browser: BrowserManager;

  beforeEach(() => {
    browser = new BrowserManager();
  });

  afterEach(async () => {
    await browser.close();
  });

  it("navigates and returns the page title", async () => {
    const result = await browser.navigate(PAGE);
    expect(result.title).toBe("Test Page");
  }, 30000);

  it("reads text content, optionally scoped to a selector", async () => {
    await browser.navigate(PAGE);
    expect(await browser.getText("#heading")).toBe("Hello");
    expect(await browser.getText()).toContain("Hello");
  }, 30000);

  it("fills a form field", async () => {
    await browser.navigate(PAGE);
    await browser.fill("#name", "hello world");
    const value = await browser.evaluate("document.getElementById('name').value");
    expect(value).toBe("hello world");
  }, 30000);

  it("clicks an element and observes the resulting DOM change", async () => {
    await browser.navigate(PAGE);
    await browser.click("#btn");
    expect(await browser.getText("#heading")).toBe("Clicked");
  }, 30000);

  it("takes a real PNG screenshot", async () => {
    await browser.navigate(PAGE);
    const buffer = await browser.screenshot();
    expect(buffer.length).toBeGreaterThan(0);
    // PNG magic bytes
    expect(buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }, 30000);

  it("evaluates arbitrary JS in the page and returns the result", async () => {
    await browser.navigate(PAGE);
    expect(await browser.evaluate("1 + 1")).toBe(2);
  }, 30000);

  it("reuses the same page across calls until close()", async () => {
    await browser.navigate(PAGE);
    const urlBefore = browser.currentUrl;
    await browser.getText();
    expect(browser.currentUrl).toBe(urlBefore);
  }, 30000);

  it("currentUrl is null before any navigation and after close()", async () => {
    expect(browser.currentUrl).toBeNull();
    await browser.navigate(PAGE);
    expect(browser.currentUrl).not.toBeNull();
    await browser.close();
    expect(browser.currentUrl).toBeNull();
  }, 30000);

  it("relaunches cleanly after close()", async () => {
    await browser.navigate(PAGE);
    await browser.close();
    const result = await browser.navigate(PAGE);
    expect(result.title).toBe("Test Page");
  }, 30000);
});
