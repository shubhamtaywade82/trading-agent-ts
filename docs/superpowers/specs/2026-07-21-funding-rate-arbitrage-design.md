# Funding-Rate Arbitrage (sub-project 4 of 5)

Part of the same larger plan as the OI-divergence, OBI shadow-signal, and liquidation-
cluster shadow-signal specs. This one does not reuse `ShadowSignalTracker` — the mechanics
are genuinely different (dual-leg notional/basis accounting vs. a single stop/target
position), so it's its own small module, as the original plan anticipated
("independent of `SymbolPositionManager`... its own thing").

## Why

Funding-rate arbitrage is delta-neutral: long spot + short perpetual futures (or the
reverse when funding is negative) collects the periodic funding payment while the two legs'
price exposure cancels. Nothing in this repo tracks a two-leg position — `SymbolPosition
Manager` is one net futures-only position per symbol, `PaperTradingManager` is a single-leg
long/short ledger. This needs its own accounting.

## Scope decision

Binance's `/fapi/v1/fundingRate` history is not capped at ~30 days the way open-interest
history is (one row per 8h, a much lighter dataset, likely retained back to contract
inception) — a real backtest is *possible* here, unlike OBI/liquidation-cluster. Building
one is explicitly out of scope for this sub-project: the original plan scoped this as a
"bolt-on ledger," and a historical-basis-reconstruction backtest (spot klines vs futures
klines, reconstructing basis per candle) is a separate, larger undertaking. This spec builds
the live paper ledger only. A backtest can be added later as its own sub-task if the live
ledger's results justify it.

## The real economics (not hand-waved)

For a position sized in `notional` USD, entered when spot price is `entrySpotPrice` and
futures mark price is `entryMarkPrice`:

```
qty = notional / entrySpotPrice
basis = markPrice - spotPrice
sign = perpDirection === "short" ? 1 : -1

totalPnl = accruedFunding + sign * qty * (entryBasis - currentBasis)
```

Derivation: the spot leg's price PnL and the perp leg's price PnL cancel except for the
*change* in basis between entry and now — that residual is the actual risk in a cash-and-
carry trade, not something a paper simulation should hide. `accruedFunding` comes from
`fundingPnl(rates, notional, perpDirection)` — already implemented and exported from
`src/paper-trading/live-runner.ts:131-139`, reused as-is (that function already encodes
"longs pay positive rate, shorts receive" correctly; no reason to reimplement it).

## Data layer

Two new standalone functions, same factoring pattern already used twice in this plan
(`fetchOpenInterestHist`, `fetchOrderBookImbalance`):

- `fetchSpotPrice(symbol): Promise<{ price: number } | { error, message }>` — new, hits
  `/api/v3/ticker/price`. No standalone spot-price fetch exists anywhere in this repo today
  (traced during design — `BinancePublicApiTool` is a generic `call()`-only wrapper,
  `getLiveTick` gives a WS spot tick but requires a live stream subscription, not a one-shot
  REST read appropriate for a periodic poll).
- `fetchFuturesStats(symbol): Promise<{ markPrice, lastFundingRate, nextFundingTime, openInterest } | { error, message }>` —
  factored out of `BinanceFuturesStatsTool.call()` (`src/tools/binance-tools.ts:219-259`),
  same refactor shape as sub-project 2's `fetchOrderBookImbalance` extraction.

`fetchFundingRates` (`src/paper-trading/live-runner.ts:692-698`, currently a private
`async function`) gets `export` added — one-line change, so this new module reuses the
exact same funding-history fetch `LivePaperRunner` already uses rather than duplicating the
endpoint call a third time in this codebase.

## `FundingArbTracker`

New file, `src/paper-trading/funding-arb.ts`. Modeled on `ShadowSignalTracker`'s
persistence shape (state file + JSONL journal, `start()`/`stop()`) but with its own position
shape — no `CandidateSignal` reuse, the interfaces don't overlap.

Per configured symbol, each poll:
- If no open position and `|lastFundingRate| > 0.0003` (0.03%/8h): open. `perpDirection =
  lastFundingRate > 0 ? "short" : "long"` (short perp collects when longs pay; long perp
  collects when shorts pay — the long-perp/short-spot case is a paper-only simplification,
  no real spot-borrow constraint modeled, marked with a `ponytail:` comment naming the
  ceiling). Fixed `$2000` notional per position (config constant, not per-symbol tuned).
- If a position is open: accrue funding since the last check (reusing the same
  8-hour-boundary-crossing gate `LivePaperRunner` already uses — no need to hit the funding-
  rate endpoint more often than funding actually pays), update the running `accruedFunding`
  and current basis. Close when `|lastFundingRate| < 0.0001` (normalized — the whole
  premise the position was opened for has decayed) or 14 days held (a carry trade, deliberately
  much longer than OBI's 4h — funding arb's edge is the accumulated 8h payments, not a quick
  reversion).

Persists to `.trading-agent/funding-arb-state.json` / `.trading-agent/funding-arb-
trades.jsonl` — same file-naming and read/write pattern as every other tracker in this plan.

## Daemon wiring

`scripts/autonomous-trading-daemon.ts` gets one more tracker instance (same 3 symbols,
`XRPUSDT`/`ETHUSDT`/`SOLUSDT`), started/stopped alongside `shadowTracker`. Independent
instance, independent files — not merged into the shadow tracker's journal, since the
position shape and promotion question (there is none here) are unrelated.

## Report

`scripts/funding-arb-report.ts` — reads the ledger's journal, reports realized PnL / funding
collected / basis PnL / hold duration per closed position, plus currently-open positions'
unrealized state. Informational only — there's no `strategies.json`-style promotion gate
for this signal (it was never going to enter that pool, and there's no "shadow vs live"
distinction here the way OBI/liq-cluster have one) — this script exists so the ledger's
results are actually visible, not turned into a decision gate.

## Testing

`fetchSpotPrice` and `fetchFuturesStats`: Jest, mocked fetch, same convention as every prior
data-layer function in this plan. `FundingArbTracker`'s open/accrue/close/PnL-formula logic:
Jest with a fake `fetchSpotPrice`/`fetchFuturesStats`/`fetchFundingRates` injected (function
parameters, not module-level mocking) so the PnL formula itself gets a deterministic,
non-real-network unit test — unlike `ShadowSignalTracker`, which legitimately needs a real
live tick for its stop/target logic, this tracker's correctness is really about the PnL
arithmetic, which should be tested precisely against known inputs.

## Out of scope (belongs to the last spec in this plan)

- Stat-arb pairs engine (spec 5) — remains a separate, from-scratch cross-symbol spread
  engine; nothing in this spec is reusable there.
