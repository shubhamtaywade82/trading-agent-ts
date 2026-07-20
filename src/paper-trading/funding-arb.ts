import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";
import { fetchSpotPrice, fetchFuturesStats } from "../tools/binance-tools.js";
import { fetchFundingRates, fundingPnl, EIGHT_H } from "./live-runner.js";

export interface FundingArbPosition {
  symbol: string;
  perpDirection: "long" | "short";
  notional: number;
  qty: number;
  entrySpotPrice: number;
  entryMarkPrice: number;
  entryBasis: number;
  openedAt: number;
  lastFundingCheckAt: number;
  accruedFundingUsd: number;
}

export interface FundingArbConfig {
  notionalPerPosition: number;
  entryThreshold: number;
  exitThreshold: number;
  maxHoldMs: number;
  stateFile: string;
  journalFile: string;
}

export const DEFAULT_FUNDING_ARB_CONFIG: FundingArbConfig = {
  notionalPerPosition: 2000,
  entryThreshold: 0.0003,
  exitThreshold: 0.0001,
  maxHoldMs: 14 * 24 * 60 * 60 * 1000,
  stateFile: ".trading-agent/funding-arb-state.json",
  journalFile: ".trading-agent/funding-arb-trades.jsonl",
};

export interface FundingArbDeps {
  fetchSpotPrice: typeof fetchSpotPrice;
  fetchFuturesStats: typeof fetchFuturesStats;
  fetchFundingRates: typeof fetchFundingRates;
}

const REAL_DEPS: FundingArbDeps = { fetchSpotPrice, fetchFuturesStats, fetchFundingRates };

// Cash-and-carry PnL: funding collected is tracked separately (accruedFundingUsd);
// this is the OTHER half — the residual price-exposure risk left over because the
// spot and perp legs' price moves cancel except for the CHANGE in basis between
// entry and now. Short perp profits when basis narrows toward spot; long perp
// profits when basis widens away from spot (mirror image).
export function computeBasisPnl(qty: number, entryBasis: number, currentBasis: number, perpDirection: "long" | "short"): number {
  const sign = perpDirection === "short" ? 1 : -1;
  return sign * qty * (entryBasis - currentBasis);
}

export class FundingArbTracker {
  private cfg: FundingArbConfig;
  private deps: FundingArbDeps;
  private state: Record<string, FundingArbPosition | null> = {};
  private running = false;

  constructor(private symbols: string[], cfg: Partial<FundingArbConfig> = {}, deps: Partial<FundingArbDeps> = {}) {
    this.cfg = { ...DEFAULT_FUNDING_ARB_CONFIG, ...cfg };
    this.deps = { ...REAL_DEPS, ...deps };
    this.loadState();
  }

  private loadState() {
    if (existsSync(this.cfg.stateFile)) {
      try {
        this.state = JSON.parse(readFileSync(this.cfg.stateFile, "utf-8"));
      } catch { this.state = {}; }
    }
    for (const s of this.symbols) if (!(s in this.state)) this.state[s] = null;
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

  async tick(now: number = Date.now()): Promise<{ opened: string[]; closed: string[] }> {
    const opened: string[] = [];
    const closed: string[] = [];

    for (const symbol of this.symbols) {
      const stats = await this.deps.fetchFuturesStats(symbol);
      if ("error" in stats) continue;
      const pos = this.state[symbol];

      if (pos) {
        if (Math.floor(now / EIGHT_H) > Math.floor(pos.lastFundingCheckAt / EIGHT_H)) {
          const rates = await this.deps.fetchFundingRates(symbol, pos.lastFundingCheckAt, now);
          pos.accruedFundingUsd += fundingPnl(rates, pos.notional, pos.perpDirection);
          pos.lastFundingCheckAt = now;
        }
        const timedOut = now - pos.openedAt >= this.cfg.maxHoldMs;
        const normalized = Math.abs(stats.lastFundingRate) < this.cfg.exitThreshold;
        if (timedOut || normalized) {
          const spotResult = await this.deps.fetchSpotPrice(symbol);
          if ("error" in spotResult) continue;
          const currentBasis = stats.markPrice - spotResult.price;
          const basisPnl = computeBasisPnl(pos.qty, pos.entryBasis, currentBasis, pos.perpDirection);
          const realizedPnlUsd = pos.accruedFundingUsd + basisPnl;
          this.journal({
            type: "funding_arb_close", symbol, reason: timedOut ? "timeout" : "normalized",
            realizedPnlUsd, accruedFundingUsd: pos.accruedFundingUsd, basisPnl,
          });
          this.state[symbol] = null;
          closed.push(symbol);
        }
        continue;
      }

      if (Math.abs(stats.lastFundingRate) > this.cfg.entryThreshold) {
        const spotResult = await this.deps.fetchSpotPrice(symbol);
        if ("error" in spotResult) continue;
        // ponytail: long-perp/short-spot (negative funding case) simulates
        // shorting spot with no real borrow constraint modeled — paper-only.
        const perpDirection: "long" | "short" = stats.lastFundingRate > 0 ? "short" : "long";
        const qty = this.cfg.notionalPerPosition / spotResult.price;
        const entryBasis = stats.markPrice - spotResult.price;
        this.state[symbol] = {
          symbol, perpDirection, notional: this.cfg.notionalPerPosition, qty,
          entrySpotPrice: spotResult.price, entryMarkPrice: stats.markPrice, entryBasis,
          openedAt: now, lastFundingCheckAt: now, accruedFundingUsd: 0,
        };
        this.journal({
          type: "funding_arb_open", symbol, perpDirection, notional: this.cfg.notionalPerPosition,
          entrySpotPrice: spotResult.price, entryMarkPrice: stats.markPrice, entryBasis,
        });
        opened.push(symbol);
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
