# Stat-Arb Pairs (sub-project 5 of 5, final)

Last spec in the plan that started with
[2026-07-21-oi-divergence-signal-design.md](2026-07-21-oi-divergence-signal-design.md).
Nothing built in sub-projects 1-4 is reusable here — `buildSignalEvaluator` is single-
symbol, `ShadowSignalTracker` and `FundingArbTracker` are both single-symbol-per-position
(even funding-arb's two legs are both on the *same* symbol, spot vs. perp). Stat-arb is
cross-symbol: a position is a bet on the *relationship* between two symbols, not on either
symbol's price alone. This is a from-scratch engine.

## Why this one gets a real backtest (unlike #2/#3)

Binance kline history has no retention cap the way order-book/liquidation data does —
sub-project 1 already established the backtest-then-promote pattern for exactly this
reason (real historical data available). Stat-arb reuses that same discipline: build the
engine, run a promotion sweep against real history with a split-sample gate, and only wire
a pair into the live tracker once it has evidence behind it. This is the opposite posture
from OBI/liquidation-cluster, which had no choice but to validate forward.

## The signal

Universe: the same 3 pool symbols (XRPUSDT, ETHUSDT, SOLUSDT) → 3 possible pairs, no new
symbol onboarding. For a candidate pair (A, B) on aligned candles:

```
spread[i]   = ln(closeA[i]) - ln(closeB[i])
mean[i]     = rolling mean of spread over the trailing 30 bars
std[i]      = rolling std of spread over the trailing 30 bars
zscore[i]   = (spread[i] - mean[i]) / std[i]
```

Entry: `|zscore| > 2` and no position open for the pair. `zscore > 2` means A is expensive
relative to B (short A / long B); `zscore < -2` means the reverse (long A / short B). Exit:
`|zscore| < 0.5` (reversion essentially complete) or `|zscore| > 3.5` (stop — the spread
kept widening instead of reverting, a signal the pair's relationship may have broken down,
not just noise) or a max-hold-bars timeout.

**Correlation pre-filter**: before ever computing a z-score trade on a pair, check Pearson
correlation of the two closes series over the same lookback window; skip the pair entirely
if `|correlation| < 0.7`. This is a lazy substitute for a full cointegration test (Engle-
Granger, Johansen) — those test for a *stable long-run relationship*, which correlation
alone doesn't guarantee, but implementing a real cointegration test in this codebase is
disproportionate to a 3-pair universe. The backtest's own split-sample gate is the real
check on whether the relationship actually held up; correlation is just a cheap filter to
avoid wasting a backtest run on two symbols that obviously don't move together.

## Position sizing

Dollar-neutral, not share-neutral (the standard pairs-trading convention): each leg gets an
independent `$2000` notional. `qtyA = notional / entryPriceA`, `qtyB = notional /
entryPriceB`. PnL is the sum of both legs' independent price PnL minus fees — there's no
funding component here (that's sub-project 4's territory), just two directional bets that
are supposed to net out except for the spread's mean-reversion.

## Implementation shape

**`src/backtest/pairs-engine.ts`** (new file, mirrors `src/backtest/engine.ts`'s role as
the pure-simulation core, kept separate from Tool-wrapper code): `computeZScoreSeries`,
`pearsonCorrelation`, `runPairsBacktest`. Output metrics reuse the field names
`BacktestMetrics` already established (`totalTrades`, `winRate`, `profitFactor`,
`sharpeRatio`, `totalPnlUsd`, `maxDrawdownPct`) for consistency with everything else in
this codebase that reports backtest results, even though this isn't literally
`BacktestMetrics` (dual-leg has no single "direction" or "stopPct").

**`scripts/pairs-arb-sweep.ts`**: for each of the 3 pairs, fetch full-history candles for
both symbols via the existing `fetchCandlesRange`, apply the correlation pre-filter, run
`runPairsBacktest`, split-sample (first-half/second-half both net-positive), require ≥15
trades (this pool has deep history available, unlike OI-divergence's ~30-day cap — no
reason to lower the bar the way sub-project 1 had to). Writes
`pairs-arb-sweep-output.json`. Never auto-promotes anything.

**`src/paper-trading/pairs-arb.ts`**: `PairsArbTracker`, its own module — not built on
`ShadowSignalTracker` or `FundingArbTracker`, the position shape doesn't fit either (two
symbols, z-score-driven entry/exit, no funding). Same state-file + journal persistence
convention as every other tracker in this plan.

**Daemon wiring — inert by default.** Unlike OBI/liquidation-cluster (which had no
backtest option and so went live-shadow immediately), stat-arb *can* be backtested, so it
gets sub-project 1's discipline: the daemon imports and constructs `PairsArbTracker`, but
with an **empty candidate list** — commented to explain it activates only once
`scripts/pairs-arb-sweep.ts` finds a `SURVIVES` pair and a human adds it manually. No
unvalidated pairs strategy runs against paper capital by default; the plumbing exists so
turning on a validated pair later is a one-line config change, not a code change.

**`scripts/pairs-arb-report.ts`**: same shape as `funding-arb-report.ts` — reads the
tracker's journal (once/if any pair is ever activated) and reports per-pair PnL.

## Testing

`computeZScoreSeries` and `pearsonCorrelation`: pure functions, Jest against known
synthetic series (e.g. perfectly correlated series, then an injected divergence, checking
the z-score spikes at the expected index). `runPairsBacktest`: Jest against synthetic
candle series with a manufactured mean-reverting spread, checking it actually finds and
closes trades. `PairsArbTracker`: same dependency-injection approach as
`FundingArbTracker` (sub-project 4) — deterministic, no real network, since its
correctness is about the z-score/entry/exit arithmetic, not live data.

## Out of scope

This is the last spec in the 5-part plan. Nothing further planned beyond this.
