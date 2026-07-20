# OI-Divergence Signal (sub-project 1 of 5)

Part of a larger plan to add open-interest, order-book-imbalance, liquidation-cluster,
funding-rate-arbitrage, and stat-arb signals to the trading agent. This spec covers only
open-interest divergence; the other four are separate specs, built in order after this one.

## Why

`strategies.json`'s pool is entirely price-action (FVG, liquidity sweep, RSI, ADX,
Ichimoku, OB retest). Open interest is a genuinely different signal family — it says
something about *positioning*, not price geometry — and the data (`binance_futures_stats`
tool) is already fetched in this repo but never wired into a tradeable condition.

## Constraint that shapes this design

Binance's `/futures/data/openInterestHist` retains only ~30 days of history. Every other
entry in `strategies.json` is backtested over 1-3 years. This signal cannot match that
sample depth — the design accepts a thinner, flagged sample rather than pretending
otherwise.

## What's in scope

Two new entry-condition types, real backtest validation (not a shadow/forward gate —
unlike OBI and liquidation-cluster in later specs, OI has actual history to test against),
and live-runner wiring so a promoted strategy can actually run in paper trading.

Confirmation-type conditions (OI rising + price rising = strong trend) are deliberately
excluded — that signal is already covered by existing trend indicators (ADX, SuperTrend).
Only the two conditions with no existing equivalent are added.

## Data layer

New function in `src/tools/backtest-tools.ts` (co-located with `fetchCandlesRange`, same
pattern):

```ts
async function fetchOpenInterestHist(
  symbol: string, period: string, startTime: number, endTime: number
): Promise<{ timestamp: number; sumOpenInterest: number }[] | { error: string; message: string }>
```

Hits `https://fapi.binance.com/futures/data/openInterestHist` with
`symbol/period/startTime/endTime/limit=500`, paginating if the range exceeds 500 rows.
`period` must be one of Binance's supported buckets (5m/15m/30m/1h/2h/4h/6h/12h/1d) — the
caller maps the strategy's candle `interval` to the matching period 1:1 (no resampling).

**Alignment**: for each candle in the fetched `Candle[]`, find the OI sample whose
timestamp is the closest one at or before `candle.openTime` (a simple pointer-walk since
both arrays are time-sorted — no binary search needed at this data volume). Produce
`oiSeries: number[]`, same length as `candles`, `NaN` where no OI sample exists yet
(before the 30-day retention window starts, or before the first sample).

## Evaluator plumbing

`buildSignalEvaluator` in `backtest-tools.ts` gains a third, optional parameter:

```ts
export function buildSignalEvaluator(
  candles: Candle[],
  entryConditions: { type: string; period?: number; value?: number }[],
  extraSeries?: { oi?: number[] },
): (i: number) => boolean
```

Two new entries in `CONDITION_SCHEMA`'s `type` enum:

- `oi_bearish_divergence` — `period` (default 10) bars lookback. Fires when
  `closes[i] > max(closes[i-period..i-1])` (new local high) AND
  `(oi[i] - oi[i-period]) / oi[i-period] < -value` (default `value = 0.03`, i.e. OI fell
  ≥3% while price made a new high). Returns `false` if `extraSeries.oi` wasn't supplied or
  any needed sample is `NaN`.
- `oi_bullish_divergence` — mirror: new local low in price, OI fell ≥`value` over the same
  window. (OI falling on a new low = shorts covering into weak hands, not fresh
  conviction — a bounce setup, not a breakdown-confirmation setup.)

Both conditions are no-ops (`return false`) when `extraSeries` is absent, so existing
callers that don't pass it are unaffected — pure additive change, no signature break for
current call sites once the third param defaults to `undefined`.

## Backtest wiring

The existing futures-backtest tool (the one wrapping `fetchCandlesRange` +
`runFuturesBacktest`, ~line 434 in `backtest-tools.ts`) gets one addition: after fetching
candles, if `entry` conditions include any `oi_*` type, also call
`fetchOpenInterestHist` for the same symbol/range, align it, and pass
`{ oi: oiSeries }` as `extraSeries` into `buildSignalEvaluator` (threaded through
`runFuturesBacktest`'s existing `entryConditions` param, which already accepts a
pre-built evaluator function as an alternative to a raw condition array — this reuses that
existing escape hatch rather than adding a new param to `runFuturesBacktest` itself).

If `fetchOpenInterestHist` errors (e.g. symbol has no futures market), the backtest
returns that error rather than silently treating OI conditions as never-firing — a
strategy that can't fetch its own data shouldn't report "0 trades, works great."

## Live-runner wiring

`LivePaperRunner` (`src/paper-trading/live-runner.ts`) polls per (symbol, tf) group and
already calls `buildSignalEvaluator` per poll. For any active pool strategy using `oi_*`
conditions, the runner maintains a rolling OI buffer per (symbol, tf) — refetched each
poll cycle via the same `fetchOpenInterestHist`, windowed to the strategy's own lookback
need, and passed as `extraSeries` the same way the backtest path does. No new persistence
— the buffer is recomputed each poll like the candle window already is.

## Promotion gate

Same discipline as every existing pool entry, adjusted for the shorter available window:

- `runFuturesBacktest` net-positive (positive `pnlUsd`)
- Split-sample: since only ~30d of OI history exists, split into two ~15-day halves
  (first-half / second-half of the available OI range), both independently net-positive
  — same method the file already uses, just a shorter total window
- Minimum 8 trades (existing pool's bar is 15, but that assumes a 1-3yr window; 8 is the
  proportionate equivalent for a ~30d sample, not an arbitrarily lowered bar)
- Any promoted entry gets a `"note"` in `strategies.json` flagging the thin sample and
  short backtest window, matching the existing convention for weak-sample entries (see
  `xrp-ob-retest-short-1h`'s `"warn"` field)

Entries that fail this gate are not added — no fallback to "wire it in anyway and watch
live," per the earlier decision for this specific signal (OI has a real backtest, unlike
OBI/liquidation-cluster which get the forward-shadow gate in their own specs).

## Testing

One runnable check per the file's existing pattern (no test framework currently used in
this repo for backtest-tools.ts — verified by hand-running the futures-backtest tool
against a known symbol is the existing practice, per `scripts/*.ts` one-off verification
scripts referenced in `strategies.json`'s `_verification` history). This spec's
implementation plan should include a `scripts/oi-divergence-verify.ts` one-off script,
following that established pattern: fetch real OI + candle data for one symbol, print the
computed `oiSeries` alongside candle closes for a handful of bars, and assert the
alignment/divergence logic by eye against known values — not a unit-test framework
introduction.

## Out of scope (belongs to later specs in this plan)

- OBI signal + forward-shadow-paper gate mechanism (spec 2)
- Liquidation-cluster signal, reusing spec 2's shadow-gate (spec 3)
- Funding-rate-arbitrage bolt-on ledger (spec 4)
- Stat-arb pairs engine (spec 5)
