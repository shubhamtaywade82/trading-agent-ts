import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";
import { Provider } from "../provider/provider.js";
import { resolveOllamaCloudKeys } from "./ollama-cloud.js";

// Read-only LLM analyst over the paper-trading journal. It NEVER touches
// LivePaperRunner, never sees strategies.json as anything but reference
// data, and has no tool-calling surface — it can only produce text. Entry/
// exit decisions come from buildSignalEvaluator or ConceptsEngine (rules),
// optionally gated by AiEntryGate — never from this module. This module's
// only effect on the world is appending to a log file.
//
// "Learning" here means: periodically look at accumulated real trade
// history, compare it against what the backtest predicted, and write down
// what's observed — not silently rewriting strategy parameters. A human
// reads the log and decides whether to act on it (see strategies.json's
// existing pattern of every past finding being written down with its
// evidence, never applied automatically).

interface PositionFillEvent {
  ts: string; type: string; strategyId?: string; symbol?: string; tf?: string;
  direction?: "long" | "short"; action?: string;
  price?: number; entryPriceAtFill?: number; entryTimeAtFill?: number | null;
  reason?: string; realizedPnl?: number;
}

export interface ClosedTrade {
  strategyId: string; symbol: string; tf: string; direction: "long" | "short";
  entryPrice: number; exitPrice: number; entryTime: string; exitTime: string;
  reason: string; pnl: number;
}

const CLOSING_ACTIONS = new Set(["reduce", "close", "flip_close"]);

export function reconstructClosedTrades(journalFile: string): ClosedTrade[] {
  if (!existsSync(journalFile)) return [];
  const lines = readFileSync(journalFile, "utf-8").trim().split("\n").filter(Boolean);
  const closed: ClosedTrade[] = [];
  for (const line of lines) {
    let e: PositionFillEvent;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "position_fill" || !e.action || !CLOSING_ACTIONS.has(e.action) || !e.strategyId) continue;
    closed.push({
      strategyId: e.strategyId, symbol: e.symbol ?? "", tf: e.tf ?? "",
      direction: e.direction ?? "short", entryPrice: e.entryPriceAtFill ?? 0,
      exitPrice: e.price ?? 0,
      entryTime: e.entryTimeAtFill != null ? new Date(e.entryTimeAtFill).toISOString() : e.ts,
      exitTime: e.ts, reason: e.reason ?? "unknown", pnl: e.realizedPnl ?? 0,
    });
  }
  return closed;
}

interface BacktestRef { winRate: number; pf: number }
function loadBacktestRefs(poolPath: string): Record<string, BacktestRef> {
  const cfg = JSON.parse(readFileSync(poolPath, "utf-8"));
  const out: Record<string, BacktestRef> = {};
  for (const strats of Object.values(cfg.symbols) as any[][]) {
    for (const s of strats) out[s.id] = { winRate: s.metrics.winRate, pf: s.metrics.pf };
  }
  return out;
}

