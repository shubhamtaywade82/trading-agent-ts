import { AiEntryGate, AiGateIntent, ChatCapable, CapabilityLookup } from "../../src/paper-trading/ai-gate.js";
import { ChatResponse } from "../../src/provider/provider.js";

function intent(): AiGateIntent {
  return {
    strategyId: "xrp-liq-sweep-short-1h", symbol: "XRPUSDT", tf: "1h", direction: "short",
    entryPrice: 3.1, stopPrice: 3.193, targetPrice: 2.914,
    candleContext: "[synthetic candle context]",
    symbolPositionSummary: "flat",
  };
}

function stubProvider(respond: (messages: unknown[]) => Promise<ChatResponse> | ChatResponse): ChatCapable {
  return { chat: async (messages) => respond(messages) };
}

describe("AiEntryGate", () => {
  it("approves with size=1.0 when the model responds APPROVE", async () => {
    const provider = stubProvider(() => ({
      done: true,
      message: { role: "assistant", content: "Looks fine, no red flags.\ndecision: APPROVE size=1.0" },
    }));
    const gate = new AiEntryGate({}, provider);
    const decision = await gate.review(intent());
    expect(decision).toMatchObject({ approved: true, sizeMultiplier: 1 });
  });

  it("approves with a reduced size when the model hedges", async () => {
    const provider = stubProvider(() => ({
      done: true,
      message: { role: "assistant", content: "Entry is a bit extended.\ndecision: APPROVE size=0.5" },
    }));
    const gate = new AiEntryGate({}, provider);
    const decision = await gate.review(intent());
    expect(decision).toMatchObject({ approved: true, sizeMultiplier: 0.5 });
  });

  it("rejects (size=0) when the model responds REJECT", async () => {
    const provider = stubProvider(() => ({
      done: true,
      message: { role: "assistant", content: "This looks like an exhausted move.\ndecision: REJECT" },
    }));
    const gate = new AiEntryGate({}, provider);
    const decision = await gate.review(intent());
    expect(decision).toMatchObject({ approved: false, sizeMultiplier: 0 });
  });

  it("fails closed (size=0, not approved) when the provider throws (e.g. a timeout)", async () => {
    const provider = stubProvider(() => {
      throw new Error("connect timeout after 20000ms");
    });
    const gate = new AiEntryGate({}, provider);
    const decision = await gate.review(intent());
    expect(decision.approved).toBe(false);
    expect(decision.sizeMultiplier).toBe(0);
    expect(decision.rationale).toContain("ai_gate_error");
  });

  it("fails closed when the model response has no parseable decision line", async () => {
    const provider = stubProvider(() => ({
      done: true,
      message: { role: "assistant", content: "I'm not sure, this is ambiguous." },
    }));
    const gate = new AiEntryGate({}, provider);
    const decision = await gate.review(intent());
    expect(decision.approved).toBe(false);
    expect(decision.sizeMultiplier).toBe(0);
    expect(decision.rationale).toContain("unparseable");
  });

  it("fails closed when the provider rejects its promise asynchronously", async () => {
    const provider: ChatCapable = { chat: async () => { throw new Error("network error"); } };
    const gate = new AiEntryGate({}, provider);
    const decision = await gate.review(intent());
    expect(decision.approved).toBe(false);
  });
});

function fakeCatalog(models: Array<{ name: string; tier: "local" | "cloud"; capabilities: string[] }>): CapabilityLookup {
  return { all: () => models, refresh: async () => models };
}

function toolCallResponse(args: Record<string, unknown>): ChatResponse {
  return {
    done: true,
    message: { role: "assistant", content: "", tool_calls: [{ function: { name: "submit_decision", arguments: args } }] },
  };
}

describe("AiEntryGate tool-calling", () => {
  const cfg = { model: "test-model", tier: "local" as const };
  const catalog = fakeCatalog([{ name: "test-model", tier: "local", capabilities: ["tools"] }]);

  it("uses tool-call args to approve at full size (object arguments)", async () => {
    const provider = stubProvider(() => toolCallResponse({ decision: "APPROVE", sizeMultiplier: 1, rationale: "fine" }));
    const gate = new AiEntryGate(cfg, provider, catalog);
    const decision = await gate.review(intent());
    expect(decision).toMatchObject({ approved: true, sizeMultiplier: 1, rationale: "fine" });
  });

  it("uses tool-call args to reject (stringified JSON arguments)", async () => {
    const provider = stubProvider(() => ({
      done: true,
      message: { role: "assistant", content: "", tool_calls: [{ function: { name: "submit_decision", arguments: JSON.stringify({ decision: "REJECT", sizeMultiplier: 0, rationale: "exhausted move" }) } }] },
    }));
    const gate = new AiEntryGate(cfg, provider, catalog);
    const decision = await gate.review(intent());
    expect(decision).toMatchObject({ approved: false, sizeMultiplier: 0, rationale: "exhausted move" });
  });

  it("clamps an out-of-range sizeMultiplier into [0,1]", async () => {
    const provider = stubProvider(() => toolCallResponse({ decision: "APPROVE", sizeMultiplier: 5, rationale: "ok" }));
    const gate = new AiEntryGate(cfg, provider, catalog);
    const decision = await gate.review(intent());
    expect(decision.sizeMultiplier).toBe(1);
  });

  it("fails closed when tool call args are missing required fields", async () => {
    const provider = stubProvider(() => toolCallResponse({ decision: "APPROVE" }));
    const gate = new AiEntryGate(cfg, provider, catalog);
    const decision = await gate.review(intent());
    expect(decision.approved).toBe(false);
    expect(decision.rationale).toContain("unparseable tool call args");
  });

  it("fails closed when the model returns no tool call at all", async () => {
    const provider = stubProvider(() => ({ done: true, message: { role: "assistant", content: "no tool used" } }));
    const gate = new AiEntryGate(cfg, provider, catalog);
    const decision = await gate.review(intent());
    expect(decision.approved).toBe(false);
    expect(decision.rationale).toContain("no tool call in response");
  });

  it("falls back to regex parsing when the catalog says the model has no tools capability", async () => {
    const noToolsCatalog = fakeCatalog([{ name: "test-model", tier: "local", capabilities: ["completion"] }]);
    const provider = stubProvider(() => ({
      done: true,
      message: { role: "assistant", content: "Looks fine.\ndecision: APPROVE size=0.5" },
    }));
    const gate = new AiEntryGate(cfg, provider, noToolsCatalog);
    const decision = await gate.review(intent());
    expect(decision).toMatchObject({ approved: true, sizeMultiplier: 0.5 });
  });

  it("falls back to regex parsing when no catalog is supplied (back-compat)", async () => {
    const provider = stubProvider(() => ({
      done: true,
      message: { role: "assistant", content: "Looks fine.\ndecision: APPROVE size=1.0" },
    }));
    const gate = new AiEntryGate(cfg, provider);
    const decision = await gate.review(intent());
    expect(decision).toMatchObject({ approved: true, sizeMultiplier: 1 });
  });
});
