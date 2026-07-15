import { scoreByModel } from "../../src/benchmark/score.js";
import { formatReport } from "../../src/benchmark/report.js";
import { BenchmarkResult } from "../../src/benchmark/types.js";

function result(overrides: Partial<BenchmarkResult>): BenchmarkResult {
  return {
    model: "qwen3:8b",
    tier: "local",
    caseId: "c1",
    pass: true,
    latencyMs: 100,
    tokensPerSec: 20,
    ...overrides,
  };
}

describe("scoreByModel", () => {
  it("groups results by tier+model and computes pass rate", () => {
    const results = [
      result({ model: "a", caseId: "c1", pass: true, latencyMs: 100, tokensPerSec: 10 }),
      result({ model: "a", caseId: "c2", pass: false, latencyMs: 200, tokensPerSec: 30 }),
      result({ model: "b", tier: "cloud", caseId: "c1", pass: true, latencyMs: 50, tokensPerSec: null }),
    ];

    const scores = scoreByModel(results);
    const a = scores.find((s) => s.model === "a")!;
    const b = scores.find((s) => s.model === "b")!;

    expect(a.cases).toBe(2);
    expect(a.passRate).toBe(0.5);
    expect(a.avgLatencyMs).toBe(150);
    expect(a.avgTokensPerSec).toBe(20);

    expect(b.tier).toBe("cloud");
    expect(b.passRate).toBe(1);
    expect(b.avgTokensPerSec).toBeNull();
  });

  it("returns an empty array for no results", () => {
    expect(scoreByModel([])).toEqual([]);
  });
});

describe("formatReport", () => {
  it("ranks by pass rate then latency, higher pass rate first", () => {
    const report = formatReport([
      { model: "slow-perfect", tier: "local", cases: 2, passRate: 1, avgLatencyMs: 500, avgTokensPerSec: 10 },
      { model: "fast-imperfect", tier: "local", cases: 2, passRate: 0.5, avgLatencyMs: 50, avgTokensPerSec: 40 },
    ]);

    const lines = report.split("\n");
    const perfectLine = lines.findIndex((l) => l.includes("slow-perfect"));
    const imperfectLine = lines.findIndex((l) => l.includes("fast-imperfect"));
    expect(perfectLine).toBeLessThan(imperfectLine);
    expect(report).toContain("100%");
    expect(report).toContain("50%");
  });

  it("handles no results", () => {
    expect(formatReport([])).toBe("(no benchmark results)");
  });
});
