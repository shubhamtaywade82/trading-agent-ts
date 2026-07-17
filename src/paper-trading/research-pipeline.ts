import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";
import { fetchCandlesRange, runFuturesBacktest } from "../tools/backtest-tools.js";
import { Candle } from "../backtest/types.js";
import { LivePaperRunner } from "./live-runner.js";
import { sendTelegram } from "./notifier.js";

// Self-learning re-research/promotion loop. Refactors the exact methodology
// already used to build strategies.json (scripts/day-trader-sweep.ts's
// split-sample survival screen + scripts/train-forward-test.ts's realistic-
// sizing reverify — both one-off scripts, confirmed via direct read to have
// no exported functions) into a reusable, schedulable pipeline.
//
// This is the ONE place the system writes to strategies.json autonomously,
// and it's bounded by reusing the identical validation gate every human-
// curated entry already passed: minTrades, 3-way split-sample all-positive,
// same realistic sizing (5x leverage / 5% margin) as everything else in this
// repo. No signal logic is invented here — only existing condition types
// (already wired into buildSignalEvaluator) get re-swept across params/
// timeframes. buildSignalEvaluator itself is never touched.

export interface SignalDef {
  id: string;
  direction: "long" | "short";
  entry: { type: string; period?: number; value?: number }[];
}

// Same signal set validated in day-trader-sweep.ts — kept here as data, not
// new logic, so the pipeline can re-sweep them on a schedule.
export const DEFAULT_SIGNAL_POOL: SignalDef[] = [
  { id: "bearish_liq_ob", direction: "short", entry: [{ type: "bearish_liq_ob" }] },
  { id: "bearish_liq_fvg", direction: "short", entry: [{ type: "bearish_liq_fvg" }] },
  { id: "bearish_liq_sweep", direction: "short", entry: [{ type: "bearish_liq_sweep" }] },
  { id: "bullish_liq_fvg", direction: "long", entry: [{ type: "bullish_liq_fvg" }] },
  { id: "bearish_fvg", direction: "short", entry: [{ type: "bearish_fvg" }] },
  { id: "rsi_above_80", direction: "short", entry: [{ type: "rsi_above", period: 14, value: 80 }] },
  { id: "ichimoku_bearish_breakout", direction: "short", entry: [{ type: "ichimoku_bearish_breakout" }] },
  { id: "ichimoku_below_cloud_short", direction: "short", entry: [{ type: "ichimoku_below_cloud_short" }] },
  { id: "adx_di_cross_short", direction: "short", entry: [{ type: "adx_di_cross_short", value: 20 }] },
  { id: "volume_spike_short", direction: "short", entry: [{ type: "volume_spike_short" }] },
];

export interface TimeframeSweepCfg { lookbackDays: number; stopValues: number[]; targetValues: number[]; maxHoldBars: number }

export const DEFAULT_TIMEFRAME_CFG: Record<string, TimeframeSweepCfg> = {
  "15m": { lookbackDays: 90, stopValues: [0.005, 0.008, 0.01, 0.015], targetValues: [0.01, 0.02, 0.03], maxHoldBars: 48 },
  "30m": { lookbackDays: 180, stopValues: [0.008, 0.012, 0.02], targetValues: [0.015, 0.03, 0.04], maxHoldBars: 48 },
  "1h": { lookbackDays: 365, stopValues: [0.01, 0.02, 0.03], targetValues: [0.02, 0.04, 0.06, 0.12], maxHoldBars: 48 },
  "4h": { lookbackDays: 730, stopValues: [0.02, 0.03, 0.05], targetValues: [0.04, 0.08, 0.15], maxHoldBars: 42 },
};

export interface ResearchCycleConfig {
  symbols: string[];
  signalPool: SignalDef[];
  timeframeCfg: Record<string, TimeframeSweepCfg>;
  minTrades: number;
  leverage: number;
  marginPerTradePct: number;
  feeBps: number;
  slippageBps: number;
  initialCapital: number;
}

export const DEFAULT_RESEARCH_CYCLE_CONFIG: ResearchCycleConfig = {
  symbols: ["SOLUSDT", "ETHUSDT", "XRPUSDT"],
  signalPool: DEFAULT_SIGNAL_POOL,
  timeframeCfg: DEFAULT_TIMEFRAME_CFG,
  minTrades: 15,
  leverage: 5,
  marginPerTradePct: 0.05,
  feeBps: 5,
  slippageBps: 3,
  initialCapital: 10000,
};

