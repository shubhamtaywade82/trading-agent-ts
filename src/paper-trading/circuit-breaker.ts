import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { LivePaperRunner } from "./live-runner.js";
import { reconstructClosedTrades, ClosedTrade } from "./trade-analyst.js";
import { sendTelegram } from "./notifier.js";

// Self-correcting risk control: watches each strategy's rolling recent
// trade history and automatically pauses NEW entries (never touches open
// positions, never touches buildSignalEvaluator or any strategy parameter)
// when performance craters. Fully reversible — auto-resumes once enough
// fresh trades show recovery, or stays paused pending manual review.
//
// Runs in-process against the same LivePaperRunner instance (see
// LivePaperRunner.setPaused/isPaused) so there's no file-write race with the
// runner's own state persistence.

export interface CircuitBreakerConfig {
  journalFile: string;
  stateFile: string;
  rollingWindow: number;       // last N closed trades used for rolling PF
  pfFloor: number;             // pause if rolling PF drops below this
  maxConsecutiveLosses: number; // pause if this many losses in a row
  cooldownTrades: number;      // fresh closed trades (pool-wide) before re-checking a paused strategy
  dailyMaxLossPct: number;     // halt ALL new entries for the rest of the UTC day if today's realized loss exceeds this fraction of total initial capital
  notifyTelegram: boolean;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  journalFile: ".trading-agent/paper-trades.jsonl",
  stateFile: ".trading-agent/circuit-breaker-state.json",
  rollingWindow: 10,
  pfFloor: 0.7,
  maxConsecutiveLosses: 5,
  cooldownTrades: 20,
  dailyMaxLossPct: 0.03,
  notifyTelegram: true,
};

// Sum of realized PnL for trades that CLOSED on the given UTC date
// (dateIso = "YYYY-MM-DD"). Realized-only — unrealized needs live prices,
// which nothing on this path tracks; the per-strategy stops bound open risk.
export function realizedPnlForUtcDate(trades: ClosedTrade[], dateIso: string): number {
  return trades.filter(t => t.exitTime.slice(0, 10) === dateIso).reduce((s, t) => s + t.pnl, 0);
}

interface BreakerEntry {
  paused: boolean;
  reason: string | null;
  pausedAt: string | null;
  pausedTradeCount: number; // this strategy's total closed-trade count at the moment it was paused
}

type BreakerState = Record<string, BreakerEntry>;

function rollingPf(trades: ClosedTrade[]): number {
  const grossProfit = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  return grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
}

function consecutiveLosses(trades: ClosedTrade[]): number {
  let n = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i].pnl <= 0) n++; else break;
  }
  return n;
}

export class StrategyCircuitBreaker {
  private cfg: CircuitBreakerConfig;
  private runner: LivePaperRunner;
  private state: BreakerState = {};
  private running = false;
  // UTC date ("YYYY-MM-DD") the daily-loss halt tripped on, or null. Once
  // tripped it holds for the rest of that date even if later exits claw the
  // loss back — daily-loss-limit semantics, not a live threshold. In-memory
  // on purpose: a restart recomputes today's loss from the journal, so the
  // halt re-derives itself (worst case: one duplicate Telegram).
  private dailyHaltDate: string | null = null;

