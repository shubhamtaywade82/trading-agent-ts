import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";
import { fetchCandlesRange, buildSignalEvaluator } from "../tools/backtest-tools.js";
import { Candle } from "../backtest/types.js";
import { BinanceStreamManager } from "../exchange/binance-stream.js";
import { ConceptsEngine } from "../concepts/adapter.js";
import { logCoinDcxBasis } from "./coindcx-shadow.js";
import {
  SymbolPositionManager, SymbolPosition, PositionFill, StrategyIntent, flatPosition,
} from "./symbol-position.js";
import { AiEntryGate, AiGateConfig, DEFAULT_AI_GATE_CONFIG } from "./ai-gate.js";
import { reconstructClosedTrades } from "./trade-analyst.js";

// Autonomous paper-trading runner. Polls Binance REST for newly-closed
// candles per (symbol, timeframe) group, evaluates every pool strategy's
// entry condition via buildSignalEvaluator (or ConceptsEngine's evaluator
// for concepts_* strategies) — the SAME functions runFuturesBacktest uses —
// and simulates fills/exits with the strategy's own stated
// stop/target/maxHoldBars. A fired entry is an *intent*, not a position
// owner: SymbolPositionManager decides whether it opens, adds to (averages
// into), reduces, closes, or flips the symbol's ONE net position — one
// position per symbol, shared capital pool per symbol, true cross-timeframe
// netting. Only the strategy that opened a position ever governs its
// stop/target/maxHoldBars; later adds change qty/avgEntryPrice only (see
// symbol-position.ts's class header for the rationale).
//
// State persists to disk so a restart resumes cleanly. Every position state
// change (open/add/reduce/close/flip) is appended to a JSONL trade journal
// for post-hoc comparison against the backtested WR/PF/Sharpe, and for
// per-strategy PnL attribution (see getStatus()).

export interface StrategyDef {
  id: string; symbol: string; tf: string; direction: "long" | "short";
  entry: { type: string; period?: number; value?: number }[];
  stopPct: number; targetPct: number; maxHoldBars: number;
}

interface StrategyStats {
  trades: number; wins: number; losses: number;
  lastEvalOpenTime: number; // last candle openTime this strategy was evaluated against
  paused?: boolean; // set externally (circuit-breaker); blocks new entries only, exits still managed
}

interface RunnerState {
  strategyStats: Record<string, StrategyStats>;
  symbolCapital: Record<string, number>;
  symbolPositions: Record<string, SymbolPosition>;
}

export interface RunnerConfig {
  initialCapitalPerSymbol: number;
  leverage: number;
  marginPerTradePct: number;
  feeBps: number;
  slippageBps: number;
  volSizing: boolean;   // scale margin down when current ATR% runs hot vs the lookback average
  volSlippage: boolean; // scale simulated slippage up when current ATR% runs hot vs the lookback average
  funding: boolean;     // charge/credit real Binance funding rates on exit
  coindcxShadow: boolean; // log Binance-vs-CoinDCX basis on every fill (read-only, best-effort)
  coindcxShadowFile: string;
  stateFile: string;
  journalFile: string;
  lookbackDaysByTf: Record<string, number>;
  aiMode: "ai" | "no-ai";
  aiGate: AiGateConfig;
  htfCacheTtlMs: number;
}

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  initialCapitalPerSymbol: 10000,
  leverage: 5,
  marginPerTradePct: 0.05,
  feeBps: 5,
  slippageBps: 3,
  volSizing: true,
  volSlippage: true,
  funding: true,
  coindcxShadow: true,
  coindcxShadowFile: ".trading-agent/coindcx-basis.jsonl",
  stateFile: ".trading-agent/paper-state.json",
  journalFile: ".trading-agent/paper-trades.jsonl",
  // generous warmup margin over the longest indicator lookback in the pool (ichimoku=52 bars)
  lookbackDaysByTf: { "15m": 8, "30m": 15, "1h": 25, "2h": 50, "4h": 100, "1d": 400 },
  aiMode: (process.env.TRADINGAGENT_AI_MODE === "ai" ? "ai" : "no-ai"),
  aiGate: DEFAULT_AI_GATE_CONFIG,
  htfCacheTtlMs: 5 * 60_000,
};

