import { Provider, ChatResponse, Tier } from "../provider/provider.js";
import { BenchmarkCase, BenchmarkResult } from "./types.js";

export interface BenchmarkTarget {
  model: string;
  tier: Tier;
  provider: Provider;
}

export async function runBenchmark(
  targets: BenchmarkTarget[],
  cases: BenchmarkCase[],
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  for (const target of targets) {
    target.provider.setModel(target.model);
    target.provider.setTier(target.tier);

    for (const testCase of cases) {
      const start = Date.now();
      try {
        const response = await target.provider.chat(testCase.messages, {
          tools: testCase.tools,
          stream: false,
        });
        const latencyMs = Date.now() - start;
        const { pass, reason } = testCase.validate(response);
        results.push({
          model: target.model,
          tier: target.tier,
          caseId: testCase.id,
          pass,
          reason,
          latencyMs,
          tokensPerSec: estimateTokensPerSec(response, latencyMs),
        });
      } catch (e) {
        results.push({
          model: target.model,
          tier: target.tier,
          caseId: testCase.id,
          pass: false,
          latencyMs: Date.now() - start,
          tokensPerSec: null,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return results;
}

// Ollama's /api/chat response includes eval_count/eval_duration (ns) on the
// final chunk when available; fall back to a rough content-length estimate
// (~4 chars/token) when a provider doesn't report them.
function estimateTokensPerSec(response: ChatResponse, latencyMs: number): number | null {
  const evalCount = response.eval_count as number | undefined;
  const evalDurationNs = response.eval_duration as number | undefined;
  if (typeof evalCount === "number" && typeof evalDurationNs === "number" && evalDurationNs > 0) {
    return evalCount / (evalDurationNs / 1e9);
  }
  if (latencyMs <= 0) return null;
  const content = response.message?.content ?? "";
  const estimatedTokens = content.length / 4;
  return estimatedTokens / (latencyMs / 1000);
}
