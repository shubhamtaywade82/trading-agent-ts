# Funding-Rate Arbitrage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone paper-trading ledger for delta-neutral funding-rate arbitrage (long spot + short/long perp, collecting funding), with real cash-and-carry PnL accounting (funding collected offset by basis convergence risk), wired into the daemon, with a report script.

**Architecture:** Two new standalone data-fetch functions (`fetchSpotPrice`, `fetchFuturesStats`) follow the same factoring pattern used twice already in this plan. `fetchFundingRates`/`fundingPnl`/`EIGHT_H` are reused from `live-runner.ts` (exported, not reimplemented). `FundingArbTracker` is a new, independent module — not built on `ShadowSignalTracker`, since the position shape (notional/qty/basis, no stop/target) is genuinely different. Dependency injection (constructor-level, not module mocking) makes the PnL arithmetic unit-testable without real network calls or real elapsed time.

**Tech Stack:** TypeScript (Node16 ESM), Jest (fake injected deps for `FundingArbTracker`'s tests — deterministic, no real network, unlike sub-project 2/3's trackers which legitimately need live data), `tsx` for daemon/report scripts.

## Global Constraints

- No historical backtest in this plan — live paper ledger only (see spec's scope decision). A backtest is a separate future sub-task if this ledger's results justify it.
- Reuse `fundingPnl`/`fetchFundingRates`/`EIGHT_H` from `live-runner.ts` — do not reimplement funding-rate fetching or the funding PnL sign convention a third time in this codebase.
- `FundingArbTracker` is its own module with its own state/journal files — not folded into `ShadowSignalTracker`.
- The long-perp/short-spot case is a paper-only simplification (no real spot-borrow constraint) — mark it with a `ponytail:` comment, don't silently pretend it's realistic.

---

### Task 1: `fetchSpotPrice`

**Files:**
- Modify: `src/tools/binance-tools.ts` (add near the top-level helpers, after `fetchBinance`, ~line 33)
- Test: `tests/tools/binance-tools.test.ts`

**Interfaces:**
- Produces: `fetchSpotPrice(symbol: string): Promise<{ price: number } | { error: string; message: string }>`

- [ ] **Step 1: Write the failing test**

Add `fetchSpotPrice` to the existing import line in `tests/tools/binance-tools.test.ts`, then add a new describe block (anywhere after the existing imports/helpers, e.g. right before `describe("fetchOrderBookImbalance", ...)`):

```ts
describe("fetchSpotPrice", () => {
  const originalFetch = global.fetch;
  afterEach(() => { (globalThis as any).fetch = originalFetch; });

  it("fetches and parses the spot ticker price", async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ symbol: "BTCUSDT", price: "64123.45" }),
    });
    const result = await fetchSpotPrice("BTCUSDT");
    expect(result).toEqual({ price: 64123.45 });
  });

  it("propagates a fetch error", async () => {
    (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error("network down"));
    const result = await fetchSpotPrice("BTCUSDT");
    expect(result).toEqual({ error: "RequestError", message: "network down" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/tools/binance-tools.test.ts -t "fetchSpotPrice"`
Expected: FAIL — `fetchSpotPrice is not a function`.

- [ ] **Step 3: Implement**

Add to `src/tools/binance-tools.ts`, directly after `fetchBinance`'s closing `}` (~line 33):

```ts
export async function fetchSpotPrice(symbol: string): Promise<{ price: number } | { error: string; message: string }> {
  const result = await fetchBinance("spot", "/api/v3/ticker/price", { symbol });
  if (result.error) return result as { error: string; message: string };
  const body = result.body as { price: string };
  return { price: Number(body.price) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/tools/binance-tools.test.ts -t "fetchSpotPrice"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/binance-tools.ts tests/tools/binance-tools.test.ts
git commit -m "feat: add fetchSpotPrice standalone helper"
```

---

### Task 2: Factor out `fetchFuturesStats`

**Files:**
- Modify: `src/tools/binance-tools.ts` (`BinanceFuturesStatsTool`, ~line 219-259)
- Test: `tests/tools/binance-tools.test.ts` (existing `BinanceFuturesStatsTool` describe block)

**Interfaces:**
- Produces: `fetchFuturesStats(symbol: string): Promise<{ markPrice: number; lastFundingRate: number; nextFundingTime: number; openInterest: number } | { error: string; message: string }>`

Same refactor shape as sub-project 2's Task 1 (`fetchOrderBookImbalance` extraction) — the
existing mocked test for `BinanceFuturesStatsTool` must keep passing unchanged.

- [ ] **Step 1: Write the failing test**

Add `fetchFuturesStats` to the import line, then add a new describe block right after the existing `describe("BinanceFuturesStatsTool", ...)`:

```ts
describe("fetchFuturesStats", () => {
  const originalFetch = global.fetch;
  afterEach(() => { (globalThis as any).fetch = originalFetch; });

  it("combines premium index and open interest, without the Tool wrapper", async () => {
    (globalThis as any).fetch = jest.fn().mockImplementation((url: URL) => {
      if (url.toString().includes("premiumIndex")) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ markPrice: "60000.5", lastFundingRate: "0.0001", nextFundingTime: 123 }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ openInterest: "1234.5" }) });
    });
    const result = await fetchFuturesStats("BTCUSDT");
    expect(result).toEqual({ markPrice: 60000.5, lastFundingRate: 0.0001, nextFundingTime: 123, openInterest: 1234.5 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/tools/binance-tools.test.ts -t "fetchFuturesStats"`
Expected: FAIL — `fetchFuturesStats is not a function`.

- [ ] **Step 3: Implement**

Replace `BinanceFuturesStatsTool.call()`'s body (`src/tools/binance-tools.ts:240-257`) and add
the new function right before the class:

```ts
export async function fetchFuturesStats(
  symbol: string,
): Promise<{ markPrice: number; lastFundingRate: number; nextFundingTime: number; openInterest: number } | { error: string; message: string }> {
  const [premium, openInterest] = await Promise.all([
    fetchBinance("usdm", "/fapi/v1/premiumIndex", { symbol }),
    fetchBinance("usdm", "/fapi/v1/openInterest", { symbol }),
  ]);
  if (premium.error) return premium as { error: string; message: string };
  if (openInterest.error) return openInterest as { error: string; message: string };

  const p = premium.body as { markPrice: string; lastFundingRate: string; nextFundingTime: number };
  const oi = openInterest.body as { openInterest: string };
  return {
    markPrice: Number(p.markPrice),
    lastFundingRate: Number(p.lastFundingRate),
    nextFundingTime: p.nextFundingTime,
    openInterest: Number(oi.openInterest),
  };
}

export class BinanceFuturesStatsTool extends Tool {
  // ... get name()/description()/tags()/parameters() unchanged ...

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = String(args.symbol ?? "");
    const result = await fetchFuturesStats(symbol);
    if ("error" in result) return result;
    return { symbol, ...result };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/tools/binance-tools.test.ts -t "BinanceFuturesStatsTool|fetchFuturesStats"`
Expected: PASS — including the pre-existing `BinanceFuturesStatsTool` test unchanged.

- [ ] **Step 5: Run the full file to confirm no regressions**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/tools/binance-tools.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add src/tools/binance-tools.ts tests/tools/binance-tools.test.ts
git commit -m "feat: factor out fetchFuturesStats from BinanceFuturesStatsTool"
```

---

### Task 3: Export `fetchFundingRates` and `EIGHT_H`

**Files:**
- Modify: `src/paper-trading/live-runner.ts` (~line 690-698)

**Interfaces:**
- Produces: `export const EIGHT_H`, `export async function fetchFundingRates(...)` (both already exist as private; this task only adds the `export` keyword — no behavior change)

No new test — this is a visibility-only change; the existing live-runner test suite is the regression check.

- [ ] **Step 1: Change visibility**

In `src/paper-trading/live-runner.ts`, change:

```ts
const EIGHT_H = 8 * 3_600_000; // Binance funding interval

async function fetchFundingRates(symbol: string, startTime: number, endTime: number): Promise<number[]> {
```

to:

```ts
export const EIGHT_H = 8 * 3_600_000; // Binance funding interval

export async function fetchFundingRates(symbol: string, startTime: number, endTime: number): Promise<number[]> {
```

- [ ] **Step 2: Run the existing live-runner test suite to confirm no regressions**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/paper-trading/live-runner-reload.test.ts tests/paper-trading/live-runner-oi.test.ts`
Expected: PASS (all tests unchanged — `export` doesn't change runtime behavior).

- [ ] **Step 3: Commit**

```bash
git add src/paper-trading/live-runner.ts
git commit -m "chore: export fetchFundingRates and EIGHT_H for reuse by FundingArbTracker"
```

---

### Task 4: `FundingArbTracker` core

**Files:**
- Create: `src/paper-trading/funding-arb.ts`
- Test: `tests/paper-trading/funding-arb.test.ts`

**Interfaces:**
- Consumes: `fetchSpotPrice` (Task 1), `fetchFuturesStats` (Task 2), `fetchFundingRates`/`fundingPnl`/`EIGHT_H` (Task 3, all from `live-runner.js`)
- Produces: `computeBasisPnl(qty, entryBasis, currentBasis, perpDirection): number`, `FundingArbPosition`, `FundingArbConfig`, `DEFAULT_FUNDING_ARB_CONFIG`, `FundingArbDeps`, `FundingArbTracker`

- [ ] **Step 1: Write the failing tests**

Create `tests/paper-trading/funding-arb.test.ts`:

```ts
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { FundingArbTracker, computeBasisPnl, FundingArbDeps } from "../../src/paper-trading/funding-arb.js";

describe("computeBasisPnl", () => {
  it("short perp: profits when basis narrows (converges toward spot)", () => {
    // entryBasis 10, currentBasis 4 -> basis narrowed by 6, short perp profits
    expect(computeBasisPnl(100, 10, 4, "short")).toBeCloseTo(600);
  });

  it("short perp: loses when basis widens", () => {
    expect(computeBasisPnl(100, 10, 16, "short")).toBeCloseTo(-600);
  });

  it("long perp: profits when basis widens", () => {
    expect(computeBasisPnl(100, 10, 16, "long")).toBeCloseTo(600);
  });
});

describe("FundingArbTracker", () => {
  let dir: string;
  let stateFile: string;
  let journalFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "funding-arb-"));
    stateFile = join(dir, "state.json");
    journalFile = join(dir, "trades.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function deps(overrides: Partial<FundingArbDeps> = {}): FundingArbDeps {
    return {
      fetchSpotPrice: async () => ({ price: 100 }),
      fetchFuturesStats: async () => ({ markPrice: 101, lastFundingRate: 0.0005, nextFundingTime: 0, openInterest: 0 }),
      fetchFundingRates: async () => [0.0005],
      ...overrides,
    };
  }

  it("opens a short-perp position when funding rate is positive and above threshold", async () => {
    const tracker = new FundingArbTracker(["XRPUSDT"], { stateFile, journalFile }, deps());
    const result = await tracker.tick();
    expect(result.opened).toEqual(["XRPUSDT"]);
    const journal = await readFile(journalFile, "utf-8");
    expect(journal).toContain('"type":"funding_arb_open"');
    expect(journal).toContain('"perpDirection":"short"');
  });

  it("opens a long-perp position when funding rate is negative and below -threshold", async () => {
    const tracker = new FundingArbTracker(["XRPUSDT"], { stateFile, journalFile }, deps({
      fetchFuturesStats: async () => ({ markPrice: 99, lastFundingRate: -0.0005, nextFundingTime: 0, openInterest: 0 }),
    }));
    const result = await tracker.tick();
    expect(result.opened).toEqual(["XRPUSDT"]);
    const journal = await readFile(journalFile, "utf-8");
    expect(journal).toContain('"perpDirection":"long"');
  });

  it("does not open when funding rate is below threshold", async () => {
    const tracker = new FundingArbTracker(["XRPUSDT"], { stateFile, journalFile }, deps({
      fetchFuturesStats: async () => ({ markPrice: 100.1, lastFundingRate: 0.00005, nextFundingTime: 0, openInterest: 0 }),
    }));
    const result = await tracker.tick();
    expect(result.opened).toEqual([]);
  });

  it("does not open a second position while one is already open for a symbol", async () => {
    const tracker = new FundingArbTracker(["XRPUSDT"], { stateFile, journalFile }, deps());
    await tracker.tick();
    const result = await tracker.tick(Date.now() + 1000); // still within an 8h boundary, no funding accrual expected
    expect(result.opened).toEqual([]);
  });

  it("closes on max hold and reports realized PnL = funding + basis PnL", async () => {
    let now = 1_700_000_000_000;
    const tracker = new FundingArbTracker(["XRPUSDT"], { stateFile, journalFile, maxHoldMs: 1000 }, deps());
    await tracker.tick(now);
    now += 2000; // past maxHoldMs
    const result = await tracker.tick(now);
    expect(result.closed).toEqual(["XRPUSDT"]);
    const journal = await readFile(journalFile, "utf-8");
    expect(journal).toContain('"type":"funding_arb_close"');
    expect(journal).toContain('"reason":"timeout"');
  });

  it("closes when funding rate normalizes below the exit threshold", async () => {
    let now = 1_700_000_000_000;
    const openDeps = deps();
    const tracker = new FundingArbTracker(["XRPUSDT"], { stateFile, journalFile }, openDeps);
    await tracker.tick(now);
    now += 1000;
    const closeDeps = deps({ fetchFuturesStats: async () => ({ markPrice: 100.05, lastFundingRate: 0.00001, nextFundingTime: 0, openInterest: 0 }) });
    const tracker2 = new FundingArbTracker(["XRPUSDT"], { stateFile, journalFile }, closeDeps);
    const result = await tracker2.tick(now);
    expect(result.closed).toEqual(["XRPUSDT"]);
    const journal = await readFile(journalFile, "utf-8");
    expect(journal).toContain('"reason":"normalized"');
  });

  it("persists open positions across a new tracker instance pointed at the same state file", async () => {
    const first = new FundingArbTracker(["XRPUSDT"], { stateFile, journalFile }, deps());
    await first.tick();
    const second = new FundingArbTracker(["XRPUSDT"], { stateFile, journalFile }, deps());
    await second.tick(Date.now() + 1000);
    const journal = await readFile(journalFile, "utf-8");
    const opens = journal.split("\n").filter(l => l.includes('"type":"funding_arb_open"'));
    expect(opens).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/paper-trading/funding-arb.test.ts`
Expected: FAIL — module `../../src/paper-trading/funding-arb.js` doesn't exist.

- [ ] **Step 3: Implement**

Create `src/paper-trading/funding-arb.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/paper-trading/funding-arb.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/paper-trading/funding-arb.ts tests/paper-trading/funding-arb.test.ts
git commit -m "feat: add FundingArbTracker with real cash-and-carry PnL accounting"
```

---

### Task 5: Daemon wiring

**Files:**
- Modify: `scripts/autonomous-trading-daemon.ts`

**Interfaces:**
- Consumes: `FundingArbTracker` (Task 4)

No unit test — same reasoning as every prior daemon-wiring task in this plan (manual smoke test is this repo's established practice for this file).

- [ ] **Step 1: Import and instantiate**

Add to the imports (near `ShadowSignalTracker`'s import):

```ts
import { FundingArbTracker } from "../src/paper-trading/funding-arb.js";
```

After `const shadowTracker = new ShadowSignalTracker(shadowCandidates, stream);`:

```ts
const fundingArbTracker = new FundingArbTracker(SHADOW_SYMBOLS);
```

(Reuses the existing `SHADOW_SYMBOLS` constant — same 3 symbols, no new list.)

- [ ] **Step 2: Start it and add it to shutdown**

After the `shadowTracker.start(...)` block:

```ts
fundingArbTracker.start(pollSeconds * 1000, (r) => {
  for (const symbol of r.opened) console.log(`💰 FUNDING ARB opened: ${symbol}`);
  for (const symbol of r.closed) console.log(`💰 FUNDING ARB closed: ${symbol}`);
}).catch(e => console.error("Funding arb loop crashed (trading unaffected):", e));
```

In `shutdown()`, add `fundingArbTracker.stop();` alongside `shadowTracker.stop();`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no new errors.

- [ ] **Step 4: Manual smoke test**

Run: `npx tsx scripts/autonomous-trading-daemon.ts --poll-seconds=15` for ~60s, then `Ctrl+C`.
Expected: no new errors; `.trading-agent/funding-arb-state.json` created with 3 keys
(XRPUSDT/ETHUSDT/SOLUSDT). A `💰 FUNDING ARB opened:` line is not guaranteed (funding
rate crossing 0.03%/8h isn't constant) — absence is fine, the state file existing is the
pass condition.

- [ ] **Step 5: Commit**

```bash
git add scripts/autonomous-trading-daemon.ts
git commit -m "feat: wire FundingArbTracker into the autonomous daemon"
```

---

### Task 6: Report script

**Files:**
- Create: `scripts/funding-arb-report.ts`
- Modify: `src/paper-trading/funding-arb.ts` (add `summarizeFundingArbJournal`)
- Test: `tests/paper-trading/funding-arb.test.ts` (add a new describe block)

**Interfaces:**
- Produces: `summarizeFundingArbJournal(entries: { type: string; symbol: string; reason?: string; realizedPnlUsd?: number; accruedFundingUsd?: number; basisPnl?: number }[]): Record<string, { closedCount: number; totalRealizedPnlUsd: number; totalFundingCollected: number; totalBasisPnl: number }>`

- [ ] **Step 1: Write the failing test**

Add to `tests/paper-trading/funding-arb.test.ts` (add `summarizeFundingArbJournal` to the import line):

```ts
describe("summarizeFundingArbJournal", () => {
  it("aggregates closed positions per symbol", () => {
    const entries = [
      { type: "funding_arb_open", symbol: "XRPUSDT" },
      { type: "funding_arb_close", symbol: "XRPUSDT", reason: "normalized", realizedPnlUsd: 12.5, accruedFundingUsd: 15, basisPnl: -2.5 },
      { type: "funding_arb_open", symbol: "XRPUSDT" },
      { type: "funding_arb_close", symbol: "XRPUSDT", reason: "timeout", realizedPnlUsd: -3, accruedFundingUsd: 8, basisPnl: -11 },
    ];
    const summary = summarizeFundingArbJournal(entries);
    expect(summary["XRPUSDT"]).toEqual({
      closedCount: 2, totalRealizedPnlUsd: 9.5, totalFundingCollected: 23, totalBasisPnl: -13.5,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/paper-trading/funding-arb.test.ts -t "summarizeFundingArbJournal"`
Expected: FAIL — `summarizeFundingArbJournal is not a function`.

- [ ] **Step 3: Implement**

Add to `src/paper-trading/funding-arb.ts`, after the `FundingArbTracker` class:

```ts
export function summarizeFundingArbJournal(
  entries: { type: string; symbol: string; reason?: string; realizedPnlUsd?: number; accruedFundingUsd?: number; basisPnl?: number }[],
): Record<string, { closedCount: number; totalRealizedPnlUsd: number; totalFundingCollected: number; totalBasisPnl: number }> {
  const result: ReturnType<typeof summarizeFundingArbJournal> = {};
  for (const e of entries) {
    if (e.type !== "funding_arb_close") continue;
    if (!result[e.symbol]) result[e.symbol] = { closedCount: 0, totalRealizedPnlUsd: 0, totalFundingCollected: 0, totalBasisPnl: 0 };
    const s = result[e.symbol];
    s.closedCount++;
    s.totalRealizedPnlUsd += e.realizedPnlUsd ?? 0;
    s.totalFundingCollected += e.accruedFundingUsd ?? 0;
    s.totalBasisPnl += e.basisPnl ?? 0;
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/paper-trading/funding-arb.test.ts -t "summarizeFundingArbJournal"`
Expected: PASS.

- [ ] **Step 5: Write the report script**

Create `scripts/funding-arb-report.ts`:

```ts
// Reads .trading-agent/funding-arb-trades.jsonl (closed positions) and
// .trading-agent/funding-arb-state.json (currently open) and reports realized
// PnL / funding collected / basis PnL per symbol, plus a best-effort live
// re-mark of any still-open position. Informational only — this signal has
// no strategies.json promotion path (see design spec), so this script isn't
// a decision gate the way the shadow-signal report is.
import { readFileSync, existsSync } from "fs";
import { summarizeFundingArbJournal, computeBasisPnl, FundingArbPosition } from "../src/paper-trading/funding-arb.js";
import { fetchSpotPrice, fetchFuturesStats } from "../src/tools/binance-tools.js";

const JOURNAL_FILE = ".trading-agent/funding-arb-trades.jsonl";
const STATE_FILE = ".trading-agent/funding-arb-state.json";

async function main() {
  if (existsSync(JOURNAL_FILE)) {
    const lines = readFileSync(JOURNAL_FILE, "utf-8").split("\n").filter(Boolean);
    const entries = lines.map(l => JSON.parse(l));
    const summary = summarizeFundingArbJournal(entries);
    console.log("Funding-arb report — closed positions\n");
    for (const [symbol, s] of Object.entries(summary)) {
      console.log(`${symbol}: ${s.closedCount} closed, realizedPnL=$${s.totalRealizedPnlUsd.toFixed(2)} (funding=$${s.totalFundingCollected.toFixed(2)}, basis=$${s.totalBasisPnl.toFixed(2)})`);
    }
    if (Object.keys(summary).length === 0) console.log("No closed positions yet.");
  } else {
    console.log("No journal yet — the daemon hasn't run with funding-arb tracking on.");
  }

  if (existsSync(STATE_FILE)) {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as Record<string, FundingArbPosition | null>;
    console.log("\nOpen positions (best-effort live mark)\n");
    for (const [symbol, pos] of Object.entries(state)) {
      if (!pos) continue;
      const [stats, spot] = await Promise.all([fetchFuturesStats(symbol), fetchSpotPrice(symbol)]);
      if ("error" in stats || "error" in spot) { console.log(`${symbol}: mark failed`); continue; }
      const currentBasis = stats.markPrice - spot.price;
      const basisPnl = computeBasisPnl(pos.qty, pos.entryBasis, currentBasis, pos.perpDirection);
      const unrealized = pos.accruedFundingUsd + basisPnl;
      console.log(`${symbol}: ${pos.perpDirection} perp, notional=$${pos.notional}, unrealized=$${unrealized.toFixed(2)} (funding=$${pos.accruedFundingUsd.toFixed(2)}, basis=$${basisPnl.toFixed(2)})`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: Manual smoke test**

Run: `npx tsx scripts/funding-arb-report.ts`
Expected: prints either "no journal yet" or a closed-position summary, plus any open
positions' best-effort live mark (from Task 5's smoke-test state file, if still present) —
no thrown error either way.

- [ ] **Step 7: Run the full paper-trading test suite to confirm no regressions**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/paper-trading/`
Expected: PASS (all tests).

- [ ] **Step 8: Commit**

```bash
git add src/paper-trading/funding-arb.ts scripts/funding-arb-report.ts tests/paper-trading/funding-arb.test.ts
git commit -m "feat: add funding-arb journal summarizer + report script"
```

---

## After this plan

The daemon needs to run for some meaningful period accumulating funding-arb history before
`scripts/funding-arb-report.ts` says anything statistically meaningful — operational
follow-up, not a task here. There is no promotion gate to review (see spec) — this ledger
just runs, and its report is informational.

Sub-project 5 (stat-arb pairs) is the last spec in this plan — a from-scratch cross-symbol
spread engine, nothing in this plan is reusable there either.
