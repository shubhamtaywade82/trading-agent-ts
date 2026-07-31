import type { BinanceStreamManager } from "../exchange/binance-stream.js";

import { BINANCE_TAGS } from "./binance-client.js";
import { Tool } from "./tool.js";

abstract class BinanceStreamTool extends Tool {
  constructor(protected stream: BinanceStreamManager) {
    super();
  }

  override get tags(): string[] {
    return [...BINANCE_TAGS, "websocket", "real-time"];
  }
}

export class BinanceWatchPriceTool extends BinanceStreamTool {
  readonly name = "binance_watch_price";
  readonly description = "Subscribe to a live Binance WebSocket ticker stream for a symbol (auto-subscribes on first call) and return the latest price. Call repeatedly to poll a live feed instead of re-fetching REST each time.";

  override get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { symbol: { type: "string", description: "e.g. BTCUSDT" } },
      required: ["symbol"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = typeof args["symbol"] === "string" ? args["symbol"].toUpperCase() : "";
    try {
      if (!this.stream.isSubscribed(symbol)) await this.stream.subscribe(symbol);
    } catch (e) {
      return { error: "SubscribeError", message: (e as Error).message };
    }

    // First tick may not have arrived yet right after subscribing.
    for (let i = 0; i < 20; i++) {
      const tick = this.stream.getLatest(symbol);
      if (tick) return { ...tick };
      await new Promise((resolve) => { setTimeout(resolve, 250); });
    }
    return { error: "NoTickYet", message: "Subscribed but no price received yet, try again" };
  }
}

export class BinanceUnwatchPriceTool extends BinanceStreamTool {
  readonly name = "binance_unwatch_price";
  readonly description = "Unsubscribe from a symbol's live WebSocket ticker stream.";

  override get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    };
  }

  call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = typeof args["symbol"] === "string" ? args["symbol"] : "";
    const removed = this.stream.unsubscribe(symbol);
    return Promise.resolve({ unsubscribed: removed });
  }
}

export class BinanceLiquidationsTool extends BinanceStreamTool {
  readonly name = "binance_liquidations";

  get description(): string {
    return (
      "Live futures liquidation feed (WebSocket, no key). action: 'subscribe' (start buffering, " +
      "returns immediately — liquidations accumulate in the background, call 'list' after a few " +
      "seconds), 'list' (recent liquidations, optionally filtered by symbol), 'unsubscribe'. A " +
      "burst of same-side liquidations often precedes/confirms a squeeze — use with order-book and " +
      "funding data, not alone."
    );
  }

  override get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        action: { type: "string", enum: ["subscribe", "list", "unsubscribe"] },
        symbol: { type: "string", description: "Optional filter for 'list'" },
      },
      required: ["action"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = typeof args["action"] === "string" ? args["action"] : "";

    if (action === "subscribe") {
      try {
        if (!this.stream.isSubscribedToLiquidations()) await this.stream.subscribeLiquidations();
      } catch (e) {
        return { error: "SubscribeError", message: (e as Error).message };
      }
      return { subscribed: true };
    }

    if (action === "list") {
      const symbol = typeof args["symbol"] === "string" ? args["symbol"] : undefined;
      return { liquidations: this.stream.getLiquidations(symbol) };
    }

    if (action === "unsubscribe") {
      return { unsubscribed: this.stream.unsubscribeLiquidations() };
    }

    return { error: "InvalidAction", message: "action must be 'subscribe', 'list', or 'unsubscribe'" };
  }
}

export class BinancePriceAlertTool extends BinanceStreamTool {
  readonly name = "binance_price_alert";

  get description(): string {
    return (
      "Manage live price alerts backed by the WebSocket ticker stream. action: 'create' " +
      "(symbol, condition: 'above'|'below', threshold — auto-subscribes to the symbol), " +
      "'list' (all alerts with triggered status), 'remove' (id)."
    );
  }

  override get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "remove"] },
        symbol: { type: "string" },
        condition: { type: "string", enum: ["above", "below"] },
        threshold: { type: "number" },
        id: { type: "number" },
      },
      required: ["action"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = typeof args["action"] === "string" ? args["action"] : "";

    if (action === "create") {
      return this.createAlert(args);
    }

    if (action === "list") {
      return { alerts: this.stream.listAlerts() };
    }

    if (action === "remove") {
      const id = Number(args["id"]);
      return { removed: this.stream.removeAlert(id) };
    }

    return { error: "InvalidAction", message: "action must be 'create', 'list', or 'remove'" };
  }

  private async createAlert(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = typeof args["symbol"] === "string" ? args["symbol"].toUpperCase() : "";
    const condition = args["condition"];
    const threshold = Number(args["threshold"]);
    if (!symbol || (condition !== "above" && condition !== "below") || Number.isNaN(threshold)) {
      return { error: "InvalidArgs", message: "create requires symbol, condition ('above'|'below'), threshold" };
    }
    try {
      if (!this.stream.isSubscribed(symbol)) await this.stream.subscribe(symbol);
    } catch (e) {
      return { error: "SubscribeError", message: (e as Error).message };
    }
    const alert = this.stream.addAlert(symbol, condition, threshold);
    return { ...alert };
  }
}
