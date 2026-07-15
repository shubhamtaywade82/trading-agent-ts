import { Provider, ChatResponse } from "../../src/provider/provider.js";
import { runBenchmark } from "../../src/benchmark/runner.js";
import { BenchmarkCase } from "../../src/benchmark/types.js";

function response(content: string, extra: Partial<ChatResponse> = {}): ChatResponse {
  return { message: { role: "assistant", content }, done: true, ...extra };
}

const passingCase: BenchmarkCase = {
  id: "always-pass",
  description: "trivially passes",
  messages: [{ role: "user", content: "hi" }],
  validate: () => ({ pass: true }),
};

const failingCase: BenchmarkCase = {
  id: "always-fail",
  description: "trivially fails",
  messages: [{ role: "user", content: "hi" }],
  validate: () => ({ pass: false, reason: "nope" }),
};

describe("runBenchmark", () => {
  it("runs every case against every target and records pass/fail", async () => {
    const provider = new Provider({ tier: "local", model: "placeholder" });
    jest.spyOn(provider, "chat").mockResolvedValue(response("ok"));

    const results = await runBenchmark(
      [{ model: "qwen3:8b", tier: "local", provider }],
      [passingCase, failingCase],
    );

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.caseId === "always-pass")?.pass).toBe(true);
    expect(results.find((r) => r.caseId === "always-fail")?.pass).toBe(false);
    expect(results.find((r) => r.caseId === "always-fail")?.reason).toBe("nope");
  });

  it("sets the provider's model/tier before invoking chat", async () => {
    const provider = new Provider({ tier: "cloud", model: "placeholder" });
    const chatSpy = jest.spyOn(provider, "chat").mockResolvedValue(response("ok"));

    await runBenchmark([{ model: "qwen3:8b", tier: "local", provider }], [passingCase]);

    expect(provider.currentModel).toBe("qwen3:8b");
    expect(provider.currentTier).toBe("local");
    expect(chatSpy).toHaveBeenCalled();
  });

  it("records a failing result with the error message when chat throws", async () => {
    const provider = new Provider({ tier: "local", model: "x" });
    jest.spyOn(provider, "chat").mockRejectedValue(new Error("connection refused"));

    const results = await runBenchmark([{ model: "qwen3:8b", tier: "local", provider }], [passingCase]);

    expect(results[0].pass).toBe(false);
    expect(results[0].error).toBe("connection refused");
    expect(results[0].tokensPerSec).toBeNull();
  });

  it("computes tokensPerSec from eval_count/eval_duration when present", async () => {
    const provider = new Provider({ tier: "local", model: "x" });
    jest.spyOn(provider, "chat").mockResolvedValue(
      response("ok", { eval_count: 100, eval_duration: 2_000_000_000 }), // 2s -> 50 tok/s
    );

    const results = await runBenchmark([{ model: "qwen3:8b", tier: "local", provider }], [passingCase]);

    expect(results[0].tokensPerSec).toBe(50);
  });

  it("falls back to a content-length estimate when eval fields are absent", async () => {
    const provider = new Provider({ tier: "local", model: "x" });
    jest.spyOn(provider, "chat").mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(response("a".repeat(40))), 5)),
    );

    const results = await runBenchmark([{ model: "qwen3:8b", tier: "local", provider }], [passingCase]);

    expect(results[0].tokensPerSec).not.toBeNull();
    expect(results[0].tokensPerSec).toBeGreaterThan(0);
  });
});
