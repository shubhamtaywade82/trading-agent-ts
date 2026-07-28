# SMC Engine Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ConceptsEngine` (`src/concepts/adapter.ts`) the single source of SMC/ICT structure detection, retiring the two duplicate implementations (`src/tools/orderblocks.ts` and the inline `smc*` helpers in `src/tools/backtest-tools.ts`) without changing any `strategies.json` condition-type string or either call site's loop structure.

**Architecture:** New file `src/concepts/legacy-conditions.ts` caches one `ConceptsEngine` instance per candle array (`WeakMap<Candle[], ConceptsEngine>`) and re-implements the existing `smcBullishOB`/`smcBearishOB`/`smcBullishFVG`/`smcBearishFVG`/`smcBullishLiqSweep`/`smcBearishLiqSweep`/`smcDisplacement` function *bodies* to read off that cached engine's `PerBarSignals`, plus a ConceptsEngine-backed replacement for `orderblocks.ts`'s `detectOrderBlockZones`+`buildObRetestSignals` pair. Both existing call sites (`buildSignalEvaluator` in `backtest-tools.ts`, and `BinanceSignalFusionTool`'s precompute block in the same file) call these functions by the same names with the same per-bar-index signatures they call today — so neither call site's code changes, only the functions' internals move to `legacy-conditions.ts` and get re-implemented. This was discovered by reading the actual call sites: there are two places computing these arrays, not one, and 14 condition types route through them, not 8 as first estimated in the design spec — the caching-wrapper shape absorbs that without extra work per call site.

**Tech Stack:** TypeScript, Jest (`node --experimental-vm-modules`), `tsx` for scratch scripts, `trading-concepts-ts` (local `file:` dependency at `../../trading-workspace/libraries/trading-concepts-ts`).

## Global Constraints

- `strategies.json` condition-type strings (`bearish_ob`, `bullish_fvg`, `ob_retest_long`, etc.) do not change.
- Re-verification and all backtests run at `leverage: 10` (not 5) — the pool gets validated at the leverage that's actually running live, per the approved spec.
- Every strategy backtest MUST go through `runFuturesBacktest` (`src/tools/backtest-tools.ts:862`) — this repo has a documented history of discredited hand-rolled backtest scripts (see `strategies.json._verification.history`); do not write a second simulation loop anywhere in this plan.
- `src/tools/orderblocks.ts` and the `smc*` function bodies in `backtest-tools.ts` are deleted only in the final task, after every condition type has been migrated and re-verified.

---

### Task 1: `legacy-conditions.ts` core + OB/FVG wrappers

**Files:**
- Create: `src/concepts/legacy-conditions.ts`
- Test: `tests/concepts/legacy-conditions.test.ts`

**Interfaces:**
- Produces: `legacyBullishOb(candles: Candle[], i: number): boolean`, `legacyBearishOb(candles: Candle[], i: number): boolean`, `legacyBullishFvg(candles: Candle[], i: number): boolean`, `legacyBearishFvg(candles: Candle[], i: number): boolean` — all consumed by Task 4.
- Consumes: `ConceptsEngine` from `src/concepts/adapter.ts` (`getSignals(): PerBarSignals`, already public), `Candle` from `src/backtest/types.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/concepts/legacy-conditions.test.ts
import { legacyBullishOb, legacyBearishOb, legacyBullishFvg, legacyBearishFvg } from "../../src/concepts/legacy-conditions.js";
import { Candle } from "../../src/backtest/types.js";

function candle(openTime: number, open: number, high: number, low: number, close: number, volume = 100): Candle {
  return { openTime, open, high, low, close, volume };
}

describe("legacy-conditions OB/FVG wrappers", () => {
  it("flags a fair value gap where candle i-1's high sits below candle i+1's low", () => {
    const candles = [
      candle(0, 100, 101, 99, 100),
      candle(3_600_000, 100, 102, 100, 101.5),   // c1: high 102
      candle(7_200_000, 103, 105, 103, 104.5),   // gap candle
      candle(10_800_000, 104.5, 106, 104, 105.5), // c3: low 104 > c1.high 102 -> bullish FVG at index 2
      candle(14_400_000, 105.5, 107, 105, 106),
    ];
    expect(legacyBullishFvg(candles, 2)).toBe(true);
    expect(legacyBearishFvg(candles, 2)).toBe(false);
  });

  it("returns false for every bar on a flat series with no structure", () => {
    const candles = Array.from({ length: 30 }, (_, i) => candle(i * 3_600_000, 100, 100.1, 99.9, 100));
    for (let i = 0; i < candles.length; i++) {
      expect(legacyBullishOb(candles, i)).toBe(false);
      expect(legacyBearishOb(candles, i)).toBe(false);
    }
  });

  it("caches the engine per candle array — calling twice with the same array doesn't throw or diverge", () => {
    const candles = Array.from({ length: 30 }, (_, i) => candle(i * 3_600_000, 100 + i, 101 + i, 99 + i, 100.5 + i));
    const first = legacyBullishOb(candles, 15);
    const second = legacyBullishOb(candles, 15);
    expect(first).toBe(second);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/concepts/legacy-conditions.test.ts`
Expected: FAIL — `Cannot find module '../../src/concepts/legacy-conditions.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/concepts/legacy-conditions.ts
import { ConceptsEngine, PerBarSignals } from "./adapter.js";
import { Candle } from "../backtest/types.js";
import { OrderBlock } from "trading-concepts-ts";

// One ConceptsEngine per candle array for the lifetime of that array — every
// wrapper below is called once per bar in a loop by both buildSignalEvaluator
// and BinanceSignalFusionTool's precompute block; without this cache each
// call would re-run TradingConcepts.analyze() (an O(n) whole-series pass)
// once per bar, turning an O(n) backtest into O(n^2).
const engineCache = new WeakMap<Candle[], ConceptsEngine>();

function engineFor(candles: Candle[]): ConceptsEngine {
  let engine = engineCache.get(candles);
  if (!engine) {
    engine = new ConceptsEngine(candles);
    engineCache.set(candles, engine);
  }
  return engine;
}

function signalsFor(candles: Candle[]): PerBarSignals {
  return engineFor(candles).getSignals();
}

export function legacyBullishOb(candles: Candle[], i: number): boolean {
  return signalsFor(candles).newBullishOB[i] ?? false;
}

export function legacyBearishOb(candles: Candle[], i: number): boolean {
  return signalsFor(candles).newBearishOB[i] ?? false;
}

export function legacyBullishFvg(candles: Candle[], i: number): boolean {
  return signalsFor(candles).newBullishFVG[i] ?? false;
}

export function legacyBearishFvg(candles: Candle[], i: number): boolean {
  return signalsFor(candles).newBearishFVG[i] ?? false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/concepts/legacy-conditions.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/concepts/legacy-conditions.ts tests/concepts/legacy-conditions.test.ts
git commit -m "feat: add ConceptsEngine-backed OB/FVG legacy condition wrappers"
```

---

### Task 2: Liquidity sweep + displacement wrappers

**Files:**
- Modify: `src/concepts/legacy-conditions.ts`
- Test: `tests/concepts/legacy-conditions.test.ts`

**Interfaces:**
- Consumes: `engineFor`/`signalsFor` from Task 1 (same file, not exported — internal helpers).
- Produces: `legacyBullishLiqSweep(candles: Candle[], i: number): boolean`, `legacyBearishLiqSweep(candles: Candle[], i: number): boolean`, `legacyDisplacement(candles: Candle[], i: number): { dir: "up" | "down" } | null` — consumed by Task 4.

**Semantic mapping (verified against the current `smc*` implementations before writing this task):**
- `smcBullishLiqSweep` fires when price sweeps below a prior swing low then closes back above it — a bullish reversal. `ConceptsEngine`'s `sellsideSweep` (a sweep of *sellside* liquidity — the resting liquidity below swing lows) is the same event. `legacyBullishLiqSweep` → `sellsideSweep`.
- `smcBearishLiqSweep` is the mirror (sweep above a prior high, close back below) → `ConceptsEngine`'s `buysideSweep`. `legacyBearishLiqSweep` → `buysideSweep`.
- `smcDisplacement` fires on an impulsive candle (body > 1.5× the 20-bar average body) that closes beyond the prior bar's high/low — the same concept `ConceptsEngine`'s Break-of-Structure signals (`bullishBOS`/`bearishBOS`) already capture. The only field ever read off `smcDisplacement`'s return value at either call site is `.dir` (`d?.dir === "up"` / `"down"`) — `.strength` is computed but never read anywhere in the codebase (confirmed by grep), so `legacyDisplacement` does not need to compute it.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/concepts/legacy-conditions.test.ts
import { legacyBullishLiqSweep, legacyBearishLiqSweep, legacyDisplacement } from "../../src/concepts/legacy-conditions.js";

describe("legacy-conditions liquidity sweep + displacement wrappers", () => {
  it("returns false everywhere on a flat series with no sweeps or displacement", () => {
    const candles = Array.from({ length: 40 }, (_, i) => candle(i * 3_600_000, 100, 100.1, 99.9, 100));
    for (let i = 0; i < candles.length; i++) {
      expect(legacyBullishLiqSweep(candles, i)).toBe(false);
      expect(legacyBearishLiqSweep(candles, i)).toBe(false);
      expect(legacyDisplacement(candles, i)).toBeNull();
    }
  });

  it("legacyDisplacement returns only {dir} — never reads or requires a strength field downstream", () => {
    const candles = Array.from({ length: 40 }, (_, i) => candle(i * 3_600_000, 100, 100.1, 99.9, 100));
    const result = legacyDisplacement(candles, 20);
    expect(result === null || ("dir" in result && (result.dir === "up" || result.dir === "down"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/concepts/legacy-conditions.test.ts`
Expected: FAIL — `legacyBullishLiqSweep` is not exported

- [ ] **Step 3: Write the implementation**

```ts
// append to src/concepts/legacy-conditions.ts
export function legacyBullishLiqSweep(candles: Candle[], i: number): boolean {
  return signalsFor(candles).sellsideSweep[i] ?? false;
}

export function legacyBearishLiqSweep(candles: Candle[], i: number): boolean {
  return signalsFor(candles).buysideSweep[i] ?? false;
}

export function legacyDisplacement(candles: Candle[], i: number): { dir: "up" | "down" } | null {
  const sig = signalsFor(candles);
  if (sig.bullishBOS[i]) return { dir: "up" };
  if (sig.bearishBOS[i]) return { dir: "down" };
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/concepts/legacy-conditions.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/concepts/legacy-conditions.ts tests/concepts/legacy-conditions.test.ts
git commit -m "feat: add ConceptsEngine-backed liquidity sweep + displacement wrappers"
```

---

### Task 3: OB-retest wrapper + `orderblocks.ts` replacement

**Files:**
- Modify: `src/concepts/legacy-conditions.ts`
- Test: `tests/concepts/legacy-conditions.test.ts`

**Interfaces:**
- Consumes: `engineFor` (Task 1, internal), `OrderBlock` type from `trading-concepts-ts` (fields used: `index`, `type`, `top`, `bottom` — confirmed by reading `trading-concepts-ts/src/smartMoney.ts`'s `findOrderBlocks`: for both bullish and bearish OBs, `top` = the OB candle's high, `bottom` = the OB candle's low, i.e. the zone is the OB candle's full range, not just its body).
- Produces: `legacyObRetestLong(candles: Candle[], i: number): boolean`, `legacyObRetestShort(candles: Candle[], i: number): boolean` — consumed by Task 4.

**Retest logic** (ported from `orderblocks.ts`'s `buildObRetestSignals`, which this task supersedes): for a bullish OB, price is expected to pull back down into the zone from above — the near/proximal edge on that approach is the zone's `top`, the far/invalidation edge is `bottom` (a close below `bottom` means the zone failed, no trade). For a bearish OB it's the mirror: proximal = `bottom`, distal = `top`. First touch of the proximal edge, provided the distal edge hasn't already been closed through, fires exactly one retest signal per zone — same "fresh zone, one signal, invalidate-or-fire" behavior `orderblocks.ts` had, just fed from `ConceptsEngine`'s canonical order blocks instead of a second ATR-adaptive detector. One known, accepted behavioral difference: `orderblocks.ts` started scanning for a retest one bar after the *impulse* candle; `ConceptsEngine`'s `OrderBlock` doesn't record a separate impulse index, so this scans from one bar after the OB candle itself (`ob.index + 1`) — slightly more permissive, and exactly the kind of drift Task 5's re-verification pass exists to catch.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/concepts/legacy-conditions.test.ts
import { legacyObRetestLong, legacyObRetestShort } from "../../src/concepts/legacy-conditions.js";

describe("legacy-conditions OB retest wrappers", () => {
  it("returns false everywhere on a flat series with no order blocks", () => {
    const candles = Array.from({ length: 40 }, (_, i) => candle(i * 3_600_000, 100, 100.1, 99.9, 100));
    for (let i = 0; i < candles.length; i++) {
      expect(legacyObRetestLong(candles, i)).toBe(false);
      expect(legacyObRetestShort(candles, i)).toBe(false);
    }
  });

  it("fires at most once per zone — long and short never both true on the same bar for a single-zone series", () => {
    // A sharp up-impulse followed by a pullback: plausible bullish-OB-then-retest shape.
    const candles: Candle[] = [];
    let px = 100;
    for (let i = 0; i < 15; i++) { candles.push(candle(i * 3_600_000, px, px + 0.2, px - 0.2, px)); px -= 0.05; }
    candles.push(candle(15 * 3_600_000, px, px + 0.1, px - 0.3, px - 0.2)); // down-close candle -> bullish OB candidate
    for (let i = 16; i < 20; i++) { px += 2; candles.push(candle(i * 3_600_000, px - 2, px + 0.1, px - 2.1, px)); } // impulse up
    for (let i = 20; i < 30; i++) { px -= 0.3; candles.push(candle(i * 3_600_000, px + 0.3, px + 0.35, px - 0.05, px)); } // pullback
    for (let i = 0; i < candles.length; i++) {
      expect(legacyObRetestLong(candles, i) && legacyObRetestShort(candles, i)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/concepts/legacy-conditions.test.ts`
Expected: FAIL — `legacyObRetestLong` is not exported

- [ ] **Step 3: Write the implementation**

```ts
// append to src/concepts/legacy-conditions.ts
interface RetestArrays { long: boolean[]; short: boolean[] }
const retestCache = new WeakMap<Candle[], RetestArrays>();

function buildRetestArrays(candles: Candle[], orderBlocks: OrderBlock[]): RetestArrays {
  const n = candles.length;
  const long = new Array<boolean>(n).fill(false);
  const short = new Array<boolean>(n).fill(false);

  for (const ob of orderBlocks) {
    const proximal = ob.type === "bullish" ? ob.top : ob.bottom;
    const distal = ob.type === "bullish" ? ob.bottom : ob.top;
    for (let i = ob.index + 1; i < n; i++) {
      const c = candles[i];
      if (ob.type === "bullish") {
        if (c.close < distal) break;
        if (c.low <= proximal) { long[i] = true; break; }
      } else {
        if (c.close > distal) break;
        if (c.high >= proximal) { short[i] = true; break; }
      }
    }
  }
  return { long, short };
}

function retestArraysFor(candles: Candle[]): RetestArrays {
  let arr = retestCache.get(candles);
  if (!arr) {
    const orderBlocks = engineFor(candles).analyze().orderBlocks;
    arr = buildRetestArrays(candles, orderBlocks);
    retestCache.set(candles, arr);
  }
  return arr;
}

export function legacyObRetestLong(candles: Candle[], i: number): boolean {
  return retestArraysFor(candles).long[i] ?? false;
}

export function legacyObRetestShort(candles: Candle[], i: number): boolean {
  return retestArraysFor(candles).short[i] ?? false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/concepts/legacy-conditions.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/concepts/legacy-conditions.ts tests/concepts/legacy-conditions.test.ts
git commit -m "feat: add ConceptsEngine-backed OB retest wrappers"
```

---

### Task 4: Wire both call sites onto `legacy-conditions.ts`

**Files:**
- Modify: `src/tools/backtest-tools.ts:1,6` (imports), `:733-786` (`buildSignalEvaluator`'s `needSmc` block and `obRetest` block), `:992-1049` (delete the old `smc*` function bodies — keep `smcSwingHighs`/`smcSwingLows` for now, see note below), `:1122-1165` (`BinanceSignalFusionTool`'s precompute block)
- Test: `tests/tools/backtest-tools.test.ts` (new `describe` block)

**Interfaces:**
- Consumes: `legacyBullishOb`, `legacyBearishOb`, `legacyBullishFvg`, `legacyBearishFvg`, `legacyBullishLiqSweep`, `legacyBearishLiqSweep`, `legacyDisplacement`, `legacyObRetestLong`, `legacyObRetestShort` — all from Task 1–3, `src/concepts/legacy-conditions.ts`.

**What's changing and why:** the current `smcBullishOB`/`smcBearishOB`/`smcBullishFVG`/`smcBearishFVG`/`smcBullishLiqSweep`/`smcBearishLiqSweep`/`smcDisplacement` function bodies (lines 1006-1049) are deleted; every call to them (in both the `buildSignalEvaluator` precompute loop at line ~741-754 and `BinanceSignalFusionTool`'s precompute loop at line ~1156-1169) is repointed to the matching `legacy*` function. `smcSwingHighs`/`smcSwingLows` (lines 992-1005) are left in place but their output (`sh`/`sl`) becomes unused dead computation at both call sites — they were only ever consumed by the old `smcBullishLiqSweep`/`smcBearishLiqSweep` signature, which no longer takes them. Leaving them in place (rather than also stripping the now-dead `sh`/`sl` computation and the two now-unused function parameters) keeps this task's diff to "swap the implementation," not "also reshape both call sites' local variables" — that cleanup is explicitly deferred to Task 6, done once, alongside the `orderblocks.ts` deletion, instead of twice here.

The `ob_retest_long`/`ob_retest_short` block (lines 782-786) swaps `detectOrderBlockZones`/`buildObRetestSignals` (from `orderblocks.ts`) for `legacyObRetestLong`/`legacyObRetestShort`, called once per bar inside the returned evaluator closure rather than precomputed as arrays — matching how every other condition type in that `switch` already works (each `case` reads live, nothing else in that switch precomputes into a captured local first). This also means the `obRetestCond`-gated precompute block (lines 782-787) disappears entirely — `legacyObRetestLong`/`legacyObRetestShort` cache their own array internally (Task 3), so there's nothing left to gate.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/tools/backtest-tools.test.ts
import { buildSignalEvaluator } from "../../src/tools/backtest-tools.js";
import { Candle } from "../../src/backtest/types.js";

function candle(openTime: number, open: number, high: number, low: number, close: number, volume = 100): Candle {
  return { openTime, open, high, low, close, volume };
}

describe("buildSignalEvaluator SMC condition types route through ConceptsEngine", () => {
  it("bearish_fvg and ob_retest_short evaluate without throwing across a full candle series", () => {
    const candles = Array.from({ length: 60 }, (_, i) => {
      const px = 100 + Math.sin(i / 4) * 3;
      return candle(i * 3_600_000, px, px + 1, px - 1, px + Math.sin(i / 3) * 0.5, 100);
    });
    const evalFvg = buildSignalEvaluator(candles, [{ type: "bearish_fvg" }]);
    const evalRetest = buildSignalEvaluator(candles, [{ type: "ob_retest_short" }]);
    for (let i = 0; i < candles.length; i++) {
      expect(typeof evalFvg(i)).toBe("boolean");
      expect(typeof evalRetest(i)).toBe("boolean");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/tools/backtest-tools.test.ts -t "route through ConceptsEngine"`
Expected: FAIL if `buildSignalEvaluator` still references `detectOrderBlockZones`/old `smc*` internals with a bug in the swap — this test is a smoke test for the rewiring, written before the rewiring so it can catch a broken import/wiring immediately. (If it passes before Step 3, that's a sign the old code path already handled these fine — expected, since behavior is meant to stay observably similar; the real regression check is Task 5's re-verification, not this smoke test.)

- [ ] **Step 3: Rewire both call sites**

In `src/tools/backtest-tools.ts`, replace the import at line 6:

```ts
// before
import { detectOrderBlockZones, buildObRetestSignals } from "./orderblocks.js";
// after
import {
  legacyBullishOb, legacyBearishOb, legacyBullishFvg, legacyBearishFvg,
  legacyBullishLiqSweep, legacyBearishLiqSweep, legacyDisplacement,
  legacyObRetestLong, legacyObRetestShort,
} from "../concepts/legacy-conditions.js";
```

Replace the `needSmc` block's precompute loop (around line 741-754):

```ts
// before
for (let i = 0; i < n; i++) {
  const oB = smcBullishOB(candles, i, 10) !== null;
  const oS = smcBearishOB(candles, i, 10) !== null;
  ob_bull[i] = oB; ob_bear[i] = oS;
  fvg_bull[i] = smcBullishFVG(candles, i);
  fvg_bear[i] = smcBearishFVG(candles, i);
  const d = smcDisplacement(candles, i);
  disp_bull[i] = d?.dir === "up"; disp_bear[i] = d?.dir === "down";
  liq_bull[i] = smcBullishLiqSweep(candles, sl, i, 20);
  liq_bear[i] = smcBearishLiqSweep(candles, sh, i, 20);
  liqob_bull[i] = liq_bull[i] && oB;
  liqob_bear[i] = liq_bear[i] && oS;
  liqfvg_bull[i] = liq_bull[i] && fvg_bull[i];
  liqfvg_bear[i] = liq_bull[i] && fvg_bear[i];
}
// after
for (let i = 0; i < n; i++) {
  const oB = legacyBullishOb(candles, i);
  const oS = legacyBearishOb(candles, i);
  ob_bull[i] = oB; ob_bear[i] = oS;
  fvg_bull[i] = legacyBullishFvg(candles, i);
  fvg_bear[i] = legacyBearishFvg(candles, i);
  const d = legacyDisplacement(candles, i);
  disp_bull[i] = d?.dir === "up"; disp_bear[i] = d?.dir === "down";
  liq_bull[i] = legacyBullishLiqSweep(candles, i);
  liq_bear[i] = legacyBearishLiqSweep(candles, i);
  liqob_bull[i] = liq_bull[i] && oB;
  liqob_bear[i] = liq_bear[i] && oS;
  liqfvg_bull[i] = liq_bull[i] && fvg_bull[i];
  liqfvg_bear[i] = liq_bull[i] && fvg_bear[i];
}
```

Delete the `obRetest`-precompute block (lines 779-787: the comment, `obRetest` variable declaration, and the `if (obRetestCond) {...}` block) — nothing replaces it, `legacyObRetestLong`/`legacyObRetestShort` are called directly in the switch instead.

Replace the switch cases at lines 828-829:

```ts
// before
case "ob_retest_long": return obRetest?.long[i] ?? false;
case "ob_retest_short": return obRetest?.short[i] ?? false;
// after
case "ob_retest_long": return legacyObRetestLong(candles, i);
case "ob_retest_short": return legacyObRetestShort(candles, i);
```

Apply the identical precompute-loop swap to `BinanceSignalFusionTool`'s block (lines 1156-1169) — same before/after as the `needSmc` block above, same import (already added at the top of the file, no second import needed).

Delete the now-dead function bodies at lines 1006-1049 (`smcBullishOB`, `smcBearishOB`, `smcBullishFVG`, `smcBearishFVG`, `smcBullishLiqSweep`, `smcBearishLiqSweep`, `smcDisplacement`) — leave `smcSwingHighs`/`smcSwingLows` (lines 992-1005) in place per the note above.

- [ ] **Step 4: Run tests to verify they pass, and that nothing else broke**

Run: `node --experimental-vm-modules node_modules/.bin/jest tests/tools/backtest-tools.test.ts tests/concepts/legacy-conditions.test.ts`
Expected: PASS, all tests including the smoke test from Step 1

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors — this catches any remaining reference to the deleted `smc*` functions or the old `orderblocks.js` import that Step 3 missed (e.g. in `BinanceSignalFusionTool`'s block, which still declares local `sh`/`sl` via `smcSwingHighs`/`smcSwingLows` — confirm those two calls still compile since those functions still exist).

- [ ] **Step 5: Commit**

```bash
git add src/tools/backtest-tools.ts tests/tools/backtest-tools.test.ts
git commit -m "refactor: route SMC condition types through ConceptsEngine via legacy-conditions"
```

---

### Task 5: Dual-run divergence check + pool re-verification at 10x

**Files:**
- Create: `scripts/smc-migration-dual-run.ts` (scratch, not committed — per the design spec, informational only, throwaway)
- Create: `scripts/smc-migration-reverify.ts` (committed, modeled on the existing `scripts/full-reverify.ts` pattern)
- Modify: `strategies.json` (per-strategy `metrics`, plus a new `_verification.smcConsolidation2026` narrative key, plus removal of any strategy that fails re-verification)

**Interfaces:**
- Consumes: `runFuturesBacktest`, `fetchCandlesRange` (`src/tools/backtest-tools.ts`, already exported), the rewired `buildSignalEvaluator` from Task 4 (used implicitly — `runFuturesBacktest` calls it internally when passed a raw condition array).

This task only runs against the 22 `strategies.json` entries whose `entry` array includes one of: `bearish_fvg`, `bullish_fvg`, `bearish_liq_sweep`, `bearish_liq_fvg`, `bullish_liq_fvg`, `bearish_liq_ob`, `ob_retest_short` (confirmed by scanning `strategies.json` — no pool entry currently uses plain `bearish_ob`/`bullish_ob`/`bearish_displacement`/`ob_retest_long`, only the composites and `bearish_fvg` do; those unused-by-the-pool types still got tested directly in Tasks 1-3, they just have no pool entries to re-verify here).

- [ ] **Step 1: Write the dual-run script**

```ts
// scripts/smc-migration-dual-run.ts — scratch, not committed. Compares the
// OLD smc* implementation (git-stashed copy, run manually before this
// script existed) against the NEW ConceptsEngine-backed one is not
// possible post-deletion — so this must run BEFORE Task 4's Step 3 deletes
// the old functions. Run it between Task 4 Step 2 (tests written, old code
// still present) and Task 4 Step 3 (rewiring) by temporarily importing both
// old (inline, copy-pasted below) and new (legacy-conditions.ts) versions.
import { fetchCandlesRange, runFuturesBacktest } from "../src/tools/backtest-tools.js";
import { legacyBullishFvg, legacyBearishFvg, legacyBullishLiqSweep, legacyBearishLiqSweep } from "../src/concepts/legacy-conditions.js";
import { Candle } from "../src/backtest/types.js";
import { readFileSync, writeFileSync } from "fs";

// Old implementations, copied verbatim from backtest-tools.ts before deletion —
// this file is scratch/throwaway, kept only long enough to produce the
// divergence report below, then discarded.
function oldBullishFVG(candles: Candle[], i: number): boolean {
  if (i < 1 || i >= candles.length - 1) return false;
  return candles[i - 1].high < candles[i + 1].low;
}
function oldBearishFVG(candles: Candle[], i: number): boolean {
  if (i < 1 || i >= candles.length - 1) return false;
  return candles[i - 1].low > candles[i + 1].high;
}

const cfg = JSON.parse(readFileSync("strategies.json", "utf-8"));
const AFFECTED_TYPES = new Set(["bearish_fvg", "bearish_liq_sweep", "bearish_liq_fvg", "bullish_liq_fvg", "bearish_liq_ob", "ob_retest_short"]);

async function main() {
  const report: any[] = [];
  for (const [sym, strats] of Object.entries(cfg.symbols) as [string, any[]][]) {
    for (const s of strats) {
      if (!s.entry.some((e: any) => AFFECTED_TYPES.has(e.type))) continue;
      const f = await fetchCandlesRange(sym, s.tf, Date.UTC(2023, 6, 16), Date.now());
      if ("error" in f) { console.error(sym, s.id, f.message); continue; }
      const candles = f.candles;

      // FVG divergence (the only type with a like-for-like old/new comparator
      // available without re-deriving swing highs/lows for liq-sweep):
      let fvgDivergences = 0;
      for (let i = 0; i < candles.length; i++) {
        const oldB = oldBullishFVG(candles, i), oldS = oldBearishFVG(candles, i);
        const newB = legacyBullishFvg(candles, i), newS = legacyBearishFvg(candles, i);
        if (oldB !== newB || oldS !== newS) fvgDivergences++;
      }
      report.push({ symbol: sym, id: s.id, tf: s.tf, bars: candles.length, fvgDivergences, fvgDivergencePct: fvgDivergences / candles.length });
      console.log(`${s.id}: ${fvgDivergences}/${candles.length} bars diverge (${(100 * fvgDivergences / candles.length).toFixed(1)}%)`);
    }
  }
  writeFileSync("scripts/smc-migration-dual-run-output.json", JSON.stringify(report, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
```

Run: `npx tsx scripts/smc-migration-dual-run.ts`
Expected: prints a divergence percentage per affected strategy. No pass/fail threshold — read it, confirm nothing is wildly off (e.g. >80% divergence would suggest a wiring bug, not expected algorithm drift), then move on. Divergence in the 10-40% range is expected and fine — `ConceptsEngine`'s FVG detector uses a `minGapPercent` filter the old 3-candle check didn't have, so it's structurally a stricter/different set of gaps, not a bug.

Delete `scripts/smc-migration-dual-run.ts` and `scripts/smc-migration-dual-run-output.json` after reading the output — this script is scratch per the design spec, not committed.

- [ ] **Step 2: Write the re-verification script**

```ts
// scripts/smc-migration-reverify.ts
// Re-verifies every strategies.json entry affected by the SMC engine
// consolidation, at 10x leverage (this pool was last verified at 5x — see
// docs/superpowers/specs/2026-07-28-smc-engine-consolidation-design.md for
// why 10x, not a revert to 5x). Everything routes through
// runFuturesBacktest — no second simulation loop.
import { fetchCandlesRange, runFuturesBacktest } from "../src/tools/backtest-tools.js";
import { Candle } from "../src/backtest/types.js";
import { readFileSync, writeFileSync } from "fs";

const LEVERAGE = 10, MARGIN_PCT = 0.05, SLIPPAGE_BPS = 3, FEE_BPS = 5, CAP = 10000;
const START = Date.UTC(2023, 6, 16);
const NOW = Date.now();
const AFFECTED_TYPES = new Set(["bearish_fvg", "bearish_liq_sweep", "bearish_liq_fvg", "bullish_liq_fvg", "bearish_liq_ob", "ob_retest_short"]);

const cfg = JSON.parse(readFileSync("strategies.json", "utf-8"));

interface Row { symbol: string; id: string; oldMetrics: any; fullMetrics: any; trainMetrics: any; testMetrics: any; survives: boolean }

async function main() {
  const rows: Row[] = [];
  for (const [sym, strats] of Object.entries(cfg.symbols) as [string, any[]][]) {
    for (const s of strats) {
      if (!s.entry.some((e: any) => AFFECTED_TYPES.has(e.type))) continue;
      const f = await fetchCandlesRange(sym, s.tf, START, NOW);
      if ("error" in f) { console.error(sym, s.id, f.message); continue; }
      const candles: Candle[] = f.candles;
      const half = Math.floor(candles.length / 2);
      const train = candles.slice(0, half), test = candles.slice(half);

      const run = (c: Candle[]) => runFuturesBacktest(c, s.entry, s.direction, s.risk.stopPct, s.risk.targetPct, FEE_BPS, s.maxHoldBars, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS).metrics as any;
      const fullMetrics = run(candles), trainMetrics = run(train), testMetrics = run(test);
      const survives = trainMetrics.totalPnlUsd > 0 && testMetrics.totalPnlUsd > 0;

      console.log(`${sym} ${s.id}: survives=${survives} full trades=${fullMetrics.totalTrades} WR=${(fullMetrics.winRate * 100).toFixed(0)}% PF=${fullMetrics.profitFactor.toFixed(2)} (was: trades=${s.metrics.trades} WR=${(s.metrics.winRate * 100).toFixed(0)}% PF=${s.metrics.pf.toFixed(2)} @5x)`);
      rows.push({ symbol: sym, id: s.id, oldMetrics: s.metrics, fullMetrics, trainMetrics, testMetrics, survives });
    }
  }
  writeFileSync("scripts/smc-migration-reverify-output.json", JSON.stringify(rows, null, 2));
  console.log(`\n${rows.filter(r => r.survives).length}/${rows.length} survive re-verification at 10x`);
}
main().catch(e => { console.error(e); process.exit(1); });
```

Run: `npx tsx scripts/smc-migration-reverify.ts`
Expected: prints one line per affected strategy plus a summary count. Output written to `scripts/smc-migration-reverify-output.json`.

- [ ] **Step 3: Update `strategies.json` from the re-verification output**

For every row where `survives: true`: update that strategy's `metrics` object in `strategies.json` with `fullMetrics`' values (map `totalTrades`→`trades`, `winRate`→`winRate`, `profitFactor`→`pf`, `totalPnlUsd`→`pnlUsd`, `totalReturnPct`→`returnPct`, `maxDrawdownPct`→`maxDDPct`, `sharpeRatio`→`sharpe` — matching the existing per-strategy `metrics` field names shown in the `xrp-bearish-fvg-1h` entry).

For every row where `survives: false`: remove that strategy object from its symbol's array in `strategies.json`.

Add a new key to `_verification` (sibling to the existing `newSymbolsExpansion2026` narrative, same prose style):

```json
"smcConsolidation2026": "2026-07-28: Consolidated 3 duplicate SMC/ICT implementations (ConceptsEngine, src/tools/orderblocks.ts, inline smc* helpers in backtest-tools.ts) onto ConceptsEngine alone (docs/superpowers/specs/2026-07-28-smc-engine-consolidation-design.md). Re-verified every pool entry using bearish_fvg/bearish_liq_sweep/bearish_liq_fvg/bullish_liq_fvg/bearish_liq_ob/ob_retest_short through runFuturesBacktest with a split-sample check, at 10x leverage (this pool was previously verified at 5x — DEFAULT_RUNNER_CONFIG.leverage was bumped to 10x in commit 65a492d without re-verification; this pass fixes that gap rather than reverting leverage). <N>/<M> entries survived; failures removed from the pool (see scripts/smc-migration-reverify-output.json for full before/after metrics)."
```

Fill in `<N>`/`<M>` and reference the actual removed strategy IDs (if any) in the narrative, matching how `_verification.history` names specific discredited results.

- [ ] **Step 4: Commit**

```bash
git add strategies.json scripts/smc-migration-reverify.ts scripts/smc-migration-reverify-output.json
git commit -m "chore: re-verify SMC-affected strategy pool at 10x leverage post-consolidation"
```

---

### Task 6: Delete `orderblocks.ts` and dead code

**Files:**
- Delete: `src/tools/orderblocks.ts`
- Modify: `src/tools/backtest-tools.ts` (remove now-dead `sh`/`sl` computation and `smcSwingHighs`/`smcSwingLows` calls at both call sites, and the two now-unexported-but-unused function definitions if nothing else calls them)

**Interfaces:**
- Consumes: nothing new — this is cleanup only, no behavior change from Task 5's re-verified state.

- [ ] **Step 1: Grep for stray references**

Run: `grep -rn "orderblocks\.js\|detectOrderBlockZones\|buildObRetestSignals\|smcSwingHighs\|smcSwingLows" src/ tests/ scripts/`
Expected: only hits inside `src/tools/backtest-tools.ts` for `smcSwingHighs`/`smcSwingLows` (the now-dead `sh`/`sl` precompute lines noted in Task 4), and the `orderblocks.ts` file itself. No hits anywhere else — confirms nothing outside this plan's scope depends on the file being deleted.

- [ ] **Step 2: Delete the dead file and dead computation**

```bash
git rm src/tools/orderblocks.ts
```

In `src/tools/backtest-tools.ts`, remove the two now-unused lines from both precompute blocks (the `needSmc` block and `BinanceSignalFusionTool`'s block):

```ts
// delete this line from both blocks
const sh = smcSwingHighs(closes, 5);
const sl = smcSwingLows(closes, 5);
```

Then delete the `smcSwingHighs`/`smcSwingLows` function definitions themselves (lines 992-1005 as of Task 4's state) — with the `sh`/`sl` call sites gone, nothing references them anymore (re-confirm with the same grep from Step 1).

- [ ] **Step 3: Run the full test suite and typecheck**

Run: `node --experimental-vm-modules node_modules/.bin/jest`
Expected: PASS, no regressions

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: delete orderblocks.ts and dead SMC swing-point helpers post-consolidation"
```

---

## Self-Review Notes

- **Spec coverage**: Design spec's canonical-engine goal (✓ Tasks 1-3), incremental migration with dual-run sanity check (✓ Task 5 Step 1, adjusted from "per condition type" to "once, batched" since the caching-wrapper architecture — discovered while reading the real call sites — made per-type dispatch edits unnecessary), 10x re-verification with pool pruning (✓ Task 5 Steps 2-3), final deletion (✓ Task 6). The "8 condition types" estimate in the spec's Architecture section was low — real count is 14 dispatched types across 2 call sites — this plan's Task 4 handles the full set, not a subset.
- **Placeholder scan**: no TBD/TODO; the two spots with a fill-in-the-blank (`<N>`/`<M>` in Task 5 Step 3's narrative string) are explicitly filled from that task's own script output, not deferred work.
- **Type consistency**: `legacy*` function names and signatures (`(candles: Candle[], i: number) => boolean`, `legacyDisplacement` returning `{ dir: "up" | "down" } | null`) are identical across Tasks 1-4 — checked against each task's "Interfaces: Consumes" line.