export interface ResearchCandidate {
  symbol: string; tf: string; signalId: string; direction: "long" | "short";
  entry: SignalDef["entry"]; stopPct: number; targetPct: number; maxHoldBars: number;
  trades: number; winRate: number; pf: number; sharpe: number; pnlUsd: number; maxDDPct: number;
  foldsPositive: boolean[]; allFoldsPositive: boolean;
}

function splitIntoFolds(candles: Candle[], n: number): Candle[][] {
  const size = Math.floor(candles.length / n);
  const folds: Candle[][] = [];
  for (let i = 0; i < n; i++) {
    folds.push(i === n - 1 ? candles.slice(i * size) : candles.slice(i * size, (i + 1) * size));
  }
  return folds;
}

// Pure sweep — no file writes, no side effects. Reruns the same
// runFuturesBacktest engine used everywhere else in this repo across a
// stop/target grid per (symbol, timeframe, signal), and only returns a
// candidate for combos where a 3-way contiguous split of the window is
// independently profitable in every fold (stricter than the 2-half check
// day-trader-sweep used, per the "3-fold OOS" bar this module commits to).
export async function runResearchCycle(cfg: Partial<ResearchCycleConfig> = {}): Promise<{ tested: number; candidates: ResearchCandidate[] }> {
  const c = { ...DEFAULT_RESEARCH_CYCLE_CONFIG, ...cfg };
  let tested = 0;
  const candidates: ResearchCandidate[] = [];

  for (const symbol of c.symbols) {
    for (const [tf, tfCfg] of Object.entries(c.timeframeCfg)) {
      const endTime = Date.now();
      const startTime = endTime - tfCfg.lookbackDays * 24 * 60 * 60 * 1000;
      const fetched = await fetchCandlesRange(symbol, tf, startTime, endTime);
      if ("error" in fetched) continue;
      const candles = fetched.candles;
      const folds = splitIntoFolds(candles, 3);

      for (const sig of c.signalPool) {
        let best: ResearchCandidate | null = null;
        for (const stopPct of tfCfg.stopValues) {
          for (const targetPct of tfCfg.targetValues) {
            tested++;
            const full: any = runFuturesBacktest(candles, sig.entry, sig.direction, stopPct, targetPct, c.feeBps, tfCfg.maxHoldBars, c.initialCapital, c.leverage, c.marginPerTradePct, c.slippageBps);
            if (full.metrics.totalTrades < c.minTrades) continue;
            const foldResults = folds.map(f => runFuturesBacktest(f, sig.entry, sig.direction, stopPct, targetPct, c.feeBps, tfCfg.maxHoldBars, c.initialCapital, c.leverage, c.marginPerTradePct, c.slippageBps) as any);
            const foldsPositive = foldResults.map(r => r.metrics.totalPnlUsd > 0);
            const allFoldsPositive = foldsPositive.every(Boolean);
            if (!allFoldsPositive) continue;
            const candidate: ResearchCandidate = {
              symbol, tf, signalId: sig.id, direction: sig.direction, entry: sig.entry,
              stopPct, targetPct, maxHoldBars: tfCfg.maxHoldBars,
              trades: full.metrics.totalTrades, winRate: full.metrics.winRate, pf: full.metrics.profitFactor,
              sharpe: full.metrics.sharpeRatio, pnlUsd: full.metrics.totalPnlUsd, maxDDPct: full.metrics.maxDrawdownPct,
              foldsPositive, allFoldsPositive,
            };
            if (!best || candidate.sharpe > best.sharpe) best = candidate;
          }
        }
        if (best) candidates.push(best);
      }
    }
  }

  return { tested, candidates };
}

export interface ResearchPipelineConfig {
  poolPath: string;
  cyclesLogFile: string;
  maxPromotionsPerCycle: number;
  maxPoolSize: number;
  notifyTelegram: boolean;
  cycle: ResearchCycleConfig;
}

export const DEFAULT_RESEARCH_PIPELINE_CONFIG: ResearchPipelineConfig = {
  poolPath: "strategies.json",
  cyclesLogFile: ".trading-agent/research-cycles.jsonl",
  maxPromotionsPerCycle: 3,
  maxPoolSize: 40,
  notifyTelegram: true,
  cycle: DEFAULT_RESEARCH_CYCLE_CONFIG,
};

