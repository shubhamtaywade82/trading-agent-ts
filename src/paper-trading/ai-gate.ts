import { Provider, ChatMessage, ChatResponse, ChatOptions, OllamaToolSchema } from "../provider/provider.js";
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

// Single tool the model must call to render a decision -- replaces free-text
// + regex with a schema Ollama validates before it ever reaches us. Still
// re-validated below (parseToolDecision): never trust unvalidated model
// output on a money-affecting field, schema or not.
const DECIDE_TOOL: OllamaToolSchema[] = [
  {
    type: "function",
    function: {
      name: "submit_decision",
      description: "Submit your APPROVE/REJECT decision for this pre-trade risk review.",
      parameters: {
        type: "object",
        properties: {
          decision: { type: "string", enum: ["APPROVE", "REJECT"] },
          sizeMultiplier: { type: "number", description: "1.0 for full size, 0.5 for half size on moderate concern, ignored if decision is REJECT" },
          rationale: { type: "string", description: "1-2 sentence reason" },
        },
        required: ["decision", "sizeMultiplier", "rationale"],
      },
    },
  },
];

function parseToolDecision(res: ChatResponse): AiGateDecision {
  const call = (res.message?.tool_calls as Array<{ function: { name: string; arguments: unknown } }> | undefined)?.[0];
  if (!call) return { approved: false, sizeMultiplier: 0, rationale: `no tool call in response: ${(res.message?.content ?? "").slice(0, 200)}` };

  const raw = typeof call.function.arguments === "string" ? safeJsonParse(call.function.arguments) : call.function.arguments;
  const args = raw as { decision?: unknown; sizeMultiplier?: unknown; rationale?: unknown } | null;
  const decision = typeof args?.decision === "string" ? args.decision.toUpperCase() : null;
  const rationale = typeof args?.rationale === "string" ? args.rationale : "";

  if (decision !== "APPROVE" && decision !== "REJECT") {
    return { approved: false, sizeMultiplier: 0, rationale: `unparseable tool call args: ${JSON.stringify(raw).slice(0, 200)}` };
  }
  if (decision === "REJECT") return { approved: false, sizeMultiplier: 0, rationale };

  const size = typeof args?.sizeMultiplier === "number" && Number.isFinite(args.sizeMultiplier) ? args.sizeMultiplier : NaN;
  if (Number.isNaN(size)) {
    return { approved: false, sizeMultiplier: 0, rationale: `unparseable tool call args: ${JSON.stringify(raw).slice(0, 200)}` };
  }
  return { approved: true, sizeMultiplier: Math.min(1, Math.max(0, size)), rationale };
}

function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

// Structural subset of Provider actually used here -- lets tests inject a
// stub without depending on Provider's concrete constructor/HTTP internals.
export interface ChatCapable {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse>;
}

// Structural subset of ModelCatalog (src/provider/catalog.ts) actually used
// here -- same rationale as ChatCapable: lets tests inject a hand-built fake
// without satisfying ModelCatalog's private internals.
export interface CapabilityLookup {
  all(): Array<{ name: string; tier: "local" | "cloud"; capabilities: string[] }>;
  refresh(): Promise<unknown>;
}

export class AiEntryGate {
  private provider: ChatCapable;
  private model: string;
  private catalog?: CapabilityLookup;
  private toolsSupported: boolean | null = null; // null = not yet resolved

  constructor(cfg: Partial<AiGateConfig> = {}, provider?: ChatCapable, catalog?: CapabilityLookup) {
    const c = { ...DEFAULT_AI_GATE_CONFIG, ...cfg };
    this.model = c.model;
    this.catalog = catalog;
    if (provider) {
      this.provider = provider;
    } else {
      const cloudKeys = c.tier === "cloud" ? resolveOllamaCloudKeys() : {};
      this.provider = new Provider({ tier: c.tier, model: c.model, timeoutMs: c.timeoutMs, ...cloudKeys });
    }
  }

  // Lazily resolved once per instance. Local Ollama's /api/tags reports real
  // per-model capabilities (authoritative); cloud-tier capability detection
  // is a name heuristic that always claims "tools" support, so it's treated
  // as unverified and logged once rather than trusted outright.
  private async resolveToolsSupported(): Promise<boolean> {
    if (this.toolsSupported !== null) return this.toolsSupported;
    if (!this.catalog) return (this.toolsSupported = false);
    try {
      if (this.catalog.all().length === 0) await this.catalog.refresh();
      const entry = this.catalog.all().find(m => m.name === this.model);
      this.toolsSupported = entry?.capabilities.includes("tools") ?? false;
      if (this.toolsSupported && entry?.tier === "cloud") {
        console.warn(`ai-gate: relying on unverified cloud tool-call support for model ${this.model}`);
      }
    } catch {
      this.toolsSupported = false;
    }
    return this.toolsSupported;
  }

  async review(intent: AiGateIntent): Promise<AiGateDecision> {
    try {
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(intent) },
      ];
      if (await this.resolveToolsSupported()) {
        const res = await this.provider.chat(messages, { tools: DECIDE_TOOL });
        return parseToolDecision(res);
      }
      const res = await this.provider.chat(messages);
      const text = (res.message?.content ?? "").trim();
      return parseDecision(text);
    } catch (e) {
      return { approved: false, sizeMultiplier: 0, rationale: `ai_gate_error: ${(e as Error).message}` };
    }
  }
}
