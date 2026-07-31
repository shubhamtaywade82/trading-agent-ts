import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Candle } from "../backtest/types.js";
import { ConceptsEngine } from "../concepts/adapter.js";
import type { BinanceStreamManager } from "../exchange/binance-stream.js";
import { fetchCandlesRange, buildSignalEvaluator, fetchOpenInterestHist, alignOiToCandles } from "../tools/backtest-tools.js";

import type { AiGateConfig} from "./ai-gate.js";
import { AiEntryGate, DEFAULT_AI_GATE_CONFIG } from "./ai-gate.js";
import { logCoinDcxBasis } from "./coindcx-shadow.js";
import type { SymbolPosition, PositionFill, StrategyIntent} from "./symbol-position.js";
import {
  SymbolPositionManager, flatPosition,
} from "./symbol-position.js";
import { reconstructClosedTrades } from "./trade-analyst.js";
import type { TrailingConfig} from "./trailing.js";
import { DEFAULT_TRAILING_CONFIG, updateTrailingStop } from "./trailing.js";

// Autonomous paper-trading runner. Polls Binance REST for newly-closed
// Candles per (symbol, timeframe) group, evaluates every pool strategy's
// Entry condition via buildSignalEvaluator (or ConceptsEngine's evaluator
// For concepts_* strategies) — the SAME functions runFuturesBacktest uses —
// And simulates fills/exits with the strategy's own stated
// Stop/target/maxHoldBars. A fired entry is an *intent*, not a position
// Owner: SymbolPositionManager decides whether it opens, adds to (averages
// Into), reduces, closes, or flips the symbol's ONE net position — one
// Position per symbol, shared capital pool per symbol, true cross-timeframe
// Netting. Only the strategy that opened a position ever governs its
// Stop/target/maxHoldBars; later adds change qty/avgEntryPrice only (see
// Symbol-position.ts's class header for the rationale).
//
// State persists to disk so a restart resumes cleanly. Every position state
// Change (open/add/reduce/close/flip) is appended to a JSONL trade journal
// For post-hoc comparison against the backtested WR/PF/Sharpe, and for
// Per-strategy PnL attribution (see getStatus()).

export interface StrategyDef {
  id: string; symbol: string; tf: string; direction: "long" | "short";
  entry: Array<{ type: string; period?: number; value?: number }>;
  stopPct: number; targetPct: number; maxHoldBars: number;
  sizeMultiplier: number; // From PnlAdaptor (pnl-adaptor.ts); 1 unless resized based on live PnL
  trailing?: TrailingConfig; // Opt-in ATR trailing stop, from strategies.json's per-strategy "trailing" block
}

interface StrategyStats {
  trades: number; wins: number; losses: number;
  lastEvalOpenTime: number; // Last candle openTime this strategy was evaluated against
  paused?: boolean; // Set externally (circuit-breaker); blocks new entries only, exits still managed
}

interface RunnerState {
  strategyStats: Record<string, StrategyStats>;
  symbolCapital: Record<string, number>;
  symbolPositions: Record<string, SymbolPosition>;
}

export interface RunnerConfig {
  initialCapitalPerSymbol: number;
  leverage: number;
  marginPerTradePct: number; // Hard ceiling on margin committed to one trade, regardless of riskPerTradePct
  riskPerTradePct: number;   // Target fraction of capital lost on a stop-out; drives actual sizing, capped by marginPerTradePct
  maxMarginUtilizationPct: number; // Ceiling on TOTAL same-direction margin open on one symbol at once (pyramiding cap)
  correlationGuard: boolean;       // Downsize new entries once too many symbols already share the same direction
  correlationThreshold: number;    // Fraction of symbols same-direction before the guard starts downsizing
  feeBps: number;
  slippageBps: number;
  volSizing: boolean;   // Scale margin down when current ATR% runs hot vs the lookback average
  volSlippage: boolean; // Scale simulated slippage up when current ATR% runs hot vs the lookback average
  funding: boolean;     // Charge/credit real Binance funding rates on exit
  coindcxShadow: boolean; // Log Binance-vs-CoinDCX basis on every fill (read-only, best-effort)
  coindcxShadowFile: string;
  stateFile: string;
  journalFile: string;
  lookbackDaysByTf: Record<string, number>;
  aiMode: "ai" | "no-ai";
  aiGate: AiGateConfig;
  htfCacheTtlMs: number;
}

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  initialCapitalPerSymbol: 20, // $20 per symbol = $100 total initial capital across 5 symbols
  leverage: 10,
  marginPerTradePct: 0.25,
  riskPerTradePct: 0.015,
  maxMarginUtilizationPct: 0.6,
  correlationGuard: true,
  correlationThreshold: 0.5,
  feeBps: 5,
  slippageBps: 3,
  volSizing: true,
  volSlippage: true,
  funding: true,
  coindcxShadow: true,
  coindcxShadowFile: ".trading-agent/coindcx-basis.jsonl",
  stateFile: ".trading-agent/paper-state.json",
  journalFile: ".trading-agent/paper-trades.jsonl",
  // Generous warmup margin over the longest indicator lookback in the pool (ichimoku=52 bars)
  lookbackDaysByTf: { "15m": 8, "30m": 15, "1h": 25, "2h": 50, "4h": 100, "1d": 400 },
  aiMode: (process.env["TRADINGAGENT_AI_MODE"] === "ai" ? "ai" : "no-ai"),
  aiGate: DEFAULT_AI_GATE_CONFIG,
  htfCacheTtlMs: 5 * 60_000,
};

// Next timeframe up, for the HTF structure-alignment gate
// (concepts_htf_aligned_bullish/bearish). Only covers timeframes actually
// Used by the strategy pool.
const HTF_FOR_TF: Record<string, string> = { "15m": "1h", "30m": "4h", "1h": "4h", "2h": "1d", "4h": "1d" };

