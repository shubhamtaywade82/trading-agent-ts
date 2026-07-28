# Trailing Stop Engine (sub-project D of 4)

Last of the 4 sub-projects that started with the margin/risk-sizing review:
(A) re-verify pool at 10x — done, (B) per-symbol exposure cap — done,
(C) cross-symbol correlation guard — done, (D) this spec.

## Scope decision

2-phase model (breakeven-lock + ATR trail), not the 4-phase model with
partial take-profit a pasted external doc proposed. Partial-TP means partial
position closes — real added complexity (more journal fields, more state,
harder to validate) for a pool that's currently 6 strategies. Ship the
simpler mechanism, prove it out, add partial-TP later as its own follow-up
if the data supports it.

## Why the fixed target gets disabled once trailing activates

Once a position has moved far enough in profit to confirm the move is real
(the "activation" threshold below), the whole point of trailing is to let it
run past the original fixed target rather than cap it there. So: before
trailing activates, the existing fixed-target exit check behaves exactly as
today (a trade can still hit its original target early, completely
normally). Once phase reaches `"trailing"`, the fixed-target check is
skipped for that position — only the trailing stop (or liquidation, or
timeout) can close it from then on.

## Architecture

New file `src/paper-trading/trailing.ts` — pure functions, no fs/journal
access, matching this codebase's existing pattern for `volScale`/
`slippageMultiplier`/`correlationScale` (all in `live-runner.ts`) and
`legacy-conditions.ts`'s WeakMap-cache style for anything ATR-derived.

```ts
export type TrailingPhase = "initial" | "breakeven" | "trailing";

export interface TrailingConfig {
  enabled: boolean;
  breakevenAtrMult: number;   // profit (as ATR multiples) that triggers breakeven lock
  breakevenOffsetBps: number; // stop lands at entry +/- this many bps (covers fees)
  activationAtrMult: number;  // profit (as ATR multiples) that triggers trailing
  trailAtrMult: number;       // trail distance behind the extreme, in ATR multiples
  minTrailPct: number;        // floor on trail distance (ATR-collapse guard)
  maxTrailPct: number;        // ceiling on trail distance (ATR-spike guard)
}

export interface TrailingState {
  phase: TrailingPhase;
  extremePrice: number; // best price seen since entry (high for long, low for short)
}

export function initTrailingState(entryPrice: number): TrailingState;
export function atrPct(candles: Candle[], period?: number): number;

export interface TrailingUpdateResult {
  state: TrailingState;
  stopPrice: number;       // updated stop -- only ever moves in favor of the position
  phaseChanged: boolean;
  targetDisabled: boolean; // true once phase reaches "trailing"
}

export function updateTrailingStop(
  state: TrailingState,
  bar: Candle,
  direction: "long" | "short",
  entryPrice: number,
  currentStopPrice: number,
  config: TrailingConfig,
  candlesUpToBar: Candle[], // for ATR -- causal, no lookahead
): TrailingUpdateResult;
```

Invariant enforced inside `updateTrailingStop`, not by callers: the returned
`stopPrice` never moves against the position. A trailing stop that widens
isn't a trailing stop.

## Integration points

**`src/paper-trading/symbol-position.ts`**: `SymbolPosition` gains two
fields, set once at `open()` from the governing strategy's config, untouched
by `add()` — same rule as `governingStopPrice`/`governingTargetPrice`/
`governingMaxHoldBars` already follow ("only the strategy that opened the
position governs its risk plan"):
```ts
trailing: TrailingState | null;       // null = trailing not enabled for this position
trailingConfig: TrailingConfig | null; // immutable snapshot from the governing strategy
```
`StrategyIntent` gains `trailingConfig?: TrailingConfig` so `applyIntent` →
`open()` can thread it through without `SymbolPositionManager` reaching back
into `strategies.json` itself (keeps it side-effect-free, per its own header
comment).

**`src/paper-trading/live-runner.ts`**: `StrategyDef` gains `trailing?:
TrailingConfig`, read from `strategies.json`'s per-strategy `trailing` block
in `loadStrategiesFromPool` (omitted = disabled, matches
`DEFAULT_TRAILING_CONFIG.enabled = false`). In `processGroup`'s governing-exit
block (`live-runner.ts:557` today), immediately after computing `bar`/`dir`
and before the `hitLiq`/`hitStop`/`hitTarget` checks: if `pos.trailing` is
non-null, call `updateTrailingStop`, write the result back into
`pos.governingStopPrice`/`pos.trailing`, journal a `trailing_phase_change`
event when `phaseChanged`, and skip the `hitTarget` check when
`targetDisabled`. `hitLiq` is never affected — liquidation is unconditional
regardless of trailing state.

**`src/tools/backtest-tools.ts`**: `runFuturesBacktest` gains one more
optional trailing final parameter, `trailingConfig?: TrailingConfig` —
backward-compatible like `riskPerTradePct` before it (omitted = every
existing caller's behavior unchanged). Inside the per-bar exit-scan loop
(`for (let j = i + 1; ...)`), before checking `hitStop`/`hitTarget` for bar
`j`: if `trailingConfig?.enabled`, call `updateTrailingStop` with
`candles.slice(0, j + 1)` (causal), use the returned `stopPrice` for that
bar's stop check and skip the target check when `targetDisabled`.

## Validation plan (before any strategy gets `trailing.enabled: true` for real)

Same discipline as every other pool-affecting change this session — no
strategy's live config changes without a passing backtest comparison:

1. For each of the 6 current pool strategies, run `runFuturesBacktest` twice
   over full history: baseline (no trailing) vs. with a starting default
   `TrailingConfig` (`breakevenAtrMult: 1.0, activationAtrMult: 2.0,
   trailAtrMult: 1.5, minTrailPct: 0.005, maxTrailPct: 0.04`).
2. Compare `totalPnlUsd`, `profitFactor`, `winRate`, `maxDrawdownPct`,
   `totalTrades` (win rate is expected to drop somewhat — winners becoming
   small breakeven trades is the mechanism, not a bug).
3. Split-sample check (train/test halves), same net-positive-both-halves
   gate as every prior re-verification this session.
4. Only strategies where trailing **and** split-sample both hold get
   `trailing.enabled: true` written into `strategies.json`. Everything else
   stays fixed-stop — no forced adoption.

## Explicitly out of scope for this sub-project

- Partial take-profit / multi-phase exits (see Scope decision above).
- Funding-aware trail-widening (a pasted doc's suggestion) — a real idea,
  but its own follow-up once the base mechanism is proven.
- TUI dashboard display of trailing phase — cosmetic, separate small task,
  not blocking the engine itself.
- Parameter sweeps on `breakevenAtrMult`/`activationAtrMult`/`trailAtrMult`
  — start with one reasonable default set (above), validate, tune later if
  the data calls for it.
