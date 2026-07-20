# OBI Shadow-Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a generic, persisted, live-tick-driven signal tracker; wire an order-book-imbalance (OBI) candidate into it via the existing autonomous daemon; produce a shadow-period report script. No `strategies.json` involvement — OBI stays in its own permanent tracker (shadow vs. live is a flag on that tracker, not a pool entry).

**Architecture:** `fetchOrderBookImbalance` is factored out of the existing `BinanceOrderBookTool` so the live tool and the new tracker share one implementation. `ShadowSignalTracker` is a new class modeled on this repo's two existing patterns: `PaperTradingManager`'s live-tick mark-to-market (`src/exchange/paper-trading.ts`) plus `LivePaperRunner`'s state-file+journal persistence and `start()`/`stop()` daemon-component shape (`circuit-breaker.ts` et al.). It's generic over "what counts as a fire" (a `checkFire()` function per candidate) so sub-project 3's liquidation-cluster signal reuses it without a rewrite.

**Tech Stack:** TypeScript (Node16 ESM), Jest (real-network tests for anything touching `BinanceStreamManager`, matching `tests/exchange/paper-trading.test.ts`'s existing convention — no live-tick mock exists in this repo and this plan doesn't introduce one), `tsx` for scripts.

## Global Constraints

- OBI is never a `strategies.json` entry — no task in this plan touches that file or `buildSignalEvaluator`.
- Don't reimplement the imbalance calculation in two places — `BinanceOrderBookTool` and `ShadowSignalTracker`'s OBI candidate both call `fetchOrderBookImbalance`.
- No plugin registry or config DSL for `CandidateSignal` — a plain function parameter (`checkFire`) is enough for two consumers (OBI now, liquidation-cluster next); do not build more generality than that.
- Scripts never auto-promote a shadow candidate to `shadow: false` — that's a manual, reviewed edit after reading the report (same convention as sub-project 1's Task 6).

---

### Task 1: `fetchOrderBookImbalance` + `BinanceOrderBookTool` refactor

**Files:**
- Modify: `src/tools/binance-tools.ts` (`BinanceOrderBookTool`, ~line 167-219)
- Test: `tests/tools/binance-tools.test.ts` (existing `BinanceOrderBookTool` describe block, ~line 167-187)

**Interfaces:**
- Produces: `fetchOrderBookImbalance(symbol: string, market: string, limit: number): Promise<{ bestBid: string | null; bestAsk: string | null; bidVolume: number; askVolume: number; imbalance: number } | { error: string; message: string }>`

- [ ] **Step 1: Write the failing test**