// Ratio of recent ATR% (last `period` true ranges) to the average over the
// Whole candle window — >1 means current volatility is running hot relative
// To the strategy's validated baseline. Shared by volScale (sizing) and
// SlippageMultiplier (fill realism) below; returns 1 (neutral) when there
// Isn't enough data or the reference is degenerate.
function atrRatio(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return 1;
  const trs: number[] = [];
  for (let j = 1; j < candles.length; j++) {
    const c = candles[j], pc = candles[j - 1];
    if (c === undefined || pc === undefined) continue;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - pc.close), Math.abs(c.low - pc.close)) / pc.close);
  }
  const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const cur = avg(trs.slice(-period));
  const ref = avg(trs);
  if (cur <= 0 || ref <= 0) return 1;
  return cur / ref;
}

// Volatility-aware sizing scale: when current volatility runs hot, a
// Fixed-% stop is more likely to be tagged by noise, so size down
// Proportionally. Downsize-only (clamped to [0.5, 1]) — never sizes UP in
// Quiet regimes, so live stays conservatively comparable to the fixed-size
// Backtest.
export function volScale(candles: Candle[], period = 14): number {
  const r = atrRatio(candles, period);
  return Math.min(1, Math.max(0.5, 1 / r));
}

// Volatility-aware slippage: fills are realistically worse (wider spread,
// Thinner book) when volatility is running hot. Widen-only (clamped to
// [1, 3]) — never narrows below the base slippageBps in quiet regimes.
export function slippageMultiplier(candles: Candle[], period = 14): number {
  return Math.min(3, Math.max(1, atrRatio(candles, period)));
}

// Correlation-aware sizing: the pool trades highly-correlated crypto majors
// (BTC/ETH/SOL/XRP/DOGE move together in a broad market move), so N
// Same-direction positions across N symbols isn't N independent bets, it's
// Closer to one leveraged bet sized N times over. Downsize-only (never sizes
// UP for being contrarian) once the fraction of symbols already positioned
// In the same direction crosses `threshold`, linearly down to a 0.4 floor at
// 100% same-direction — never zero, since a single strategy's own edge
// Still deserves some size even in a fully one-sided book.
const CORRELATION_MIN_SCALE = 0.4;

export function correlationScale(sameDirectionCount: number, totalSymbols: number, threshold: number): number {
  if (totalSymbols <= 0) return 1;
  const fraction = sameDirectionCount / totalSymbols;
  if (fraction <= threshold) return 1;
  const overshoot = (fraction - threshold) / (1 - threshold || 1);
  return Math.max(CORRELATION_MIN_SCALE, 1 - overshoot * (1 - CORRELATION_MIN_SCALE));
}

export interface EntryMarginInputs {
  symbolCapital: number;
  stopPct: number;
  leverage: number;
  marginPerTradePct: number;      // Hard ceiling on margin for one trade
  riskPerTradePct: number;        // Target fraction of capital lost on a stop-out
  maxMarginUtilizationPct: number; // Ceiling on total same-direction margin per symbol
  existingSameDirMargin: number;  // Margin already committed in the SAME direction on this symbol (0 if flat/opposite)
  sizeScale: number;               // Combined volScale * correlationScale, or 1
}

// Single source of truth for entry sizing, matching runFuturesBacktest's
// Risk-based formula (backtest-tools.ts) so live and backtest never drift —
// Same "one shared engine" discipline this codebase already applies to
// Signal evaluation. Order: risk-based-capped-by-ceiling, THEN scaled by
// Vol/correlation, THEN clipped to the exposure-cap headroom (a scaled-down
// Trade shouldn't be able to bypass the pyramiding cap).
export function computeEntryMargin(inputs: EntryMarginInputs): number {
  const { symbolCapital, stopPct, leverage, marginPerTradePct, riskPerTradePct, maxMarginUtilizationPct, existingSameDirMargin, sizeScale } = inputs;
  const flatMargin = symbolCapital * marginPerTradePct;
  const riskMargin = (symbolCapital * riskPerTradePct) / stopPct / leverage;
  const scaledMargin = Math.min(flatMargin, riskMargin) * sizeScale;
  const headroom = Math.max(0, symbolCapital * maxMarginUtilizationPct - existingSameDirMargin);
  return Math.min(scaledMargin, headroom);
}

// Funding PnL over a held position: longs PAY when the rate is positive,
// Shorts RECEIVE. `rates` are the per-event funding rates (e.g. 0.0001)
// That occurred while the position was open.
// Ponytail: applied to entry notional, not per-event mark notional — the
// Error is a rounding term at 8h funding granularity.
export function fundingPnl(rates: number[], notional: number, direction: "long" | "short"): number {
  const sum = rates.reduce((s, r) => s + r, 0);
  return (direction === "long" ? -1 : 1) * sum * notional;
}

interface PoolStrategy {
  id: string;
  enabled?: boolean;
  tf?: string;
  direction: "long" | "short";
  entry: Array<{ type: string; period?: number; value?: number }>;
  risk: { stopPct: number; targetPct: number };
  maxHoldBars?: number;
  sizeMultiplier?: number;
  trailing?: TrailingConfig;
}

interface PoolFile {
  symbols: Record<string, PoolStrategy[]>;
  config?: {
    leverage?: number;
    marginPerTradePct?: number;
    riskPerTradePct?: number;
    maxMarginUtilizationPct?: number;
    correlationGuard?: boolean;
    correlationThreshold?: number;
    aiGate?: Partial<AiGateConfig> & { mode?: "ai" | "no-ai" };
  };
}

