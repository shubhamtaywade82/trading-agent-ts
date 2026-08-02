# Phase 1: Market Data Platform — Implementation Plan

**Goal:** Land the authenticated Binance USDⓈ-M Futures adapter and a shared
multi-timeframe candle store, per
`docs/superpowers/specs/2026-08-02-binance-pipeline-architecture-design.md`. No AI, no
existing call site changed, no live order ever placed by this change.

**Tech stack:** TypeScript, `binance-client-js` (`github:shubhamtaywade82/binance-client-js`,
not on npm — pinned to commit `c26c8602fbfc609a92af6c2ac59575fe05734b16`), Jest.

**Constraint:** `BinanceFuturesAdapter` defaults `testnet: true`. Constructing it
without `apiKey`/`apiSecret` throws. This is a separate, opt-in path from the existing
GET-only `src/tools/binance-client.ts` (`AGENTS.md` architecture decision #2) — nothing
here modifies that file.

**Known environment limitation:** this sandbox has no `node_modules` (the repo's
`trading-concepts-ts` `file:` dependency points at a sibling directory that doesn't
exist here), so `npm install`/`tsc`/`jest` could not be run to verify this change in
this session. The new files were written to match `tsconfig.json`'s strict settings
and existing code patterns by inspection; **run `npm install && npx tsc -p
tsconfig.json --noEmit && npm test` in an environment with the full workspace before
trusting this compiles clean.**

---

### Task 1: canonical types (`src/types/`)

**Files:** Create `src/types/market.ts`

**Interfaces:** `Timeframe`, `FuturesCandle` (extends `Candle` from
`src/backtest/types.ts` with `closeTime`), `OrderSide`, `OrderType`, `PositionRisk`,
`OrderParams`, `OrderResult`, `FuturesTicker`, `OpenInterest` — consumed by Task 2.

No test file — pure type definitions, nothing to assert at runtime.

### Task 2: `BinanceFuturesAdapter`

**Files:** Create `src/exchange/binance/client.ts`

**Interfaces:**
- Consumes: `BinanceFuturesClient` from `binance-client-js`; types from Task 1.
- Produces: `BinanceFuturesAdapter` class (`getKlines`, `getMarkPrice`,
  `getOpenInterest`, `getFundingRateHistory`, `getPositionRisk`, `createOrder`,
  `cancelOrder`, `getOpenOrders`, `subscribeKlines`, `subscribeUserStream`,
  `closeAll`, `.raw` escape hatch), `binanceFuturesAdapterFromEnv()` factory reading
  `BINANCE_API_KEY`/`BINANCE_API_SECRET`/`BINANCE_TESTNET`.

Every method's response typing was written against the real `.d.ts` fetched from
`shubhamtaywade82/binance-client-js` (methods return `Promise<any>` there — this
wrapper narrows the specific fields it reads, it does not assume the library's
internal typing is trustworthy beyond "it's a promise").

### Task 3: `MarketState` candle store

**Files:** Create `src/market-state/candle-store.ts`, `src/market-state/market-state.ts`

**Interfaces:**
- Consumes: `BinanceFuturesAdapter` (Task 2).
- Produces: `CandleStore` (per `(symbol, timeframe)` rolling buffer: `backfill()`,
  `push()`, `latest()`, `get(n)`), `MarketState` facade (`latestCandle`, `candles`,
  `latestMarkPrice`, `latestFundingRate`, `latestOpenInterest`, `start`/`stop`).

Not wired into `live-runner.ts` in this change — net-new, currently unused by existing
call sites, so current paper-trading behavior is unaffected. A follow-up phase migrates
`live-runner.ts`'s per-strategy `fetchCandlesRange` polling onto this shared store.

### Task 4: dependency + env wiring

**Files:** Modify `package.json` (add `binance-client-js` git dependency),
`.env.example` (add `BINANCE_API_KEY`, `BINANCE_API_SECRET`, `BINANCE_TESTNET`)

No behavior change for anyone not setting the new env vars — `binanceFuturesAdapterFromEnv()`
returns `null` when the keys are absent (Task 2).

---

## Explicitly deferred (see design spec for the full module map)

- Features/events/snapshot/LLM/risk-validator/replay (Phases 2-6) — design-only for
  now, listed in the spec with target file paths so Phase 1's types don't need to
  change shape later.
- Migrating `live-runner.ts` onto `MarketState` — separate change, needs its own
  before/after behavior check against the existing REST-polling path.
- `BinanceBroker implements IBrokerage` — no live call site to wire it into yet
  (see spec's "Broker interface" section for why this is deliberately not built here).

## Self-Review Notes

- Every `binance-client-js` method name referenced (`getKlines`, `getMarkPrice`,
  `getOpenInterest`, `getFundingRateHistory`, `getPositionRiskV3`, `createOrder`,
  `cancelOrder`, `getOpenOrders`, `wsSubscribeCandles`, `subscribeUserStream`,
  `closeAllWebSockets`) was checked against the real `binance-futures-client.d.ts`,
  not assumed from the design write-up that kicked this off.
- No test suite could be run in this sandbox (see Known environment limitation above)
  — flagged explicitly rather than claimed as passing.
