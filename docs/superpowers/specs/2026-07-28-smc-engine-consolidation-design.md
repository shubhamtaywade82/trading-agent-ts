# SMC Engine Consolidation (Phase A of 3 — regime-adaptive strategy selection)

Phase A of a 3-phase effort toward regime-adaptive scalp/intraday/swing strategy
selection: (A) this spec — consolidate 3 duplicate SMC/ICT implementations into 1,
(B) build a regime classifier on top of the consolidated engine, (C) build a
selection layer that activates/deactivates timeframe cohorts based on the
classifier, wired into both backtest and `LivePaperRunner`. B and C each get their
own spec after A ships.

## Why this is Phase A and not skippable

A regime classifier needs one trustworthy source of market-structure truth (BOS/
CHoCH, order blocks, FVGs, liquidity). Today there are three:

1. `ConceptsEngine` (`src/concepts/adapter.ts`) — wraps the external
   `trading-concepts-ts` library. Most complete: BOS/CHoCH/MSS, OB, FVG, breaker
   blocks, inverse-FVG, sellside/buyside liquidity sweeps, Judas swings, premium/
   discount/OTE zones, confluence scores, killzones, plus Volume Profile/VWAP/CVD.
   Used today only by the `concepts_*` condition-type namespace.
2. `src/tools/orderblocks.ts` — a second, independent ATR-adaptive order-block-zone
   detector, used only by `ob_retest_long`/`ob_retest_short`.
3. Inline `smc*` helpers in `src/tools/backtest-tools.ts` (`smcSwingHighs`,
   `smcBullishOB`, `smcBearishFVG`, `smcBullishLiqSweep`, etc.) — a third, plain
   swing-based implementation, used by `bearish_ob`/`bullish_ob`/`bearish_fvg`/
   `bullish_fvg`/`bearish_liq_sweep`/`bullish_liq_sweep`.

Building a regime classifier on top of any one of these while the other two keep
running live in the strategy pool means the classifier's view of "current
structure" can disagree with what actually triggered a strategy's entry. Fix the
foundation first.

This also folds in an unrelated but real bug found during the review that started
this effort: `DEFAULT_RUNNER_CONFIG.leverage` was bumped 5x→10x in commit `65a492d`,
but `strategies.json`'s pool was last validated at 5x. Rather than reverting
leverage, this phase's re-verification pass validates the whole pool at 10x —
leverage stays where it is, but now with proof behind it.

## Canonical engine

`ConceptsEngine` becomes the only SMC/ICT implementation. Confirmed feasible by
reading `trading-concepts-ts` source directly: `findOrderBlocks`/`findFVGs`/
`findLiquidityZones`/`detectStructure` all return full zone bounds and mitigation
state (`OrderBlock.top/bottom/mitigated/mitigationIndex`, `FVG.top/bottom/
mitigated`), not just boolean flags — enough to rebuild every legacy condition
type, including the retest logic `ob_retest_*` needs.

`strategies.json` condition-type strings do not change. `bearish_ob`, `bullish_fvg`,
`ob_retest_long`, etc. keep meaning exactly what they mean today — only what code
answers them changes.

## Architecture

New file `src/concepts/legacy-conditions.ts`: one wrapper function per retiring
condition type (`bearishOb`, `bullishOb`, `bearishFvg`, `bullishFvg`,
`bearishLiqSweep`, `bullishLiqSweep`, `obRetestLong`, `obRetestShort`). Each returns
the same `boolean[]`-per-candle shape `buildSignalEvaluator`'s dispatch table
already expects, so the evaluator loop itself is untouched.

- OB/FVG/sweep formation conditions: read straight off `ConceptsEngine`'s
  `PerBarSignals` booleans — these already exist (`newBullishOB`, `newBearishFVG`,
  sellside/buyside sweep flags, etc.), no new computation needed.
- `ob_retest_long`/`ob_retest_short`: `PerBarSignals` only exposes *formation*
  events, not *retest* events. The wrapper needs zone-touch logic — for each bar,
  check whether price re-enters an unmitigated OB's `[bottom, top]` range after
  formation. This reads the raw `OrderBlock[]` off `ConceptsEngine`'s underlying
  `analyze()` result (not currently surfaced by the adapter — small addition to
  `adapter.ts` to expose it, not a change to `trading-concepts-ts` itself).