function loadStrategiesFromPool(poolPath = "strategies.json"): { strategies: StrategyDef[]; leverage?: number; marginPerTradePct?: number; riskPerTradePct?: number; maxMarginUtilizationPct?: number; correlationGuard?: boolean; correlationThreshold?: number; aiGate?: Partial<AiGateConfig>; aiModeOverride?: "ai" | "no-ai" } {
  const cfg = JSON.parse(readFileSync(poolPath, "utf-8")) as PoolFile;
  const out: StrategyDef[] = [];
  for (const [symbol, strats] of Object.entries(cfg.symbols)) {
    for (const s of strats) {
      if (s.enabled === false) continue; // Permanently pruned by PnlAdaptor -- absent from the live pool
      out.push({
        id: s.id, symbol, tf: s.tf ?? "1h", direction: s.direction,
        entry: s.entry, stopPct: s.risk.stopPct, targetPct: s.risk.targetPct,
        maxHoldBars: s.maxHoldBars ?? 48, sizeMultiplier: s.sizeMultiplier ?? 1,
        ...(s.trailing ? { trailing: { ...DEFAULT_TRAILING_CONFIG, ...s.trailing } } : {}),
      });
    }
  }
  const config = cfg.config;
  const aiGateCfg = cfg.config?.aiGate;
  return {
    strategies: out,
    ...(config?.leverage !== undefined && { leverage: config.leverage }),
    ...(config?.marginPerTradePct !== undefined && { marginPerTradePct: config.marginPerTradePct }),
    ...(config?.riskPerTradePct !== undefined && { riskPerTradePct: config.riskPerTradePct }),
    ...(config?.maxMarginUtilizationPct !== undefined && { maxMarginUtilizationPct: config.maxMarginUtilizationPct }),
    ...(config?.correlationGuard !== undefined && { correlationGuard: config.correlationGuard }),
    ...(config?.correlationThreshold !== undefined && { correlationThreshold: config.correlationThreshold }),
    ...(aiGateCfg !== undefined && { aiGate: aiGateCfg }),
    ...(aiGateCfg?.mode !== undefined && { aiModeOverride: aiGateCfg.mode }),
  };
}

// A short human-readable summary of a symbol's current net position, for
// The AI gate's prompt context and for dashboard/log display.
function describePosition(pos: SymbolPosition | undefined): string {
  if (!pos?.direction || pos.qty === 0) return "flat";
  return `${pos.direction} ${pos.qty.toFixed(4)} ${pos.symbol} @ ${pos.avgEntryPrice.toFixed(4)}, contributors: [${pos.contributingStrategyIds.join(", ")}]`;
}

function formatRecentCandles(candles: Candle[], bars: number): string {
  return candles.slice(-bars).map(c => `${new Date(c.openTime).toISOString()} O${c.open} H${c.high} L${c.low} C${c.close}`).join(" | ");
}

export class LivePaperRunner {
  private strategies: StrategyDef[];
  private state: RunnerState = { strategyStats: {}, symbolCapital: {}, symbolPositions: {} };
  private readonly cfg: RunnerConfig;
  private running = false;
  private readonly positionManager: SymbolPositionManager;
  private readonly aiGate: AiEntryGate | null = null;
  private readonly htfCache = new Map<string, { candles: Candle[]; fetchedAt: number }>();
  // Portfolio-wide daily-loss halt, set by StrategyCircuitBreaker. Blocks
  // New entries only; exits still managed. In-memory on purpose: the breaker
  // Recomputes today's realized loss from the journal every check, so a
  // Restart re-derives the halt instead of trusting stale persisted state.
  private globalHalt = false;

  constructor(cfg: Partial<RunnerConfig> = {}, poolPath = "strategies.json") {
    const pool = loadStrategiesFromPool(poolPath);
    this.strategies = pool.strategies;
    const baseLeverage = cfg.leverage ?? pool.leverage ?? DEFAULT_RUNNER_CONFIG.leverage;
    const baseMarginPerTradePct = cfg.marginPerTradePct ?? pool.marginPerTradePct ?? DEFAULT_RUNNER_CONFIG.marginPerTradePct;
    const baseRiskPerTradePct = cfg.riskPerTradePct ?? pool.riskPerTradePct ?? DEFAULT_RUNNER_CONFIG.riskPerTradePct;
    const baseMaxMarginUtilizationPct = cfg.maxMarginUtilizationPct ?? pool.maxMarginUtilizationPct ?? DEFAULT_RUNNER_CONFIG.maxMarginUtilizationPct;
    const baseCorrelationGuard = cfg.correlationGuard ?? pool.correlationGuard ?? DEFAULT_RUNNER_CONFIG.correlationGuard;
    const baseCorrelationThreshold = cfg.correlationThreshold ?? pool.correlationThreshold ?? DEFAULT_RUNNER_CONFIG.correlationThreshold;
    this.cfg = {
      ...DEFAULT_RUNNER_CONFIG,
      leverage: baseLeverage,
      marginPerTradePct: baseMarginPerTradePct,
      riskPerTradePct: baseRiskPerTradePct,
      maxMarginUtilizationPct: baseMaxMarginUtilizationPct,
      correlationGuard: baseCorrelationGuard,
      correlationThreshold: baseCorrelationThreshold,
      ...cfg,
      aiGate: { ...DEFAULT_RUNNER_CONFIG.aiGate, ...pool.aiGate, ...cfg.aiGate },
      // Env var takes precedence over strategies.json, which takes precedence over the hardcoded default
      aiMode: cfg.aiMode ?? (process.env["TRADINGAGENT_AI_MODE"] === "ai" ? "ai"
        : (process.env["TRADINGAGENT_AI_MODE"] === "no-ai" ? "no-ai"
        : pool.aiModeOverride ?? DEFAULT_RUNNER_CONFIG.aiMode)),
    };
    this.positionManager = new SymbolPositionManager(this.cfg.leverage, this.cfg.feeBps);
    if (this.cfg.aiMode === "ai") this.aiGate = new AiEntryGate(this.cfg.aiGate);
    this.loadState();
  }

