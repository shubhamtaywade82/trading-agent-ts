# Stat-Arb Pairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a from-scratch pairs-trading engine (z-score of log-price-ratio spread, dollar-neutral legs), a real backtest-gated promotion sweep across the 3-pair universe, a live paper tracker, and daemon wiring that starts inert until a pair actually clears the gate.

**Architecture:** `src/backtest/pairs-engine.ts` is the pure simulation core (mirrors `src/backtest/engine.ts`'s role), consumed by a sweep script (`scripts/pairs-arb-sweep.ts`, same backtest-then-promote discipline as sub-project 1) and, independently, by `PairsArbTracker` (`src/paper-trading/pairs-arb.ts`, a new module — the position shape doesn't fit `ShadowSignalTracker` or `FundingArbTracker`). Two existing private helpers (`tfToMs` in `live-runner.ts`) get exported for reuse rather than reimplemented.

**Tech Stack:** TypeScript (Node16 ESM), Jest (pure-function tests for the engine/math; dependency-injected deterministic tests for `PairsArbTracker`, same pattern as sub-project 4's `FundingArbTracker`), `tsx` for the sweep/report scripts.

## Global Constraints

- Real backtest, real split-sample gate (first-half/second-half both net-positive, ≥15 trades) before any pair is considered for live tracking — same discipline as sub-project 1, not the shadow-gate pattern of #2/#3.
- Daemon wiring ships with an **empty** candidate list — no pair goes live against paper capital without a human reviewing the sweep output first.
- Dollar-neutral position sizing ($2000 per leg, independent), not share-neutral.
- Correlation pre-filter (|r| < 0.7 skips a pair) is a lazy substitute for real cointegration testing — documented as such, not passed off as more rigorous than it is.

---

### Task 1: Pair data-prep primitives

**Files:**
- Create: `src/backtest/pairs-engine.ts`
- Test: `tests/backtest/pairs-engine.test.ts`

**Interfaces:**
- Produces: `alignPairCandles(candlesA: Candle[], candlesB: Candle[]): { a: Candle[]; b: Candle[] }`
- Produces: `pearsonCorrelation(a: number[], b: number[]): number`
- Produces: `computeZScoreSeries(closesA: number[], closesB: number[], lookback: number): number[]`

- [ ] **Step 1: Write the failing tests**

Create `tests/backtest/pairs-engine.test.ts`:

```ts
import { alignPairCandles, pearsonCorrelation, computeZScoreSeries } from "../../src/backtest/pairs-engine.js";
import { Candle } from "../../src/backtest/types.js";

function candle(openTime: number, close: number): Candle {
  return { openTime, open: close, high: close, low: close, close, volume: 1 };
}

describe("alignPairCandles", () => {
  it("keeps only openTimes present in both series", () => {
    const a = [candle(1, 10), candle(2, 11), candle(3, 12), candle(4, 13)];
    const b = [candle(2, 20), candle(3, 21), candle(4, 22), candle(5, 23)];
    const { a: alignedA, b: alignedB } = alignPairCandles(a, b);
    expect(alignedA.map(c => c.openTime)).toEqual([2, 3, 4]);
    expect(alignedB.map(c => c.openTime)).toEqual([2, 3, 4]);
  });
});

describe("pearsonCorrelation", () => {
  it("is exactly 1 for a perfectly positively linear relationship", () => {
    expect(pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBeCloseTo(1);
  });

  it("is exactly -1 for a perfectly negatively linear relationship", () => {
    expect(pearsonCorrelation([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBeCloseTo(-1);
  });
});

describe("computeZScoreSeries", () => {
  it("returns NaN before the lookback window is filled", () => {
    const closesA = [100, 101, 99, 100, 101];
    const closesB = [100, 100, 100, 100, 100];
    const z = computeZScoreSeries(closesA, closesB, 4);
    expect(Number.isNaN(z[0])).toBe(true);
    expect(Number.isNaN(z[3])).toBe(true);
  });

  it("returns NaN when the trailing window has zero variance", () => {
    const closesA = [100, 100, 100, 100, 100];
    const closesB = [100, 100, 100, 100, 100];
    const z = computeZScoreSeries(closesA, closesB, 3);
    expect(Number.isNaN(z[4])).toBe(true);
  });

  it("produces a large positive z-score when the spread jumps far above recent history", () => {
    const closesA = [100, 102, 98, 101, 99, 150];
    const closesB = [100, 100, 100, 100, 100, 100];
    const z = computeZScoreSeries(closesA, closesB, 4);
    expect(z[5]).toBeGreaterThan(2);
  });

  it("produces a large negative z-score when the spread drops far below recent history", () => {
    const closesA = [100, 102, 98, 101, 99, 60];
    const closesB = [100, 100, 100, 100, 100, 100];
    const z = computeZScoreSeries(closesA, closesB, 4);
    expect(z[5]).toBeLessThan(-2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/backtest/pairs-engine.test.ts`
Expected: FAIL — module `../../src/backtest/pairs-engine.js` doesn't exist.

- [ ] **Step 3: Implement**

Create `src/backtest/pairs-engine.ts`:

```ts
import { Candle } from "./types.js";

export function alignPairCandles(candlesA: Candle[], candlesB: Candle[]): { a: Candle[]; b: Candle[] } {
  const timesB = new Set(candlesB.map(c => c.openTime));
  const a = candlesA.filter(c => timesB.has(c.openTime));
  const timesA = new Set(a.map(c => c.openTime));
  const b = candlesB.filter(c => timesA.has(c.openTime));
  return { a, b };
}

export function pearsonCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const meanA = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const meanB = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    cov += da * db; varA += da * da; varB += db * db;
  }
  const denom = Math.sqrt(varA * varB);
  return denom === 0 ? 0 : cov / denom;
}

// z[i] compares spread[i] to the mean/std of the TRAILING `lookback` bars
// BEFORE i (not including i) — a live poll asks "is right now unusual
// relative to recent history", which excluding the current bar answers
// honestly (including it would let a huge move partly cancel itself out of
// its own reference window).
export function computeZScoreSeries(closesA: number[], closesB: number[], lookback: number): number[] {
  const n = Math.min(closesA.length, closesB.length);
  const spread = Array.from({ length: n }, (_, i) => Math.log(closesA[i]) - Math.log(closesB[i]));
  const z = new Array(n).fill(NaN);
  for (let i = lookback; i < n; i++) {
    const window = spread.slice(i - lookback, i);
    const mean = window.reduce((s, v) => s + v, 0) / lookback;
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / lookback;
    const std = Math.sqrt(variance);
    z[i] = std === 0 ? NaN : (spread[i] - mean) / std;
  }
  return z;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/backtest/pairs-engine.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backtest/pairs-engine.ts tests/backtest/pairs-engine.test.ts
git commit -m "feat: add pair alignment, correlation, and rolling z-score primitives"
```

---

### Task 2: `runPairsBacktest`

**Files:**
- Modify: `src/backtest/pairs-engine.ts`
- Test: `tests/backtest/pairs-engine.test.ts`

**Interfaces:**
- Consumes: `alignPairCandles`, `computeZScoreSeries` (Task 1)
- Produces: `PairsBacktestConfig`, `PairsTrade`, `PairsBacktestMetrics`, `runPairsBacktest(candlesA: Candle[], candlesB: Candle[], config: PairsBacktestConfig): { trades: PairsTrade[]; metrics: PairsBacktestMetrics }`

- [ ] **Step 1: Write the failing test**

Add to `tests/backtest/pairs-engine.test.ts` (add `runPairsBacktest` to the import line):

```ts
describe("runPairsBacktest", () => {
  function candlesFrom(closes: number[]): Candle[] {
    return closes.map((c, i) => candle(i, c));
  }

  const BASE_CONFIG = {
    lookback: 4, entryZ: 2, exitZ: 0.5, stopZ: 3.5, maxHoldBars: 20,
    notionalPerLeg: 2000, feeBps: 5, slippageBps: 3, initialCapital: 10000,
  };

  it("opens a short_a_long_b trade when A spikes far above B, and closes it on reversion", () => {
    // Flat, slightly noisy history to build a real variance reference, then a
    // spike in A (fires entry) which reverts back toward B a few bars later
    // (fires exit).
    const closesA = [100, 102, 98, 101, 99, 150, 140, 120, 105, 100, 100];
    const closesB = new Array(closesA.length).fill(100);
    const result = runPairsBacktest(candlesFrom(closesA), candlesFrom(closesB), BASE_CONFIG);
    expect(result.trades.length).toBeGreaterThan(0);
    const first = result.trades[0];
    expect(first.direction).toBe("short_a_long_b");
    expect(Number.isFinite(first.pnlUsd)).toBe(true);
  });

  it("opens a long_a_short_b trade when A drops far below B, and closes it on reversion", () => {
    const closesA = [100, 102, 98, 101, 99, 60, 70, 85, 95, 100, 100];
    const closesB = new Array(closesA.length).fill(100);
    const result = runPairsBacktest(candlesFrom(closesA), candlesFrom(closesB), BASE_CONFIG);
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades[0].direction).toBe("long_a_short_b");
  });

  it("computes metrics with the expected field names", () => {
    const closesA = [100, 102, 98, 101, 99, 150, 140, 120, 105, 100, 100];
    const closesB = new Array(closesA.length).fill(100);
    const result = runPairsBacktest(candlesFrom(closesA), candlesFrom(closesB), BASE_CONFIG);
    expect(result.metrics).toEqual(expect.objectContaining({
      totalTrades: expect.any(Number), winRate: expect.any(Number), profitFactor: expect.any(Number),
      sharpeRatio: expect.any(Number), totalPnlUsd: expect.any(Number), maxDrawdownPct: expect.any(Number),
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/backtest/pairs-engine.test.ts -t "runPairsBacktest"`
Expected: FAIL — `runPairsBacktest is not a function`.

- [ ] **Step 3: Implement**

Add to `src/backtest/pairs-engine.ts`:

```ts
export interface PairsBacktestConfig {
  lookback: number; entryZ: number; exitZ: number; stopZ: number; maxHoldBars: number;
  notionalPerLeg: number; feeBps: number; slippageBps: number; initialCapital: number;
}

export interface PairsTrade {
  entryBarIdx: number; exitBarIdx: number;
  direction: "short_a_long_b" | "long_a_short_b";
  entryZ: number; exitZ: number;
  pnlUsd: number;
  exitReason: "target" | "stop" | "timeout";
}

export interface PairsBacktestMetrics {
  totalTrades: number; winRate: number; profitFactor: number; sharpeRatio: number;
  totalPnlUsd: number; maxDrawdownPct: number;
}

export function runPairsBacktest(
  candlesA: Candle[], candlesB: Candle[], config: PairsBacktestConfig,
): { trades: PairsTrade[]; metrics: PairsBacktestMetrics } {
  const { a, b } = alignPairCandles(candlesA, candlesB);
  const closesA = a.map(c => c.close);
  const closesB = b.map(c => c.close);
  const z = computeZScoreSeries(closesA, closesB, config.lookback);
  const feeFrac = config.feeBps / 10000;
  const slipFrac = config.slippageBps / 10000;

  const trades: PairsTrade[] = [];
  let pos: {
    direction: "short_a_long_b" | "long_a_short_b"; entryBarIdx: number; entryZ: number;
    qtyA: number; qtyB: number; fillA: number; fillB: number;
  } | null = null;

  for (let i = 0; i < closesA.length; i++) {
    const zi = z[i];
    if (Number.isNaN(zi)) continue;

    if (pos) {
      const barsHeld = i - pos.entryBarIdx;
      const hitExit = Math.abs(zi) < config.exitZ;
      const hitStop = Math.abs(zi) > config.stopZ;
      const timedOut = barsHeld >= config.maxHoldBars;
      if (hitExit || hitStop || timedOut) {
        const short = pos.direction === "short_a_long_b";
        const fillAExit = short ? closesA[i] * (1 + slipFrac) : closesA[i] * (1 - slipFrac);
        const fillBExit = short ? closesB[i] * (1 - slipFrac) : closesB[i] * (1 + slipFrac);
        const legAPnl = short ? pos.qtyA * (pos.fillA - fillAExit) : pos.qtyA * (fillAExit - pos.fillA);
        const legBPnl = short ? pos.qtyB * (fillBExit - pos.fillB) : pos.qtyB * (pos.fillB - fillBExit);
        const fees = 2 * config.notionalPerLeg * feeFrac; // feeBps already round-trip, x2 legs
        const pnlUsd = legAPnl + legBPnl - fees;
        trades.push({
          entryBarIdx: pos.entryBarIdx, exitBarIdx: i, direction: pos.direction,
          entryZ: pos.entryZ, exitZ: zi, pnlUsd,
          exitReason: hitStop ? "stop" : hitExit ? "target" : "timeout",
        });
        pos = null;
      }
      continue;
    }

    if (Math.abs(zi) > config.entryZ) {
      const direction: "short_a_long_b" | "long_a_short_b" = zi > 0 ? "short_a_long_b" : "long_a_short_b";
      const short = direction === "short_a_long_b";
      const qtyA = config.notionalPerLeg / closesA[i];
      const qtyB = config.notionalPerLeg / closesB[i];
      const fillA = short ? closesA[i] * (1 - slipFrac) : closesA[i] * (1 + slipFrac);
      const fillB = short ? closesB[i] * (1 + slipFrac) : closesB[i] * (1 - slipFrac);
      pos = { direction, entryBarIdx: i, entryZ: zi, qtyA, qtyB, fillA, fillB };
    }
  }

  const wins = trades.filter(t => t.pnlUsd > 0);
  const losses = trades.filter(t => t.pnlUsd <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0));
  const totalPnlUsd = grossProfit - grossLoss;

  let equity = config.initialCapital, peak = equity, maxDrawdownPct = 0;
  const returns: number[] = [];
  for (const t of trades) {
    equity += t.pnlUsd;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak);
    returns.push(t.pnlUsd / (2 * config.notionalPerLeg));
  }
  const meanReturn = returns.length ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const variance = returns.length ? returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / returns.length : 0;
  const stdReturn = Math.sqrt(variance);

  return {
    trades,
    metrics: {
      totalTrades: trades.length,
      winRate: trades.length ? wins.length / trades.length : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
      sharpeRatio: stdReturn > 0 ? meanReturn / stdReturn : 0,
      totalPnlUsd,
      maxDrawdownPct,
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/backtest/pairs-engine.test.ts`
Expected: PASS (9 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/backtest/pairs-engine.ts tests/backtest/pairs-engine.test.ts
git commit -m "feat: add runPairsBacktest dollar-neutral pairs simulation"
```

---

### Task 3: Export `tfToMs` + add `fetchRecentCloses`

**Files:**
- Modify: `src/paper-trading/live-runner.ts` (visibility only)
- Modify: `src/tools/binance-tools.ts` (add `fetchRecentCloses`)
- Test: `tests/tools/binance-tools.test.ts`

**Interfaces:**
- Produces: `export function tfToMs(tf: string): number` (visibility change only, no behavior change)
- Produces: `fetchRecentCloses(symbol: string, tf: string, barsNeeded: number): Promise<{ closes: number[] } | { error: string; message: string }>`

- [ ] **Step 1: Change `tfToMs` visibility**

In `src/paper-trading/live-runner.ts`, change:

```ts
function tfToMs(tf: string): number {
```

to:

```ts
export function tfToMs(tf: string): number {
```

- [ ] **Step 2: Write the failing test for `fetchRecentCloses`**

Add `fetchRecentCloses` to the import line in `tests/tools/binance-tools.test.ts`, then add:

```ts
describe("fetchRecentCloses", () => {
  const originalFetch = global.fetch;
  afterEach(() => { (globalThis as any).fetch = originalFetch; });

  it("fetches candles and returns the last N closes", async () => {
    // The mock simulates the real API's server-side `limit` truncation
    // (Binance returns at most `limit` most-recent klines) — a static
    // mockResolvedValue would ignore the requested limit entirely and make
    // this assertion pass or fail for the wrong reason.
    const allCloses = Array.from({ length: 20 }, (_, i) => 100 + i);
    (globalThis as any).fetch = jest.fn().mockImplementation((url: URL) => {
      const limit = Number(url.searchParams.get("limit"));
      return Promise.resolve({ ok: true, status: 200, json: async () => fakeKlines(allCloses.slice(-limit)) });
    });
    const result = await fetchRecentCloses("BTCUSDT", "1h", 5);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.closes).toHaveLength(5);
      expect(result.closes[result.closes.length - 1]).toBe(119); // last close of the 20-point series
    }
  });

  it("propagates a fetch error", async () => {
    (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error("network down"));
    const result = await fetchRecentCloses("BTCUSDT", "1h", 5);
    expect(result).toEqual({ error: "RequestError", message: "network down" });
  });
});
```

(`fakeKlines` already exists at the top of this test file.)

- [ ] **Step 3: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/tools/binance-tools.test.ts -t "fetchRecentCloses"`
Expected: FAIL — `fetchRecentCloses is not a function`.

- [ ] **Step 4: Implement**

Add to `src/tools/binance-tools.ts`, directly after `fetchSpotPrice` (Task 1 of sub-project 4):

```ts
export async function fetchRecentCloses(symbol: string, tf: string, barsNeeded: number): Promise<{ closes: number[] } | { error: string; message: string }> {
  const result = await fetchBinance("spot", KLINES_PATH.spot, { symbol, interval: tf, limit: barsNeeded });
  if (result.error) return result as { error: string; message: string };
  const rows = result.body as unknown[][];
  return { closes: rows.map(row => Number(row[4])) };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/tools/binance-tools.test.ts -t "fetchRecentCloses"`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full binance-tools file and live-runner tests to confirm no regressions**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/tools/binance-tools.test.ts tests/paper-trading/live-runner-reload.test.ts tests/paper-trading/live-runner-oi.test.ts`
Expected: PASS (all tests).

- [ ] **Step 7: Commit**

```bash
git add src/paper-trading/live-runner.ts src/tools/binance-tools.ts tests/tools/binance-tools.test.ts
git commit -m "feat: add fetchRecentCloses helper, export tfToMs for reuse"
```

---

### Task 4: Promotion sweep script

**Files:**
- Create: `scripts/pairs-arb-sweep.ts`

**Interfaces:**
- Consumes: `fetchCandlesRange` (existing, `backtest-tools.ts`), `pearsonCorrelation`, `runPairsBacktest` (Tasks 1-2)
- Produces: `scripts/pairs-arb-sweep-output.json` (data artifact, not code)

No unit test — this is a real-network research script, same category as `scripts/oi-divergence-sweep.ts` from sub-project 1.

- [ ] **Step 1: Write the script**

```ts
// scripts/pairs-arb-sweep.ts
// Promotion gate for the stat-arb pairs engine: for each of the 3 possible
// pairs among XRPUSDT/ETHUSDT/SOLUSDT, apply a correlation pre-filter, then
// backtest z-score mean-reversion over the pair's full available history
// with a split-sample check (first half / second half of the window,
// independently net-positive) and a >=15 trade minimum — same discipline as
// scripts/oi-divergence-sweep.ts. Writes scripts/pairs-arb-sweep-output.json.
// Never writes anywhere that would make a pair go live automatically —
// promoting a SURVIVES pair into the daemon's candidate list is a manual,
// reviewed edit (see docs/superpowers/specs/2026-07-21-stat-arb-pairs-design.md).
import { writeFileSync } from "fs";
import { fetchCandlesRange } from "../src/tools/backtest-tools.js";
import { pearsonCorrelation, runPairsBacktest } from "../src/backtest/pairs-engine.js";

const SYMBOLS = ["XRPUSDT", "ETHUSDT", "SOLUSDT"];
const PAIRS: [string, string][] = [];
for (let i = 0; i < SYMBOLS.length; i++) for (let j = i + 1; j < SYMBOLS.length; j++) PAIRS.push([SYMBOLS[i], SYMBOLS[j]]);

const TF = "1h";
const LOOKBACK_DAYS = 365;
const MIN_CORRELATION = 0.7;
const MIN_TRADES = 15;
const CONFIG = { lookback: 30, entryZ: 2, exitZ: 0.5, stopZ: 3.5, maxHoldBars: 96, notionalPerLeg: 2000, feeBps: 5, slippageBps: 3, initialCapital: 10000 };

interface Result {
  pairA: string; pairB: string; correlation: number;
  trades: number; winRate: number; pf: number; sharpe: number; pnlUsd: number;
  h1: { trades: number; pnlUsd: number }; h2: { trades: number; pnlUsd: number };
  verdict: "SURVIVES" | "REGIME_FRAGILE" | "LOW_CORRELATION" | "TOO_FEW_TRADES";
}

async function main() {
  const endTime = Date.now();
  const startTime = endTime - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const results: Result[] = [];

  for (const [symA, symB] of PAIRS) {
    const [candlesAResult, candlesBResult] = await Promise.all([
      fetchCandlesRange(symA, TF, startTime, endTime),
      fetchCandlesRange(symB, TF, startTime, endTime),
    ]);
    if ("error" in candlesAResult) { console.error(`${symA}: ${candlesAResult.message}`); continue; }
    if ("error" in candlesBResult) { console.error(`${symB}: ${candlesBResult.message}`); continue; }
    const candlesA = candlesAResult.candles, candlesB = candlesBResult.candles;

    const n = Math.min(candlesA.length, candlesB.length);
    const correlation = pearsonCorrelation(candlesA.slice(0, n).map(c => c.close), candlesB.slice(0, n).map(c => c.close));
    if (Math.abs(correlation) < MIN_CORRELATION) {
      results.push({ pairA: symA, pairB: symB, correlation, trades: 0, winRate: 0, pf: 0, sharpe: 0, pnlUsd: 0, h1: { trades: 0, pnlUsd: 0 }, h2: { trades: 0, pnlUsd: 0 }, verdict: "LOW_CORRELATION" });
      console.log(`${symA}/${symB}: correlation ${correlation.toFixed(2)} below ${MIN_CORRELATION}, skipped`);
      continue;
    }

    const full = runPairsBacktest(candlesA, candlesB, CONFIG);
    if (full.metrics.totalTrades < MIN_TRADES) {
      results.push({ pairA: symA, pairB: symB, correlation, trades: full.metrics.totalTrades, winRate: 0, pf: 0, sharpe: 0, pnlUsd: 0, h1: { trades: 0, pnlUsd: 0 }, h2: { trades: 0, pnlUsd: 0 }, verdict: "TOO_FEW_TRADES" });
      console.log(`${symA}/${symB}: only ${full.metrics.totalTrades} trades (<${MIN_TRADES}), skipped`);
      continue;
    }

    const mid = Math.floor(n / 2);
    const h1 = runPairsBacktest(candlesA.slice(0, mid), candlesB.slice(0, mid), CONFIG);
    const h2 = runPairsBacktest(candlesA.slice(mid), candlesB.slice(mid), CONFIG);
    const bothHalvesPositive = h1.metrics.totalPnlUsd > 0 && h2.metrics.totalPnlUsd > 0;

    const result: Result = {
      pairA: symA, pairB: symB, correlation,
      trades: full.metrics.totalTrades, winRate: full.metrics.winRate, pf: full.metrics.profitFactor,
      sharpe: full.metrics.sharpeRatio, pnlUsd: full.metrics.totalPnlUsd,
      h1: { trades: h1.metrics.totalTrades, pnlUsd: h1.metrics.totalPnlUsd },
      h2: { trades: h2.metrics.totalTrades, pnlUsd: h2.metrics.totalPnlUsd },
      verdict: full.metrics.totalPnlUsd > 0 && bothHalvesPositive ? "SURVIVES" : "REGIME_FRAGILE",
    };
    results.push(result);
    console.log(`${symA}/${symB}: correlation=${correlation.toFixed(2)}, ${result.trades} trades, PF=${result.pf.toFixed(2)}, Sharpe=${result.sharpe.toFixed(2)}, PnL=$${result.pnlUsd.toFixed(0)} — ${result.verdict}`);
  }

  const survivors = results.filter(r => r.verdict === "SURVIVES");
  console.log(`\n${survivors.length} SURVIVES out of ${PAIRS.length} pairs tested.`);
  writeFileSync("scripts/pairs-arb-sweep-output.json", JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log("Wrote scripts/pairs-arb-sweep-output.json. Review SURVIVES entries and manually add any worth keeping to the daemon's pairs-arb candidate list, per docs/superpowers/specs/2026-07-21-stat-arb-pairs-design.md's promotion gate.");
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it**

Run: `npx tsx scripts/pairs-arb-sweep.ts`
Expected: prints per-pair correlation/backtest results and a SURVIVES count;
`scripts/pairs-arb-sweep-output.json` is written. Zero survivors is a valid, honest
outcome — do not lower `MIN_TRADES`, `MIN_CORRELATION`, or the split-sample requirement to
manufacture a result.

- [ ] **Step 3: Commit**

```bash
git add scripts/pairs-arb-sweep.ts
git commit -m "chore: add stat-arb pairs promotion sweep script"
```

---

### Task 5: `PairsArbTracker` core

**Files:**
- Create: `src/paper-trading/pairs-arb.ts`
- Test: `tests/paper-trading/pairs-arb.test.ts`

**Interfaces:**
- Consumes: `fetchRecentCloses` (Task 3), `computeZScoreSeries` (Task 1)
- Produces: `PairsArbCandidate`, `PairsArbConfig`, `PairsArbDeps`, `PairsArbTracker`

- [ ] **Step 1: Write the failing tests**

Create `tests/paper-trading/pairs-arb.test.ts`:

```ts
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { PairsArbTracker, PairsArbCandidate, PairsArbDeps } from "../../src/paper-trading/pairs-arb.js";

describe("PairsArbTracker", () => {
  let dir: string;
  let stateFile: string;
  let journalFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pairs-arb-"));
    stateFile = join(dir, "state.json");
    journalFile = join(dir, "trades.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const CANDIDATE: PairsArbCandidate = { id: "XRPUSDT-ETHUSDT", symbolA: "XRPUSDT", symbolB: "ETHUSDT", tf: "1h", lookback: 4, entryZ: 2, exitZ: 0.5, stopZ: 3.5, maxHoldBars: 20 };

  function deps(overrides: Partial<PairsArbDeps> = {}): PairsArbDeps {
    // History that produces a strong positive z-score on the latest bar (A spiked vs B).
    return {
      fetchRecentCloses: async (symbol: string) =>
        symbol === "XRPUSDT"
          ? { closes: [100, 102, 98, 101, 99, 150] }
          : { closes: [100, 100, 100, 100, 100, 100] },
      ...overrides,
    };
  }

  it("opens a position when the latest z-score exceeds entryZ", async () => {
    const tracker = new PairsArbTracker([CANDIDATE], { stateFile, journalFile }, deps());
    const result = await tracker.tick();
    expect(result.opened).toEqual(["XRPUSDT-ETHUSDT"]);
    const journal = await readFile(journalFile, "utf-8");
    expect(journal).toContain('"type":"pairs_arb_open"');
    expect(journal).toContain('"direction":"short_a_long_b"');
  });

  it("does not open when correlation-adjacent history is too short to compute a z-score", async () => {
    const tracker = new PairsArbTracker([CANDIDATE], { stateFile, journalFile }, deps({
      fetchRecentCloses: async () => ({ closes: [100, 101] }), // shorter than lookback
    }));
    const result = await tracker.tick();
    expect(result.opened).toEqual([]);
  });

  it("does not open a second position while one is already open for a pair", async () => {
    const tracker = new PairsArbTracker([CANDIDATE], { stateFile, journalFile }, deps());
    await tracker.tick();
    const result = await tracker.tick();
    expect(result.opened).toEqual([]);
  });

  it("closes on max hold and journals a finite realized PnL", async () => {
    const shortHold = { ...CANDIDATE, maxHoldBars: 0 };
    const tracker = new PairsArbTracker([shortHold], { stateFile, journalFile }, deps());
    await tracker.tick();
    const result = await tracker.tick();
    expect(result.closed).toEqual(["XRPUSDT-ETHUSDT"]);
    const journal = await readFile(journalFile, "utf-8");
    expect(journal).toContain('"type":"pairs_arb_close"');
    expect(journal).toContain('"reason":"timeout"');
  });

  it("persists open positions across a new tracker instance pointed at the same state file", async () => {
    const first = new PairsArbTracker([CANDIDATE], { stateFile, journalFile }, deps());
    await first.tick();
    const second = new PairsArbTracker([CANDIDATE], { stateFile, journalFile }, deps());
    await second.tick();
    const journal = await readFile(journalFile, "utf-8");
    const opens = journal.split("\n").filter(l => l.includes('"type":"pairs_arb_open"'));
    expect(opens).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/paper-trading/pairs-arb.test.ts`
Expected: FAIL — module `../../src/paper-trading/pairs-arb.js` doesn't exist.

- [ ] **Step 3: Implement**

Create `src/paper-trading/pairs-arb.ts`:

```ts
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
```

Note: `entryBarCount` increments once per live poll tick rather than per candle bar
(unlike the backtest, which walks bar-by-bar) — the live tracker's notion of "how long has
this been held" is wall-clock polls, not historical bars, since it isn't replaying a fixed
candle series. This is a deliberate difference from `runPairsBacktest`'s bar-indexed hold
tracking, not an inconsistency — `maxHoldBars` on a live candidate should be read as
"max poll cycles held," which approximates the backtest's bar-based timeout closely enough
when the poll interval matches the candidate's `tf`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/paper-trading/pairs-arb.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/paper-trading/pairs-arb.ts tests/paper-trading/pairs-arb.test.ts
git commit -m "feat: add PairsArbTracker with dollar-neutral live position tracking"
```

---

### Task 6: Daemon wiring (inert by default)

**Files:**
- Modify: `scripts/autonomous-trading-daemon.ts`

**Interfaces:**
- Consumes: `PairsArbTracker`, `PairsArbCandidate` (Task 5)

No unit test — same reasoning as every prior daemon-wiring task in this plan.

- [ ] **Step 1: Import and instantiate with an empty candidate list**

Add to the imports:

```ts
import { PairsArbTracker, PairsArbCandidate } from "../src/paper-trading/pairs-arb.js";
```

After `const fundingArbTracker = new FundingArbTracker(SHADOW_SYMBOLS);`:

```ts
// Empty until scripts/pairs-arb-sweep.ts finds a SURVIVES pair — unlike OBI/
// liq-cluster (which had no backtest option), stat-arb CAN be backtested, so
// it gets the same discipline as OI-divergence: no pair runs against paper
// capital without evidence behind it first. To activate a validated pair,
// add an entry here, e.g.:
//   { id: "XRPUSDT-ETHUSDT", symbolA: "XRPUSDT", symbolB: "ETHUSDT", tf: "1h",
//     lookback: 30, entryZ: 2, exitZ: 0.5, stopZ: 3.5, maxHoldBars: 96 }
const pairsArbCandidates: PairsArbCandidate[] = [];
const pairsArbTracker = new PairsArbTracker(pairsArbCandidates);
```

- [ ] **Step 2: Start it and add it to shutdown**

After the `fundingArbTracker.start(...)` block:

```ts
pairsArbTracker.start(pollSeconds * 1000, (r) => {
  for (const id of r.opened) console.log(`📈 PAIRS ARB opened: ${id}`);
  for (const id of r.closed) console.log(`📈 PAIRS ARB closed: ${id}`);
}).catch(e => console.error("Pairs arb loop crashed (trading unaffected):", e));
```

In `shutdown()`, add `pairsArbTracker.stop();` alongside `fundingArbTracker.stop();`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no new errors.

- [ ] **Step 4: Manual smoke test**

Run: `npx tsx scripts/autonomous-trading-daemon.ts --poll-seconds=15` for ~30s, then `Ctrl+C`.
Expected: no new errors, no `📈 PAIRS ARB` lines (candidate list is empty by design), clean
shutdown. This confirms the wiring doesn't break anything while genuinely inert — the pass
condition is silence, not activity.

- [ ] **Step 5: Commit**

```bash
git add scripts/autonomous-trading-daemon.ts
git commit -m "feat: wire PairsArbTracker into the daemon, inert until a pair is promoted"
```

---

### Task 7: Report script

**Files:**
- Create: `scripts/pairs-arb-report.ts`
- Modify: `src/paper-trading/pairs-arb.ts` (add `summarizePairsArbJournal`)
- Test: `tests/paper-trading/pairs-arb.test.ts`

**Interfaces:**
- Produces: `summarizePairsArbJournal(entries: { type: string; id: string; reason?: string; pnlUsd?: number }[]): Record<string, { closedCount: number; totalPnlUsd: number; winRate: number }>`

- [ ] **Step 1: Write the failing test**

Add to `tests/paper-trading/pairs-arb.test.ts` (add `summarizePairsArbJournal` to the import):

```ts
describe("summarizePairsArbJournal", () => {
  it("aggregates closed positions per pair id", () => {
    const entries = [
      { type: "pairs_arb_open", id: "XRPUSDT-ETHUSDT" },
      { type: "pairs_arb_close", id: "XRPUSDT-ETHUSDT", reason: "target", pnlUsd: 40 },
      { type: "pairs_arb_open", id: "XRPUSDT-ETHUSDT" },
      { type: "pairs_arb_close", id: "XRPUSDT-ETHUSDT", reason: "stop", pnlUsd: -20 },
    ];
    const summary = summarizePairsArbJournal(entries);
    expect(summary["XRPUSDT-ETHUSDT"]).toEqual({ closedCount: 2, totalPnlUsd: 20, winRate: 0.5 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/paper-trading/pairs-arb.test.ts -t "summarizePairsArbJournal"`
Expected: FAIL — `summarizePairsArbJournal is not a function`.

- [ ] **Step 3: Implement**

Add to `src/paper-trading/pairs-arb.ts`, after the `PairsArbTracker` class:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/paper-trading/pairs-arb.test.ts -t "summarizePairsArbJournal"`
Expected: PASS.

- [ ] **Step 5: Write the report script**

Create `scripts/pairs-arb-report.ts`:

```ts
// Reads .trading-agent/pairs-arb-trades.jsonl and reports closed-position
// count / total PnL / win rate per pair. Informational only — same as
// funding-arb-report.ts, no strategies.json-style promotion gate here either
// (promotion happens via scripts/pairs-arb-sweep.ts before a pair ever goes
// live, not after).
import { readFileSync, existsSync } from "fs";
import { summarizePairsArbJournal } from "../src/paper-trading/pairs-arb.js";

const JOURNAL_FILE = ".trading-agent/pairs-arb-trades.jsonl";

function main() {
  if (!existsSync(JOURNAL_FILE)) {
    console.log("No journal yet — no pairs-arb candidate has been promoted into the daemon's active list.");
    return;
  }
  const lines = readFileSync(JOURNAL_FILE, "utf-8").split("\n").filter(Boolean);
  const entries = lines.map(l => JSON.parse(l));
  const summary = summarizePairsArbJournal(entries);
  console.log("Pairs-arb report\n");
  for (const [id, s] of Object.entries(summary)) {
    console.log(`${id}: ${s.closedCount} closed, totalPnL=$${s.totalPnlUsd.toFixed(2)}, winRate=${(s.winRate * 100).toFixed(0)}%`);
  }
  if (Object.keys(summary).length === 0) console.log("No closed positions yet.");
}

main();
```

- [ ] **Step 6: Manual smoke test**

Run: `npx tsx scripts/pairs-arb-report.ts`
Expected: "No journal yet" message (the daemon's candidate list is empty per Task 6, so no
journal exists) — no thrown error.

- [ ] **Step 7: Run the full paper-trading and backtest test suites to confirm no regressions**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/paper-trading/ tests/backtest/`
Expected: PASS (all tests).

- [ ] **Step 8: Commit**

```bash
git add src/paper-trading/pairs-arb.ts scripts/pairs-arb-report.ts tests/paper-trading/pairs-arb.test.ts
git commit -m "feat: add pairs-arb journal summarizer + report script"
```

---

## After this plan

Run `scripts/pairs-arb-sweep.ts` for real and review `scripts/pairs-arb-sweep-output.json`.
If any pair reads `SURVIVES`, manually add it to `pairsArbCandidates` in
`scripts/autonomous-trading-daemon.ts` (Task 6) — that's the one-line change that turns the
already-built, already-tested tracker on for that pair. This is the last sub-project in the
5-part plan that started with the OI-divergence spec; there is no sub-project 6.
