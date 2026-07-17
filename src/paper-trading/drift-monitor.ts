import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";
import { reconstructClosedTrades, ClosedTrade } from "./trade-analyst.js";
import { sendTelegram } from "./notifier.js";
import { readBasisRecords } from "./coindcx-shadow.js";

// Proactive live-vs-backtest divergence watcher. readiness.ts's
// maxWinRateDivergence only ever gets checked at the 20-trade milestone
// gate; this recomputes the same live-vs-backtest comparison after every
// batch of newly-closed trades pool-wide and alerts the moment a strategy
// crosses a threshold for the first time — so divergence is caught as it
// develops, not only when someone happens to open the readiness panel.
// Pure read/alert — no write path into strategy state or LivePaperRunner.

export interface DriftMonitorConfig {
  journalFile: string;
  poolPath: string;
  stateFile: string;
  logFile: string;
  checkEveryNTrades: number;   // recompute after this many new pool-wide closed trades
  minTradesPerStrategy: number; // don't judge a strategy on too few trades
  wrDivergenceThreshold: number; // |liveWR - backtestWR| that triggers an alert
  pfDropThreshold: number;      // livePF below this triggers an alert
  basisLogFile: string;         // coindcx-shadow.ts's output (§5.4/§5.7 of the E2E doc)
  basisWindow: number;          // both the minimum sample size and the rolling window
  basisThresholdBps: number;    // avg |basisBps| over the window that triggers an alert
  notifyTelegram: boolean;
}