// Next timeframe up, for the HTF structure-alignment gate
// (concepts_htf_aligned_bullish/bearish). Only covers timeframes actually
// used by the strategy pool.
const HTF_FOR_TF: Record<string, string> = { "15m": "1h", "30m": "4h", "1h": "4h", "2h": "1d", "4h": "1d" };

// Ratio of recent ATR% (last `period` true ranges) to the average over the
// whole candle window — >1 means current volatility is running hot relative
// to the strategy's validated baseline. Shared by volScale (sizing) and
// slippageMultiplier (fill realism) below; returns 1 (neutral) when there
// isn't enough data or the reference is degenerate.
function atrRatio(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return 1;
  const trs: number[] = [];
  for (let j = 1; j < candles.length; j++) {
    const c = candles[j], pc = candles[j - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)) / pc);
  }
  const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const cur = avg(trs.slice(-period));
  const ref = avg(trs);
  if (cur <= 0 || ref <= 0) return 1;
  return cur / ref;
}

// Volatility-aware sizing scale: when current volatility runs hot, a
// fixed-% stop is more likely to be tagged by noise, so size down
// proportionally. Downsize-only (clamped to [0.5, 1]) — never sizes UP in
// quiet regimes, so live stays conservatively comparable to the fixed-size
// backtest.
export function volScale(candles: Candle[], period = 14): number {
  const r = atrRatio(candles, period);
  return Math.min(1, Math.max(0.5, 1 / r));
}

// Volatility-aware slippage: fills are realistically worse (wider spread,
// thinner book) when volatility is running hot. Widen-only (clamped to
// [1, 3]) — never narrows below the base slippageBps in quiet regimes.
export function slippageMultiplier(candles: Candle[], period = 14): number {
  return Math.min(3, Math.max(1, atrRatio(candles, period)));
}

// Funding PnL over a held position: longs PAY when the rate is positive,
// shorts RECEIVE. `rates` are the per-event funding rates (e.g. 0.0001)
// that occurred while the position was open.
// ponytail: applied to entry notional, not per-event mark notional — the
// error is a rounding term at 8h funding granularity.
export function fundingPnl(rates: number[], notional: number, direction: "long" | "short"): number {
  const sum = rates.reduce((s, r) => s + r, 0);
  return (direction === "long" ? -1 : 1) * sum * notional;
}

function loadStrategiesFromPool(poolPath = "strategies.json"): { strategies: StrategyDef[]; aiGate?: Partial<AiGateConfig>; aiModeOverride?: "ai" | "no-ai" } {
  const cfg = JSON.parse(readFileSync(poolPath, "utf-8"));
  const out: StrategyDef[] = [];
  for (const [symbol, strats] of Object.entries(cfg.symbols) as [string, any[]][]) {
    for (const s of strats) {
      out.push({
        id: s.id, symbol, tf: s.tf ?? "1h", direction: s.direction,
        entry: s.entry, stopPct: s.risk.stopPct, targetPct: s.risk.targetPct,
        maxHoldBars: s.maxHoldBars ?? 48,
      });
    }
  }
  const aiGateCfg = cfg.config?.aiGate as { mode?: "ai" | "no-ai" } & Partial<AiGateConfig> | undefined;
  return { strategies: out, aiGate: aiGateCfg, aiModeOverride: aiGateCfg?.mode };
}

// A short human-readable summary of a symbol's current net position, for
// the AI gate's prompt context and for dashboard/log display.
function describePosition(pos: SymbolPosition | undefined): string {
  if (!pos || !pos.direction || pos.qty === 0) return "flat";
  return `${pos.direction} ${pos.qty.toFixed(4)} ${pos.symbol} @ ${pos.avgEntryPrice.toFixed(4)}, contributors: [${pos.contributingStrategyIds.join(", ")}]`;
}

