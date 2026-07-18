import { readFileSync, existsSync } from "fs";
import { Provider, OllamaToolSchema, ChatMessage } from "../provider/provider.js";
import { resolveOllamaCloudKeys } from "./ollama-cloud.js";
import { assessReadiness, DEFAULT_READINESS_CRITERIA } from "./readiness.js";
import { TradeEvaluator } from "./trade-evaluator.js";
import { TradeAnalyst, reconstructClosedTrades } from "./trade-analyst.js";

// Read-only conversational assistant over the paper-trading system's on-disk
// state. Every tool below wraps an existing read function — no new business
// logic, no write path. There is deliberately NO place_order/close_position/
// modify_stop tool: the tool array passed to Provider.chat() is the complete
// enforcement — the model cannot call a function that isn't in the list, no
// matter what a prompt injection or a confused user asks it to do.
//
// Runs as its own process (scripts/paper-trade-chat.ts), reading the same
// journal/state files LivePaperRunner and friends write. No in-process
// coupling to a running bot — works whether or not one is currently active.

// Matches LivePaperRunner's RunnerState (live-runner.ts) -- one net position
// per symbol (shared across strategies), one capital pool per symbol.
interface PaperState {
  strategyStats: Record<string, { trades: number; wins: number; losses: number; paused?: boolean }>;
  symbolCapital: Record<string, number>;
  symbolPositions: Record<string, {
    symbol: string; direction: "long" | "short" | null; qty: number; avgEntryPrice: number;
    notional: number; margin: number; contributingStrategyIds: string[];
  }>;
}

const EMPTY_STATE: PaperState = { strategyStats: {}, symbolCapital: {}, symbolPositions: {} };

export interface ChatAssistantConfig {
  stateFile: string;
  journalFile: string;
  poolPath: string;
  model: string;
  tier: "local" | "cloud";
  maxToolRounds: number;
}

const TIER: "local" | "cloud" = process.env.TRADINGAGENT_ANALYST_TIER === "local" ? "local" : "cloud";
const MODEL = process.env.TRADINGAGENT_ANALYST_MODEL || (TIER === "local" ? "minicpm5-1b" : "gpt-oss:20b");

export const DEFAULT_CHAT_CONFIG: ChatAssistantConfig = {
  stateFile: ".trading-agent/paper-state.json",
  journalFile: ".trading-agent/paper-trades.jsonl",
  poolPath: "strategies.json",
  model: MODEL,
  tier: TIER,
  maxToolRounds: 4,
};

function loadPaperState(stateFile: string): PaperState {
  if (!existsSync(stateFile)) return EMPTY_STATE;
  try { return JSON.parse(readFileSync(stateFile, "utf-8")); } catch { return EMPTY_STATE; }
}

function loadPool(poolPath: string): any {
  return JSON.parse(readFileSync(poolPath, "utf-8"));
}

