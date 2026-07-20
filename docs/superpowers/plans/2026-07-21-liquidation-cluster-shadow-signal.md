# Liquidation-Cluster Shadow-Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a liquidation-cluster contrarian signal that folds into the *same* `ShadowSignalTracker` instance, state file, and journal the daemon already runs for OBI (sub-project 2) — no second tracker, no second report script.

**Architecture:** `detectLiquidationCluster` is a new pure, synchronous helper in `binance-stream.ts` (co-located with the liquidation buffer it reads) that counts same-side liquidations for a symbol within a trailing window and returns the contrarian direction past a threshold. The daemon subscribes to the liquidation stream once at startup and appends 3 more `CandidateSignal` entries to the array already feeding `shadowTracker`. `scripts/obi-shadow-report.ts` is renamed to `scripts/shadow-signal-report.ts` since its logic was already generic per candidate id.

**Tech Stack:** TypeScript (Node16 ESM), Jest (this task's new logic is pure/synchronous — no real-network test needed, unlike sub-project 2's tracker tests), `tsx` for the daemon/report scripts.

## Global Constraints

- `BinanceStreamManager`'s liquidation buffer stays a 200-event global cap shared across all symbols — this plan does not change it (would affect `BinanceLiquidationsTool`, out of scope).
- No second `ShadowSignalTracker` instance, no second state/journal file — liquidation-cluster candidates share sub-project 2's.
- Same promotion gate as sub-project 2: ≥20 fires, net-positive, 3-week minimum, manual review before flipping `shadow: false`.

---

### Task 1: `detectLiquidationCluster`

**Files:**
- Modify: `src/exchange/binance-stream.ts` (add helper near `getLiquidations`, ~line 256)
- Test: `tests/exchange/binance-stream.test.ts`

**Interfaces:**
- Produces: `detectLiquidationCluster(stream: Pick<BinanceStreamManager, "getLiquidations">, symbol: string, windowMs: number, threshold: number, now?: number): "long" | "short" | null`
- Consumes: `Liquidation` (existing interface, `src/exchange/binance-stream.ts:43-49`)

The `Pick<BinanceStreamManager, "getLiquidations">` parameter type (rather than the full
class) is deliberate: this function's only dependency is that one method, so tests can pass
a plain object literal implementing just `getLiquidations()` instead of standing up a real
WebSocket connection — unlike `ShadowSignalTracker`'s own tests (sub-project 2), which
legitimately need a real stream for live-tick pricing. The optional `now` parameter (default
`Date.now()`) exists for the same reason: deterministic window-boundary tests without
faking the system clock.

- [ ] **Step 1: Write the failing tests**

Add to `tests/exchange/binance-stream.test.ts` (add `detectLiquidationCluster` and `Liquidation` to the top-level import from `../../src/exchange/binance-stream.js`):

```ts
describe("detectLiquidationCluster", () => {
  function fakeStream(liquidations: Liquidation[]): Pick<BinanceStreamManager, "getLiquidations"> {
    return { getLiquidations: (symbol?: string) => symbol ? liquidations.filter(l => l.symbol === symbol) : liquidations };
  }

  it("fires long when >= threshold SELL-side liquidations happened within the window", () => {
    const now = 1_700_000_000_000;
    const liqs: Liquidation[] = Array.from({ length: 5 }, (_, i) => ({
      symbol: "XRPUSDT", side: "SELL", price: 1, quantity: 100, time: now - i * 1000,
    }));
    const result = detectLiquidationCluster(fakeStream(liqs), "XRPUSDT", 5 * 60 * 1000, 5, now);
    expect(result).toBe("long");
  });

  it("fires short when >= threshold BUY-side liquidations happened within the window", () => {
    const now = 1_700_000_000_000;
    const liqs: Liquidation[] = Array.from({ length: 5 }, (_, i) => ({
      symbol: "XRPUSDT", side: "BUY", price: 1, quantity: 100, time: now - i * 1000,
    }));
    const result = detectLiquidationCluster(fakeStream(liqs), "XRPUSDT", 5 * 60 * 1000, 5, now);
    expect(result).toBe("short");
  });

  it("does not fire below the threshold", () => {
    const now = 1_700_000_000_000;
    const liqs: Liquidation[] = Array.from({ length: 4 }, (_, i) => ({
      symbol: "XRPUSDT", side: "SELL", price: 1, quantity: 100, time: now - i * 1000,
    }));
    const result = detectLiquidationCluster(fakeStream(liqs), "XRPUSDT", 5 * 60 * 1000, 5, now);
    expect(result).toBeNull();
  });

  it("ignores liquidations outside the trailing window", () => {
    const now = 1_700_000_000_000;
    const liqs: Liquidation[] = Array.from({ length: 5 }, (_, i) => ({
      symbol: "XRPUSDT", side: "SELL", price: 1, quantity: 100, time: now - (6 * 60 * 1000) - i * 1000, // all 6+ min old
    }));
    const result = detectLiquidationCluster(fakeStream(liqs), "XRPUSDT", 5 * 60 * 1000, 5, now);
    expect(result).toBeNull();
  });

  it("ignores liquidations for other symbols", () => {
    const now = 1_700_000_000_000;
    const liqs: Liquidation[] = Array.from({ length: 5 }, (_, i) => ({
      symbol: "ETHUSDT", side: "SELL", price: 1, quantity: 100, time: now - i * 1000,
    }));
    const result = detectLiquidationCluster(fakeStream(liqs), "XRPUSDT", 5 * 60 * 1000, 5, now);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/exchange/binance-stream.test.ts -t "detectLiquidationCluster"`
