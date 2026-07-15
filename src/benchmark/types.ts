import { ChatMessage, ChatResponse, OllamaToolSchema, Tier } from "../provider/provider.js";

export interface BenchmarkCase {
  id: string;
  description: string;
  messages: ChatMessage[];
  tools?: OllamaToolSchema[];
  validate: (response: ChatResponse) => { pass: boolean; reason?: string };
}

export interface BenchmarkResult {
  model: string;
  tier: Tier;
  caseId: string;
  pass: boolean;
  reason?: string;
  latencyMs: number;
  tokensPerSec: number | null;
  error?: string;
}

export interface ModelScore {
  model: string;
  tier: Tier;
  cases: number;
  passRate: number;
  avgLatencyMs: number;
  avgTokensPerSec: number | null;
}
