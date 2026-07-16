import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";
import { Provider } from "../provider/provider.js";
import { fetchCandlesRange } from "../tools/backtest-tools.js";
import { resolveOllamaCloudKeys } from "./ollama-cloud.js";

// Per-EVENT (not periodic-batch, see trade-analyst.ts) LLM evaluation — every
// entry and every exit gets its own reasoned write-up, building a labeled
// trail for later research: which setups the model rated highly that lost
// anyway, whether stops were too tight for the instrument's volatility,
// whether exits look well-timed relative to what happened right after. This
// is the raw material for tightening entries/exits later — not a live
// decision input. Same boundary as every other LLM component here: read the
// journal, write to its own log, zero write access to trading state.
//
// Runs as an async queue, one call at a time (single local Ollama instance —
// no point racing itself), fully decoupled from the trading tick's timing.
// If evaluation falls behind fills, it just queues; nothing blocks on it.

interface JournalEvent {
  ts: string; type: string; strategyId?: string; symbol?: string; tf?: string;
  direction?: "long" | "short"; entryPrice?: number; stopPrice?: number; targetPrice?: number;
  exitPrice?: number; reason?: string; pnl?: number; margin?: number;
}

export interface TradeEvaluation {
  ts: string; strategyId: string; symbol: string; eventType: "entry" | "exit";
  evaluation: string; qualityScore: number | null; error?: string;
}

export interface EvaluatorConfig {
  journalFile: string;
  logFile: string;
  stateFile: string;
  model: string;
  tier: "local" | "cloud";
  candleContextBars: number;
}

// Same tier/model resolution as trade-analyst.ts: cloud by default, local
// only via TRADINGAGENT_ANALYST_TIER=local, which then defaults to
// minicpm5-1b (must be pulled locally first).
const EVALUATOR_TIER: "local" | "cloud" = process.env.TRADINGAGENT_ANALYST_TIER === "local" ? "local" : "cloud";
const EVALUATOR_MODEL = process.env.TRADINGAGENT_ANALYST_MODEL || (EVALUATOR_TIER === "local" ? "minicpm5-1b" : "gpt-oss:20b");

export const DEFAULT_EVALUATOR_CONFIG: EvaluatorConfig = {
  journalFile: ".trading-agent/paper-trades.jsonl",
  logFile: ".trading-agent/trade-evaluations.jsonl",
  stateFile: ".trading-agent/trade-evaluator-state.json",
  model: EVALUATOR_MODEL,
  tier: EVALUATOR_TIER,
  candleContextBars: 20,
};

function extractQualityScore(text: string): number | null {
  const m = text.match(/"?(?:qualityScore|exitQuality)"?\s*[:=]\s*([1-5])/i);
  return m ? Number(m[1]) : null;
}

async function buildEntryPrompt(e: JournalEvent, cfg: EvaluatorConfig): Promise<{ system: string; user: string }> {
  let candleContext = "(candle context unavailable)";
  try {
    const end = Date.now();
    const start = end - cfg.candleContextBars * 3 * 3_600_000; // generous lookback window regardless of tf
    const fetched = await fetchCandlesRange(e.symbol!, e.tf!, start, end);
    if (!("error" in fetched)) {
      const bars = fetched.candles.slice(-cfg.candleContextBars);
      candleContext = bars.map(c => `O${c.open.toFixed(6)} H${c.high.toFixed(6)} L${c.low.toFixed(6)} C${c.close.toFixed(6)}`).join(" | ");
    }
  } catch { /* leave placeholder */ }

  return {
    system:
      "You are a trade-ENTRY quality reviewer for a rule-based crypto futures paper-trading bot. You do not " +
      "control trades — you write a short structured evaluation of this ONE entry signal for a research log " +
      "that will later be mined to tighten entry/exit precision. Given the strategy, direction, entry/stop/" +
      "target prices, and recent candle context, assess: (1) does market context (trend, volatility, recent " +
      "structure) support this signal, (2) any red flags (chasing extension, stop too tight for recent range, " +
      "target unrealistic), (3) a quality score. Keep it to 2-3 sentences, then end with exactly one line: " +
      '"qualityScore: N" where N is 1-5 (1=weak setup, 5=textbook).',
    user:
      `Strategy: ${e.strategyId}\nSymbol/TF: ${e.symbol} ${e.tf}\nDirection: ${e.direction}\n` +
      `Entry: ${e.entryPrice}  Stop: ${e.stopPrice}  Target: ${e.targetPrice}\n` +
      `Recent candles (oldest to newest): ${candleContext}`,
  };
}

function buildExitPrompt(e: JournalEvent, entryEval: TradeEvaluation | null): { system: string; user: string } {
  return {
    system:
      "You are a trade-EXIT quality reviewer for a rule-based crypto futures paper-trading bot. You do not " +
      "control trades — you write a short structured evaluation of this ONE exit for a research log that will " +
      "later be mined to tighten entry/exit precision. Given the exit reason, PnL, and (if available) the " +
      "entry evaluation, assess whether the exit looks well-timed and whether the stop/target sizing seems " +
      "appropriate for this instrument, or whether it's worth testing a wider/tighter level. Keep it to 2-3 " +
      'sentences, then end with exactly one line: "exitQuality: N" where N is 1-5 (1=poorly sized, 5=clean).',
    user:
      `Strategy: ${e.strategyId}\nSymbol: ${e.symbol}\nExit reason: ${e.reason}\nExit price: ${e.exitPrice}\nPnL: $${e.pnl}\n` +
      (entryEval ? `Entry evaluation was: ${entryEval.evaluation}` : "(no entry evaluation on record)"),
  };
}