  private loadState() {
    if (existsSync(this.cfg.stateFile)) {
      try {
        this.state = JSON.parse(readFileSync(this.cfg.stateFile, "utf-8"));
      } catch {
        this.state = { strategyStats: {}, symbolCapital: {}, symbolPositions: {} };
      }
    }
    for (const s of this.strategies) {
      if (!this.state.strategyStats[s.id]) {
        this.state.strategyStats[s.id] = { trades: 0, wins: 0, losses: 0, lastEvalOpenTime: 0 };
      }
    }
    for (const symbol of this.getSymbols()) {
      if (this.state.symbolCapital[symbol] === undefined) {
        this.state.symbolCapital[symbol] = this.cfg.initialCapitalPerSymbol;
      }
      if (!this.state.symbolPositions[symbol]) {
        this.state.symbolPositions[symbol] = flatPosition(symbol);
      }
    }
  }

  private saveState() {
    const dir = dirname(this.cfg.stateFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.cfg.stateFile, JSON.stringify(this.state, null, 2));
  }

  private journal(event: Record<string, unknown>) {
    const dir = dirname(this.cfg.journalFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.cfg.journalFile, `${JSON.stringify({ ts: new Date().toISOString(), ...event })  }\n`);
  }

  private journalFills(symbol: string, tf: string, fills: PositionFill[]) {
    for (const f of fills) {
      this.journal({ type: "position_fill", symbol, tf, positionAfter: this.summarizePosition(symbol), ...f });
    }
  }

  private summarizePosition(symbol: string) {
    const pos = this.state.symbolPositions[symbol];
    if (pos === undefined) return null;
    return { qty: pos.qty, avgEntryPrice: pos.avgEntryPrice, direction: pos.direction, contributingStrategyIds: pos.contributingStrategyIds };
  }

  getStatus() {
    const closed = reconstructClosedTrades(this.cfg.journalFile);
    return this.strategies.map(s => {
      const st = this.state.strategyStats[s.id] ?? { trades: 0, wins: 0, losses: 0, lastEvalOpenTime: 0 };
      const own = closed.filter(t => t.strategyId === s.id);
      const attributedPnl = Math.round(own.reduce((sum, t) => sum + t.pnl, 0) * 100) / 100;
      return {
        id: s.id, symbol: s.symbol, tf: s.tf, direction: s.direction,
        attributedPnl,
        trades: st.trades, wins: st.wins, losses: st.losses,
        winRate: st.trades > 0 ? st.wins / st.trades : null,
      };
    });
  }

  getSymbols(): string[] {
    return [...new Set(this.strategies.map(s => s.symbol))];
  }

  // One row per symbol's current net position, for the dashboard's
  // Positions blotter (replaces the old per-strategy openPosition list).
  getSymbolPositions(): SymbolPosition[] {
    return this.getSymbols().flatMap(sym => {
      const p = this.state.symbolPositions[sym];
      if (p === undefined) return [];
      return p.direction !== null && p.qty > 0 ? [p] : [];
    });
  }

  // Called by CircuitBreaker (in-process, same daemon) to pause/resume new
  // Entries for a strategy. Mutates in-memory state directly and persists —
  // Going through the file would race with this class's own saveState()
  // Calls on every tick. Blocks new entries only; open positions still exit
  // Normally (see processGroup()'s exit-management block, unconditional).
  setPaused(strategyId: string, paused: boolean): void {
    const st = this.state.strategyStats[strategyId];
    if (!st) return;
    st.paused = paused;
    this.saveState();
  }

  isPaused(strategyId: string): boolean {
    return !!this.state.strategyStats[strategyId]?.paused;
  }

  setGlobalHalt(on: boolean): void {
    this.globalHalt = on;
  }

  isGlobalHalted(): boolean {
    return this.globalHalt;
  }

  // Picks up strategies newly appended to strategies.json (e.g. by
  // ResearchPipeline's auto-promotion) without a process restart, and
  // (as of PnlAdaptor, pnl-adaptor.ts) picks up a changed sizeMultiplier or
  // An enabled:false prune for EXISTING ids too. For existing ids this only
  // Ever touches sizeMultiplier or removes the id from the active pool —
  // Entry/risk/maxHoldBars/direction are never mutated in place, and a
  // Pruned strategy's open position (if any) still exits normally, since
  // Exits are position-driven, not strategy-list-driven (see
  // ProcessGroup()'s governingStrategyId check, unconditional on pool
  // Membership).
  reloadPool(poolPath = "strategies.json"): number {
    const rawCfg = JSON.parse(readFileSync(poolPath, "utf-8")) as PoolFile;
    const prunedIds = new Set<string>();
    for (const strats of Object.values(rawCfg.symbols)) {
      for (const s of strats) if (s.enabled === false) prunedIds.add(s.id);
    }

    const fresh = loadStrategiesFromPool(poolPath).strategies;
    const freshById = new Map(fresh.map(s => [s.id, s]));
    const existingIds = new Set(this.strategies.map(s => s.id));
    let changed = 0;

    for (const existing of this.strategies) {
      const updated = freshById.get(existing.id);
      if (updated && updated.sizeMultiplier !== existing.sizeMultiplier) {
        this.journal({ type: "size_multiplier_updated", strategyId: existing.id, from: existing.sizeMultiplier, to: updated.sizeMultiplier });
        existing.sizeMultiplier = updated.sizeMultiplier;
        changed++;
      }
    }
    if (prunedIds.size > 0) {
      const before = this.strategies.length;
      this.strategies = this.strategies.filter(s => !prunedIds.has(s.id));
      const removed = before - this.strategies.length;
      if (removed > 0) {
        for (const id of prunedIds) this.journal({ type: "strategy_pruned", strategyId: id });
        changed += removed;
      }
    }

    const added = fresh.filter(s => !existingIds.has(s.id));
    for (const s of added) {
      this.strategies.push(s);
      if (!this.state.strategyStats[s.id]) {
        this.state.strategyStats[s.id] = { trades: 0, wins: 0, losses: 0, lastEvalOpenTime: 0 };
      }
      if (this.state.symbolCapital[s.symbol] === undefined) {
        this.state.symbolCapital[s.symbol] = this.cfg.initialCapitalPerSymbol;
      }
      if (!this.state.symbolPositions[s.symbol]) {
        this.state.symbolPositions[s.symbol] = flatPosition(s.symbol);
      }
    }
    if (added.length > 0 || changed > 0) this.saveState();
    return added.length;
  }

