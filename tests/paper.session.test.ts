import { describe, it, expect } from "@jest/globals";
import { PaperBrokerage } from "../src/brokerage/paperBrokerage.js";
import { loadConfig } from "../src/config/loader.js";
import type { OrderIntent } from "../src/domain/types.js";

describe("PaperBrokerage Idempotency & Determinism", () => {
  it("never double-fills orders with the same idempotency key", async () => {
    const cfg = loadConfig(undefined, {
      paper: { enabled: true, initialCapital: 10_000, baseCurrency: "USD" },
    });
    const brokerage = new PaperBrokerage(cfg);
    brokerage.markToMarket(new Map([["AAPL", 150]]));

    const intent: OrderIntent = {
      idempotencyKey: "test-idempotency-key-1",
      symbol: "AAPL",
      side: "BUY",
      qty: 10,
      type: "MARKET",
    };

    const fill1 = await brokerage.submit(intent);
    const fill2 = await brokerage.submit(intent);

    expect(fill1.status).toBe("FILLED");
    expect(fill1).toEqual(fill2);

    const account = brokerage.getAccount();
    // Cash should be deducted once for 10 units, not twice
    const expectedCash = 10_000 - (150 * (1 + cfg.execution.slippagePct) * 10 + 150 * 10 * cfg.execution.commissionPct);
    expect(account.cash).toBeCloseTo(expectedCash, 2);
  });
});
