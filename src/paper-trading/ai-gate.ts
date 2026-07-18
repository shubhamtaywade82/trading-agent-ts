import { Provider, ChatMessage, ChatResponse } from "../provider/provider.js";
import { resolveOllamaCloudKeys } from "./ollama-cloud.js";

// A real, explicit reversal of the boundary TradeAnalyst/TradeEvaluator hold
// ("never touches trading state") -- this gate CAN veto or scale a
// rules-fired entry before it opens. Opt-in (RunnerConfig.aiMode defaults to
// "no-ai"), and deliberately FAILS CLOSED: any timeout, network error, or
// unparseable response means the trade is skipped, never traded blind. See
// docs/superpowers/... plan for the full rationale.

export interface AiGateConfig {
  tier: "local" | "cloud";
  model: string;
  timeoutMs: number;
}

export interface AiGateIntent {
  strategyId: string;
  symbol: string;
  tf: string;
  direction: "long" | "short";
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  candleContext: string; // caller-formatted recent candles, already fetched -- no extra fetch here
  symbolPositionSummary: string; // e.g. "flat" | "long 1.2 XRPUSDT @ 3.10, contributors: [strat-a, strat-b]"
}

export interface AiGateDecision {
  approved: boolean;
  sizeMultiplier: number; // 0 when rejected/errored, else 0.5-1.0
  rationale: string;
}

const GATE_TIER: "local" | "cloud" = process.env.TRADINGAGENT_ANALYST_TIER === "local" ? "local" : "cloud";
const GATE_MODEL =
  process.env.TRADINGAGENT_ANALYST_MODEL || (GATE_TIER === "local" ? "minicpm5-1b" : "gpt-oss:20b");

export const DEFAULT_AI_GATE_CONFIG: AiGateConfig = {
  tier: GATE_TIER,
  model: GATE_MODEL,
  timeoutMs: 20_000, // well under Provider's own 60s cloud connect timeout -- fail closed fast
};

const SYSTEM_PROMPT =
  "You are a pre-trade risk gate for a rule-based crypto futures PAPER-trading bot. A deterministic " +
  "rules engine has already fired an entry signal -- your job is ONLY to catch cases where market " +
  "context makes this specific signal look unusually bad (e.g. entry price already far extended past " +
  "where the signal's edge was validated, an obviously exhausted move, a conflicting current position). " +
  "You are NOT re-deciding the strategy -- default to APPROVE unless something concrete looks wrong. " +
  "Respond with 2-3 sentences, then end with EXACTLY one line: " +
  '"decision: APPROVE size=1.0" or "decision: APPROVE size=0.5" (half-size on moderate concern) or ' +
  '"decision: REJECT".';

function buildUserPrompt(intent: AiGateIntent): string {
  return (
    `Strategy: ${intent.strategyId}\n` +
    `Symbol/TF: ${intent.symbol} ${intent.tf}\n` +
    `Direction: ${intent.direction}\n` +
    `Entry: ${intent.entryPrice} Stop: ${intent.stopPrice} Target: ${intent.targetPrice}\n` +
    `Current symbol position: ${intent.symbolPositionSummary}\n` +
    `Recent candles: ${intent.candleContext}`
  );
}

function parseDecision(text: string): AiGateDecision {
  const m = text.match(/decision:\s*(APPROVE|REJECT)(?:\s+size=([0-9.]+))?/i);
  if (!m) return { approved: false, sizeMultiplier: 0, rationale: `unparseable AI response: ${text.slice(0, 200)}` };
  if (m[1].toUpperCase() === "REJECT") return { approved: false, sizeMultiplier: 0, rationale: text };
  return { approved: true, sizeMultiplier: Number(m[2] ?? 1), rationale: text };
}

// Structural subset of Provider actually used here -- lets tests inject a
// stub without depending on Provider's concrete constructor/HTTP internals.
export interface ChatCapable {
  chat(messages: ChatMessage[]): Promise<ChatResponse>;
}

export class AiEntryGate {
  private provider: ChatCapable;

  constructor(cfg: Partial<AiGateConfig> = {}, provider?: ChatCapable) {
    if (provider) {
      this.provider = provider;
    } else {
      const c = { ...DEFAULT_AI_GATE_CONFIG, ...cfg };
      const cloudKeys = c.tier === "cloud" ? resolveOllamaCloudKeys() : {};
      this.provider = new Provider({ tier: c.tier, model: c.model, timeoutMs: c.timeoutMs, ...cloudKeys });
    }
  }

  async review(intent: AiGateIntent): Promise<AiGateDecision> {
    try {
      const res = await this.provider.chat([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(intent) },
      ]);
      const text = (res.message?.content ?? "").trim();
      return parseDecision(text);
    } catch (e) {
      return { approved: false, sizeMultiplier: 0, rationale: `ai_gate_error: ${(e as Error).message}` };
    }
  }
}