  // Portfolio-level rollup across every symbol's shared capital pool — one
  // Pool per symbol (not per-strategy, not account-wide), matching how
  // Positions are now shared per symbol too.
  getPortfolio() {
    let totalCapital = 0, usedMargin = 0, openCount = 0;
    for (const symbol of this.getSymbols()) {
      const cap = this.state.symbolCapital[symbol];
      if (cap === undefined) continue;
      totalCapital += cap;
      const pos = this.state.symbolPositions[symbol];
      if (pos?.direction) { usedMargin += pos.margin; openCount++; }
    }
    const totalInitial = this.getSymbols().length * this.cfg.initialCapitalPerSymbol;
    const totalRealizedPnl = totalCapital - totalInitial;
    return {
      totalInitialCapital: totalInitial,
      totalRealizedPnl,
      usedMargin,
      availableBalance: totalCapital - usedMargin,
      openPositions: openCount,
      symbolCount: this.getSymbols().length,
      strategyCount: this.strategies.length,
      leverage: this.cfg.leverage,
      marginPerTradePct: this.cfg.marginPerTradePct,
      // TotalEquity intentionally excludes unrealized PnL — caller adds it in
      // (unrealized requires live prices, which this class doesn't track).
      totalCapitalNoUnrealized: totalCapital,
    };
  }

  // Display-only mark-to-market — NOT used by any trading decision. Actual
  // Entries/exits only ever evaluate on closed candles (see tick() below),
  // Matching the backtest engine bar-for-bar. This exists purely so the
  // Dashboard can show unrealized PnL between candle closes without the
  // Live price ever influencing what the bot does.
  unrealizedPnl(symbol: string, livePrice: number): number | null {
    const pos = this.state.symbolPositions[symbol];
    if (!pos?.direction) return null;
    const feeFrac = this.cfg.feeBps / 10_000;
    const raw = (livePrice - pos.avgEntryPrice) * (pos.direction === "long" ? 1 : -1) * pos.qty;
    return raw - pos.notional * feeFrac;
  }

  // Sum of unrealized PnL across every open symbol position, priced off the
  // Stream's latest ticker tick per symbol. Display/risk-check only — same
  // Rule as unrealizedPnl() above, never used by any entry/exit decision.
  totalUnrealizedPnl(stream: BinanceStreamManager): number {
    let sum = 0;
    for (const symbol of this.getSymbols()) {
      const pos = this.state.symbolPositions[symbol];
      if (!pos?.direction) continue;
      const tick = stream.getLatest(symbol);
      if (!tick) continue;
      const u = this.unrealizedPnl(symbol, tick.price);
      if (u !== null) sum += u;
    }
    return sum;
  }

  private groupMap(): Map<string, StrategyDef[]> {
    const groups = new Map<string, StrategyDef[]>();
    for (const s of this.strategies) {
      const key = `${s.symbol}:${s.tf}`;
      const arr = groups.get(key);
      if (arr) arr.push(s); else groups.set(key, [s]);
    }
    return groups;
  }

  private async getHtfCandles(symbol: string, tf: string): Promise<Candle[]> {
    const htfTf = HTF_FOR_TF[tf];
    if (!htfTf) return [];
    const key = `${symbol}:${htfTf}`;
    const cached = this.htfCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < this.cfg.htfCacheTtlMs) return cached.candles;