function buildPrompt(trades: ClosedTrade[], backtestRefs: Record<string, BacktestRef>): { system: string; user: string } {
  const byStrategy = new Map<string, ClosedTrade[]>();
  for (const t of trades) {
    const arr = byStrategy.get(t.strategyId);
    if (arr) arr.push(t); else byStrategy.set(t.strategyId, [t]);
  }

  const lines: string[] = [];
  for (const [id, ts] of byStrategy) {
    const wins = ts.filter(t => t.pnl > 0).length;
    const wr = wins / ts.length;
    const grossProfit = ts.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(ts.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    const totalPnl = ts.reduce((s, t) => s + t.pnl, 0);
    const ref = backtestRefs[id];
    lines.push(
      `${id}: ${ts.length} live trades, WR ${(wr * 100).toFixed(0)}% (backtest expected ${ref ? (ref.winRate * 100).toFixed(0) : "?"}%), ` +
      `PF ${pf.toFixed(2)} (backtest expected ${ref?.pf.toFixed(2) ?? "?"}), total PnL $${totalPnl.toFixed(2)}, ` +
      `exit reasons: ${ts.map(t => t.reason).reduce((acc: Record<string, number>, r) => { acc[r] = (acc[r] ?? 0) + 1; return acc; }, {}) && Object.entries(ts.reduce((acc: Record<string, number>, t) => { acc[t.reason] = (acc[t.reason] ?? 0) + 1; return acc; }, {})).map(([r, c]) => `${r}=${c}`).join(",")}`
    );
  }

  const recent = [...trades].slice(-15).map(t =>
    `${t.exitTime} ${t.strategyId} ${t.direction} entry=${t.entryPrice} exit=${t.exitPrice} reason=${t.reason} pnl=${t.pnl.toFixed(2)}`
  ).join("\n");

  return {
    system:
      "You are a trading performance analyst reviewing PAPER (simulated) trading results for a rule-based " +
      "crypto futures strategy pool (SOLUSDT/ETHUSDT/XRPUSDT). You have NO ability to place trades, change " +
      "strategy parameters, or take any action of any kind — you produce written analysis only, for a human " +
      "to read and decide whether to act on. Be specific and quantitative. Prioritize: (1) strategies whose " +
      "live win-rate or profit-factor diverges meaningfully from backtested expectations, (2) unusual " +
      "clusters of stop-outs or liquidations, (3) any strategy that has gone unusually long without firing. " +
      "Do not repeat the raw numbers back verbatim — interpret them. Keep the response under 250 words, plain text.",
    user:
      `Per-strategy live performance so far:\n${lines.join("\n")}\n\n` +
      `${recent ? `Most recent closed trades:\n${recent}\n\n` : ""}` +
      `Write a short analyst note on what stands out.`,
  };
}

export interface AnalystConfig {
  journalFile: string;
  learningsFile: string;   // append-only JSONL of every analysis run
  summaryFile: string;     // human-readable rolling markdown digest
  stateFile: string;
  poolPath: string;
  model: string;
  tier: "local" | "cloud";
  minNewTradesToAnalyze: number;
  minIntervalMs: number;
  maxSummaryEntries: number;
}

// Default to Ollama Cloud (not local) — set TRADINGAGENT_ANALYST_TIER=local
// to opt back into local inference, in which case the model defaults to
// minicpm5-1b (must be pulled locally first: `ollama pull minicpm5-1b`).
const ANALYST_TIER: "local" | "cloud" = process.env.TRADINGAGENT_ANALYST_TIER === "local" ? "local" : "cloud";
const ANALYST_MODEL = process.env.TRADINGAGENT_ANALYST_MODEL || (ANALYST_TIER === "local" ? "minicpm5-1b" : "gpt-oss:20b");

export const DEFAULT_ANALYST_CONFIG: AnalystConfig = {
  journalFile: ".trading-agent/paper-trades.jsonl",
  learningsFile: ".trading-agent/paper-trading-learnings.jsonl",
  summaryFile: ".trading-agent/paper-trading-insights.md",
  stateFile: ".trading-agent/analyst-state.json",
  poolPath: "strategies.json",
  model: ANALYST_MODEL,
  tier: ANALYST_TIER,
  minNewTradesToAnalyze: 3,
  minIntervalMs: 60 * 60 * 1000, // 1 hour floor between LLM calls regardless of trade volume
  maxSummaryEntries: 30,
};

interface AnalystState { lastAnalyzedTradeCount: number; lastAnalysisTime: number }

export class TradeAnalyst {
  private cfg: AnalystConfig;
  private provider: Provider;
  private state: AnalystState = { lastAnalyzedTradeCount: 0, lastAnalysisTime: 0 };
  private running = false;

  constructor(cfg: Partial<AnalystConfig> = {}) {
    this.cfg = { ...DEFAULT_ANALYST_CONFIG, ...cfg };
    const cloudKeys = this.cfg.tier === "cloud" ? resolveOllamaCloudKeys() : {};
    this.provider = new Provider({ tier: this.cfg.tier, model: this.cfg.model, ...cloudKeys });
    this.loadState();
  }

  private loadState() {
    if (existsSync(this.cfg.stateFile)) {
      try { this.state = JSON.parse(readFileSync(this.cfg.stateFile, "utf-8")); } catch { /* ignore, use defaults */ }
    }
  }

  private saveState() {
    const dir = dirname(this.cfg.stateFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.cfg.stateFile, JSON.stringify(this.state, null, 2));
  }

  private appendLearning(entry: Record<string, unknown>) {
    const dir = dirname(this.cfg.learningsFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.cfg.learningsFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  }

  private updateSummaryMarkdown(newEntry: { ts: string; tradesAnalyzed: number; summary: string; error?: string }) {
    const dir = dirname(this.cfg.summaryFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let existing: { ts: string; tradesAnalyzed: number; summary: string; error?: string }[] = [];
    if (existsSync(this.cfg.summaryFile)) {
      try {
        const raw = readFileSync(this.cfg.summaryFile, "utf-8");
        const marker = "<!-- analyst-entries:";
        const idx = raw.indexOf(marker);
        if (idx >= 0) existing = JSON.parse(raw.slice(idx + marker.length, raw.indexOf("-->", idx)));
      } catch { /* start fresh */ }
    }
    existing = [newEntry, ...existing].slice(0, this.cfg.maxSummaryEntries);

    const body = [
      "# Paper Trading — AI Analyst Log",
      "",
      "Read-only performance analysis over accumulated paper-trading history. This LLM has no ability",
      "to place trades or change strategy parameters — it only writes observations for a human to read.",
      "Actual trade decisions come exclusively from `buildSignalEvaluator` (deterministic, backtest-matched).",
      "",
      ...existing.map(e => [
        `## ${new Date(e.ts).toLocaleString()} — ${e.tradesAnalyzed} trades analyzed`,
        "",
        e.error ? `_Analysis failed: ${e.error}_` : e.summary,
        "",
      ].join("\n")),
      `<!-- analyst-entries:${JSON.stringify(existing)}-->`,
    ].join("\n");
    writeFileSync(this.cfg.summaryFile, body);
  }

  getLatestSummary(): { ts: string; tradesAnalyzed: number; summary: string } | null {
    if (!existsSync(this.cfg.learningsFile)) return null;
    try {
      const lines = readFileSync(this.cfg.learningsFile, "utf-8").trim().split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        const e = JSON.parse(lines[i]);
        if (e.summary) return e;
      }
    } catch { /* fall through */ }
    return null;
  }

  // Runs at most once per call; returns whether an analysis actually ran.
  async maybeAnalyze(): Promise<boolean> {
    const trades = reconstructClosedTrades(this.cfg.journalFile);
    const newTrades = trades.length - this.state.lastAnalyzedTradeCount;
    const dueByTime = Date.now() - this.state.lastAnalysisTime >= this.cfg.minIntervalMs;
    const dueByVolume = newTrades >= this.cfg.minNewTradesToAnalyze;
    if (trades.length === 0 || !(dueByTime && (dueByVolume || this.state.lastAnalysisTime === 0))) return false;

    let summary: string;
    let error: string | undefined;
    try {
      const refs = loadBacktestRefs(this.cfg.poolPath);
      const { system, user } = buildPrompt(trades, refs);
      const res = await this.provider.chat([
        { role: "system", content: system },
        { role: "user", content: user },
      ]);
      summary = res.message.content.trim();
    } catch (e) {
      error = (e as Error).message;
      summary = "";
    }

    this.state = { lastAnalyzedTradeCount: trades.length, lastAnalysisTime: Date.now() };
    this.saveState();
    this.appendLearning({ tradesAnalyzed: trades.length, newTradesSinceLastRun: newTrades, summary, error, model: this.cfg.model });
    this.updateSummaryMarkdown({ ts: new Date().toISOString(), tradesAnalyzed: trades.length, summary, error });
    return true;
  }

  async start(checkIntervalMs = 5 * 60 * 1000, onResult?: (ran: boolean) => void) {
    this.running = true;
    while (this.running) {
      try {
        const ran = await this.maybeAnalyze();
        onResult?.(ran);
      } catch { /* maybeAnalyze already catches provider errors; this guards the loop itself */ }
      if (!this.running) break;
      await new Promise(r => setTimeout(r, checkIntervalMs));
    }
  }

  stop() {
    this.running = false;
  }
}
