import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";
import { fetchRecentCloses } from "../tools/binance-tools.js";
import { computeZScoreSeries } from "../backtest/pairs-engine.js";

export interface PairsArbCandidate {
  id: string; symbolA: string; symbolB: string; tf: string;
  lookback: number; entryZ: number; exitZ: number; stopZ: number; maxHoldBars: number;
}

interface PairsArbPosition {
  direction: "short_a_long_b" | "long_a_short_b";
  entryPriceA: number; entryPriceB: number;
  qtyA: number; qtyB: number;
  entryBarCount: number; // bars held tracker — incremented once per tick while open
}

export interface PairsArbConfig {
  notionalPerLeg: number;
  stateFile: string;
  journalFile: string;
}

export const DEFAULT_PAIRS_ARB_CONFIG: PairsArbConfig = {
  notionalPerLeg: 2000,
  stateFile: ".trading-agent/pairs-arb-state.json",
  journalFile: ".trading-agent/pairs-arb-trades.jsonl",
};

export interface PairsArbDeps {
  fetchRecentCloses: typeof fetchRecentCloses;
}

const REAL_DEPS: PairsArbDeps = { fetchRecentCloses };

export class PairsArbTracker {
  private cfg: PairsArbConfig;
  private deps: PairsArbDeps;
  private state: Record<string, PairsArbPosition | null> = {};
  private running = false;

  constructor(private candidates: PairsArbCandidate[], cfg: Partial<PairsArbConfig> = {}, deps: Partial<PairsArbDeps> = {}) {
    this.cfg = { ...DEFAULT_PAIRS_ARB_CONFIG, ...cfg };
    this.deps = { ...REAL_DEPS, ...deps };
    this.loadState();
  }

  private loadState() {
    if (existsSync(this.cfg.stateFile)) {
      try {
        this.state = JSON.parse(readFileSync(this.cfg.stateFile, "utf-8"));
      } catch { this.state = {}; }
    }
    for (const c of this.candidates) if (!(c.id in this.state)) this.state[c.id] = null;
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

  async tick(): Promise<{ opened: string[]; closed: string[] }> {
    const opened: string[] = [];
    const closed: string[] = [];

    for (const c of this.candidates) {
      const [closesAResult, closesBResult] = await Promise.all([
        this.deps.fetchRecentCloses(c.symbolA, c.tf, c.lookback + 2),
        this.deps.fetchRecentCloses(c.symbolB, c.tf, c.lookback + 2),
      ]);
      if ("error" in closesAResult || "error" in closesBResult) continue;
      const z = computeZScoreSeries(closesAResult.closes, closesBResult.closes, c.lookback);
      const zi = z[z.length - 1];
      if (Number.isNaN(zi)) continue;
      const priceA = closesAResult.closes[closesAResult.closes.length - 1];
      const priceB = closesBResult.closes[closesBResult.closes.length - 1];

      const pos = this.state[c.id];
      if (pos) {
        pos.entryBarCount++;
        const hitExit = Math.abs(zi) < c.exitZ;
        const hitStop = Math.abs(zi) > c.stopZ;
        const timedOut = pos.entryBarCount > c.maxHoldBars;
        if (hitExit || hitStop || timedOut) {
          const short = pos.direction === "short_a_long_b";
          const legAPnl = short ? pos.qtyA * (pos.entryPriceA - priceA) : pos.qtyA * (priceA - pos.entryPriceA);
          const legBPnl = short ? pos.qtyB * (priceB - pos.entryPriceB) : pos.qtyB * (pos.entryPriceB - priceB);
          const pnlUsd = legAPnl + legBPnl;
          this.journal({
            type: "pairs_arb_close", id: c.id, reason: hitStop ? "stop" : hitExit ? "target" : "timeout", pnlUsd,
          });
          this.state[c.id] = null;
          closed.push(c.id);
        }
        continue;
      }

      if (Math.abs(zi) > c.entryZ) {
        const direction: "short_a_long_b" | "long_a_short_b" = zi > 0 ? "short_a_long_b" : "long_a_short_b";
        this.state[c.id] = {
          direction, entryPriceA: priceA, entryPriceB: priceB,
          qtyA: this.cfg.notionalPerLeg / priceA, qtyB: this.cfg.notionalPerLeg / priceB,
          entryBarCount: 0,
        };
        this.journal({ type: "pairs_arb_open", id: c.id, direction, entryPriceA: priceA, entryPriceB: priceB, entryZ: zi });
        opened.push(c.id);
      }
    }

    this.saveState();
    return { opened, closed };
  }

  async start(intervalMs: number, onResult?: (r: { opened: string[]; closed: string[] }) => void) {
    this.running = true;
    while (this.running) {
      try {
        const result = await this.tick();
        onResult?.(result);
      } catch { /* guard the loop, matching every other tracker's start() */ }
      if (!this.running) break;
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  stop() {
    this.running = false;
  }
}

export function summarizePairsArbJournal(
  entries: { type: string; id: string; reason?: string; pnlUsd?: number }[],
): Record<string, { closedCount: number; totalPnlUsd: number; winRate: number }> {
  const byId = new Map<string, number[]>();
  for (const e of entries) {
    if (e.type !== "pairs_arb_close" || e.pnlUsd === undefined) continue;
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id)!.push(e.pnlUsd);
  }
  const result: ReturnType<typeof summarizePairsArbJournal> = {};
  for (const [id, pnls] of byId) {
    const wins = pnls.filter(p => p > 0).length;
    result[id] = { closedCount: pnls.length, totalPnlUsd: pnls.reduce((s, p) => s + p, 0), winRate: wins / pnls.length };
  }
  return result;
}