interface EvaluatorState { lastLineCount: number }

export class TradeEvaluator {
  private cfg: EvaluatorConfig;
  private provider: Provider;
  private state: EvaluatorState = { lastLineCount: 0 };
  private queue: JournalEvent[] = [];
  private running = false;
  private processing = false;
  private recentByStrategy = new Map<string, TradeEvaluation>(); // last entry-eval per strategy, for exit context

  constructor(cfg: Partial<EvaluatorConfig> = {}) {
    this.cfg = { ...DEFAULT_EVALUATOR_CONFIG, ...cfg };
    const cloudKeys = this.cfg.tier === "cloud" ? resolveOllamaCloudKeys() : {};
    this.provider = new Provider({ tier: this.cfg.tier, model: this.cfg.model, ...cloudKeys });
    if (existsSync(this.cfg.stateFile)) {
      try { this.state = JSON.parse(readFileSync(this.cfg.stateFile, "utf-8")); } catch { /* defaults */ }
    }
  }

  private saveState() {
    const dir = dirname(this.cfg.stateFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.cfg.stateFile, JSON.stringify(this.state));
  }

  private appendLog(entry: TradeEvaluation) {
    const dir = dirname(this.cfg.logFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.cfg.logFile, JSON.stringify(entry) + "\n");
  }

  queueLength(): number {
    return this.queue.length;
  }

  getRecentEvaluations(n: number): TradeEvaluation[] {
    if (!existsSync(this.cfg.logFile)) return [];
    try {
      const lines = readFileSync(this.cfg.logFile, "utf-8").trim().split("\n").filter(Boolean);
      return lines.slice(-n).reverse().map(l => JSON.parse(l));
    } catch {
      return [];
    }
  }

  // Scans for new journal lines and enqueues them for evaluation — cheap,
  // call this every trading tick. The actual LLM work happens in the
  // background worker loop (start()), fully decoupled from tick timing.
  scanForNewEvents(): number {
    if (!existsSync(this.cfg.journalFile)) return 0;
    const lines = readFileSync(this.cfg.journalFile, "utf-8").trim().split("\n").filter(Boolean);
    if (lines.length <= this.state.lastLineCount) return 0;
    const newLines = lines.slice(this.state.lastLineCount);
    this.state.lastLineCount = lines.length;
    this.saveState();

    let queued = 0;
    for (const line of newLines) {
      let e: JournalEvent;
      try { e = JSON.parse(line); } catch { continue; }
      if ((e.type === "entry" || e.type === "exit") && e.strategyId) { this.queue.push(e); queued++; }
    }
    return queued;
  }

  private async processOne(e: JournalEvent) {
    try {
      if (e.type === "entry") {
        const { system, user } = await buildEntryPrompt(e, this.cfg);
        const res = await this.provider.chat([{ role: "system", content: system }, { role: "user", content: user }]);
        const evaluation = res.message.content.trim();
        const record: TradeEvaluation = { ts: new Date().toISOString(), strategyId: e.strategyId!, symbol: e.symbol ?? "", eventType: "entry", evaluation, qualityScore: extractQualityScore(evaluation) };
        this.recentByStrategy.set(e.strategyId!, record);
        this.appendLog(record);
      } else if (e.type === "exit") {
        const entryEval = this.recentByStrategy.get(e.strategyId!) ?? null;
        const { system, user } = buildExitPrompt(e, entryEval);
        const res = await this.provider.chat([{ role: "system", content: system }, { role: "user", content: user }]);
        const evaluation = res.message.content.trim();
        const record: TradeEvaluation = { ts: new Date().toISOString(), strategyId: e.strategyId!, symbol: e.symbol ?? "", eventType: "exit", evaluation, qualityScore: extractQualityScore(evaluation) };
        this.appendLog(record);
        this.recentByStrategy.delete(e.strategyId!);
      }
    } catch (err) {
      this.appendLog({ ts: new Date().toISOString(), strategyId: e.strategyId ?? "unknown", symbol: e.symbol ?? "", eventType: e.type === "exit" ? "exit" : "entry", evaluation: "", qualityScore: null, error: (err as Error).message });
    }
  }

  async start(scanIntervalMs = 30_000, onProgress?: (queueLen: number) => void) {
    this.running = true;
    while (this.running) {
      this.scanForNewEvents();
      if (!this.processing && this.queue.length > 0) {
        this.processing = true;
        const e = this.queue.shift()!;
        await this.processOne(e);
        this.processing = false;
        onProgress?.(this.queue.length);
      }
      if (!this.running) break;
      await new Promise(r => setTimeout(r, this.queue.length > 0 ? 500 : scanIntervalMs));
    }
  }

  stop() {
    this.running = false;
  }
}
