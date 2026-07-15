import { Tool } from "./tool.js";
import { BrowserManager } from "../browser/manager.js";

abstract class BrowserTool extends Tool {
  constructor(protected browser: BrowserManager) {
    super();
  }

  get tags(): string[] {
    return ["browser", "web"];
  }
}

export class BrowserNavigateTool extends BrowserTool {
  name = "browser_navigate";
  description = "Open a URL in the headless browser and return its title";

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { url: { type: "string", description: "URL to navigate to, e.g. https://example.com" } },
      required: ["url"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const result = await this.browser.navigate(String(args.url ?? ""));
      return { ...result };
    } catch (e) {
      return { error: "NavigationError", message: (e as Error).message };
    }
  }
}

export class BrowserClickTool extends BrowserTool {
  name = "browser_click";
  description = "Click an element on the current page by CSS selector";

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { selector: { type: "string", description: "CSS selector, e.g. 'button.submit'" } },
      required: ["selector"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      await this.browser.click(String(args.selector ?? ""));
      return { clicked: true, url: this.browser.currentUrl };
    } catch (e) {
      return { error: "ClickError", message: (e as Error).message };
    }
  }
}

export class BrowserFillTool extends BrowserTool {
  name = "browser_fill";
  description = "Fill a form field on the current page by CSS selector";

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector, e.g. 'input[name=email]'" },
        text: { type: "string" },
      },
      required: ["selector", "text"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      await this.browser.fill(String(args.selector ?? ""), String(args.text ?? ""));
      return { filled: true };
    } catch (e) {
      return { error: "FillError", message: (e as Error).message };
    }
  }
}

export class BrowserGetTextTool extends BrowserTool {
  name = "browser_get_text";
  description = "Get the text content of the current page, or a specific element by CSS selector";

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { selector: { type: "string", description: "Optional CSS selector; defaults to the whole page body" } },
      required: [],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const text = await this.browser.getText(args.selector ? String(args.selector) : undefined);
      return { text };
    } catch (e) {
      return { error: "GetTextError", message: (e as Error).message };
    }
  }
}

export class BrowserScreenshotTool extends BrowserTool {
  name = "browser_screenshot";
  description = "Take a PNG screenshot of the current page, returned as base64";

  get parameters(): Record<string, unknown> {
    return { type: "object", properties: {}, required: [] };
  }

  async call(): Promise<Record<string, unknown>> {
    try {
      const buffer = await this.browser.screenshot();
      return { pngBase64: buffer.toString("base64"), sizeBytes: buffer.length };
    } catch (e) {
      return { error: "ScreenshotError", message: (e as Error).message };
    }
  }
}

export class BrowserEvaluateTool extends BrowserTool {
  name = "browser_evaluate";
  description = "Run JavaScript in the current page and return the result (page context only, not a host shell)";

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { script: { type: "string", description: "JS expression or function body to evaluate in the page" } },
      required: ["script"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const result = await this.browser.evaluate(String(args.script ?? ""));
      return { result };
    } catch (e) {
      return { error: "EvaluateError", message: (e as Error).message };
    }
  }
}

export class BrowserCloseTool extends BrowserTool {
  name = "browser_close";
  description = "Close the headless browser, freeing its resources";

  get parameters(): Record<string, unknown> {
    return { type: "object", properties: {}, required: [] };
  }

  async call(): Promise<Record<string, unknown>> {
    await this.browser.close();
    return { closed: true };
  }
}