export const DEFAULT_DRIFT_MONITOR_CONFIG: DriftMonitorConfig = {
  journalFile: ".trading-agent/paper-trades.jsonl",
  poolPath: "strategies.json",
  stateFile: ".trading-agent/drift-monitor-state.json",
  logFile: ".trading-agent/drift-alerts.jsonl",
  checkEveryNTrades: 5,
  minTradesPerStrategy: 5,
  wrDivergenceThreshold: 0.20,
  pfDropThreshold: 1.0,
  basisLogFile: ".trading-agent/coindcx-basis.jsonl",
  basisWindow: 20,
  basisThresholdBps: 15,
  notifyTelegram: true,
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

function liveStats(trades: ClosedTrade[]): { winRate: number; pf: number } {
  const wins = trades.filter(t => t.pnl > 0).length;
  const winRate = trades.length > 0 ? wins / trades.length : 0;
  const grossProfit = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  return { winRate, pf };
}

interface StrategyAlertFlags { wrDivergence: boolean; pfBelowFloor: boolean }
interface DriftState { lastCheckedTotalTrades: number; alerted: Record<string, StrategyAlertFlags>; alertedBasis: Record<string, boolean> }

export class DriftMonitor {
  private cfg: DriftMonitorConfig;
  private state: DriftState = { lastCheckedTotalTrades: 0, alerted: {}, alertedBasis: {} };
  private running = false;

  constructor(cfg: Partial<DriftMonitorConfig> = {}) {
    this.cfg = { ...DEFAULT_DRIFT_MONITOR_CONFIG, ...cfg };
    if (existsSync(this.cfg.stateFile)) {
      try { this.state = JSON.parse(readFileSync(this.cfg.stateFile, "utf-8")); } catch { /* defaults */ }
    }
    this.state.alertedBasis ??= {}; // back-compat: state files written before the basis-drift check lack this key
  }

  // Independent of checkEveryNTrades — basis records accumulate on every
  // fill (entry AND exit), faster than closed trades, so gating this behind
  // the trade-count throttle would delay its own signal for no reason.
  private async checkBasisDrift(alerts: string[]): Promise<void> {
    const records = readBasisRecords(this.cfg.basisLogFile);
    const bySymbol = new Map<string, number[]>();
    for (const r of records) {
      const arr = bySymbol.get(r.symbol);
      if (arr) arr.push(r.basisBps); else bySymbol.set(r.symbol, [r.basisBps]);
    }
    for (const [symbol, all] of bySymbol) {
      if (all.length < this.cfg.basisWindow) continue; // not enough fills yet to judge
      const window = all.slice(-this.cfg.basisWindow);
      const avgAbsBasis = window.reduce((s, b) => s + Math.abs(b), 0) / window.length;
      const drifting = avgAbsBasis > this.cfg.basisThresholdBps;
      const wasAlerted = this.state.alertedBasis[symbol] ?? false;
      if (drifting && !wasAlerted) {
        const text = `🟡 BASIS DRIFT: ${symbol} avg |Binance↔CoinDCX basis| ${avgAbsBasis.toFixed(1)}bps over last ${window.length} fills — exceeds ${this.cfg.basisThresholdBps}bps, live edge may run smaller than backtested once execution moves to CoinDCX`;
        alerts.push(text);
        this.log({ type: "basis_drift", symbol, avgAbsBasisBps: avgAbsBasis, fills: window.length });
        if (this.cfg.notifyTelegram) await sendTelegram(text);
      }
      this.state.alertedBasis[symbol] = drifting; // re-arms if it recovers then drifts again
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

  // Runs at most one comparison per call; returns whether it actually ran
  // (gated by checkEveryNTrades) and any newly-crossed alerts fired.
  async check(): Promise<{ ran: boolean; alerts: string[] }> {
    const trades = reconstructClosedTrades(this.cfg.journalFile);
    const alerts: string[] = [];
    await this.checkBasisDrift(alerts); // independent cadence, see comment above

    if (trades.length - this.state.lastCheckedTotalTrades < this.cfg.checkEveryNTrades) {
      this.saveState(); // persist any basis-flag changes even when the strategy pass below is skipped
      return { ran: false, alerts };
    }

    const refs = loadBacktestRefs(this.cfg.poolPath);
    const byStrategy = new Map<string, ClosedTrade[]>();
    for (const t of trades) {
      const arr = byStrategy.get(t.strategyId);
      if (arr) arr.push(t); else byStrategy.set(t.strategyId, [t]);
    }

    for (const [strategyId, strategyTrades] of byStrategy) {
      if (strategyTrades.length < this.cfg.minTradesPerStrategy) continue;
      const ref = refs[strategyId];
      if (!ref) continue;
      const live = liveStats(strategyTrades);
      const flags = this.state.alerted[strategyId] ?? { wrDivergence: false, pfBelowFloor: false };

      const wrDiv = Math.abs(live.winRate - ref.winRate);
      const wrDrifting = wrDiv > this.cfg.wrDivergenceThreshold;
      if (wrDrifting && !flags.wrDivergence) {
        const text = `🟡 DRIFT: ${ref.label} (${strategyId}) live WR ${(live.winRate*100).toFixed(0)}% vs backtest ${(ref.winRate*100).toFixed(0)}% — diverged ${(wrDiv*100).toFixed(0)}pts over ${strategyTrades.length} live trades`;
        alerts.push(text);
        this.log({ type: "wr_divergence", strategyId, label: ref.label, liveWinRate: live.winRate, backtestWinRate: ref.winRate, trades: strategyTrades.length });
        if (this.cfg.notifyTelegram) await sendTelegram(text);
      }
      flags.wrDivergence = wrDrifting; // re-arms if it recovers then drifts again

      const pfDropping = live.pf < this.cfg.pfDropThreshold;
      if (pfDropping && !flags.pfBelowFloor) {
        const text = `🟡 DRIFT: ${ref.label} (${strategyId}) live PF ${live.pf.toFixed(2)} dropped below ${this.cfg.pfDropThreshold} (backtest expected ${ref.pf.toFixed(2)}) over ${strategyTrades.length} live trades`;
        alerts.push(text);
        this.log({ type: "pf_drop", strategyId, label: ref.label, livePf: live.pf, backtestPf: ref.pf, trades: strategyTrades.length });
        if (this.cfg.notifyTelegram) await sendTelegram(text);
      }
      flags.pfBelowFloor = pfDropping;

      this.state.alerted[strategyId] = flags;
    }

    this.state.lastCheckedTotalTrades = trades.length;
    this.saveState();
    return { ran: true, alerts };
  }

  async start(intervalMs = 5 * 60 * 1000, onResult?: (r: { ran: boolean; alerts: string[] }) => void) {
    this.running = true;
    while (this.running) {
      try {
        const result = await this.check();
        onResult?.(result);
      } catch { /* guard the loop */ }
      if (!this.running) break;
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  stop() {
    this.running = false;
  }
}
