# OI-Divergence Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new open-interest-divergence entry-condition types (`oi_bearish_divergence`, `oi_bullish_divergence`) to the shared signal evaluator, wire them through backtesting and live paper trading, and produce a sweep script that finds (but does not auto-promote) candidate `strategies.json` entries.

**Architecture:** Pure-function data layer (`fetchOpenInterestHist` + `alignOiToCandles`) feeds an optional third parameter on the existing `buildSignalEvaluator`. The single-strategy futures-backtest tool and the live paper-trading runner both thread this through the same evaluator call they already make — no new engine, no duplicate signal logic (this repo has been burned three times by duplicate signal implementations drifting from the source of truth; see `strategies.json`'s `_verification.history`).

**Tech Stack:** TypeScript (Node16 ESM, `.js`-suffixed imports), Jest (`ts-jest`, ESM preset) for tests, `tsx` for standalone scripts.

## Global Constraints

- Binance `/futures/data/openInterestHist` retains ~30 days only — every OI backtest window is capped at whatever data is actually returned, not a fixed lookback.
- Do not reimplement `buildSignalEvaluator`'s switch anywhere else — every condition-evaluation path must call the shared function (existing repo rule, see `src/tools/backtest-tools.ts:610-614`).
- Never have a script auto-write `strategies.json` — existing repo convention (see `scripts/full-reverify.ts` header comment); promotion is a reviewed, manual edit.
- New conditions must be no-ops (`return false`) when `extraSeries.oi` is absent, so every existing call site that doesn't pass a third argument is unaffected.

---

### Task 1: Open-interest data fetch + alignment

**Files:**
- Modify: `src/tools/backtest-tools.ts` (add near `fetchCandlesRange`, ~line 330)
- Test: `tests/tools/backtest-tools.test.ts` (add new `describe` block)

**Interfaces:**
- Produces: `fetchOpenInterestHist(symbol: string, period: string, startTime: number, endTime: number): Promise<{ points: { timestamp: number; sumOpenInterest: number }[] } | { error: string; message: string }>`
- Produces: `alignOiToCandles(candles: Candle[], points: { timestamp: number; sumOpenInterest: number }[]): number[]` — same length as `candles`, `NaN` where no OI sample exists yet.

- [ ] **Step 1: Write the failing tests**

Add to `tests/tools/backtest-tools.test.ts` (new imports at top: `fetchOpenInterestHist, alignOiToCandles` added to the existing `import { ... } from "../../src/tools/backtest-tools.js"` line, and add `Candle` to the existing `StrategyConfig` import line from `../../src/backtest/types.js`):

```ts
describe("fetchOpenInterestHist", () => {
  const originalFetch = global.fetch;
  afterEach(() => { (globalThis as any).fetch = originalFetch; });

  it("fetches and maps openInterestHist rows", async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => [
        { symbol: "BTCUSDT", sumOpenInterest: "1000.5", sumOpenInterestValue: "1", timestamp: 1700000000000 },
        { symbol: "BTCUSDT", sumOpenInterest: "1050.0", sumOpenInterestValue: "1", timestamp: 1700003600000 },
      ],
    });
    const result = await fetchOpenInterestHist("BTCUSDT", "1h", 1700000000000, 1700003600000);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.points).toEqual([
        { timestamp: 1700000000000, sumOpenInterest: 1000.5 },
        { timestamp: 1700003600000, sumOpenInterest: 1050.0 },
      ]);
    }
  });

  it("propagates a fetch error", async () => {
    (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error("network down"));
    const result = await fetchOpenInterestHist("BTCUSDT", "1h", 0, 1);
    expect(result).toEqual({ error: "RequestError", message: "network down" });
  });

  it("rejects an unsupported period", async () => {
    const result = await fetchOpenInterestHist("BTCUSDT", "3m", 0, 1);
    expect(result).toEqual({ error: "InvalidPeriod", message: "period must be one of: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d" });
  });
});

describe("alignOiToCandles", () => {
  it("carries forward the last OI sample at or before each candle's openTime", () => {
    const candles: Candle[] = [
      { openTime: 1000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { openTime: 2000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { openTime: 3000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ];
    const points = [
      { timestamp: 1500, sumOpenInterest: 100 },
      { timestamp: 2500, sumOpenInterest: 200 },
    ];
    expect(alignOiToCandles(candles, points)).toEqual([NaN, 100, 200]);
  });

  it("returns an empty array for empty candles", () => {
    expect(alignOiToCandles([], [{ timestamp: 1, sumOpenInterest: 1 }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/tools/backtest-tools.test.ts -t "fetchOpenInterestHist|alignOiToCandles"`
Expected: FAIL — `fetchOpenInterestHist is not a function` / `alignOiToCandles is not a function`.

- [ ] **Step 3: Implement**

Add to `src/tools/backtest-tools.ts` directly after `fetchCandlesRange` (after its closing `}` around line 330):

```ts
const OI_PERIODS = ["5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"];

export async function fetchOpenInterestHist(
  symbol: string, period: string, startTime: number, endTime: number,
): Promise<{ points: { timestamp: number; sumOpenInterest: number }[] } | { error: string; message: string }> {
  if (!OI_PERIODS.includes(period)) {
    return { error: "InvalidPeriod", message: `period must be one of: ${OI_PERIODS.join(", ")}` };
  }
  const all: { timestamp: number; sumOpenInterest: number }[] = [];
  let from = startTime;
  try {
    while (from < endTime) {
      const url = new URL("/futures/data/openInterestHist", "https://fapi.binance.com");
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("period", period);
      url.searchParams.set("limit", "500");
      url.searchParams.set("startTime", String(from));
      url.searchParams.set("endTime", String(endTime));
      const response = await fetchWithRetry(url);
      const body = await response.json();
      if (!response.ok) return { error: "BinanceApiError", message: JSON.stringify(body) };
      const rows = body as { sumOpenInterest: string; timestamp: number }[];
      if (rows.length === 0) break;
      for (const r of rows) all.push({ timestamp: r.timestamp, sumOpenInterest: Number(r.sumOpenInterest) });
      from = rows[rows.length - 1].timestamp + 1;
      if (rows.length < 500) break;
      await new Promise(r => setTimeout(r, 250));
    }
    return { points: all };
  } catch (e) {
    return { error: "RequestError", message: (e as Error).message };
  }
}

export function alignOiToCandles(candles: Candle[], points: { timestamp: number; sumOpenInterest: number }[]): number[] {
  const result: number[] = new Array(candles.length).fill(NaN);
  let p = 0;
  for (let i = 0; i < candles.length; i++) {
    while (p < points.length - 1 && points[p + 1].timestamp <= candles[i].openTime) p++;
    if (points[p] && points[p].timestamp <= candles[i].openTime) result[i] = points[p].sumOpenInterest;
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/tools/backtest-tools.test.ts -t "fetchOpenInterestHist|alignOiToCandles"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/backtest-tools.ts tests/tools/backtest-tools.test.ts
git commit -m "feat: add open-interest history fetch + candle alignment"
```

---

### Task 2: New condition types in `buildSignalEvaluator`

**Files:**
- Modify: `src/tools/backtest-tools.ts` (`CONDITION_SCHEMA` ~line 9-34, `buildSignalEvaluator` ~line 615-765)
- Test: `tests/tools/backtest-tools.test.ts`

**Interfaces:**
- Consumes: nothing new (uses `Candle[]` and the condition array types already in the file).
- Produces: `buildSignalEvaluator(candles, entryConditions, extraSeries?: { oi?: number[] })` — third param optional, existing two-arg call sites unaffected.

- [ ] **Step 1: Write the failing tests**

Add `buildSignalEvaluator` to the existing import line, then add:

```ts
describe("buildSignalEvaluator: OI divergence", () => {
  function candlesWithCloses(closes: number[]): Candle[] {
    return closes.map((c, i) => ({ openTime: 1000 + i * 3600000, open: c, high: c, low: c, close: c, volume: 1 }));
  }

  it("fires oi_bearish_divergence when price makes a new high but OI fell", () => {
    const closes = [...Array(10).fill(100), 105]; // bar 10 is a new high over the prior 10
    const candles = candlesWithCloses(closes);
    const oi = [...Array(10).fill(1000), 900]; // -10% vs bar 0
    const evaluator = buildSignalEvaluator(candles, [{ type: "oi_bearish_divergence", period: 10, value: 0.05 }], { oi });
    expect(evaluator(10)).toBe(true);
  });

  it("does not fire oi_bearish_divergence when OI rose", () => {
    const closes = [...Array(10).fill(100), 105];
    const candles = candlesWithCloses(closes);
    const oi = [...Array(10).fill(1000), 1100];
    const evaluator = buildSignalEvaluator(candles, [{ type: "oi_bearish_divergence", period: 10, value: 0.05 }], { oi });
    expect(evaluator(10)).toBe(false);
  });

  it("fires oi_bullish_divergence when price makes a new low and OI fell", () => {
    const closes = [...Array(10).fill(100), 95];
    const candles = candlesWithCloses(closes);
    const oi = [...Array(10).fill(1000), 900];
    const evaluator = buildSignalEvaluator(candles, [{ type: "oi_bullish_divergence", period: 10, value: 0.05 }], { oi });
    expect(evaluator(10)).toBe(true);
  });

  it("is a no-op when extraSeries is not supplied", () => {
    const closes = [...Array(10).fill(100), 105];
    const candles = candlesWithCloses(closes);
    const evaluator = buildSignalEvaluator(candles, [{ type: "oi_bearish_divergence" }]);
    expect(evaluator(10)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/tools/backtest-tools.test.ts -t "OI divergence"`
Expected: FAIL — condition type not recognized, `evaluator(10)` returns `false` for the "should fire" cases (the `default: return false` branch catches unknown types).

- [ ] **Step 3: Implement**

In `CONDITION_SCHEMA`'s `type` enum (`src/tools/backtest-tools.ts` ~line 27), add after `"ob_retest_long", "ob_retest_short",`:

```ts
        "oi_bearish_divergence", "oi_bullish_divergence",
```

Change `buildSignalEvaluator`'s signature (~line 615):

```ts
export function buildSignalEvaluator(
  candles: Candle[],
  entryConditions: { type: string; period?: number; value?: number }[],
  extraSeries?: { oi?: number[] },
): (i: number) => boolean {
```

Add two cases to the returned switch (~line 761, right before `default: return false;`):

```ts
        case "oi_bearish_divergence": {
          const oi = extraSeries?.oi;
          const period = c.period ?? 10;
          if (!oi || i < period) return false;
          const oiNow = oi[i], oiPast = oi[i - period];
          if (Number.isNaN(oiNow) || Number.isNaN(oiPast) || oiPast === 0) return false;
          const oiChange = (oiNow - oiPast) / oiPast;
          const priorHigh = Math.max(...closes.slice(i - period, i));
          return closes[i] > priorHigh && oiChange < -(c.value ?? 0.03);
        }
        case "oi_bullish_divergence": {
          const oi = extraSeries?.oi;
          const period = c.period ?? 10;
          if (!oi || i < period) return false;
          const oiNow = oi[i], oiPast = oi[i - period];
          if (Number.isNaN(oiNow) || Number.isNaN(oiPast) || oiPast === 0) return false;
          const oiChange = (oiNow - oiPast) / oiPast;
          const priorLow = Math.min(...closes.slice(i - period, i));
          return closes[i] < priorLow && oiChange < -(c.value ?? 0.03);
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/tools/backtest-tools.test.ts -t "OI divergence"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/backtest-tools.ts tests/tools/backtest-tools.test.ts
git commit -m "feat: add oi_bearish_divergence / oi_bullish_divergence conditions"
```

---

### Task 3: Wire OI into `BinanceFuturesBacktestTool`

**Files:**
- Modify: `src/tools/backtest-tools.ts` (`BinanceFuturesBacktestTool.call`, ~line 365-394)
- Test: `tests/tools/backtest-tools.test.ts`

**Interfaces:**
- Consumes: `fetchOpenInterestHist`, `alignOiToCandles` (Task 1), `buildSignalEvaluator` with `extraSeries` (Task 2).
- Produces: no new export — `BinanceFuturesBacktestTool` is already exported and already tested indirectly; this task changes its behavior for `oi_*` entries only.

- [ ] **Step 1: Write the failing test**

Add `BinanceFuturesBacktestTool` to the existing import line in `tests/tools/backtest-tools.test.ts`, then:

```ts
describe("BinanceFuturesBacktestTool: OI conditions", () => {
  const originalFetch = global.fetch;
  afterEach(() => { (globalThis as any).fetch = originalFetch; });

  it("fetches and aligns OI history when entry includes an oi_* condition", async () => {
    (globalThis as any).fetch = jest.fn().mockImplementation((url: URL) => {
      const href = url.toString();
      if (href.includes("/futures/data/openInterestHist")) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => RISING.map((_, i) => ({
            symbol: "BTCUSDT", sumOpenInterest: String(1000 - i), sumOpenInterestValue: "1",
            timestamp: 1700000000000 + i * 3600000,
          })),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => fakeKlines(RISING) });
    });
    const tool = new BinanceFuturesBacktestTool();
    const result = await tool.call({
      symbol: "BTCUSDT", interval: "1h", limit: 200, direction: "short",
      entry: [{ type: "oi_bearish_divergence", period: 10, value: 0.01 }],
      stopPct: 0.02, targetPct: 0.04,
    });
    expect(result.error).toBeUndefined();
    expect(typeof result.totalTrades).toBe("number");
  });

  it("propagates an OI fetch error instead of silently returning zero trades", async () => {
    (globalThis as any).fetch = jest.fn().mockImplementation((url: URL) => {
      const href = url.toString();
      if (href.includes("/futures/data/openInterestHist")) {
        return Promise.resolve({ ok: false, status: 400, json: async () => ({ msg: "bad symbol" }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => fakeKlines(RISING) });
    });
    const tool = new BinanceFuturesBacktestTool();
    const result = await tool.call({
      symbol: "BADSYM", interval: "1h", limit: 200, direction: "short",
      entry: [{ type: "oi_bearish_divergence" }], stopPct: 0.02, targetPct: 0.04,
    });
    expect(result.error).toBe("BinanceApiError");
  });
});
```

Note: `RISING` and `fakeKlines` already exist at the top of this test file (used by the `BinanceBacktestTool` block).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/tools/backtest-tools.test.ts -t "BinanceFuturesBacktestTool: OI"`
Expected: FAIL — the mock's `openInterestHist` branch is never hit (tool doesn't fetch it yet), and/or `result.totalTrades` is `undefined` because the metrics spread never ran an OI-aware evaluator (this passes vacuously before the wiring exists, which is itself the tell — the error-propagation test is the one that actually fails first, since today the tool never calls the OI endpoint at all, so `result.error` stays `undefined` instead of `"BinanceApiError"`).

- [ ] **Step 3: Implement**

In `BinanceFuturesBacktestTool.call` (`src/tools/backtest-tools.ts`), after the existing candle-fetch block and before the `runFuturesBacktest` call (~line 391):

```ts
    let evaluatorOrEntry: typeof entry | ((i: number) => boolean) = entry;
    if (entry.some(c => c.type.startsWith("oi_"))) {
      const oiStart = candles[0].openTime;
      const oiEnd = candles[candles.length - 1].openTime + 1;
      const oiResult = await fetchOpenInterestHist(symbol, interval, oiStart, oiEnd);
      if ("error" in oiResult) return oiResult;
      const oiSeries = alignOiToCandles(candles, oiResult.points);
      evaluatorOrEntry = buildSignalEvaluator(candles, entry, { oi: oiSeries });
    }

    const result = runFuturesBacktest(candles, evaluatorOrEntry, direction, stopPct, targetPct, feeBps, maxHoldBars, initialCapital, leverage, marginPerTradePct, slippageBps) as any;
```

(This replaces the existing single-line `const result = runFuturesBacktest(candles, entry, ...)` call — `entry` is swapped for `evaluatorOrEntry`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/tools/backtest-tools.test.ts -t "BinanceFuturesBacktestTool: OI"`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full test file to confirm no regressions**

Run: `npx jest tests/tools/backtest-tools.test.ts`
Expected: PASS (all prior tests still pass — `evaluatorOrEntry` defaults to `entry` unchanged for non-OI strategies).

- [ ] **Step 6: Commit**

```bash
git add src/tools/backtest-tools.ts tests/tools/backtest-tools.test.ts
git commit -m "feat: wire OI history fetch into BinanceFuturesBacktestTool for oi_* entries"
```

---

### Task 4: Wire OI into `LivePaperRunner`

**Files:**
- Modify: `src/paper-trading/live-runner.ts` (import line ~3, `processGroup` ~line 441-552)
- Test: `tests/paper-trading/live-runner-reload.test.ts` is reload-focused; add a new file instead.
- Test: `tests/paper-trading/live-runner-oi.test.ts` (new)

**Interfaces:**
- Consumes: `fetchOpenInterestHist`, `alignOiToCandles`, `buildSignalEvaluator(candles, entry, extraSeries?)` (Tasks 1-2).
- Produces: no new export — behavior-only change to `LivePaperRunner.tick()` for pools containing `oi_*` strategies.

- [ ] **Step 1: Write the failing test**

Create `tests/paper-trading/live-runner-oi.test.ts`:

```ts
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync } from "fs";
import { LivePaperRunner } from "../../src/paper-trading/live-runner.js";

function fakeKlines(closes: number[], startMs: number): unknown[][] {
  return closes.map((c, i) => {
    const t = startMs + i * 3600000;
    return [t, c, c * 1.001, c * 0.999, c, "100", t + 3599999, "0", 0, "0", "0", "0"];
  });
}

describe("LivePaperRunner: OI conditions", () => {
  let dir: string;
  let poolPath: string;
  const originalFetch = global.fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "live-runner-oi-"));
    poolPath = join(dir, "strategies.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    (globalThis as any).fetch = originalFetch;
  });

  it("fetches OI history and passes it to the evaluator when an active strategy uses oi_*", async () => {
    const start = Date.now() - 20 * 3600000;
    const closes = [...Array(10).fill(100), 105, 105, 105, 105, 105, 105, 105, 105, 105, 105];
    let sawOiCall = false;

    (globalThis as any).fetch = jest.fn().mockImplementation((url: URL) => {
      const href = url.toString();
      if (href.includes("/futures/data/openInterestHist")) {
        sawOiCall = true;
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => closes.map((_, i) => ({
            symbol: "XRPUSDT", sumOpenInterest: String(1000 - i * 10), sumOpenInterestValue: "1",
            timestamp: start + i * 3600000,
          })),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => fakeKlines(closes, start) });
    });

    writeFileSync(poolPath, JSON.stringify({
      symbols: {
        XRPUSDT: [{
          id: "oi-test", tf: "1h", direction: "short",
          entry: [{ type: "oi_bearish_divergence", period: 10, value: 0.01 }],
          risk: { stopPct: 0.02, targetPct: 0.04 }, maxHoldBars: 48,
        }],
      },
    }));

    const runner = new LivePaperRunner({
      stateFile: join(dir, "paper-state.json"),
      journalFile: join(dir, "paper-trades.jsonl"),
      aiMode: "no-ai",
      lookbackDaysByTf: { "1h": 1 },
    }, poolPath);

    await runner.tick();
    expect(sawOiCall).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/paper-trading/live-runner-oi.test.ts`
Expected: FAIL — `sawOiCall` stays `false` (the runner never requests `openInterestHist` today).

- [ ] **Step 3: Implement**

In `src/paper-trading/live-runner.ts`, update the import (~line 3):

```ts
import { fetchCandlesRange, buildSignalEvaluator, fetchOpenInterestHist, alignOiToCandles } from "../tools/backtest-tools.js";
```

In `processGroup` (~line 456, right after `const lastClosed = candles[candles.length - 1];` and before `let fills = 0;`):

```ts
    let oiSeries: number[] | undefined;
    if (strats.some(s => s.entry.some(c => c.type.startsWith("oi_")))) {
      const oiResult = await fetchOpenInterestHist(symbol, tf, startTime, endTime);
      if ("error" in oiResult) {
        this.journal({ type: "oi_fetch_error", symbol, tf, message: oiResult.message });
      } else {
        oiSeries = alignOiToCandles(candles, oiResult.points);
      }
    }
```

Then change the per-strategy evaluator build (~line 546-552) from:

```ts
        let evaluator: (i: number) => boolean;
        if (hasConceptsConditions) {
          const htfContext = needsHtf ? new ConceptsEngine(await this.getHtfCandles(symbol, tf)).toHTFContext() : undefined;
          evaluator = new ConceptsEngine(candles, htfContext ? { htfContext } : undefined).evaluator(strat.entry);
        } else {
          evaluator = buildSignalEvaluator(candles, strat.entry);
        }
```

to:

```ts
        let evaluator: (i: number) => boolean;
        if (hasConceptsConditions) {
          const htfContext = needsHtf ? new ConceptsEngine(await this.getHtfCandles(symbol, tf)).toHTFContext() : undefined;
          evaluator = new ConceptsEngine(candles, htfContext ? { htfContext } : undefined).evaluator(strat.entry);
        } else {
          evaluator = buildSignalEvaluator(candles, strat.entry, oiSeries ? { oi: oiSeries } : undefined);
        }
```

Note the deliberate difference from Task 3: on an OI fetch error, the backtest tool returns the error (a one-shot deliberate request should fail loudly); the live runner instead journals `oi_fetch_error` and lets `oi_*` conditions evaluate as `false` for that poll cycle (a transient data hiccup shouldn't halt the whole (symbol, tf) group's other strategies or crash the poll loop) — `buildSignalEvaluator`'s existing no-op-without-`extraSeries` behavior from Task 2 makes this free, no extra branching needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/paper-trading/live-runner-oi.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full paper-trading test suite to confirm no regressions**

Run: `npx jest tests/paper-trading/`
Expected: PASS (all existing tests, including `live-runner-reload.test.ts`, still pass — `oiSeries` is `undefined` for every pool with no `oi_*` strategies, matching prior behavior exactly).

- [ ] **Step 6: Commit**

```bash
git add src/paper-trading/live-runner.ts tests/paper-trading/live-runner-oi.test.ts
git commit -m "feat: wire OI history into LivePaperRunner for oi_* strategies"
```

---

### Task 5: Manual sanity-check script

**Files:**
- Create: `scripts/oi-divergence-verify.ts`

**Interfaces:**
- Consumes: `fetchOpenInterestHist`, `alignOiToCandles`, `fetchCandlesRange` (all already exported).
- Produces: nothing importable — this is a standalone script run by hand, matching this repo's existing `scripts/*.ts` convention (real-network eyeball checks, not part of the Jest suite).

- [ ] **Step 1: Write the script**

```ts
// scripts/oi-divergence-verify.ts
// Hand-run sanity check: fetch real candles + OI history for one symbol,
// print them side by side so the alignment and divergence math can be
// eyeballed against known values. Not a substitute for the Jest unit tests
// in tests/tools/backtest-tools.test.ts — this is the same "verify against
// real data by hand" step this repo's other scripts/*.ts files use.
import { fetchCandlesRange, fetchOpenInterestHist, alignOiToCandles, buildSignalEvaluator } from "../src/tools/backtest-tools.js";

const SYMBOL = process.argv[2] ?? "BTCUSDT";
const TF = process.argv[3] ?? "1h";

async function main() {
  const endTime = Date.now();
  const startTime = endTime - 25 * 24 * 60 * 60 * 1000; // 25d, safely inside the ~30d OI retention window

  const candlesResult = await fetchCandlesRange(SYMBOL, TF, startTime, endTime);
  if ("error" in candlesResult) throw new Error(`candles: ${candlesResult.message}`);
  const candles = candlesResult.candles;

  const oiResult = await fetchOpenInterestHist(SYMBOL, TF, startTime, endTime);
  if ("error" in oiResult) throw new Error(`oi: ${oiResult.message}`);

  const oiSeries = alignOiToCandles(candles, oiResult.points);
  const nonNan = oiSeries.filter(v => !Number.isNaN(v)).length;
  console.log(`${SYMBOL} ${TF}: ${candles.length} candles, ${oiResult.points.length} OI points, ${nonNan} aligned (non-NaN)`);

  console.log("\nLast 15 bars — close, OI:");
  for (let i = Math.max(0, candles.length - 15); i < candles.length; i++) {
    console.log(`  ${new Date(candles[i].openTime).toISOString()}  close=${candles[i].close}  oi=${oiSeries[i]}`);
  }

  const evalBear = buildSignalEvaluator(candles, [{ type: "oi_bearish_divergence", period: 10, value: 0.03 }], { oi: oiSeries });
  const evalBull = buildSignalEvaluator(candles, [{ type: "oi_bullish_divergence", period: 10, value: 0.03 }], { oi: oiSeries });
  let bearFires = 0, bullFires = 0;
  for (let i = 0; i < candles.length; i++) {
    if (evalBear(i)) bearFires++;
    if (evalBull(i)) bullFires++;
  }
  console.log(`\noi_bearish_divergence fired ${bearFires} times, oi_bullish_divergence fired ${bullFires} times over ${candles.length} bars.`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it**

Run: `npx tsx scripts/oi-divergence-verify.ts BTCUSDT 1h`
Expected: prints candle/OI counts, the last 15 bars' close+OI values (eyeball-check the OI numbers look like real open-interest magnitudes, not zeros or NaN throughout), and non-zero-ish fire counts for at least one of the two conditions. If `nonNan` is 0, the alignment logic or the OI endpoint response shape has a real problem — stop and investigate before Task 6.

- [ ] **Step 3: Commit**

```bash
git add scripts/oi-divergence-verify.ts
git commit -m "chore: add manual OI-divergence data sanity-check script"
```

---

### Task 6: Promotion sweep script

**Files:**
- Create: `scripts/oi-divergence-sweep.ts`

**Interfaces:**
- Consumes: `fetchCandlesRange`, `runFuturesBacktest`, `buildSignalEvaluator`, `fetchOpenInterestHist`, `alignOiToCandles` (all already exported).
- Produces: `scripts/oi-divergence-sweep-output.json` (data file, not code) — human reviews it and manually edits `strategies.json` for anything that clears the gate, per this repo's existing convention of scripts never auto-writing `strategies.json` (see `scripts/full-reverify.ts`'s header comment).

- [ ] **Step 1: Write the script**

```ts
// scripts/oi-divergence-sweep.ts
// Promotion gate for the new oi_bearish_divergence / oi_bullish_divergence
// conditions: runs each against the existing pool's symbols across a small
// stop/target grid, split-samples the ~30d OI window into two ~15d halves,
// and only flags a combo SURVIVES if the full window is net-positive, both
// halves are independently net-positive, and it clears >=8 trades (the
// proportionate equivalent of this repo's usual 15-trade bar, scaled down
// for a ~30d window instead of the usual 1-3yr one — see
// docs/superpowers/specs/2026-07-21-oi-divergence-signal-design.md).
// Writes results to scripts/oi-divergence-sweep-output.json. Never writes
// strategies.json — promoting a SURVIVES combo is a manual, reviewed edit.
import { writeFileSync } from "fs";
import { fetchCandlesRange, fetchOpenInterestHist, alignOiToCandles, buildSignalEvaluator, runFuturesBacktest } from "../src/tools/backtest-tools.js";

const SYMBOLS = ["XRPUSDT", "ETHUSDT", "SOLUSDT"];
const TIMEFRAMES = ["15m", "30m", "1h", "4h"];
const CONDITIONS: { type: string; direction: "long" | "short" }[] = [
  { type: "oi_bearish_divergence", direction: "short" },
  { type: "oi_bullish_divergence", direction: "long" },
];
const STOP_VALUES = [0.01, 0.02, 0.03];
const TARGET_VALUES = [0.02, 0.04, 0.06];
const MIN_TRADES = 8;
const LEVERAGE = 5, MARGIN_PCT = 0.05, SLIPPAGE_BPS = 3, FEE_BPS = 5, CAP = 10000, MAX_HOLD_BARS = 48;

interface Result {
  symbol: string; tf: string; conditionType: string; direction: string;
  stopPct: number; targetPct: number;
  trades: number; winRate: number; pf: number; sharpe: number; pnlUsd: number;
  h1: { trades: number; pnlUsd: number }; h2: { trades: number; pnlUsd: number };
  verdict: "SURVIVES" | "REGIME_FRAGILE" | "TOO_FEW_TRADES";
}

async function main() {
  const endTime = Date.now();
  const startTime = endTime - 25 * 24 * 60 * 60 * 1000; // stay inside ~30d OI retention
  const results: Result[] = [];

  for (const symbol of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      const candlesResult = await fetchCandlesRange(symbol, tf, startTime, endTime);
      if ("error" in candlesResult) { console.error(`${symbol} ${tf}: candles error — ${candlesResult.message}`); continue; }
      const candles = candlesResult.candles;
      if (candles.length < 30) { console.error(`${symbol} ${tf}: too few candles (${candles.length}), skipping`); continue; }

      const oiResult = await fetchOpenInterestHist(symbol, tf, startTime, endTime);
      if ("error" in oiResult) { console.error(`${symbol} ${tf}: OI error — ${oiResult.message}`); continue; }
      const oiSeries = alignOiToCandles(candles, oiResult.points);

      const mid = startTime + (endTime - startTime) / 2;
      const midIdx = candles.findIndex(c => c.openTime >= mid);
      const h1 = candles.slice(0, midIdx < 0 ? candles.length : midIdx);
      const h2 = candles.slice(midIdx < 0 ? candles.length : midIdx);
      const oi1 = oiSeries.slice(0, midIdx < 0 ? oiSeries.length : midIdx);
      const oi2 = oiSeries.slice(midIdx < 0 ? oiSeries.length : midIdx);

      for (const cond of CONDITIONS) {
        for (const sp of STOP_VALUES) {
          for (const tp of TARGET_VALUES) {
            const entry = [{ type: cond.type, period: 10, value: 0.03 }];
            const fullEval = buildSignalEvaluator(candles, entry, { oi: oiSeries });
            const full = runFuturesBacktest(candles, fullEval, cond.direction, sp, tp, FEE_BPS, MAX_HOLD_BARS, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS) as any;
            if (full.metrics.totalTrades < MIN_TRADES) continue;

            const h1Eval = buildSignalEvaluator(h1, entry, { oi: oi1 });
            const h2Eval = buildSignalEvaluator(h2, entry, { oi: oi2 });
            const r1 = runFuturesBacktest(h1, h1Eval, cond.direction, sp, tp, FEE_BPS, MAX_HOLD_BARS, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS) as any;
            const r2 = runFuturesBacktest(h2, h2Eval, cond.direction, sp, tp, FEE_BPS, MAX_HOLD_BARS, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS) as any;
            const bothHalvesPositive = r1.metrics.totalPnlUsd > 0 && r2.metrics.totalPnlUsd > 0;

            results.push({
              symbol, tf, conditionType: cond.type, direction: cond.direction,
              stopPct: sp, targetPct: tp,
              trades: full.metrics.totalTrades, winRate: full.metrics.winRate,
              pf: full.metrics.profitFactor, sharpe: full.metrics.sharpeRatio, pnlUsd: full.metrics.totalPnlUsd,
              h1: { trades: r1.metrics.totalTrades, pnlUsd: r1.metrics.totalPnlUsd },
              h2: { trades: r2.metrics.totalTrades, pnlUsd: r2.metrics.totalPnlUsd },
              verdict: full.metrics.totalPnlUsd > 0 && bothHalvesPositive ? "SURVIVES" : "REGIME_FRAGILE",
            });
          }
        }
      }
      console.log(`${symbol} ${tf}: swept, ${results.filter(r => r.symbol === symbol && r.tf === tf).length} combos with >=${MIN_TRADES} trades`);
    }
  }

  const survivors = results.filter(r => r.verdict === "SURVIVES");
  console.log(`\n${survivors.length} SURVIVES out of ${results.length} combos tested.`);
  for (const s of survivors) {
    console.log(`  ${s.symbol} ${s.tf} ${s.conditionType} stop=${s.stopPct} target=${s.targetPct}: ${s.trades} trades, PF=${s.pf.toFixed(2)}, Sharpe=${s.sharpe.toFixed(1)}, PnL=$${s.pnlUsd.toFixed(0)}`);
  }
  writeFileSync("scripts/oi-divergence-sweep-output.json", JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log("\nWrote scripts/oi-divergence-sweep-output.json. Review SURVIVES entries and manually add any worth keeping to strategies.json with a note flagging the ~25d sample window, per docs/superpowers/specs/2026-07-21-oi-divergence-signal-design.md's promotion gate.");
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it**

Run: `npx tsx scripts/oi-divergence-sweep.ts`
Expected: prints per-(symbol, tf) sweep progress, then a SURVIVES count and `scripts/oi-divergence-sweep-output.json` is written. Zero survivors is a valid, honest outcome — do not lower `MIN_TRADES` or the split-sample requirement to manufacture a result; if nothing survives, the signal doesn't get promoted this round, matching the promotion-gate decision in the spec.

- [ ] **Step 3: Commit**

```bash
git add scripts/oi-divergence-sweep.ts
git commit -m "chore: add OI-divergence promotion sweep script"
```

(Do not commit `scripts/oi-divergence-sweep-output.json` — it's a data artifact from a live-market run, not source; follow the existing repo pattern where some `*-output.json` files are committed as historical evidence (see `scripts/full-reverify-output.json`) — if you want this run's results preserved the same way, commit it as a separate, explicit step after reviewing the numbers, not automatically here.)

---

## After this plan

Reviewing `scripts/oi-divergence-sweep-output.json` and manually promoting any `SURVIVES` entries into `strategies.json` (with the thin-sample note) is a follow-up action, not a task in this plan — the result is data-dependent and unknown until Task 6 actually runs against live Binance data.

Sub-projects 2-5 (OBI shadow-signal, liquidation-cluster shadow-signal, funding-rate-arbitrage bolt-on, stat-arb pairs engine) are separate specs/plans, built in that order after this one lands.
