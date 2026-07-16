import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";
import { reconstructClosedTrades, ClosedTrade } from "./trade-analyst.js";
import { terminalBell, sendTelegram } from "./notifier.js";

// Deterministic (not LLM-judged) readiness gate — the whole point of every
// prior round of this research was "don't trust a vibes-based ready/not
// ready call," so this stays a plain rule check against real accumulated
// paper-trading data, same spirit as buildSignalEvaluator being the one
// source of truth for entries. The AI analyst may comment on a strategy;
// it never decides readiness.

export interface ReadinessCriteria {
  minTrades: number;
  minProfitFactor: number;       // live PF must clear this
  maxWinRateDivergence: number;  // |liveWR - backtestWR| must be <= this
  requirePositivePnl: boolean;
  portfolioReadyFraction: number; // fraction of evaluable strategies that must be individually ready
  portfolioMinEvaluable: number;  // need at least this many strategies with enough trades before judging the pool
}

export const DEFAULT_READINESS_CRITERIA: ReadinessCriteria = {
  minTrades: 20,
  minProfitFactor: 1.2,
  maxWinRateDivergence: 0.15,
  requirePositivePnl: true,
  portfolioReadyFraction: 0.6,
  portfolioMinEvaluable: 3,
};

interface BacktestRef { winRate: number; pf: number; label: string }
function loadBacktestRefs(poolPath: string): Record<string, BacktestRef> {
  const cfg = JSON.parse(readFileSync(poolPath, "utf-8"));
  const out: Record<string, BacktestRef> = {};
  for (const strats of Object.values(cfg.symbols) as any[][]) {
    for (const s of strats) out[s.id] = { winRate: s.metrics.winRate, pf: s.metrics.pf, label: s.label };
  }
  return out;
}

// Every WR/PF number this whole research produced — backtest AND paper —
// was computed at THIS leverage/margin. "Ready for live" only means ready
// at these settings; sizing up leverage changes risk (and drawdown) in ways
// that were never tested, so the notification states it explicitly rather
// than leaving it implicit.
function loadSizingConfig(poolPath: string): { leverage: number; marginPerTradePct: number } {
  const cfg = JSON.parse(readFileSync(poolPath, "utf-8"));
  return { leverage: cfg.config?.leverage ?? 5, marginPerTradePct: cfg.config?.marginPerTradePct ?? 0.05 };
}

export interface StrategyReadiness {
  strategyId: string; label: string; ready: boolean; evaluable: boolean;
  trades: number; liveWinRate: number; livePf: number; totalPnl: number;
  backtestWinRate: number; backtestPf: number;
  reasons: string[]; // why not ready, empty if ready
}

function computeStrategyReadiness(id: string, trades: ClosedTrade[], ref: BacktestRef | undefined, c: ReadinessCriteria): StrategyReadiness {
  const wins = trades.filter(t => t.pnl > 0).length;
  const liveWinRate = trades.length > 0 ? wins / trades.length : 0;
  const grossProfit = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const livePf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const evaluable = trades.length >= c.minTrades;

  const reasons: string[] = [];
  if (!evaluable) reasons.push(`only ${trades.length}/${c.minTrades} trades`);
  if (evaluable && livePf < c.minProfitFactor) reasons.push(`PF ${livePf.toFixed(2)} < ${c.minProfitFactor}`);
  if (evaluable && c.requirePositivePnl && totalPnl <= 0) reasons.push(`total PnL $${totalPnl.toFixed(2)} not positive`);
  if (evaluable && ref) {
    const div = Math.abs(liveWinRate - ref.winRate);
    if (div > c.maxWinRateDivergence) reasons.push(`WR diverges ${(div * 100).toFixed(0)}pts from backtest (${(liveWinRate*100).toFixed(0)}% vs ${(ref.winRate*100).toFixed(0)}%)`);
  }

  return {
    strategyId: id, label: ref?.label ?? id, ready: evaluable && reasons.length === 0, evaluable,
    trades: trades.length, liveWinRate, livePf, totalPnl,
    backtestWinRate: ref?.winRate ?? 0, backtestPf: ref?.pf ?? 0, reasons,
  };
}

export interface PortfolioReadiness {
  ready: boolean; readyCount: number; evaluableCount: number; totalStrategies: number;
  readyStrategyIds: string[];
}

export function assessReadiness(journalFile: string, poolPath: string, criteria: ReadinessCriteria = DEFAULT_READINESS_CRITERIA): { strategies: StrategyReadiness[]; portfolio: PortfolioReadiness } {
  const closed = reconstructClosedTrades(journalFile);
  const refs = loadBacktestRefs(poolPath);
  const byStrategy = new Map<string, ClosedTrade[]>();
  for (const t of closed) {
    const arr = byStrategy.get(t.strategyId);
    if (arr) arr.push(t); else byStrategy.set(t.strategyId, [t]);
  }
  // Include every strategy in the pool, even ones with 0 closed trades, so
  // the caller can see "not evaluable yet" rather than it silently missing.
  const allIds = new Set([...Object.keys(refs), ...byStrategy.keys()]);
  const strategies = [...allIds].map(id => computeStrategyReadiness(id, byStrategy.get(id) ?? [], refs[id], criteria));

  const evaluable = strategies.filter(s => s.evaluable);
  const ready = evaluable.filter(s => s.ready);
  const portfolio: PortfolioReadiness = {
    ready: evaluable.length >= criteria.portfolioMinEvaluable && ready.length / evaluable.length >= criteria.portfolioReadyFraction,
    readyCount: ready.length, evaluableCount: evaluable.length, totalStrategies: strategies.length,
    readyStrategyIds: ready.map(s => s.strategyId),
  };
  return { strategies, portfolio };
}