  constructor(runner: LivePaperRunner, cfg: Partial<CircuitBreakerConfig> = {}) {
    this.runner = runner;
    this.cfg = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...cfg };
    this.loadState();
  }

  private loadState() {
    if (existsSync(this.cfg.stateFile)) {
      try { this.state = JSON.parse(readFileSync(this.cfg.stateFile, "utf-8")); } catch { this.state = {}; }
    }
  }

  private saveState() {
    const dir = dirname(this.cfg.stateFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.cfg.stateFile, JSON.stringify(this.state, null, 2));
  }

  getState(): BreakerState {
    return { ...this.state };
  }

  getDailyHalt(): { active: boolean; date: string | null } {
    return { active: this.runner.isGlobalHalted(), date: this.dailyHaltDate };
  }

  // Portfolio-level daily loss cap. Trips the runner's global halt (new
  // entries only) when today's realized loss exceeds dailyMaxLossPct of
  // total initial capital; releases automatically at the next UTC day.
  private checkDailyLoss(allTrades: ClosedTrade[]) {
    const today = new Date().toISOString().slice(0, 10);
    if (this.dailyHaltDate && this.dailyHaltDate !== today) {
      this.dailyHaltDate = null;
      this.runner.setGlobalHalt(false);
      if (this.cfg.notifyTelegram) sendTelegram(`🟢 DAILY LOSS HALT released — new UTC day, trading resumed.`);
    }
    if (this.dailyHaltDate) return; // already halted for today
    const pnlToday = realizedPnlForUtcDate(allTrades, today);
    const limit = this.runner.getPortfolio().totalInitialCapital * this.cfg.dailyMaxLossPct;
    if (pnlToday <= -limit) {
      this.dailyHaltDate = today;
      this.runner.setGlobalHalt(true);
      if (this.cfg.notifyTelegram) {
        sendTelegram(`🔴 DAILY LOSS HALT: realized PnL today ${pnlToday.toFixed(2)} breached -${(this.cfg.dailyMaxLossPct * 100).toFixed(1)}% of capital.\nAll new entries blocked until next UTC day; open positions still managed normally.`);
      }
    }
  }

  // Runs once; returns strategies that changed pause state this call.
  async check(): Promise<{ pausedNow: string[]; resumedNow: string[] }> {
    const allTrades = reconstructClosedTrades(this.cfg.journalFile);
    this.checkDailyLoss(allTrades);
    const byStrategy = new Map<string, ClosedTrade[]>();
    for (const t of allTrades) {
      const arr = byStrategy.get(t.strategyId);
      if (arr) arr.push(t); else byStrategy.set(t.strategyId, [t]);
    }

    const pausedNow: string[] = [];
    const resumedNow: string[] = [];

    for (const [strategyId, trades] of byStrategy) {
      const entry = this.state[strategyId] ?? { paused: false, reason: null, pausedAt: null, pausedTradeCount: 0 };
      const window = trades.slice(-this.cfg.rollingWindow);

      if (!entry.paused) {
        const pf = rollingPf(window);
        const losses = consecutiveLosses(trades);
        if (window.length >= this.cfg.rollingWindow && pf < this.cfg.pfFloor) {
          this.pause(strategyId, trades.length, `rolling PF ${pf.toFixed(2)} < floor ${this.cfg.pfFloor} over last ${window.length} trades`);
          pausedNow.push(strategyId);
        } else if (losses >= this.cfg.maxConsecutiveLosses) {
          this.pause(strategyId, trades.length, `${losses} consecutive losses`);
          pausedNow.push(strategyId);
        }
      } else {
        const freshTrades = trades.length - entry.pausedTradeCount;
        if (freshTrades >= this.cfg.cooldownTrades) {
          const pf = rollingPf(window);
          const losses = consecutiveLosses(trades);
          if (pf >= this.cfg.pfFloor && losses < this.cfg.maxConsecutiveLosses) {
            this.resume(strategyId, `rolling PF recovered to ${pf.toFixed(2)} over last ${window.length} trades after ${freshTrades} new trades`);
            resumedNow.push(strategyId);
          } else {
            // Still below the bar after cooldown — re-anchor the cooldown
            // window so it re-checks after another cooldownTrades instead of
            // spamming a failed re-check every cycle.
            entry.pausedTradeCount = trades.length;
            this.state[strategyId] = entry;
          }
        }
      }
    }

    this.saveState();
    return { pausedNow, resumedNow };
  }

  private pause(strategyId: string, tradeCountAtPause: number, reason: string) {
    this.state[strategyId] = { paused: true, reason, pausedAt: new Date().toISOString(), pausedTradeCount: tradeCountAtPause };
    this.runner.setPaused(strategyId, true);
    if (this.cfg.notifyTelegram) {
      sendTelegram(`🟠 CIRCUIT BREAKER: ${strategyId} paused\n${reason}\nNew entries blocked; open positions still managed normally. Auto-resumes after ${this.cfg.cooldownTrades} fresh pool trades if it recovers.`);
    }
  }

  private resume(strategyId: string, reason: string) {
    const entry = this.state[strategyId];
    if (entry) { entry.paused = false; entry.reason = null; entry.pausedAt = null; }
    this.runner.setPaused(strategyId, false);
    if (this.cfg.notifyTelegram) {
      sendTelegram(`🟢 CIRCUIT BREAKER: ${strategyId} auto-resumed\n${reason}`);
    }
  }

  async start(intervalMs = 5 * 60 * 1000, onResult?: (r: { pausedNow: string[]; resumedNow: string[] }) => void) {
    this.running = true;
    while (this.running) {
      try {
        const result = await this.check();
        onResult?.(result);
      } catch { /* guard the loop; check() itself doesn't throw on bad data */ }
      if (!this.running) break;
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  stop() {
    this.running = false;
  }
}