Expected: FAIL — `detectLiquidationCluster is not a function`.

- [ ] **Step 3: Implement**

Add to `src/exchange/binance-stream.ts`, directly after `getLiquidations` (after its closing `}`, ~line 259):

```ts
export function detectLiquidationCluster(
  stream: Pick<BinanceStreamManager, "getLiquidations">,
  symbol: string, windowMs: number, threshold: number, now: number = Date.now(),
): "long" | "short" | null {
  const recent = stream.getLiquidations(symbol).filter(l => now - l.time <= windowMs);
  const sells = recent.filter(l => l.side === "SELL").length;
  const buys = recent.filter(l => l.side === "BUY").length;
  if (sells >= threshold) return "long";
  if (buys >= threshold) return "short";
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/exchange/binance-stream.test.ts -t "detectLiquidationCluster"`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full file to confirm no regressions**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/exchange/binance-stream.test.ts`
Expected: PASS (all tests, including the pre-existing real-network ones).

- [ ] **Step 6: Commit**

```bash
git add src/exchange/binance-stream.ts tests/exchange/binance-stream.test.ts
git commit -m "feat: add detectLiquidationCluster helper"
```

---

### Task 2: Daemon wiring

**Files:**
- Modify: `scripts/autonomous-trading-daemon.ts`

**Interfaces:**
- Consumes: `detectLiquidationCluster` (Task 1), `CandidateSignal`, `ShadowSignalTracker` (sub-project 2, already imported)

No unit test — same reasoning as sub-project 2's Task 3 (this repo doesn't unit-test its daemon entry point; manual smoke test is the established practice here).

- [ ] **Step 1: Import the new helper**

In `scripts/autonomous-trading-daemon.ts`, change the existing `binance-stream.js` import (currently `import { BinanceStreamManager } from "../src/exchange/binance-stream.js";`, ~line 21):

```ts
import { BinanceStreamManager, detectLiquidationCluster } from "../src/exchange/binance-stream.js";
```

- [ ] **Step 2: Rename `obiCandidates` to `shadowCandidates` and append liquidation-cluster entries**

Replace the block at `scripts/autonomous-trading-daemon.ts:51-67` (`const OBI_SYMBOLS = ...` through `const shadowTracker = ...`):

```ts
const SHADOW_SYMBOLS = ["XRPUSDT", "ETHUSDT", "SOLUSDT"];
const obiCandidates: CandidateSignal[] = SHADOW_SYMBOLS.map(symbol => ({
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
const liqClusterCandidates: CandidateSignal[] = SHADOW_SYMBOLS.map(symbol => ({
  id: `liq-cluster-${symbol}`,
  symbol,
  shadow: true,
  stopPct: 0.02,
  targetPct: 0.04,
  maxHoldMs: 4 * 60 * 60 * 1000,
  checkFire: async () => detectLiquidationCluster(stream, symbol, 5 * 60 * 1000, 5),
}));
const shadowCandidates: CandidateSignal[] = [...obiCandidates, ...liqClusterCandidates];
const shadowTracker = new ShadowSignalTracker(shadowCandidates, stream);
```

(`OBI_SYMBOLS` renamed to `SHADOW_SYMBOLS` since it now seeds both candidate families with
the same 3 symbols — same list, more accurate name.)

- [ ] **Step 3: Subscribe to the liquidation stream at startup**

After the existing ticker-subscribe block (`scripts/autonomous-trading-daemon.ts:117-118`, `await Promise.all(runner.getSymbols().map(sym => stream.subscribe(sym))) ...`), add:

```ts
await stream.subscribeLiquidations().catch(e => console.error("Liquidation stream subscribe failed (liq-cluster shadow signal will never fire):", e));
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no new errors in `scripts/autonomous-trading-daemon.ts`.

- [ ] **Step 5: Manual smoke test**

Run: `npx tsx scripts/autonomous-trading-daemon.ts --poll-seconds=15` for ~60s, then `Ctrl+C`.
Expected: startup banner unchanged, no new errors; `.trading-agent/shadow-state.json` now
has 6 keys (3 `obi-*`, 3 `liq-cluster-*`) instead of 3. A `🔍 SHADOW fired: liq-cluster-*`
line is not guaranteed in a 60s window (5 same-side liquidations in 5 minutes on one symbol
is a real but not constant event) — absence is fine, presence of the 6-key state file is
the actual pass condition.

- [ ] **Step 6: Commit**

```bash
git add scripts/autonomous-trading-daemon.ts
git commit -m "feat: fold liquidation-cluster candidates into the shared shadow tracker"
```

---

### Task 3: Rename the report script

**Files:**
- Rename: `scripts/obi-shadow-report.ts` → `scripts/shadow-signal-report.ts`

No test — this is a rename plus a comment update, `summarizeShadowJournal` (sub-project 2)
is unchanged and already generic per candidate id.

- [ ] **Step 1: Rename and update the header comment**

```bash
git mv scripts/obi-shadow-report.ts scripts/shadow-signal-report.ts
```

Then update the header comment (the file's first 4 lines) from:

```ts
// Reads .trading-agent/shadow-trades.jsonl and reports fire count / win rate
// / profit factor / total PnL% per candidate. Prints only — never flips a
// candidate's shadow flag in autonomous-trading-daemon.ts. That's a manual,
// reviewed edit once a candidate's verdict reads SURVIVES.
```

to:

```ts
// Reads .trading-agent/shadow-trades.jsonl and reports fire count / win rate
// / profit factor / total PnL% per candidate — covers every shadow signal
// family sharing this journal (OBI, liquidation-cluster, ...), not just OBI;
// summarizeShadowJournal (shadow-signal-tracker.ts) is generic per candidate
// id. Prints only — never flips a candidate's shadow flag in
// autonomous-trading-daemon.ts. That's a manual, reviewed edit once a
// candidate's verdict reads SURVIVES.
```

Also update the console header inside `main()` from `"OBI shadow-signal report\n"` to `"Shadow-signal report\n"`.

- [ ] **Step 2: Manual smoke test**

Run: `npx tsx scripts/shadow-signal-report.ts`
Expected: same output shape as before the rename (reads the same journal path by default), now under the new filename.

- [ ] **Step 3: Commit**

```bash
git add scripts/shadow-signal-report.ts
git commit -m "chore: rename obi-shadow-report.ts to shadow-signal-report.ts (now covers liq-cluster too)"
```

---

## After this plan

Same as sub-project 2: the daemon needs to run for the 3-week window accumulating fires
before `scripts/shadow-signal-report.ts` says anything meaningful. Reviewing the report and
manually flipping any `SURVIVES` candidate's `shadow: false` is a follow-up action, not a
task here.

Sub-projects 4 (funding-rate-arbitrage) and 5 (stat-arb pairs) remain separate specs/plans —
neither reuses `ShadowSignalTracker` (funding-rate-arbitrage needs its own carry-PnL ledger;
stat-arb needs a cross-symbol spread engine), so they start fresh from their own specs.
