import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";
import { BinanceStreamManager, getLiveTick } from "../exchange/binance-stream.js";

export interface CandidateSignal {
  id: string;
  symbol: string;
  shadow: boolean; // true = paper-only, not yet counted as validated
  checkFire: () => Promise<"long" | "short" | null>;
  stopPct: number;
  targetPct: number;
  maxHoldMs: number;
}

interface ShadowPosition {
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  openedAt: number;
  maxHoldMs: number;
}

export interface ShadowTrackerConfig {
  stateFile: string;
  journalFile: string;
}

export const DEFAULT_SHADOW_TRACKER_CONFIG: ShadowTrackerConfig = {
  stateFile: ".trading-agent/shadow-state.json",
  journalFile: ".trading-agent/shadow-trades.jsonl",
};

export class ShadowSignalTracker {
  private cfg: ShadowTrackerConfig;
  private state: Record<string, ShadowPosition | null> = {};
  private running = false;

  constructor(private candidates: CandidateSignal[], private stream: BinanceStreamManager, cfg: Partial<ShadowTrackerConfig> = {}) {
    this.cfg = { ...DEFAULT_SHADOW_TRACKER_CONFIG, ...cfg };
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

  async tick(): Promise<{ opened: string[]; closed: { id: string; reason: string }[] }> {
    const opened: string[] = [];
    const closed: { id: string; reason: string }[] = [];

    for (const c of this.candidates) {
      const pos = this.state[c.id];
      if (pos) {
        const tick = await getLiveTick(this.stream, c.symbol);
        if ("error" in tick) continue;
        const hitStop = pos.direction === "long" ? tick.price <= pos.stopPrice : tick.price >= pos.stopPrice;
        const hitTarget = pos.direction === "long" ? tick.price >= pos.targetPrice : tick.price <= pos.targetPrice;
        const timedOut = Date.now() - pos.openedAt >= pos.maxHoldMs;
        if (hitStop || hitTarget || timedOut) {
          const reason = hitStop ? "stop" : hitTarget ? "target" : "timeout";
          const pnlPct = pos.direction === "long" ? (tick.price - pos.entryPrice) / pos.entryPrice : (pos.entryPrice - tick.price) / pos.entryPrice;
          this.journal({ type: "shadow_close", id: c.id, symbol: c.symbol, reason, closePrice: tick.price, pnlPct });
          this.state[c.id] = null;
          closed.push({ id: c.id, reason });
        }
        continue;
      }

      const direction = await c.checkFire();
      if (!direction) continue;
      const tick = await getLiveTick(this.stream, c.symbol);
      if ("error" in tick) continue;
      const stopPrice = direction === "long" ? tick.price * (1 - c.stopPct) : tick.price * (1 + c.stopPct);
      const targetPrice = direction === "long" ? tick.price * (1 + c.targetPct) : tick.price * (1 - c.targetPct);
      this.state[c.id] = { symbol: c.symbol, direction, entryPrice: tick.price, stopPrice, targetPrice, openedAt: tick.time, maxHoldMs: c.maxHoldMs };
      this.journal({ type: "shadow_open", id: c.id, symbol: c.symbol, direction, entryPrice: tick.price, stopPrice, targetPrice });
      opened.push(c.id);
    }

    this.saveState();
    return { opened, closed };
  }

  async start(intervalMs: number, onResult?: (r: { opened: string[]; closed: { id: string; reason: string }[] }) => void) {
    this.running = true;
    while (this.running) {
      try {
        const result = await this.tick();
        onResult?.(result);
      } catch { /* guard the loop, matching StrategyCircuitBreaker's start() */ }
      if (!this.running) break;
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  stop() {
    this.running = false;
  }
}

export function summarizeShadowJournal(
  entries: { type: string; id: string; reason?: string; pnlPct?: number }[],
): Record<string, { fires: number; wins: number; losses: number; winRate: number; pf: number; totalPnlPct: number; verdict: "SURVIVES" | "NOT_YET" }> {
  const byId = new Map<string, { pnls: number[] }>();
  for (const e of entries) {
    if (e.type !== "shadow_close" || e.pnlPct === undefined) continue;
    if (!byId.has(e.id)) byId.set(e.id, { pnls: [] });
    byId.get(e.id)!.pnls.push(e.pnlPct);
  }
  const result: ReturnType<typeof summarizeShadowJournal> = {};
  for (const [id, { pnls }] of byId) {
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p <= 0);
    const grossWin = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    const totalPnlPct = grossWin - grossLoss;
    const fires = pnls.length;
    result[id] = {
      fires, wins: wins.length, losses: losses.length,
      winRate: fires > 0 ? wins.length / fires : 0,
      pf: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      totalPnlPct,
      verdict: fires >= 20 && totalPnlPct > 0 ? "SURVIVES" : "NOT_YET",
    };
  }
  return result;
}