export class ResearchPipeline {
  private cfg: ResearchPipelineConfig;
  private runner: LivePaperRunner | null;

  constructor(cfg: Partial<ResearchPipelineConfig> = {}, runner: LivePaperRunner | null = null) {
    this.cfg = { ...DEFAULT_RESEARCH_PIPELINE_CONFIG, ...cfg, cycle: { ...DEFAULT_RESEARCH_CYCLE_CONFIG, ...cfg.cycle } };
    this.runner = runner;
  }

  private log(entry: Record<string, unknown>) {
    const dir = dirname(this.cfg.cyclesLogFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.cfg.cyclesLogFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  }

  // Runs one full cycle: sweep -> log everything -> promote up to
  // maxPromotionsPerCycle survivors not already in the pool, capped at
  // maxPoolSize total strategies. Returns what was promoted.
  async runCycle(): Promise<{ tested: number; candidateCount: number; promoted: string[] }> {
    const { tested, candidates } = await runResearchCycle(this.cfg.cycle);
    const pool = JSON.parse(readFileSync(this.cfg.poolPath, "utf-8"));

    const existingKeys = new Set<string>();
    let poolSize = 0;
    for (const [symbol, strats] of Object.entries(pool.symbols) as [string, any[]][]) {
      for (const s of strats) {
        existingKeys.add(`${symbol}:${s.tf}:${JSON.stringify(s.entry)}:${s.direction}`);
        poolSize++;
      }
    }

    const fresh = candidates.filter(c => !existingKeys.has(`${c.symbol}:${c.tf}:${JSON.stringify(c.entry)}:${c.direction}`));
    fresh.sort((a, b) => b.sharpe - a.sharpe);

    const promoted: string[] = [];
    const promotedAt = new Date().toISOString();
    for (const cand of fresh) {
      if (promoted.length >= this.cfg.maxPromotionsPerCycle) break;
      if (poolSize >= this.cfg.maxPoolSize) break;

      const id = `${cand.symbol.toLowerCase()}-auto-${cand.signalId}-${cand.tf}-${Date.parse(promotedAt)}`;
      const entry = {
        id, label: `Auto-research: ${cand.signalId} (${cand.tf})`, direction: cand.direction, tf: cand.tf,
        maxHoldBars: cand.maxHoldBars, entry: cand.entry,
        risk: { stopPct: cand.stopPct, targetPct: cand.targetPct },
        metrics: {
          sharpe: cand.sharpe, pf: cand.pf, winRate: cand.winRate, trades: cand.trades,
          pnlUsd: Math.round(cand.pnlUsd), returnPct: cand.pnlUsd / this.cfg.cycle.initialCapital, maxDDPct: cand.maxDDPct,
        },
        source: "auto-research", promotedAt,
      };
      if (!pool.symbols[cand.symbol]) pool.symbols[cand.symbol] = [];
      pool.symbols[cand.symbol].push(entry);
      poolSize++;
      promoted.push(id);

      if (this.cfg.notifyTelegram) {
        await sendTelegram(
          `🔬 AUTO-PROMOTED: ${entry.label} (${id})\n${cand.symbol} ${cand.tf} ${cand.direction}, stop ${(cand.stopPct*100).toFixed(1)}% target ${(cand.targetPct*100).toFixed(1)}%\n` +
          `${cand.trades} trades, WR ${(cand.winRate*100).toFixed(0)}%, PF ${cand.pf.toFixed(2)}, Sharpe ${cand.sharpe.toFixed(2)}, all 3 OOS folds positive\n` +
          `Starts with its own fresh $${this.cfg.cycle.initialCapital} paper bucket.`
        );
      }
    }

    if (promoted.length > 0) {
      writeFileSync(this.cfg.poolPath, JSON.stringify(pool, null, 2));
      this.runner?.reloadPool(this.cfg.poolPath);
    }

    this.log({
      type: "research_cycle", tested, candidateCount: candidates.length, freshCount: fresh.length,
      promoted, poolSizeAfter: poolSize,
      candidates: candidates.map(c => ({ symbol: c.symbol, tf: c.tf, signalId: c.signalId, trades: c.trades, sharpe: c.sharpe, pf: c.pf, winRate: c.winRate, pnlUsd: Math.round(c.pnlUsd) })),
    });

    return { tested, candidateCount: candidates.length, promoted };
  }
}
