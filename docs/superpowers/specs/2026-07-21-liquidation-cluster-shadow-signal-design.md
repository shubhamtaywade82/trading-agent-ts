# Liquidation-Cluster Shadow-Signal (sub-project 3 of 5)

Part of the same larger plan as
[2026-07-21-oi-divergence-signal-design.md](2026-07-21-oi-divergence-signal-design.md) and
[2026-07-21-obi-shadow-signal-design.md](2026-07-21-obi-shadow-signal-design.md). This spec
reuses sub-project 2's `ShadowSignalTracker`/`CandidateSignal` machinery directly — no new
tracker, no new persistence layer. The scope here is smaller than the original 5-sub-project
plan anticipated once the reuse was traced through: liquidation-cluster candidates fold into
the *same* tracker instance and journal the daemon already runs for OBI, not a second one.

## Why, and the same constraint as OBI

Binance's public API has no historical liquidation feed — only the live `!forceOrder@arr`
WebSocket, buffered by `BinanceStreamManager` (`getLiquidations()`). Same conclusion as OBI:
forward shadow-paper validation only, no backtest possible.

## The signal

Binance's `forceOrder` `side` field is the side of the *closing* order, not the position
that got liquidated: a `SELL`-side liquidation event closed a long position (forced
selling), a `BUY`-side event closed a short (forced buying). A burst of same-side
liquidations reads as a cascade — forced selling into a long-liquidation burst looks like
capitulation (contrarian long candidate once it exhausts); forced buying into a
short-liquidation burst looks like a squeeze (contrarian short candidate). This is a fade,
not a momentum-follow — same "stop hunt, then reversal" read the original liquidation-
heatmap idea proposed.

Fire rule: ≥5 same-side liquidations for the symbol within a trailing 5-minute window →
fire the opposite direction. Exit: 2% stop / 4% target / 4h max hold — wider stop than
OBI's 1.5%/3% since a contrarian entry right after a cascade can still see continuation
before the reversal this bet is on.

## A real constraint, stated plainly

`BinanceStreamManager`'s liquidation buffer is a single 200-event cap shared across *every*
Binance futures symbol, not per-symbol (`src/exchange/binance-stream.ts`, `MAX_LIQUIDATIONS_
BUFFERED`). A burst on XRPUSDT can be pushed out of the buffer by unrelated BTC/ETH
liquidations (which dominate liquidation volume) before this signal ever reads it. Not fixed
here — raising the cap or making it per-symbol would change behavior for every other
consumer of `getLiquidations()` (namely `BinanceLiquidationsTool` itself), which is out of
scope for a signal-validation experiment. This candidate is a best-effort read of "recent
cluster," not a guaranteed-complete one — worth remembering when reading its shadow results
later; a string of zero fires could mean "no clusters happened" or "clusters happened but
got evicted by BTC/ETH noise before the daemon's poll caught them."

## Implementation shape

`detectLiquidationCluster(stream: BinanceStreamManager, symbol: string, windowMs: number,
threshold: number): "long" | "short" | null` — new synchronous helper in `binance-stream.ts`
(co-located with the buffer it reads, unlike OBI's REST-fetch helper which lives in
`binance-tools.ts`). Filters `stream.getLiquidations(symbol)` to events within `windowMs` of
now, counts by side, returns the contrarian direction if either side count clears
`threshold`.

Daemon wiring (`scripts/autonomous-trading-daemon.ts`): subscribe to the liquidation stream
once at startup, in the same block that already subscribes the ticker/kline streams (not
lazily inside `checkFire` — matches the existing upfront-subscribe pattern). Append 3 more
`CandidateSignal` entries (`liq-cluster-XRPUSDT`, `liq-cluster-ETHUSDT`, `liq-cluster-
SOLUSDT`) to the same array already feeding the one `ShadowSignalTracker` instance — same
state file, same journal, no second tracker.

## Promotion report

`scripts/obi-shadow-report.ts` is renamed `scripts/shadow-signal-report.ts` (its logic is
already generic per candidate id via `summarizeShadowJournal` — no OBI-specific code exists
in it) and its header comment updated to describe both signal families. Same gate as sub-
project 2: ≥20 fires, net-positive, 3-week minimum window, reviewed manually before flipping
`shadow: false`.

## Testing

`detectLiquidationCluster` is pure and synchronous — unit-tested with a fake `Liquidation[]`
array timestamped relative to a fixed "now" (via a small `BinanceStreamManager` test double
that only implements `getLiquidations()`, since this function's only dependency is that one
method — no real network needed, unlike `ShadowSignalTracker`'s own tests which do need a
real stream for live-tick pricing). Daemon wiring gets the same manual smoke-test treatment
as sub-project 2's Task 3 (no unit test for the daemon script itself, matching this repo's
existing practice for that file).

## Out of scope (belongs to later specs in this plan)

- Funding-rate-arbitrage bolt-on ledger (spec 4)
- Stat-arb pairs engine (spec 5)