    const lookbackDays = this.cfg.lookbackDaysByTf[htfTf] ?? 100;
    const endTime = Date.now();
    const startTime = endTime - lookbackDays * 24 * 60 * 60 * 1000;
    const fetched = await fetchCandlesRange(symbol, htfTf, startTime, endTime);
    if ("error" in fetched) return cached?.candles ?? [];
    this.htfCache.set(key, { candles: fetched.candles, fetchedAt: Date.now() });
    return fetched.candles;
  }

  // Fetch + evaluate/manage every strategy in one (symbol, tf) group. Shared
  // By the REST poll safety net (tick()) and the event-driven WS trigger
  // (attachStream()) — identical decision logic either way, only the trigger
  // Differs (fixed timer vs. a closed-kline push).
  private async processGroup(symbol: string, tf: string, strats: StrategyDef[]): Promise<{ hadCandles: boolean; fills: number; evaluations: Array<{ strategyId: string; symbol: string; tf: string; checked: boolean; fired: boolean; lastClosedCandleTime: number }> }> {
    const lookbackDays = this.cfg.lookbackDaysByTf[tf] ?? 30;
    const endTime = Date.now();
    const startTime = endTime - lookbackDays * 24 * 60 * 60 * 1000;
    const fetched = await fetchCandlesRange(symbol, tf, startTime, endTime);
    if ("error" in fetched) {
      this.journal({ type: "fetch_error", symbol, tf, message: fetched.message });
      return { hadCandles: false, fills: 0, evaluations: [] };
    }
    let candles: Candle[] = fetched.candles;
    // Drop the still-forming candle (Binance includes it as the last row).
    const tfMs = tfToMs(tf);
    const forming = candles.at(-1);
    if (forming !== undefined && forming.openTime + tfMs > Date.now()) {
      candles = candles.slice(0, -1);
    }
    if (candles.length === 0) return { hadCandles: false, fills: 0, evaluations: [] };
    const lastClosed = candles.at(-1);
    if (lastClosed === undefined) return { hadCandles: false, fills: 0, evaluations: [] };

    // OI is only fetched when a strategy actually needs it, and a fetch
    // Error just journals + leaves oi_* conditions evaluating false for this
    // Poll (buildSignalEvaluator's no-extraSeries no-op) rather than failing
    // The whole group — unlike the one-shot backtest tool, a transient data
    // Hiccup here shouldn't block every other strategy's exit management.
    let oiSeries: number[] | undefined;
    if (strats.some(s => s.entry.some(c => c.type.startsWith("oi_")))) {
      const oiResult = await fetchOpenInterestHist(symbol, tf, startTime, endTime);
      if ("error" in oiResult) {
        this.journal({ type: "oi_fetch_error", symbol, tf, message: oiResult.message });
      } else {
        oiSeries = alignOiToCandles(candles, oiResult.points);
      }
    }

    let fills = 0;
    const evaluations: Array<{ strategyId: string; symbol: string; tf: string; checked: boolean; fired: boolean; lastClosedCandleTime: number }> = [];

    // Exit-management for the symbol's ONE shared position only runs from
    // The tf group that currently governs it — avoids two different tf
    // Groups double-checking the same governing stop/target at different
    // Candle resolutions.
    // Ponytail: a governing stop could theoretically be crossed intra-bar on
    // A faster co-located tf before the governing tf's own candle closes;
    // Acceptable since the stop/target were validated at the governing tf's
    // Resolution. Upgrade: also check against every other active tf's
    // Closes if tighter resolution is ever needed.
    const pos = this.state.symbolPositions[symbol];
    const govId = pos?.governingStrategyId ?? "";
    const dir = pos?.direction ?? null;
    const governingHere = dir !== null && strats.some(s => s.id === govId) && lastClosed.openTime > (this.state.strategyStats[govId]?.lastEvalOpenTime ?? 0);
    if (governingHere && pos !== undefined && dir !== null) {
      const bar = lastClosed;

      // Trailing stop update — runs BEFORE the exit checks below so they see
      // The (possibly already-moved) stop, and BEFORE they decide whether
      // The fixed target is even still in play (disabled once trailing
      // Activates — see trailing.ts's header comment).
      let targetDisabled = false;
      if (pos.trailing && pos.trailingConfig && pos.governingStopPrice !== null) {
        const trailResult = updateTrailingStop(
          pos.trailing, bar, dir, pos.avgEntryPrice, pos.governingStopPrice, pos.trailingConfig, candles,
        );
        pos.trailing = trailResult.state;
        pos.governingStopPrice = trailResult.stopPrice;
        targetDisabled = trailResult.targetDisabled;
        if (trailResult.phaseChanged) {
          this.journal({ type: "trailing_phase_change", symbol, tf, governingStrategyId: pos.governingStrategyId, phase: trailResult.state.phase, stopPrice: trailResult.stopPrice, extremePrice: trailResult.state.extremePrice });
        }
      }

      const liqPrice = pos.liqPrice;
      const stopPrice = pos.governingStopPrice;
      const targetPrice = pos.governingTargetPrice;
      const hitLiq = dir === "long" ? liqPrice !== null && bar.low <= liqPrice : liqPrice !== null && bar.high >= liqPrice;
      const hitStop = dir === "long" ? stopPrice !== null && bar.low <= stopPrice : stopPrice !== null && bar.high >= stopPrice;
      const hitTarget = !targetDisabled && (dir === "long" ? targetPrice !== null && bar.high >= targetPrice : targetPrice !== null && bar.low <= targetPrice);
      const barsHeld = candles.length - 1 - (pos.governingEntryBarIdx ?? candles.length - 1);
      const timedOut = barsHeld >= (pos.governingMaxHoldBars ?? Infinity);

      if (hitLiq || hitStop || hitTarget || timedOut) {
        let exitPrice: number, reason: "liquidation" | "stop" | "target" | "timeout";
        const slipMult = this.cfg.volSlippage ? slippageMultiplier(candles) : 1;
        const slipFrac = (this.cfg.slippageBps / 10_000) * slipMult;
        if (hitLiq && liqPrice !== null) {
          exitPrice = liqPrice;
          reason = "liquidation";
        } else if (hitStop && stopPrice !== null) {
          const rawStop = stopPrice;
          exitPrice = dir === "long" ? rawStop * (1 - slipFrac) : rawStop * (1 + slipFrac);
          reason = "stop";
        } else if (hitTarget && targetPrice !== null) {
          exitPrice = targetPrice;
          reason = "target";
        } else {
          const rawClose = bar.close;
          exitPrice = dir === "long" ? rawClose * (1 - slipFrac) : rawClose * (1 + slipFrac);
          reason = "timeout";
        }

        // Funding accrues to the position as a whole; applied once here on
        // The same weighted-avg-cost basis as everything else, then folded
        // Into every attributed fill proportionally by the position manager's
        // Own realized-PnL math (funding is added to price via an
        // Equivalent-notional adjustment before closing).
        // Ponytail: charged against the position's CURRENT total notional
        // From the EARLIEST contributing lot's entry time — a position built
        // Up via several adds didn't actually hold that full notional for
        // The whole window, so this over-counts funding on the portion added
        // Later. Real per-lot notional-over-time accrual would fix this;
        // Acceptable approximation for now (same spirit as this file's
        // Pre-existing "entry notional, not per-event mark notional" note).
        let funding = 0;
        const heldFrom = (pos.governingEntryBarIdx !== null ? pos.lots.reduce((min, l) => Math.min(min, l.entryBarOpenTime), Infinity) : bar.openTime) + tfMs;
        const heldTo = bar.openTime + tfMs;
        if (this.cfg.funding && Math.floor(heldTo / EIGHT_H) > Math.floor(heldFrom / EIGHT_H)) {
          try {
            const rates = await fetchFundingRates(symbol, heldFrom, heldTo);
            funding = fundingPnl(rates, pos.notional, dir);
          } catch (e) {
            this.journal({ type: "funding_fetch_error", symbol, message: (e as Error).message });
          }
        }
        // Fold funding into the exit price as an equivalent price adjustment
        // So it flows through the position manager's single realized-PnL
        // Computation (and its per-strategy FIFO attribution) rather than a
        // Second bolt-on adjustment after the fact.
        const fundingPriceAdj = pos.qty !== 0 ? (dir === "long" ? funding / pos.qty : -funding / pos.qty) : 0;
        const adjustedExitPrice = exitPrice + fundingPriceAdj;

        const triggerStrategyId = govId;
        const { position: newPos, fills: closeFills } = this.positionManager.closePosition(pos, triggerStrategyId, adjustedExitPrice, reason);
        this.state.symbolPositions[symbol] = newPos;
        this.journalFills(symbol, tf, closeFills);
        for (const f of closeFills) {
          const st = this.state.strategyStats[f.strategyId];
          if (st) { st.trades++; if (f.realizedPnl > 0) st.wins++; else st.losses++; }
          this.state.symbolCapital[symbol] = (this.state.symbolCapital[symbol] ?? 0) + f.realizedPnl;
        }
        fills += closeFills.length;
        if (this.cfg.coindcxShadow) void logCoinDcxBasis(this.cfg.coindcxShadowFile, symbol, "exit", dir, exitPrice);
      }
    }

    for (const strat of strats) {
      const st = this.state.strategyStats[strat.id];
      if (st === undefined) continue;
      const isNew = lastClosed.openTime > st.lastEvalOpenTime;

      // Look for a new entry only if this candle hasn't been checked yet and
      // The strategy isn't paused (circuit-breaker sets this flag).
      // Multiple strategies CAN fire on the same symbol — SymbolPositionManager
      // Decides open/add/reduce/flip, there is no per-strategy "already in a
      // Position" gate anymore (that's the whole point of the shared position).
      let fired = false;
      if (isNew && !st.paused && !this.globalHalt) {
        const hasConceptsConditions = strat.entry.some(c => c.type.startsWith("concepts_"));
        const needsHtf = strat.entry.some(c => c.type.startsWith("concepts_htf_aligned_"));
        let evaluator: (i: number) => boolean;
        if (hasConceptsConditions) {
          const htfContext = needsHtf ? new ConceptsEngine(await this.getHtfCandles(symbol, tf)).toHTFContext() : undefined;
          evaluator = new ConceptsEngine(candles, htfContext ? { htfContext } : undefined).evaluator(strat.entry);
        } else {
          evaluator = buildSignalEvaluator(candles, strat.entry, oiSeries ? { oi: oiSeries } : undefined);
        }
        const i = candles.length - 1;
        fired = evaluator(i);
        if (fired) {
          const slipMult = this.cfg.volSlippage ? slippageMultiplier(candles) : 1;
          const slipFrac = (this.cfg.slippageBps / 10_000) * slipMult;
          const rawEntry = lastClosed.close;
          const entryPrice = strat.direction === "long" ? rawEntry * (1 + slipFrac) : rawEntry * (1 - slipFrac);
          const scale = this.cfg.volSizing ? volScale(candles) : 1;

          // Correlation guard: this pool trades highly-correlated crypto
          // Majors, all currently short-biased — N same-direction positions
          // Across N symbols is closer to one leveraged bet than N
          // Independent ones. Downsize once too many OTHER symbols already
          // Share this direction (excludes the current symbol itself —
          // Same-direction pyramiding on ONE symbol is maxMarginUtilizationPct's job).
          const allSymbols = this.getSymbols();
          const sameDirectionElsewhere = allSymbols.filter(sym =>
            sym !== symbol && this.state.symbolPositions[sym]?.direction === strat.direction
          ).length;
          const corrScale = this.cfg.correlationGuard
            ? correlationScale(sameDirectionElsewhere, allSymbols.length, this.cfg.correlationThreshold)
            : 1;

          const symbolCapital = this.state.symbolCapital[symbol] ?? 0;
          const preTradePos = this.state.symbolPositions[symbol];
          const existingSameDirMargin = preTradePos?.direction === strat.direction ? preTradePos.margin : 0;
          const margin = computeEntryMargin({
            symbolCapital, stopPct: strat.stopPct, leverage: this.cfg.leverage,
            marginPerTradePct: this.cfg.marginPerTradePct, riskPerTradePct: this.cfg.riskPerTradePct,
            maxMarginUtilizationPct: this.cfg.maxMarginUtilizationPct, existingSameDirMargin,
            sizeScale: scale * corrScale,
          });

          const notional = margin * this.cfg.leverage;
          let qty = (notional / entryPrice) * strat.sizeMultiplier;

          if (margin <= 0 || qty <= 0) {
            this.journal({ type: "exposure_cap_blocked", strategyId: strat.id, symbol, tf, existingSameDirMargin, maxMarginUtilizationPct: this.cfg.maxMarginUtilizationPct });
            evaluations.push({ strategyId: strat.id, symbol, tf, checked: isNew, fired, lastClosedCandleTime: lastClosed.openTime });
            if (isNew) st.lastEvalOpenTime = lastClosed.openTime;
            continue;
          }

          const intent: StrategyIntent = {
            strategyId: strat.id, symbol, tf, direction: strat.direction,
            stopPct: strat.stopPct, targetPct: strat.targetPct, maxHoldBars: strat.maxHoldBars,
            entryBarIdx: i, entryBarOpenTime: lastClosed.openTime,
            ...(strat.trailing !== undefined && { trailingConfig: strat.trailing }),
          };

          if (this.cfg.aiMode === "ai" && this.aiGate) {
            const rawStop = strat.direction === "long" ? entryPrice * (1 - strat.stopPct) : entryPrice * (1 + strat.stopPct);
            const rawTarget = strat.direction === "long" ? entryPrice * (1 + strat.targetPct) : entryPrice * (1 - strat.targetPct);
            const decision = await this.aiGate.review({
              strategyId: strat.id, symbol, tf, direction: strat.direction,
              entryPrice, stopPrice: rawStop, targetPrice: rawTarget,
              candleContext: formatRecentCandles(candles, 20),
              symbolPositionSummary: describePosition(this.state.symbolPositions[symbol]),
            });
            this.journal({ type: "ai_gate_decision", strategyId: strat.id, symbol, tf, approved: decision.approved, sizeMultiplier: decision.sizeMultiplier, rationale: decision.rationale });
            if (!decision.approved) {
              evaluations.push({ strategyId: strat.id, symbol, tf, checked: isNew, fired, lastClosedCandleTime: lastClosed.openTime });
              if (isNew) st.lastEvalOpenTime = lastClosed.openTime;
              continue;
            }
            qty *= decision.sizeMultiplier;
          }

          const currentPos = this.state.symbolPositions[symbol] ?? flatPosition(symbol);
          const { position: newPos, fills: openFills } = this.positionManager.applyIntent(currentPos, intent, entryPrice, qty);
          this.state.symbolPositions[symbol] = newPos;
          this.journalFills(symbol, tf, openFills);
          for (const f of openFills) {
            const isExitLike = f.action === "reduce" || f.action === "close" || f.action === "flip_close";
            if (isExitLike) {
              const fst = this.state.strategyStats[f.strategyId];
              if (fst) { fst.trades++; if (f.realizedPnl > 0) fst.wins++; else fst.losses++; }
              // RealizedPnl already has this fill's fee subtracted (see symbol-position.ts).
              this.state.symbolCapital[symbol] = (this.state.symbolCapital[symbol] ?? 0) + f.realizedPnl;
            } else {
              // Open/add: no PnL yet, but the fee is a real cash cost.
              this.state.symbolCapital[symbol] = (this.state.symbolCapital[symbol] ?? 0) - f.feeUsd;
            }
          }
          fills += openFills.length;
          if (this.cfg.coindcxShadow) void logCoinDcxBasis(this.cfg.coindcxShadowFile, symbol, "entry", strat.direction, entryPrice);
        }
      }

      evaluations.push({ strategyId: strat.id, symbol, tf, checked: isNew, fired, lastClosedCandleTime: lastClosed.openTime });
      if (isNew) st.lastEvalOpenTime = lastClosed.openTime;
    }

    return { hadCandles: true, fills, evaluations };
  }

  // One polling cycle: fetch latest candles per (symbol, tf) group once,
  // Then evaluate/manage every strategy in that group against them. Safety
  // Net for stop/target/liquidation checks (must see every bar) and fallback
  // Entry path if a kline stream drops — see attachStream() for the faster,
  // Event-driven entry path.
  async tick(): Promise<{ groupsChecked: number; newCandles: number; fills: number; evaluations: Array<{ strategyId: string; symbol: string; tf: string; checked: boolean; fired: boolean; lastClosedCandleTime: number }> }> {
    const groups = this.groupMap();
    let newCandles = 0, fills = 0;
    const evaluations: Array<{ strategyId: string; symbol: string; tf: string; checked: boolean; fired: boolean; lastClosedCandleTime: number }> = [];
    for (const [key, strats] of groups) {
      const [symbol, tf] = key.split(":");
      if (symbol === undefined || tf === undefined) continue;
      const result = await this.processGroup(symbol, tf, strats);
      if (result.hadCandles) newCandles++;
      fills += result.fills;
      evaluations.push(...result.evaluations);
    }

    this.saveState();
    return { groupsChecked: groups.size, newCandles, fills, evaluations };
  }

  // Subscribes a kline WS stream per (symbol, tf) group so entry evaluation
  // Fires the instant Binance reports a closed candle, instead of waiting up
  // To pollMs for the next tick(). tick()'s REST poll keeps running
  // Unchanged as the safety net for stop/target/liquidation checks and as a
  // Fallback if a stream drops. Purely additive — no decision logic here,
  // Just an earlier trigger into the same processGroup().
  async attachStream(stream: BinanceStreamManager): Promise<void> {
    const groups = this.groupMap();
    await Promise.all([...groups].map(([key, strats]) => {
      const [symbol, tf] = key.split(":");
      if (symbol === undefined || tf === undefined) return Promise.resolve();
      return stream.subscribeKline(symbol, tf, () => {
        this.processGroup(symbol, tf, strats)
          .then(() => { this.saveState(); })
          .catch(e => { this.journal({ type: "stream_tick_error", symbol, tf, message: (e as Error).message }); });
      });
    }));
  }

  async start(pollMs = 60_000, onTick?: (result: { groupsChecked: number; newCandles: number; fills: number; evaluations: Array<{ strategyId: string; symbol: string; tf: string; checked: boolean; fired: boolean; lastClosedCandleTime: number }> }) => void) {
    this.running = true;
    while (this.running) {
      try {
        const result = await this.tick();
        onTick?.(result);
      } catch (e) {
        this.journal({ type: "tick_error", message: (e as Error).message });
      }
      if (!this.running) break;
      await new Promise(r => setTimeout(r, pollMs));
    }
  }

  stop() {
    this.running = false;
  }
}

export const EIGHT_H = 8 * 3_600_000; // Binance funding interval

export async function fetchFundingRates(symbol: string, startTime: number, endTime: number): Promise<number[]> {
  const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${startTime}&endTime=${endTime}&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fundingRate HTTP ${res.status}`);
  const rows = (await res.json()) as Array<{ fundingRate: string }>;
  return rows.map(r => Number(r.fundingRate));
}

export function tfToMs(tf: string): number {
  const unit = tf.slice(-1);
  const n = Number(tf.slice(0, -1));
  const mult = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 60_000;
  return n * mult;
}