`buildSignalEvaluator` (`src/tools/backtest-tools.ts`): the ~8 cases currently
calling inline `smc*` helpers or `orderblocks.ts`'s `detectOrderBlockZones` get
repointed to `legacy-conditions.ts`.

End state, once every condition type is migrated and re-verified:
`src/tools/orderblocks.ts` and the inline `smc*` block in `backtest-tools.ts` are
deleted. Grep confirms no other references before deletion.

## Migration plan

Incremental, one condition type at a time — smaller diffs, isolates blame if a
migration causes a real problem, versus one big-bang cutover.

Order (simplest/most-isolated first): `bearish_ob`/`bullish_ob` → `bearish_fvg`/
`bullish_fvg` → `bearish_liq_sweep`/`bullish_liq_sweep` (all currently backed by
the inline `smc*` helpers, where `PerBarSignals` already has direct equivalents) →
`ob_retest_long`/`ob_retest_short` last (currently backed by `orderblocks.ts`,
needs the new zone-touch logic).

Per condition type:

1. Implement the wrapper in `legacy-conditions.ts`.
2. Scratch dual-run script (not committed): run both the old implementation and
   the new wrapper over full BTCUSDT/DOGEUSDT history, log entry/exit-index
   divergence and PnL delta per affected `strategies.json` entry to a JSONL
   report. Informational only — divergence is expected (different algorithms),
   this is a human sanity check, not an automated gate.
3. Repoint the dispatch table entry to the wrapper.
4. Re-run `runFuturesBacktest` + the split-sample sweep for every affected
   strategy, at 10x leverage (the leverage fix folded into this phase).
5. Strategy still net-positive on both halves of the split → update its
   `strategies.json._verification` entry (new metrics, `engine: "ConceptsEngine"`,
   `leverage: 10`, today's date). Strategy fails re-verification → remove it from
   its symbol's pool, append the reason to `_verification.history` (same pattern
   already used to document the `mega-sweep.ts` fabricated-metrics incident).
6. Move to the next condition type.

After the last type: delete `orderblocks.ts` and the inline `smc*` block, grep for
stray references, done.

## Data flow

```
candles
  → ConceptsEngine.analyze()
  → { PerBarSignals booleans, raw OrderBlock[]/FVG[]/LiquidityZone[] }
  → legacy-conditions.ts wrappers
  → buildSignalEvaluator (dispatch loop, unchanged)
  → same as today downstream
```

Both `runFuturesBacktest` and `LivePaperRunner` already route through
`buildSignalEvaluator` — that's the existing "one shared engine" design principle
this codebase already committed to after the `mega-sweep.ts` incident. Phase A
requires zero `live-runner.ts` changes: once the pool is re-verified, live trading
picks up the new engine automatically through the shared evaluator.

## Error handling

- Warmup/short candle windows: wrappers return all-`false` arrays matching candle
  length — matches the existing defensive pattern elsewhere in the evaluator,
  never throws.
- Re-verification failure in step 5 is not a manual follow-up — the strategy is
  removed from the live pool as part of the migration step itself.
- Dual-run divergence never blocks anything; it's purely informational. The real
  gate is step 4's re-verification against `runFuturesBacktest`.

## Testing

No new test infrastructure — reuses the existing `runFuturesBacktest`/split-sample
sweep tooling, which already implements the promotion-gate pattern this phase
needs. Dual-run comparison scripts from step 2 are scratch/throwaway. Acceptance
criterion: every surviving pool member in `strategies.json` has a fresh
`_verification` entry stamped `engine: "ConceptsEngine"`.

## Explicitly out of scope for Phase A

- Regime classification itself (Phase B).
- Strategy selection/activation logic (Phase C).
- `scripts/mmr-backtest.ts` (a 4th, unrelated standalone backtest engine found
  during the review) — separate concern, not touched here.
- Any live execution / broker integration — doesn't exist in this repo yet,
  unaffected by this phase either way.
