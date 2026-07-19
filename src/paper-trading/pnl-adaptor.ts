import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";
import { LivePaperRunner } from "./live-runner.js";
import { reconstructClosedTrades, ClosedTrade } from "./trade-analyst.js";
import { rollingPf } from "./circuit-breaker.js";
import { sendTelegram } from "./notifier.js";

// Live-PnL feedback loop: the ONE place (besides ResearchPipeline's add-only
// promotion) that adjusts EXISTING strategies based on real trading results.
// Two distinct actions, both longer-horizon and more conservative than
// StrategyCircuitBreaker's temporary pause:
//   - resize: nudge an existing strategy's sizeMultiplier up/down based on
//     live PF vs its own backtest reference, bounded per cycle.
//   - prune: soft-disable (enabled:false) a strategy whose live PF stays
//     decisively below floor over a long sample, with no partial-recovery
//     signal — permanent until a human re-enables it in strategies.json.
//
// Ships dry-run by default (see DEFAULT_PNL_ADAPTOR_CONFIG): computes and
// logs every decision to pnlAdjustmentsFile without ever writing
// strategies.json or calling reloadPool, until TRADINGAGENT_PNL_ADAPTOR_LIVE
// is explicitly set (see scripts/autonomous-trading-daemon.ts wiring).

export interface PnlAdaptorConfig {
  journalFile: string;
  poolPath: string;
  stateFile: string;
  pnlAdjustmentsFile: string;
  minSampleSize: number;        // live trades needed before any resize
  pruneMinSample: number;       // live trades needed before prune is considered (>= minSampleSize)
  pruneFloorPf: number;         // prune if live PF stays under this after pruneMinSample trades
  recoverySliceSize: number;    // most-recent-N trades checked for a recovery signal before pruning
  maxSizeStepPerCycle: number;  // max +/- change to sizeMultiplier in one cycle
  sizeMultiplierMin: number;
  sizeMultiplierMax: number;
  dryRun: boolean;
  notifyTelegram: boolean;
}

export const DEFAULT_PNL_ADAPTOR_CONFIG: PnlAdaptorConfig = {
  journalFile: ".trading-agent/paper-trades.jsonl",
  poolPath: "strategies.json",
  stateFile: ".trading-agent/pnl-adaptor-state.json",
  pnlAdjustmentsFile: ".trading-agent/pnl-adjustments.jsonl",
  minSampleSize: 30,
  pruneMinSample: 60,
  pruneFloorPf: 0.5,
  recoverySliceSize: 15,
  maxSizeStepPerCycle: 0.1,
  sizeMultiplierMin: 0.25,
  sizeMultiplierMax: 1.2,
  dryRun: true,
  notifyTelegram: true,
};

// null = not enough live trades yet, no change this cycle. Scales down when
// live PF trails backtest PF meaningfully (below 70% of backtest PF), scales
// up cautiously when live PF clears backtest PF outright — bounded to
// maxSizeStepPerCycle either direction so no single cycle can swing sizing
// far off a human-set starting point.
export function decideSizeMultiplier(
  liveTrades: ClosedTrade[],
  backtestPf: number,
  currentSizeMultiplier: number,
  cfg: Pick<PnlAdaptorConfig, "minSampleSize" | "maxSizeStepPerCycle" | "sizeMultiplierMin" | "sizeMultiplierMax">,
): number | null {
  if (liveTrades.length < cfg.minSampleSize) return null;
  const livePf = rollingPf(liveTrades);

  let target = currentSizeMultiplier;
  if (livePf < backtestPf * 0.7) target = currentSizeMultiplier - cfg.maxSizeStepPerCycle;
  else if (livePf > backtestPf) target = currentSizeMultiplier + cfg.maxSizeStepPerCycle;
  else return null; // within normal band -- no change

  target = Math.max(cfg.sizeMultiplierMin, Math.min(cfg.sizeMultiplierMax, target));
  return target === currentSizeMultiplier ? null : Math.round(target * 100) / 100;
}