export interface ReadinessMonitorConfig {
  journalFile: string;
  poolPath: string;
  stateFile: string;
  logFile: string;
  criteria: ReadinessCriteria;
  notifyBell: boolean;
  notifyTelegram: boolean;
}

export const DEFAULT_READINESS_MONITOR_CONFIG: ReadinessMonitorConfig = {
  journalFile: ".trading-agent/paper-trades.jsonl",
  poolPath: "strategies.json",
  stateFile: ".trading-agent/readiness-state.json",
  logFile: ".trading-agent/readiness.jsonl",
  criteria: DEFAULT_READINESS_CRITERIA,
  notifyBell: true,
  notifyTelegram: true,
};

interface MonitorState { notifiedStrategyIds: string[]; portfolioNotified: boolean }

// Notifies ONCE per strategy the first time it crosses the bar (and once for
// the portfolio), tracked in a state file so restarts don't re-fire. If a
// strategy later falls back below the bar and re-crosses, it notifies again
// (a real re-earned readiness, not spam from noise near the threshold —
// crossing requires clearing minTrades again from wherever the state reset).
export class ReadinessMonitor {
  private cfg: ReadinessMonitorConfig;
  private state: MonitorState = { notifiedStrategyIds: [], portfolioNotified: false };

  constructor(cfg: Partial<ReadinessMonitorConfig> = {}) {
    this.cfg = { ...DEFAULT_READINESS_MONITOR_CONFIG, ...cfg, criteria: { ...DEFAULT_READINESS_CRITERIA, ...cfg.criteria } };
    if (existsSync(this.cfg.stateFile)) {
      try { this.state = JSON.parse(readFileSync(this.cfg.stateFile, "utf-8")); } catch { /* defaults */ }
    }
  }

  private saveState() {
    const dir = dirname(this.cfg.stateFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.cfg.stateFile, JSON.stringify(this.state, null, 2));
  }

  private log(entry: Record<string, unknown>) {
    const dir = dirname(this.cfg.logFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.cfg.logFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  }

  // Call this periodically (same cadence as the trading tick is fine — it's
  // cheap, pure computation over the journal, no network unless notifying).
  async check(): Promise<{ strategies: StrategyReadiness[]; portfolio: PortfolioReadiness; newlyReady: StrategyReadiness[]; portfolioNewlyReady: boolean }> {
    const { strategies, portfolio } = assessReadiness(this.cfg.journalFile, this.cfg.poolPath, this.cfg.criteria);
    const sizing = loadSizingConfig(this.cfg.poolPath);
    const sizingNote = `Validated at ${sizing.leverage}x leverage, ${(sizing.marginPerTradePct * 100).toFixed(0)}% margin/trade — "ready" means ready AT THESE SETTINGS ONLY, sizing up changes risk in ways never tested here.`;
    const notified = new Set(this.state.notifiedStrategyIds);
    const newlyReady = strategies.filter(s => s.ready && !notified.has(s.strategyId));
    const portfolioNewlyReady = portfolio.ready && !this.state.portfolioNotified;

    for (const s of newlyReady) {
      this.state.notifiedStrategyIds.push(s.strategyId);
      this.log({ type: "strategy_ready", strategyId: s.strategyId, label: s.label, trades: s.trades, liveWinRate: s.liveWinRate, livePf: s.livePf, totalPnl: s.totalPnl, leverage: sizing.leverage, marginPerTradePct: sizing.marginPerTradePct });
      const text = `🟢 READY FOR LIVE: ${s.label} (${s.strategyId})\n${s.trades} trades, WR ${(s.liveWinRate*100).toFixed(0)}%, PF ${s.livePf.toFixed(2)}, PnL $${s.totalPnl.toFixed(2)}\n${sizingNote}`;
      if (this.cfg.notifyBell) terminalBell();
      if (this.cfg.notifyTelegram) await sendTelegram(text);
    }
    if (portfolioNewlyReady) {
      this.state.portfolioNotified = true;
      this.log({ type: "portfolio_ready", readyCount: portfolio.readyCount, evaluableCount: portfolio.evaluableCount, readyStrategyIds: portfolio.readyStrategyIds, leverage: sizing.leverage, marginPerTradePct: sizing.marginPerTradePct });
      const text = `🟢🟢 PORTFOLIO READY FOR LIVE: ${portfolio.readyCount}/${portfolio.evaluableCount} evaluable strategies passing (${portfolio.totalStrategies} total in pool)\n${sizingNote}`;
      if (this.cfg.notifyBell) terminalBell();
      if (this.cfg.notifyTelegram) await sendTelegram(text);
    }
    if (newlyReady.length > 0 || portfolioNewlyReady) this.saveState();

    return { strategies, portfolio, newlyReady, portfolioNewlyReady };
  }
}
