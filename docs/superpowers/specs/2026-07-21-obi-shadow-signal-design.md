# OBI Shadow-Signal (sub-project 2 of 5)

Part of the same larger plan as
[2026-07-21-oi-divergence-signal-design.md](2026-07-21-oi-divergence-signal-design.md).
This spec covers order-book-imbalance (OBI). Liquidation-cluster (sub-project 3) is a
separate spec that reuses this one's tracker.

## Why, and the constraint that reshapes everything

Binance's public API has no historical order-book snapshots — only a live REST depth
endpoint and a live WebSocket. There is nothing to backtest against; OBI can only be
validated by running it forward and watching what happens. That was already decided
(forward shadow-paper gate) before this spec was written.

The deeper consequence, only fully clear after tracing the engine: **OBI can never become
a `strategies.json` entry**, shadow period or not. That pool is candle-driven —
`buildSignalEvaluator` evaluates a condition per closed bar of OHLCV data — and order-book
imbalance isn't derivable from OHLCV at all. It's a live snapshot metric with no bar index.
So "promotion" in this spec doesn't mean migrating into the existing pool the way
OI-divergence's sweep script might. It means flipping a `shadow: false` flag on OBI's own,
separate, permanent tracker. OBI strategies live in their own system forever, not in
`strategies.json`.

## What's in scope

A generic, persisted, live-tick-driven position tracker (built with sub-project 3's
liquidation-cluster reuse in mind, but not built beyond what OBI needs today), wired into
the existing daemon process, plus a shadow-period report script. No new process — this
repo already runs one unified daemon (`scripts/autonomous-trading-daemon.ts`) ticking
several independent monitor components in one loop; this is one more.

## Data layer

Factor the imbalance computation out of the existing `BinanceOrderBookTool` (`src/tools/
binance-tools.ts:167-219`) into a standalone exported function, so the live tool and the
tracker share one implementation — the same "don't reimplement the signal logic" rule
`buildSignalEvaluator`'s header comment states for the candle-based pool:

```ts
export async function fetchOrderBookImbalance(
  symbol: string, market: string, limit: number,
): Promise<{ imbalance: number; bestBid: number | null; bestAsk: number | null } | { error: string; message: string }>
```

`BinanceOrderBookTool.call()` is refactored to call this and shape its existing richer
response (`bidVolume`, `askVolume`, etc.) around it — no behavior change to the tool itself.

## The tracker

`src/paper-trading/shadow-signal-tracker.ts`, new file. Deliberately generic over "what
counts as a fire" so liquidation-cluster can plug in without a rewrite — but nothing more
generic than that; no plugin registry, no config DSL, just a function parameter.

```ts
export interface CandidateSignal {
  id: string;
  symbol: string;
  shadow: boolean; // true = paper-only, not yet counted as validated
  checkFire: () => Promise<"long" | "short" | null>;
  stopPct: number;
  targetPct: number;
  maxHoldMs: number;
}
```

For OBI specifically, `checkFire` wraps `fetchOrderBookImbalance(symbol, "usdm", 50)`:
returns `"long"` if `imbalance > 0.3`, `"short"` if `imbalance < -0.3`, else `null`.
(Positive imbalance = more bid volume near top-of-book = buy pressure = long bias — same
sign convention `BinanceOrderBookTool`'s description already documents.)

Each poll tick (called from the daemon at the same cadence as everything else, default
60s):

1. For every candidate with no currently-open tracked position, call `checkFire()`. On a
   non-null result, open a position at the current live tick price (same "subscribe, wait
   up to 5s for a tick" pattern `PaperTradingManager.open()` already uses), recording
   `stopPrice`/`targetPrice` from the candidate's `stopPct`/`targetPct` and an
   `openedAt`/`maxHoldMs` deadline — the one thing `PaperTradingManager` doesn't have today
   (it only auto-closes on stop/target, never on time).
2. For every open position, mark to market against the live tick: close on stop, target,
   or `Date.now() - openedAt >= maxHoldMs` (reason `"timeout"`).

State persists to `.trading-agent/shadow-state.json` (open positions) and every
open/close event appends to `.trading-agent/shadow-trades.jsonl` — same
state-file-plus-journal shape `LivePaperRunner` already uses, for consistency and so
existing log-tailing habits carry over.

`start(intervalMs)` / `stop()` methods, matching the convention every other daemon
component already follows (`analyst.start(...)`, `circuitBreaker.start(...)`, etc.).

## Daemon wiring

`scripts/autonomous-trading-daemon.ts` constructs one `ShadowSignalTracker` (reusing the
daemon's existing `stream` instance — no second WebSocket connection) with the three OBI
candidates (XRPUSDT, ETHUSDT, SOLUSDT; `stopPct: 0.015, targetPct: 0.03, maxHoldMs: 4 *
60 * 60 * 1000`, all `shadow: true`), starts it alongside `runner.start(...)`, and adds
`shadowTracker.stop()` to the existing `shutdown()` function's stop-list.

## Promotion report

`scripts/obi-shadow-report.ts`: reads `.trading-agent/shadow-trades.jsonl`, groups by
`id`, computes fire count / win rate / profit factor / total PnL% per symbol over the
shadow window. Reports `SURVIVES` (≥20 fires AND net-positive) or not yet / failed per
symbol — printed, not written. Flipping a candidate's `shadow: false` in the daemon
script's config is a manual, reviewed edit once the report says SURVIVES, matching sub-
project 1's Task 6 convention of scripts never auto-promoting.

## Testing

Same convention as sub-project 1: Jest unit tests for `fetchOrderBookImbalance` (mocked
fetch) and `ShadowSignalTracker`'s fire/stop/target/timeout logic (a fake `BinanceStream
Manager`-shaped stub feeding scripted tick sequences, no real network) in the implementation
plan's tasks, plus a hand-run sanity script for the real order-book endpoint, following the
same pattern as `scripts/oi-divergence-verify.ts`.

## Out of scope (belongs to later specs in this plan)

- Liquidation-cluster signal, reusing this spec's `ShadowSignalTracker` and
  `CandidateSignal` interface (spec 3)
- Funding-rate-arbitrage bolt-on ledger (spec 4)
- Stat-arb pairs engine (spec 5)