function tailJournal(journalFile: string, n: number): any[] {
  if (!existsSync(journalFile)) return [];
  try {
    const lines = readFileSync(journalFile, "utf-8").trim().split("\n").filter(Boolean);
    return lines.slice(-n).reverse().map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

const TOOLS: OllamaToolSchema[] = [
  { type: "function", function: { name: "get_portfolio_status", description: "Overall paper-trading portfolio: total equity, available balance, used margin, open position count across all strategies.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "get_open_positions", description: "List every currently open paper position with entry price, stop, target, quantity, margin, and how long it's been open.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "get_strategy_status", description: "Per-strategy live paper-trading stats: capital, realized PnL, trade count, win rate, whether it currently has an open position.", parameters: { type: "object", properties: { strategyId: { type: "string", description: "Optional — omit to get all strategies" } } } } },
  { type: "function", function: { name: "get_recent_fills", description: "Recent entry/exit fills from the trade journal, most recent first.", parameters: { type: "object", properties: { count: { type: "number", description: "How many to return, default 10" } } } } },
  { type: "function", function: { name: "get_recent_trade_evaluations", description: "Recent per-trade LLM quality evaluations (entry/exit reasoning + 1-5 score) from the trade evaluator log.", parameters: { type: "object", properties: { count: { type: "number", description: "How many to return, default 5" } } } } },
  { type: "function", function: { name: "get_analyst_summary", description: "The latest periodic batch analysis comparing live performance to backtest expectations across the whole strategy pool.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "get_readiness_status", description: "Deterministic (rule-based, not LLM-judged) live-trading readiness per strategy and for the portfolio as a whole — trade count, PF, WR divergence from backtest.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "get_strategy_backtest_reference", description: "The validated backtested WR/PF/label for a strategy id, from strategies.json — what the strategy was expected to do before live trading started.", parameters: { type: "object", properties: { strategyId: { type: "string" } }, required: ["strategyId"] } } },
];

export class ChatAssistant {
  private cfg: ChatAssistantConfig;
  private provider: Provider;
  private history: ChatMessage[] = [];

  constructor(cfg: Partial<ChatAssistantConfig> = {}) {
    this.cfg = { ...DEFAULT_CHAT_CONFIG, ...cfg };
    const cloudKeys = this.cfg.tier === "cloud" ? resolveOllamaCloudKeys() : {};
    this.provider = new Provider({ tier: this.cfg.tier, model: this.cfg.model, ...cloudKeys });
    this.history.push({
      role: "system",
      content:
        "You are a read-only assistant for a rule-based crypto futures paper-trading system " +
        "(SOLUSDT/ETHUSDT/XRPUSDT). You can query live status via the tools provided, but you have " +
        "NO ability to place, close, or modify any trade — no such tool exists, and you must never " +
        "claim to have taken an action. If asked to place/close/modify a trade, explain that you are " +
        "advisory-only and that decisions come exclusively from the deterministic signal evaluator. " +
        "Answer using the tool data, be specific and quantitative, keep responses concise.",
    });
  }

  private callTool(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case "get_portfolio_status": {
        const state = loadPaperState(this.cfg.stateFile);
        const pool = loadPool(this.cfg.poolPath);
        const perSymbolCapital = pool.config?.initialCapital ?? 10000;
        const symbolCount = Object.keys(state.symbolCapital).length;
        const totalCapital = Object.values(state.symbolCapital).reduce((s, c) => s + c, 0);
        let usedMargin = 0, openCount = 0;
        for (const pos of Object.values(state.symbolPositions)) {
          if (pos.direction) { usedMargin += pos.margin; openCount++; }
        }
        const totalInitial = symbolCount * perSymbolCapital;
        return {
          totalInitialCapital: totalInitial,
          totalRealizedPnl: totalCapital - totalInitial,
          usedMargin, availableBalance: totalCapital - usedMargin,
          openPositions: openCount, symbolCount,
          leverage: pool.config?.leverage, marginPerTradePct: pool.config?.marginPerTradePct,
        };
      }
      case "get_open_positions": {
        const state = loadPaperState(this.cfg.stateFile);
        // One row per SYMBOL now (shared position, not per-strategy) -- see
        // LivePaperRunner's class header comment for why.
        return Object.values(state.symbolPositions).filter(pos => pos.direction);
      }
      case "get_strategy_status": {
        const state = loadPaperState(this.cfg.stateFile);
        const pool = loadPool(this.cfg.poolPath);
        const symbolOf: Record<string, string> = {};
        for (const [symbol, strats] of Object.entries(pool.symbols) as [string, any[]][]) {
          for (const s of strats) symbolOf[s.id] = symbol;
        }
        const closed = reconstructClosedTrades(this.cfg.journalFile);
        const rowFor = (sid: string) => {
          const st = state.strategyStats[sid];
          if (!st) return { error: `no state for strategy ${sid}` };
          const own = closed.filter(t => t.strategyId === sid);
          const attributedPnl = Math.round(own.reduce((s, t) => s + t.pnl, 0) * 100) / 100;
          const symbol = symbolOf[sid];
          const contributesToOpenPosition = symbol ? state.symbolPositions[symbol]?.contributingStrategyIds.includes(sid) ?? false : false;
          return {
            strategyId: sid, symbol, attributedPnl, trades: st.trades, wins: st.wins, losses: st.losses,
            winRate: st.trades > 0 ? st.wins / st.trades : null, contributesToOpenPosition,
          };
        };
        const id = args.strategyId as string | undefined;
        if (id) return rowFor(id);
        return Object.keys(state.strategyStats).map(rowFor);
      }
      case "get_recent_fills":
        return tailJournal(this.cfg.journalFile, Number(args.count ?? 10));
      case "get_recent_trade_evaluations": {
        const evaluator = new TradeEvaluator();
        return evaluator.getRecentEvaluations(Number(args.count ?? 5));
      }
      case "get_analyst_summary": {
        const analyst = new TradeAnalyst();
        return analyst.getLatestSummary() ?? { message: "no analysis run yet" };
      }
      case "get_readiness_status": {
        const { strategies, portfolio } = assessReadiness(this.cfg.journalFile, this.cfg.poolPath, DEFAULT_READINESS_CRITERIA);
        return { strategies, portfolio, criteria: DEFAULT_READINESS_CRITERIA };
      }
      case "get_strategy_backtest_reference": {
        const pool = loadPool(this.cfg.poolPath);
        for (const strats of Object.values(pool.symbols) as any[][]) {
          const found = strats.find(s => s.id === args.strategyId);
          if (found) return { id: found.id, label: found.label, direction: found.direction, tf: found.tf, risk: found.risk, metrics: found.metrics };
        }
        return { error: `strategy ${args.strategyId} not found in pool` };
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  async ask(userMessage: string): Promise<string> {
    this.history.push({ role: "user", content: userMessage });

    for (let round = 0; round < this.cfg.maxToolRounds; round++) {
      const res = await this.provider.chat(this.history, { tools: TOOLS });
      const toolCalls = res.message.tool_calls as Array<{ function: { name: string; arguments: unknown } }> | undefined;

      if (!toolCalls || toolCalls.length === 0) {
        const content = res.message.content;
        this.history.push({ role: "assistant", content });
        return content;
      }

      this.history.push({ role: "assistant", content: res.message.content ?? "", tool_calls: toolCalls });
      for (const call of toolCalls) {
        const args = typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments || "{}") : (call.function.arguments as Record<string, unknown>) ?? {};
        const result = this.callTool(call.function.name, args);
        this.history.push({ role: "tool", content: JSON.stringify(result) });
      }
    }
    return "(hit max tool-call rounds without a final answer — try a more specific question)";
  }
}