// Harsher, longer-horizon than StrategyCircuitBreaker's pause: requires a
// much bigger sample (pruneMinSample) with live PF decisively under floor,
// AND no recovery signal in the most recent recoverySliceSize trades (a
// strategy climbing back out doesn't get permanently cut for a bad stretch
// circuit-breaker already paused-and-resumed through).
export function decidePrune(
  liveTrades: ClosedTrade[],
  cfg: Pick<PnlAdaptorConfig, "pruneMinSample" | "pruneFloorPf" | "recoverySliceSize">,
): { prune: boolean; reason?: string } {
  if (liveTrades.length < cfg.pruneMinSample) return { prune: false };
  const overallPf = rollingPf(liveTrades);
  if (overallPf >= cfg.pruneFloorPf) return { prune: false };

  const recent = liveTrades.slice(-cfg.recoverySliceSize);
  const recentPf = rollingPf(recent);
  if (recentPf >= cfg.pruneFloorPf) return { prune: false };

  return {
    prune: true,
    reason: `live PF ${overallPf.toFixed(2)} < floor ${cfg.pruneFloorPf} over ${liveTrades.length} trades, ` +
      `no recovery in most recent ${recent.length} (PF ${recentPf.toFixed(2)})`,
  };
}

interface AdaptorEntry { lastAdjustedTradeCount: number }
type AdaptorState = Record<string, AdaptorEntry>;

interface PoolStrategy {
  id: string; metrics: { pf: number };
  sizeMultiplier?: number; enabled?: boolean;
}

export class PnlAdaptor {
  private cfg: PnlAdaptorConfig;
  private runner: LivePaperRunner | null;
  private state: AdaptorState = {};
  private running = false;

  constructor(cfg: Partial<PnlAdaptorConfig> = {}, runner: LivePaperRunner | null = null) {
    this.cfg = { ...DEFAULT_PNL_ADAPTOR_CONFIG, ...cfg };
    this.runner = runner;
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

  private logAdjustment(entry: Record<string, unknown>) {
    const dir = dirname(this.cfg.pnlAdjustmentsFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.cfg.pnlAdjustmentsFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  }

  // Runs once; returns strategies resized/pruned this call (empty in dryRun
  // -- the log still records what WOULD have happened).
  async check(): Promise<{ resized: string[]; pruned: string[] }> {
    const allTrades = reconstructClosedTrades(this.cfg.journalFile);
    const pool = JSON.parse(readFileSync(this.cfg.poolPath, "utf-8"));
    const byStrategy = new Map<string, ClosedTrade[]>();
    for (const t of allTrades) {
      const arr = byStrategy.get(t.strategyId);
      if (arr) arr.push(t); else byStrategy.set(t.strategyId, [t]);
    }

    const strategies: PoolStrategy[] = Object.values(pool.symbols).flat() as PoolStrategy[];
    const resized: string[] = [];
    const pruned: string[] = [];
    let poolChanged = false;

    for (const strat of strategies) {
      const trades = byStrategy.get(strat.id) ?? [];
      const entry = this.state[strat.id] ?? { lastAdjustedTradeCount: 0 };
      if (trades.length === entry.lastAdjustedTradeCount) continue; // no new data since last cycle

      const currentSize = strat.sizeMultiplier ?? 1;
      const newSize = decideSizeMultiplier(trades, strat.metrics.pf, currentSize, this.cfg);
      const pruneDecision = strat.enabled !== false ? decidePrune(trades, this.cfg) : { prune: false };

      if (newSize !== null) {
        this.logAdjustment({
          strategyId: strat.id, action: "resize", oldValue: currentSize, newValue: newSize,
          liveTrades: trades.length, livePf: rollingPf(trades), backtestPf: strat.metrics.pf, dryRun: this.cfg.dryRun,
        });
        if (!this.cfg.dryRun) { strat.sizeMultiplier = newSize; poolChanged = true; }
        resized.push(strat.id);
      }

      if (pruneDecision.prune) {
        this.logAdjustment({
          strategyId: strat.id, action: "prune", oldValue: strat.enabled ?? true, newValue: false,
          liveTrades: trades.length, livePf: rollingPf(trades), backtestPf: strat.metrics.pf,
          reason: pruneDecision.reason, dryRun: this.cfg.dryRun,
        });
        if (!this.cfg.dryRun) { strat.enabled = false; poolChanged = true; }
        pruned.push(strat.id);
        if (this.cfg.notifyTelegram && !this.cfg.dryRun) {
          await sendTelegram(`🔴 PNL ADAPTOR: ${strat.id} permanently disabled\n${pruneDecision.reason}`);
        }
      }

      this.state[strat.id] = { lastAdjustedTradeCount: trades.length };
    }

    this.saveState();
    if (poolChanged) {
      writeFileSync(this.cfg.poolPath, JSON.stringify(pool, null, 2));
      this.runner?.reloadPool(this.cfg.poolPath);
    }
    return { resized, pruned };
  }

  async start(intervalMs = 60 * 60 * 1000, onResult?: (r: { resized: string[]; pruned: string[] }) => void) {
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