function formatRecentCandles(candles: Candle[], bars: number): string {
  return candles.slice(-bars).map(c => `${new Date(c.openTime).toISOString()} O${c.open} H${c.high} L${c.low} C${c.close}`).join(" | ");
}

export class LivePaperRunner {
  private strategies: StrategyDef[];
  private state: RunnerState = { strategyStats: {}, symbolCapital: {}, symbolPositions: {} };
  private cfg: RunnerConfig;
  private running = false;
  private positionManager: SymbolPositionManager;
  private aiGate: AiEntryGate | null = null;
  private htfCache = new Map<string, { candles: Candle[]; fetchedAt: number }>();
  // Portfolio-wide daily-loss halt, set by StrategyCircuitBreaker. Blocks
  // new entries only; exits still managed. In-memory on purpose: the breaker
  // recomputes today's realized loss from the journal every check, so a
  // restart re-derives the halt instead of trusting stale persisted state.
  private globalHalt = false;

  constructor(cfg: Partial<RunnerConfig> = {}, poolPath = "strategies.json") {
    const pool = loadStrategiesFromPool(poolPath);
    this.strategies = pool.strategies;
    this.cfg = {
      ...DEFAULT_RUNNER_CONFIG,
      ...cfg,
      aiGate: { ...DEFAULT_RUNNER_CONFIG.aiGate, ...pool.aiGate, ...cfg.aiGate },
      // env var takes precedence over strategies.json, which takes precedence over the hardcoded default
      aiMode: cfg.aiMode ?? (process.env.TRADINGAGENT_AI_MODE === "ai" ? "ai"
        : process.env.TRADINGAGENT_AI_MODE === "no-ai" ? "no-ai"
        : pool.aiModeOverride ?? DEFAULT_RUNNER_CONFIG.aiMode),
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
    appendFileSync(this.cfg.journalFile, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
  }

  private journalFills(symbol: string, tf: string, fills: PositionFill[]) {
    for (const f of fills) {
      this.journal({ type: "position_fill", symbol, tf, positionAfter: this.summarizePosition(symbol), ...f });
    }
  }

  private summarizePosition(symbol: string) {
    const pos = this.state.symbolPositions[symbol];
    return { qty: pos.qty, avgEntryPrice: pos.avgEntryPrice, direction: pos.direction, contributingStrategyIds: pos.contributingStrategyIds };
  }

  getStatus() {
    const closed = reconstructClosedTrades(this.cfg.journalFile);
    return this.strategies.map(s => {
      const st = this.state.strategyStats[s.id];
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
  // positions blotter (replaces the old per-strategy openPosition list).
  getSymbolPositions(): SymbolPosition[] {
    return this.getSymbols()
      .map(sym => this.state.symbolPositions[sym])
      .filter(p => p.direction !== null && p.qty > 0);
  }

  // Called by CircuitBreaker (in-process, same daemon) to pause/resume new
  // entries for a strategy. Mutates in-memory state directly and persists —
  // going through the file would race with this class's own saveState()
  // calls on every tick. Blocks new entries only; open positions still exit
  // normally (see processGroup()'s exit-management block, unconditional).
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
  // ResearchPipeline's auto-promotion) without a process restart. Only
  // ADDS — never removes or mutates an existing strategy's definition or
  // state, so open positions and history are untouched.
  reloadPool(poolPath = "strategies.json"): number {
    const fresh = loadStrategiesFromPool(poolPath).strategies;
    const existingIds = new Set(this.strategies.map(s => s.id));
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
    if (added.length > 0) this.saveState();
    return added.length;
  }

  // Portfolio-level rollup across every symbol's shared capital pool — one
  // pool per symbol (not per-strategy, not account-wide), matching how
  // positions are now shared per symbol too.
  getPortfolio() {
    let totalCapital = 0, usedMargin = 0, openCount = 0;
    for (const symbol of this.getSymbols()) {
      totalCapital += this.state.symbolCapital[symbol];
      const pos = this.state.symbolPositions[symbol];
      if (pos.direction) { usedMargin += pos.margin; openCount++; }
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
      // totalEquity intentionally excludes unrealized PnL — caller adds it in
      // (unrealized requires live prices, which this class doesn't track).
      totalCapitalNoUnrealized: totalCapital,
    };
  }

  // Display-only mark-to-market — NOT used by any trading decision. Actual
  // entries/exits only ever evaluate on closed candles (see tick() below),
  // matching the backtest engine bar-for-bar. This exists purely so the
  // dashboard can show unrealized PnL between candle closes without the
  // live price ever influencing what the bot does.
  unrealizedPnl(symbol: string, livePrice: number): number | null {
    const pos = this.state.symbolPositions[symbol];
    if (!pos || !pos.direction) return null;
    const feeFrac = this.cfg.feeBps / 10000;
    const raw = (livePrice - pos.avgEntryPrice) * (pos.direction === "long" ? 1 : -1) * pos.qty;
    return raw - pos.notional * feeFrac;
  }

  // Sum of unrealized PnL across every open symbol position, priced off the
  // stream's latest ticker tick per symbol. Display/risk-check only — same
  // rule as unrealizedPnl() above, never used by any entry/exit decision.
  totalUnrealizedPnl(stream: BinanceStreamManager): number {
    let sum = 0;
    for (const symbol of this.getSymbols()) {
      const pos = this.state.symbolPositions[symbol];
      if (!pos.direction) continue;
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
  // by the REST poll safety net (tick()) and the event-driven WS trigger
  // (attachStream()) — identical decision logic either way, only the trigger
  // differs (fixed timer vs. a closed-kline push).
  private async processGroup(symbol: string, tf: string, strats: StrategyDef[]): Promise<{ hadCandles: boolean; fills: number; evaluations: { strategyId: string; symbol: string; tf: string; checked: boolean; fired: boolean; lastClosedCandleTime: number }[] }> {
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
    if (candles.length > 0 && candles[candles.length - 1].openTime + tfMs > Date.now()) {
      candles = candles.slice(0, -1);
    }
    if (candles.length === 0) return { hadCandles: false, fills: 0, evaluations: [] };
    const lastClosed = candles[candles.length - 1];

    let fills = 0;
    const evaluations: { strategyId: string; symbol: string; tf: string; checked: boolean; fired: boolean; lastClosedCandleTime: number }[] = [];

    // Exit-management for the symbol's ONE shared position only runs from
    // the tf group that currently governs it — avoids two different tf
    // groups double-checking the same governing stop/target at different
    // candle resolutions.
    // ponytail: a governing stop could theoretically be crossed intra-bar on
    // a faster co-located tf before the governing tf's own candle closes;
    // acceptable since the stop/target were validated at the governing tf's
    // resolution. Upgrade: also check against every other active tf's
    // closes if tighter resolution is ever needed.
    const pos = this.state.symbolPositions[symbol];
    const governingHere = pos.direction !== null && strats.some(s => s.id === pos.governingStrategyId) && lastClosed.openTime > (this.state.strategyStats[pos.governingStrategyId!]?.lastEvalOpenTime ?? 0);
    if (governingHere) {
      const bar = lastClosed;
      const dir = pos.direction!;
      const hitLiq = dir === "long" ? bar.low <= pos.liqPrice! : bar.high >= pos.liqPrice!;
      const hitStop = dir === "long" ? bar.low <= pos.governingStopPrice! : bar.high >= pos.governingStopPrice!;
      const hitTarget = dir === "long" ? bar.high >= pos.governingTargetPrice! : bar.low <= pos.governingTargetPrice!;
      const barsHeld = candles.length - 1 - (pos.governingEntryBarIdx ?? candles.length - 1);
      const timedOut = barsHeld >= (pos.governingMaxHoldBars ?? Infinity);

      if (hitLiq || hitStop || hitTarget || timedOut) {
        let exitPrice: number, reason: "liquidation" | "stop" | "target" | "timeout";
        if (hitLiq) { exitPrice = pos.liqPrice!; reason = "liquidation"; }
        else if (hitStop) { exitPrice = pos.governingStopPrice!; reason = "stop"; }
        else if (hitTarget) { exitPrice = pos.governingTargetPrice!; reason = "target"; }
        else { exitPrice = bar.close; reason = "timeout"; }

        // Funding accrues to the position as a whole; applied once here on
        // the same weighted-avg-cost basis as everything else, then folded
        // into every attributed fill proportionally by the position manager's
        // own realized-PnL math (funding is added to price via an
        // equivalent-notional adjustment before closing).
        // ponytail: charged against the position's CURRENT total notional
        // from the EARLIEST contributing lot's entry time — a position built
        // up via several adds didn't actually hold that full notional for
        // the whole window, so this over-counts funding on the portion added
        // later. Real per-lot notional-over-time accrual would fix this;
        // acceptable approximation for now (same spirit as this file's
        // pre-existing "entry notional, not per-event mark notional" note).
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
        // so it flows through the position manager's single realized-PnL
        // computation (and its per-strategy FIFO attribution) rather than a
        // second bolt-on adjustment after the fact.
        const fundingPriceAdj = pos.qty !== 0 ? (dir === "long" ? funding / pos.qty : -funding / pos.qty) : 0;
        const adjustedExitPrice = exitPrice + fundingPriceAdj;

        const triggerStrategyId = pos.governingStrategyId!;
        const { position: newPos, fills: closeFills } = this.positionManager.closePosition(pos, triggerStrategyId, adjustedExitPrice, reason);
        this.state.symbolPositions[symbol] = newPos;
        this.journalFills(symbol, tf, closeFills);
        for (const f of closeFills) {
          const st = this.state.strategyStats[f.strategyId];
          if (st) { st.trades++; if (f.realizedPnl > 0) st.wins++; else st.losses++; }
          this.state.symbolCapital[symbol] += f.realizedPnl;
        }
        fills += closeFills.length;
        if (this.cfg.coindcxShadow) void logCoinDcxBasis(this.cfg.coindcxShadowFile, symbol, "exit", dir, exitPrice);
      }
    }

    for (const strat of strats) {
      const st = this.state.strategyStats[strat.id];
      const isNew = lastClosed.openTime > st.lastEvalOpenTime;

      // Look for a new entry only if this candle hasn't been checked yet and
      // the strategy isn't paused (circuit-breaker sets this flag).
      // Multiple strategies CAN fire on the same symbol — SymbolPositionManager
      // decides open/add/reduce/flip, there is no per-strategy "already in a
      // position" gate anymore (that's the whole point of the shared position).
      let fired = false;
      if (isNew && !st.paused && !this.globalHalt) {
        const hasConceptsConditions = strat.entry.some(c => c.type.startsWith("concepts_"));
        const needsHtf = strat.entry.some(c => c.type.startsWith("concepts_htf_aligned_"));
        let evaluator: (i: number) => boolean;
        if (hasConceptsConditions) {
          const htfContext = needsHtf ? new ConceptsEngine(await this.getHtfCandles(symbol, tf)).toHTFContext() : undefined;
          evaluator = new ConceptsEngine(candles, htfContext ? { htfContext } : undefined).evaluator(strat.entry);
        } else {
          evaluator = buildSignalEvaluator(candles, strat.entry);
        }
        const i = candles.length - 1;
        fired = evaluator(i);
        if (fired) {
          const slipMult = this.cfg.volSlippage ? slippageMultiplier(candles) : 1;
          const slipFrac = (this.cfg.slippageBps / 10000) * slipMult;
          const rawEntry = candles[i].close;
          const entryPrice = strat.direction === "long" ? rawEntry * (1 + slipFrac) : rawEntry * (1 - slipFrac);
          const scale = this.cfg.volSizing ? volScale(candles) : 1;
          const margin = this.state.symbolCapital[symbol] * this.cfg.marginPerTradePct * scale;
          const notional = margin * this.cfg.leverage;
          let qty = notional / entryPrice;

          const intent: StrategyIntent = {
            strategyId: strat.id, symbol, tf, direction: strat.direction,
            stopPct: strat.stopPct, targetPct: strat.targetPct, maxHoldBars: strat.maxHoldBars,
            entryBarIdx: i, entryBarOpenTime: candles[i].openTime,
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

          const currentPos = this.state.symbolPositions[symbol];
          const { position: newPos, fills: openFills } = this.positionManager.applyIntent(currentPos, intent, entryPrice, qty);
          this.state.symbolPositions[symbol] = newPos;
          this.journalFills(symbol, tf, openFills);
          for (const f of openFills) {
            const isExitLike = f.action === "reduce" || f.action === "close" || f.action === "flip_close";
            if (isExitLike) {
              const fst = this.state.strategyStats[f.strategyId];
              if (fst) { fst.trades++; if (f.realizedPnl > 0) fst.wins++; else fst.losses++; }
              // realizedPnl already has this fill's fee subtracted (see symbol-position.ts).
              this.state.symbolCapital[symbol] += f.realizedPnl;
            } else {
              // open/add: no PnL yet, but the fee is a real cash cost.
              this.state.symbolCapital[symbol] -= f.feeUsd;
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
  // then evaluate/manage every strategy in that group against them. Safety
  // net for stop/target/liquidation checks (must see every bar) and fallback
  // entry path if a kline stream drops — see attachStream() for the faster,
  // event-driven entry path.
  async tick(): Promise<{ groupsChecked: number; newCandles: number; fills: number; evaluations: { strategyId: string; symbol: string; tf: string; checked: boolean; fired: boolean; lastClosedCandleTime: number }[] }> {
    const groups = this.groupMap();
    let newCandles = 0, fills = 0;
    const evaluations: { strategyId: string; symbol: string; tf: string; checked: boolean; fired: boolean; lastClosedCandleTime: number }[] = [];
    for (const [key, strats] of groups) {
      const [symbol, tf] = key.split(":");
      const result = await this.processGroup(symbol, tf, strats);
      if (result.hadCandles) newCandles++;
      fills += result.fills;
      evaluations.push(...result.evaluations);
    }

    this.saveState();
    return { groupsChecked: groups.size, newCandles, fills, evaluations };
  }

  // Subscribes a kline WS stream per (symbol, tf) group so entry evaluation
  // fires the instant Binance reports a closed candle, instead of waiting up
  // to pollMs for the next tick(). tick()'s REST poll keeps running
  // unchanged as the safety net for stop/target/liquidation checks and as a
  // fallback if a stream drops. Purely additive — no decision logic here,
  // just an earlier trigger into the same processGroup().
  async attachStream(stream: BinanceStreamManager): Promise<void> {
    const groups = this.groupMap();
    await Promise.all([...groups].map(([key, strats]) => {
      const [symbol, tf] = key.split(":");
      return stream.subscribeKline(symbol, tf, () => {
        this.processGroup(symbol, tf, strats)
          .then(() => this.saveState())
          .catch(e => this.journal({ type: "stream_tick_error", symbol, tf, message: (e as Error).message }));
      });
    }));
  }

  async start(pollMs = 60_000, onTick?: (result: { groupsChecked: number; newCandles: number; fills: number; evaluations: { strategyId: string; symbol: string; tf: string; checked: boolean; fired: boolean; lastClosedCandleTime: number }[] }) => void) {
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

const EIGHT_H = 8 * 3_600_000; // Binance funding interval

async function fetchFundingRates(symbol: string, startTime: number, endTime: number): Promise<number[]> {
  const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${startTime}&endTime=${endTime}&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fundingRate HTTP ${res.status}`);
  const rows = (await res.json()) as { fundingRate: string }[];
  return rows.map(r => Number(r.fundingRate));
}

function tfToMs(tf: string): number {
  const unit = tf.slice(-1);
  const n = Number(tf.slice(0, -1));
  const mult = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 60_000;
  return n * mult;
}