The existing test at `tests/tools/binance-tools.test.ts:167-187` must keep passing unchanged (it's the regression check for this refactor). Add a new test in the same `describe("BinanceOrderBookTool", ...)` block, after the existing `it`:

```ts
  it("rejects an invalid market", async () => {
    const tool = new BinanceOrderBookTool();
    const result = await tool.call({ symbol: "BTCUSDT", market: "notamarket" });
    expect(result.error).toBe("InvalidMarket");
  });
```

Add `fetchOrderBookImbalance` to the existing import line at the top of the test file (`import { BinancePublicApiTool, BinanceTechnicalIndicatorsTool, BinanceOrderBookTool, ... } from "../../src/tools/binance-tools.js"`), then add a new describe block right after the `BinanceOrderBookTool` one:

```ts
describe("fetchOrderBookImbalance", () => {
  const originalFetch = global.fetch;
  afterEach(() => { (globalThis as any).fetch = originalFetch; });

  it("computes imbalance directly, without the Tool wrapper", async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ bids: [["100", "10"]], asks: [["101", "3"], ["102", "2"]] }),
    });
    const result = await fetchOrderBookImbalance("BTCUSDT", "spot", 50);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.bidVolume).toBe(10);
      expect(result.askVolume).toBe(5);
      expect(result.imbalance).toBeCloseTo((10 - 5) / 15);
    }
  });

  it("rejects an invalid market before fetching", async () => {
    const result = await fetchOrderBookImbalance("BTCUSDT", "notamarket", 50);
    expect(result).toEqual({ error: "InvalidMarket", message: expect.stringContaining("market must be one of") });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/tools/binance-tools.test.ts -t "fetchOrderBookImbalance|invalid market"`
Expected: FAIL — `fetchOrderBookImbalance is not a function`; the Tool-level "rejects an invalid market" test currently passes already (the Tool has its own inline check today) — that one is a regression guard, not new-behavior proof, and may already be green. Confirm the two new `fetchOrderBookImbalance` tests specifically fail.

- [ ] **Step 3: Implement**

Read `src/tools/binance-tools.ts:165-219` first (the `DEPTH_PATH` const and full `BinanceOrderBookTool` class) to confirm current line numbers before editing — this file has moved once already this session.

Replace the body of `BinanceOrderBookTool.call()` and add the new function right before the class. The `DEPTH_PATH` map and its `InvalidMarket` check move into the new function:

```ts
export async function fetchOrderBookImbalance(
  symbol: string, market: string, limit: number,
): Promise<{ bestBid: string | null; bestAsk: string | null; bidVolume: number; askVolume: number; imbalance: number } | { error: string; message: string }> {
  const path = DEPTH_PATH[market];
  if (!path) {
    return { error: "InvalidMarket", message: `market must be one of: ${Object.keys(MARKETS).join(", ")}` };
  }
  const result = await fetchBinance(market, path, { symbol, limit });
  if (result.error) return result as { error: string; message: string };

  const body = result.body as { bids: [string, string][]; asks: [string, string][] };
  const bidVolume = body.bids.reduce((sum, [, qty]) => sum + Number(qty), 0);
  const askVolume = body.asks.reduce((sum, [, qty]) => sum + Number(qty), 0);
  const imbalance = (bidVolume - askVolume) / (bidVolume + askVolume);
  return { bestBid: body.bids[0]?.[0] ?? null, bestAsk: body.asks[0]?.[0] ?? null, bidVolume, askVolume, imbalance };
}

export class BinanceOrderBookTool extends Tool {
  // ... get name()/description()/tags() unchanged ...

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const market = typeof args.market === "string" ? args.market : "spot";
    const symbol = String(args.symbol ?? "");
    const limit = Number(args.limit ?? 50) || 50;
    const result = await fetchOrderBookImbalance(symbol, market, limit);
    if ("error" in result) return result;
    return { symbol, market, ...result };
  }
}
```

Keep `get parameters()`'s `enum: Object.keys(MARKETS)` as-is — unrelated to this change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/tools/binance-tools.test.ts -t "BinanceOrderBookTool|fetchOrderBookImbalance"`
Expected: PASS — including the pre-existing "computes bid/ask imbalance" test unchanged.

- [ ] **Step 5: Run the full file to confirm no regressions**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/tools/binance-tools.test.ts`
Expected: PASS (all tests, mocked and real-network).

- [ ] **Step 6: Commit**

```bash
git add src/tools/binance-tools.ts tests/tools/binance-tools.test.ts
git commit -m "feat: factor out fetchOrderBookImbalance from BinanceOrderBookTool"
```

---

### Task 2: `getLiveTick` extraction + `ShadowSignalTracker` core

**Files:**
- Modify: `src/exchange/binance-stream.ts` (add helper near the top-level exports)
- Modify: `src/exchange/paper-trading.ts` (`PaperTradingManager.open()`, use the new helper)
- Create: `src/paper-trading/shadow-signal-tracker.ts`
- Test: `tests/paper-trading/shadow-signal-tracker.test.ts` (new, real-network — same convention as `tests/exchange/paper-trading.test.ts`)

**Interfaces:**
- Produces: `getLiveTick(stream: BinanceStreamManager, symbol: string): Promise<Tick | { error: string; message: string }>` (exported from `binance-stream.ts`)
- Produces: `CandidateSignal` interface, `ShadowSignalTracker` class (`src/paper-trading/shadow-signal-tracker.ts`)
- Consumes: `BinanceStreamManager` (existing), `Tick` (existing)

- [ ] **Step 1: Write the failing tests**

Create `tests/paper-trading/shadow-signal-tracker.test.ts`:

```ts
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { BinanceStreamManager } from "../../src/exchange/binance-stream.js";
import { ShadowSignalTracker, CandidateSignal } from "../../src/paper-trading/shadow-signal-tracker.js";

describe("ShadowSignalTracker (real network)", () => {
  let dir: string;
  let stateFile: string;
  let journalFile: string;
  let stream: BinanceStreamManager;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "shadow-tracker-"));
    stateFile = join(dir, "shadow-state.json");
    journalFile = join(dir, "shadow-trades.jsonl");
    stream = new BinanceStreamManager();
  });

  afterEach(async () => {
    stream.closeAll();
    await rm(dir, { recursive: true, force: true });
  });

  function alwaysFiresLong(id: string, symbol: string, overrides: Partial<CandidateSignal> = {}): CandidateSignal {
    return {
      id, symbol, shadow: true, checkFire: async () => "long",
      stopPct: 0.5, targetPct: 0.5, maxHoldMs: 4 * 60 * 60 * 1000, // wide enough not to trigger by accident
      ...overrides,
    };
  }

  it("opens a position when checkFire signals a direction", async () => {
    const tracker = new ShadowSignalTracker([alwaysFiresLong("t1", "BTCUSDT")], stream, { stateFile, journalFile });
    await tracker.tick();
    const journal = await readFile(journalFile, "utf-8");
    expect(journal).toContain('"type":"shadow_open"');
    expect(journal).toContain('"id":"t1"');
  }, 20000);

  it("does not open a second position while one is already open for the same candidate", async () => {
    const tracker = new ShadowSignalTracker([alwaysFiresLong("t1", "BTCUSDT")], stream, { stateFile, journalFile });
    await tracker.tick();
    await tracker.tick();
    const journal = await readFile(journalFile, "utf-8");
    const opens = journal.split("\n").filter(l => l.includes('"type":"shadow_open"'));
    expect(opens).toHaveLength(1);
  }, 20000);

  it("closes on timeout when maxHoldMs has already elapsed", async () => {
    const tracker = new ShadowSignalTracker([alwaysFiresLong("t1", "BTCUSDT", { maxHoldMs: 0 })], stream, { stateFile, journalFile });
    await tracker.tick(); // opens
    await tracker.tick(); // next mark-to-market sees maxHoldMs already exceeded
    const journal = await readFile(journalFile, "utf-8");
    expect(journal).toContain('"type":"shadow_close"');
    expect(journal).toContain('"reason":"timeout"');
  }, 20000);

  it("closes on stop when the live price has already crossed it", async () => {
    // Open once to learn the current live price, then reopen with a stop
    // guaranteed to already be crossed on the very next mark (same trick
    // tests/exchange/paper-trading.test.ts uses for its stop-hit test).
    const probe = new ShadowSignalTracker([alwaysFiresLong("probe", "BTCUSDT")], stream, {
      stateFile: join(dir, "probe-state.json"), journalFile: join(dir, "probe-journal.jsonl"),
    });
    await probe.tick();
    const tick = stream.getLatest("BTCUSDT")!;

    const candidate: CandidateSignal = {
      id: "t1", symbol: "BTCUSDT", shadow: true, checkFire: async () => "long",
      stopPct: 0.5, targetPct: 0.99, maxHoldMs: 4 * 60 * 60 * 1000,
    };
    const tracker = new ShadowSignalTracker([candidate], stream, { stateFile, journalFile });
    // Force a stop price above the current price on a long (guaranteed hit)
    // by opening manually through tick() then rewriting state before the
    // next mark — simplest way to make this deterministic without waiting
    // for a real 0.5% move.
    await tracker.tick();
    const state = JSON.parse(await readFile(stateFile, "utf-8"));
    state.t1.stopPrice = tick.price * 1.5;
    await import("fs/promises").then(fs => fs.writeFile(stateFile, JSON.stringify(state)));
    const reloaded = new ShadowSignalTracker([candidate], stream, { stateFile, journalFile });
    await reloaded.tick();
    const journal = await readFile(journalFile, "utf-8");
    expect(journal).toContain('"reason":"stop"');
  }, 20000);

  it("persists open positions across a new tracker instance pointed at the same state file", async () => {
    const first = new ShadowSignalTracker([alwaysFiresLong("t1", "BTCUSDT")], stream, { stateFile, journalFile });
    await first.tick();
    const second = new ShadowSignalTracker([alwaysFiresLong("t1", "BTCUSDT")], stream, { stateFile, journalFile });
    await second.tick(); // should see the position already open, not open a duplicate
    const journal = await readFile(journalFile, "utf-8");
    const opens = journal.split("\n").filter(l => l.includes('"type":"shadow_open"'));
    expect(opens).toHaveLength(1);
  }, 20000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/paper-trading/shadow-signal-tracker.test.ts`
Expected: FAIL — module `../../src/paper-trading/shadow-signal-tracker.js` doesn't exist.

- [ ] **Step 3: Implement `getLiveTick`**

In `src/exchange/binance-stream.ts`, add after the `Tick` interface (~line 8):

```ts
export async function getLiveTick(stream: BinanceStreamManager, symbol: string): Promise<Tick | { error: string; message: string }> {
  const sym = symbol.toUpperCase();
  try {
    if (!stream.isSubscribed(sym)) await stream.subscribe(sym);
  } catch (e) {
    return { error: "SubscribeError", message: (e as Error).message };
  }
  let tick = stream.getLatest(sym);
  for (let i = 0; i < 20 && !tick; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    tick = stream.getLatest(sym);
  }
  return tick ?? { error: "NoPriceYet", message: "Subscribed but no live price received yet, try again" };
}
```

- [ ] **Step 4: Update `PaperTradingManager.open()` to use it**

In `src/exchange/paper-trading.ts`, change the import and `open()` body:

```ts
import { BinanceStreamManager, getLiveTick } from "./binance-stream.js";
```

Replace the subscribe-and-poll block inside `open()`:

```ts
  async open(symbol: string, direction: "long" | "short", quantity: number, stopPrice?: number, targetPrice?: number): Promise<PaperPosition | { error: string; message: string }> {
    const sym = symbol.toUpperCase();
    const tick = await getLiveTick(this.stream, sym);
    if ("error" in tick) return tick;

    const position: PaperPosition = {
      id: this.nextId++,
      symbol: sym,
      direction,
      entryPrice: tick.price,
      quantity,
      stopPrice,
      targetPrice,
      openedAt: tick.time,
      closedAt: null,
      closePrice: null,
      closeReason: null,
      realizedPnlPct: null,
    };
    this.positions.push(position);
    return position;
  }
```

- [ ] **Step 5: Run `PaperTradingManager`'s existing tests to confirm the refactor didn't break it**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/exchange/paper-trading.test.ts`
Expected: PASS (all 4 existing tests, unchanged behavior).

- [ ] **Step 6: Implement `ShadowSignalTracker`**

Create `src/paper-trading/shadow-signal-tracker.ts`:

```ts
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
```

Note on the "closes on stop" test (Step 1): it rewrites the state file directly between two `tick()` calls rather than waiting for a real price move, because a real 50% price swing isn't something a test can wait for — this mirrors the spirit of `tests/exchange/paper-trading.test.ts`'s existing stop-test trick (open with a stop price already behind the live price) adapted for a tracker that computes its own stop price internally at open time rather than accepting one as an argument.

- [ ] **Step 7: Run the new tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/paper-trading/shadow-signal-tracker.test.ts`
Expected: PASS (5 tests). These hit the real Binance ticker WebSocket for BTCUSDT — if the network is unavailable the run will hang until the 20s timeout; that's expected and matches this repo's existing real-network test behavior (see `paper-trading.test.ts`), not a bug to fix here.

- [ ] **Step 8: Run the full paper-trading and exchange test suites to confirm no regressions**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/paper-trading/ tests/exchange/`
Expected: PASS (all tests).

- [ ] **Step 9: Commit**

```bash
git add src/exchange/binance-stream.ts src/exchange/paper-trading.ts src/paper-trading/shadow-signal-tracker.ts tests/paper-trading/shadow-signal-tracker.test.ts
git commit -m "feat: add ShadowSignalTracker + getLiveTick extraction"
```

---

### Task 3: Daemon wiring (OBI candidates)

**Files:**
- Modify: `scripts/autonomous-trading-daemon.ts`

**Interfaces:**
- Consumes: `ShadowSignalTracker`, `CandidateSignal` (Task 2), `fetchOrderBookImbalance` (Task 1)
- Produces: no new export — behavior-only change to the daemon process

This task has no unit test (the daemon script is a long-running process with no existing test file — `scripts/*.ts` daemon/CLI entry points aren't unit-tested anywhere in this repo; verification here is a manual smoke run, same as this repo's established practice for this specific file).

- [ ] **Step 1: Add the import and candidate config**

In `scripts/autonomous-trading-daemon.ts`, add near the top with the other imports (~line 24, after `PnlAdaptor`):

```ts
import { ShadowSignalTracker, CandidateSignal } from "../src/paper-trading/shadow-signal-tracker.js";
import { fetchOrderBookImbalance } from "../src/tools/binance-tools.js";
```

After the existing component instantiations (~line 46, after `const pnlAdaptor = ...`):

```ts
const OBI_SYMBOLS = ["XRPUSDT", "ETHUSDT", "SOLUSDT"];
const obiCandidates: CandidateSignal[] = OBI_SYMBOLS.map(symbol => ({
  id: `obi-${symbol}`,
  symbol,
  shadow: true,
  stopPct: 0.015,
  targetPct: 0.03,
  maxHoldMs: 4 * 60 * 60 * 1000,
  checkFire: async () => {
    const result = await fetchOrderBookImbalance(symbol, "usdm", 50);
    if ("error" in result) return null;
    if (result.imbalance > 0.3) return "long";
    if (result.imbalance < -0.3) return "short";
    return null;
  },
}));
const shadowTracker = new ShadowSignalTracker(obiCandidates, stream);
```

- [ ] **Step 2: Start it alongside the other components**

After the existing `circuitBreaker.start(...)` block (~line 119), add:

```ts
shadowTracker.start(pollSeconds * 1000, (r) => {
  for (const id of r.opened) console.log(`🔍 SHADOW fired: ${id}`);
  for (const c of r.closed) console.log(`🔍 SHADOW closed: ${c.id} (${c.reason})`);
}).catch(e => console.error("Shadow tracker loop crashed (trading unaffected):", e));
```

- [ ] **Step 3: Add it to the shutdown list**

In the `shutdown()` function (~line 69-82), add `shadowTracker.stop();` alongside the other `.stop()` calls (after `pnlAdaptor.stop();`, before `stream.closeAll();`).

- [ ] **Step 4: Manual smoke test**

Run: `npx tsx scripts/autonomous-trading-daemon.ts --poll-seconds=15` and let it run for ~60 seconds, then `Ctrl+C`.
Expected: console shows the existing `=== Autonomous Trading Daemon ===` startup banner with no new errors, and within the run either a `🔍 SHADOW fired:` line (if any of the 3 symbols crosses the 0.3 imbalance threshold in that window — not guaranteed) or silence (also fine, `checkFire` just returned `null` every poll). On `Ctrl+C`, shutdown logs proceed as before with no unhandled-rejection stack trace from the shadow tracker's `stop()` call. Check `.trading-agent/shadow-state.json` was created.

- [ ] **Step 5: Commit**

```bash
git add scripts/autonomous-trading-daemon.ts
git commit -m "feat: wire OBI shadow-signal candidates into the autonomous daemon"
```

---

### Task 4: Shadow-period report

**Files:**
- Modify: `src/paper-trading/shadow-signal-tracker.ts` (add `summarizeShadowJournal`)
- Create: `scripts/obi-shadow-report.ts`
- Test: `tests/paper-trading/shadow-signal-tracker.test.ts` (add a new describe block)

**Interfaces:**
- Produces: `summarizeShadowJournal(entries: { type: string; id: string; reason?: string; pnlPct?: number }[]): Record<string, { fires: number; wins: number; losses: number; winRate: number; pf: number; totalPnlPct: number; verdict: "SURVIVES" | "NOT_YET" }>`

- [ ] **Step 1: Write the failing test**

Add to `tests/paper-trading/shadow-signal-tracker.test.ts` (add `summarizeShadowJournal` to the existing import line):

```ts
describe("summarizeShadowJournal", () => {
  it("computes fires/wins/losses/winRate/pf/verdict per candidate id", () => {
    const entries = [
      { type: "shadow_open", id: "obi-XRPUSDT" },
      { type: "shadow_close", id: "obi-XRPUSDT", reason: "target", pnlPct: 0.03 },
      { type: "shadow_open", id: "obi-XRPUSDT" },
      { type: "shadow_close", id: "obi-XRPUSDT", reason: "stop", pnlPct: -0.015 },
      { type: "shadow_open", id: "obi-ETHUSDT" },
      { type: "shadow_close", id: "obi-ETHUSDT", reason: "timeout", pnlPct: 0.005 },
    ];
    const summary = summarizeShadowJournal(entries);
    expect(summary["obi-XRPUSDT"]).toEqual({
      fires: 2, wins: 1, losses: 1, winRate: 0.5, pf: 0.03 / 0.015,
      totalPnlPct: 0.03 - 0.015, verdict: "NOT_YET",
    });
    expect(summary["obi-ETHUSDT"].fires).toBe(1);
  });

  it("flags SURVIVES only at >=20 fires and net-positive totalPnlPct", () => {
    const entries: { type: string; id: string; reason?: string; pnlPct?: number }[] = [];
    for (let i = 0; i < 20; i++) {
      entries.push({ type: "shadow_open", id: "obi-XRPUSDT" });
      entries.push({ type: "shadow_close", id: "obi-XRPUSDT", reason: i % 2 === 0 ? "target" : "stop", pnlPct: i % 2 === 0 ? 0.03 : -0.01 });
    }
    const summary = summarizeShadowJournal(entries);
    expect(summary["obi-XRPUSDT"].fires).toBe(20);
    expect(summary["obi-XRPUSDT"].verdict).toBe("SURVIVES");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/paper-trading/shadow-signal-tracker.test.ts -t "summarizeShadowJournal"`
Expected: FAIL — `summarizeShadowJournal is not a function`.

- [ ] **Step 3: Implement**

Add to `src/paper-trading/shadow-signal-tracker.ts`, after the `ShadowSignalTracker` class:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/paper-trading/shadow-signal-tracker.test.ts -t "summarizeShadowJournal"`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the report script**

Create `scripts/obi-shadow-report.ts`:

```ts
// Reads .trading-agent/shadow-trades.jsonl and reports fire count / win rate
// / profit factor / total PnL% per candidate. Prints only — never flips a
// candidate's shadow flag in autonomous-trading-daemon.ts. That's a manual,
// reviewed edit once a candidate's verdict reads SURVIVES.
import { readFileSync, existsSync } from "fs";
import { summarizeShadowJournal } from "../src/paper-trading/shadow-signal-tracker.js";

const JOURNAL_FILE = process.argv[2] ?? ".trading-agent/shadow-trades.jsonl";

function main() {
  if (!existsSync(JOURNAL_FILE)) {
    console.error(`No journal at ${JOURNAL_FILE} yet — the daemon hasn't run with shadow tracking on.`);
    process.exit(1);
  }
  const lines = readFileSync(JOURNAL_FILE, "utf-8").split("\n").filter(Boolean);
  const entries = lines.map(l => JSON.parse(l));
  const summary = summarizeShadowJournal(entries);

  console.log("OBI shadow-signal report\n");
  for (const [id, s] of Object.entries(summary)) {
    console.log(`${id}: ${s.fires} fires, ${s.wins}W/${s.losses}L (${(s.winRate * 100).toFixed(0)}%), PF=${s.pf.toFixed(2)}, totalPnL=${(s.totalPnlPct * 100).toFixed(2)}% — ${s.verdict}`);
  }
  if (Object.keys(summary).length === 0) console.log("No closed shadow trades yet.");
}

main();
```

- [ ] **Step 6: Manual smoke test**

Run: `npx tsx scripts/obi-shadow-report.ts` (against whatever `.trading-agent/shadow-trades.jsonl` Task 3's smoke test produced, or a missing file).
Expected: either the "no journal yet" message, or per-id summary lines with no thrown error either way.

- [ ] **Step 7: Run the full paper-trading test suite to confirm no regressions**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/paper-trading/`
Expected: PASS (all tests).

- [ ] **Step 8: Commit**

```bash
git add src/paper-trading/shadow-signal-tracker.ts scripts/obi-shadow-report.ts tests/paper-trading/shadow-signal-tracker.test.ts
git commit -m "feat: add shadow-journal summarizer + OBI shadow report script"
```

---

## After this plan

The daemon needs to actually run for ~3 weeks accumulating shadow fires before `scripts/obi-shadow-report.ts` says anything meaningful — that's operational follow-up, not a task here. Reviewing the report after that window and manually flipping any `SURVIVES` candidate's `shadow: false` in `scripts/autonomous-trading-daemon.ts` is a follow-up action.

Sub-project 3 (liquidation-cluster shadow-signal) reuses `ShadowSignalTracker` and `CandidateSignal` from this plan's Task 2 directly — its `checkFire` wraps the existing `BinanceLiquidationsTool`'s buffered liquidation feed instead of `fetchOrderBookImbalance`. Sub-projects 4 (funding-rate-arbitrage) and 5 (stat-arb pairs) remain separate specs/plans.
