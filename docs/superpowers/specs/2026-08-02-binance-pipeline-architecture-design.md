# Binance Pipeline Architecture — 5-Phase Module Map

Paper-trading-first, broker-swappable platform: `binance-client-js` supplies transport
and execution primitives; `trading-agent-ts` supplies market state, deterministic
features, event detection, canonical snapshots, LLM reasoning, risk validation, and
replay/backtest. Live execution is Phase 1's account/order plumbing made *available*,
not made *default* — every consumer of it defaults to testnet/paper until a strategy
has cleared replay and paper trading over a statistically meaningful sample.

## Read this first: what already exists

Before adding anything, a full pass over `src/` turned up two facts that reshape the
plan below versus a from-scratch build:

1. **`binance-client-js` is not an npm package.** It is `shubhamtaywade82/binance-client-js`
   on GitHub — cloned and inspected directly (`binance-futures-client.js` /
   `.d.ts`, 80+ methods) to ground every claim in this doc. It ships CommonJS
   (`module.exports = { BinanceFuturesClient, ... }`), no `"type": "module"`, consumed
   fine from this repo's ESM via `esModuleInterop` (already on in `tsconfig.json`).
   Every REST/WS method listed here is copied from the real `.d.ts`, not assumed.

2. **Phases 2, 3, and most of 6 already exist, scattered across three subsystems that
   don't share a common data contract yet:**

   | Concern | Already lives at | Notes |
   |---|---|---|
   | Classic TA (SMA/EMA/RSI/MACD/Bollinger/ATR/ADX/SuperTrend/Ichimoku) | `src/tools/indicators.ts` | Pure deterministic functions, series + scalar variants. |
   | SMC/ICT structure (BOS/CHoCH/MSS, OB, FVG, breaker, inverse-FVG, liquidity sweeps, judas swings, premium/discount/OTE, VWAP, CVD, volume-profile HVN/LVN/POC, killzone sessions, confluence score) | `src/concepts/adapter.ts` (`ConceptsEngine`, wraps `trading-concepts-ts`) | Returns `PerBarSignals` — one boolean/number array per signal, indexed by bar. This **is** the feature engine's structure half; do not rebuild it. |
   | Rule-based strategy pool, entry/exit conditions, position sizing, trailing stops, correlation guard, funding charge/credit | `src/paper-trading/live-runner.ts` + `strategies.json` + `src/tools/backtest-tools.ts` | The mature, actually-running crypto-futures paper trader. Polls Binance REST per (symbol, timeframe), no persistent multi-TF state store yet — see Phase 1's `MarketState` gap below. |
   | LLM pre-trade veto (Ollama, tool-calling, fail-closed) | `src/paper-trading/ai-gate.ts` | Narrow: reviews an *already-fired* rule signal, outputs `APPROVE size=X \| REJECT`. Not a full snapshot-in/LONG-SHORT-AVOID-out reasoner — Phase 5 below extends this pattern, doesn't replace it. |
   | Backtest / walk-forward / Monte Carlo / param sweep | `src/tools/backtest-tools.ts` (`runFuturesBacktest` + friends) | Mature, is the one shared simulation loop this repo already insists on (see `docs/superpowers/specs/2026-07-28-smc-engine-consolidation-design.md`). Phase 6 below is specifically "replay through the LLM+snapshot pipeline," which is new; replaying through raw rule conditions is not. |
   | Generic FSM + `IBrokerage` + `RuleEngine` + `RiskManager` | `src/agent.ts`, `src/fsm/agentMachine.ts`, `src/brokerage/`, `src/rules/engine.ts`, `src/risk/riskManager.ts`, `src/domain/types.ts` | A **second, smaller, symbol-agnostic** trading-agent skeleton (config defaults to `AAPL`/`MSFT`), disconnected from the crypto/live-runner lineage above. `IBrokerage` (`getAccount`/`submit`/`cancel`/`markToMarket`) is the cleanest existing broker-swap interface in the repo, but nothing crypto-specific implements it today. |
   | Public, unauthenticated Binance REST | `src/tools/binance-client.ts` (`fetchBinance`) | **Deliberately GET-only** — `AGENTS.md` architecture decision #2: "Public API tools never send API keys." Phase 1's authenticated adapter is a new, explicitly separate code path, not a modification of this one. |

   Net effect: **Phase 1 (auth'd exchange access + a real multi-timeframe market-state
   store) and Phase 4 (canonical snapshot assembly) are the actual net-new work.**
   Phase 2/3/6 are mostly "wire existing engines into the new contract," not "build
   from zero." Phase 5 extends `ai-gate.ts`'s proven pattern rather than inventing a
   parallel LLM-calling convention.

3. **Two trading-agent skeletons already coexist** (`agent.ts`/`IBrokerage` vs.
   `live-runner.ts`/`SymbolPositionManager`). This plan targets the crypto/live-runner
   lineage — it's the one that's actually Binance-futures-shaped and 90% built.
   Reconciling the two skeletons into one broker-swap story is a real question but is
   explicitly **out of scope** here; flagging it rather than silently picking a side.

## Target module map

Per the requested layout, using `src/types/` as the shared-interface root every other
folder imports from (prevents the "three SMC engines" duplication mistake this repo
already paid down once):

```
src/
  types/                      # canonical interfaces — Phase 0, everything else depends on this
    market.ts                 # Timeframe, FuturesCandle, OrderSide/Type, PositionRisk, ...
    snapshot.ts                # MarketSnapshot zod schema (Phase 4's payload)
    decision.ts                 # LLM decision schema (Phase 5's payload)
  exchange/
    binance/
      client.ts                # BinanceFuturesAdapter — thin typed wrapper over binance-client-js
      user-stream.ts           # listenKey lifecycle + ORDER_TRADE_UPDATE/ACCOUNT_UPDATE normalization
  market-state/
    candle-store.ts             # per-symbol, per-timeframe rolling candle buffers, WS-fed + REST-backfilled
    market-state.ts             # facade: latest candle/ticker/funding/OI/depth per symbol
  features/
    technical.ts                 # adapter over existing src/tools/indicators.ts — no reimplementation
    structure.ts                 # adapter over existing ConceptsEngine — no reimplementation
    regime.ts                    # volatility/trend regime classification (net new, small)
  events/
    event-bus.ts                 # NEW_CANDLE / BOS / CHOCH / FVG_FILLED / OB_MITIGATED / ... typed pub-sub
    detectors.ts                  # translates PerBarSignals + candle-close into named events
  snapshots/
    snapshot-builder.ts          # assembles one MarketSnapshot per symbol from market-state + features + events
  llm/
    decision-engine.ts            # snapshot in, LONG/SHORT/AVOID decision out (extends ai-gate.ts's tool-call pattern)
    prompt.ts                     # system prompt + tool schema (see contract below)
  risk/
    decision-validator.ts         # propose/dispose gate: RR floor, HTF conflict, stale data, missing trigger
  replay/
    snapshot-replay.ts            # historical candles -> snapshots -> LLM -> paper fills -> stats
  brokerage/                      # existing folder — BinanceBroker added here later, implements IBrokerage
```

Only `src/types/` and `src/exchange/binance/` are implemented in this change (Phase 1
below); the rest of the tree above is the target shape for Phases 2-6, described here
so file placement and interfaces are settled before anyone writes them.

## Canonical types (`src/types/`)

`src/backtest/types.ts`'s `Candle` (`openTime/open/high/low/close/volume`) stays the
one OHLCV shape everywhere — `src/types/market.ts` imports and extends it, it does not
redefine it:

```ts
export type Timeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" | "1w";

export interface FuturesCandle extends Candle {
  closeTime: number;
}

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";

export interface PositionRisk {
  symbol: string;
  positionAmt: number;      // signed: + long, - short
  entryPrice: number;
  markPrice: number;
  unrealizedProfit: number;
  liquidationPrice: number;
  leverage: number;
  positionSide: string;
}
```

## Phase 1 — Market Data Platform (implemented in this change)

No AI. Two new files:

**`src/exchange/binance/client.ts` — `BinanceFuturesAdapter`.** Thin typed wrapper
around `BinanceFuturesClient` from `binance-client-js`. Covers the subset of the
library's real surface this repo needs today (klines, mark price, open interest,
position risk, order create/cancel/query, user-data stream) behind typed methods;
`.raw` escapes to the untyped client for the other ~70 endpoints rather than
wrapping everything speculatively. **Defaults `testnet: true`** — callers must pass
`testnet: false` explicitly to reach production endpoints, matching
`binance-client-js`'s own "Testnet First" guidance and this repo's existing
fail-closed convention (`ai-gate.ts`'s header comment: "any timeout, network error, or
unparseable response means the trade is skipped, never traded blind"). Constructing it
without both `apiKey`/`apiSecret` throws immediately — no silent anonymous mode for an
adapter whose entire purpose is authenticated access (the anonymous path already exists
at `src/tools/binance-client.ts`).

**`src/market-state/` — the genuinely new piece.** Today, `live-runner.ts` calls
`fetchCandlesRange` once per (strategy, timeframe) on every poll tick — no shared
cache, so N strategies on the same (symbol, timeframe) refetch the same candles N
times, and there's no push-driven update path (WS candle closes) at all, only REST
polling. `market-state/candle-store.ts` is a per-`(symbol, timeframe)` rolling buffer,
backfilled once via `BinanceFuturesAdapter.getKlines` and kept current via
`wsSubscribeCandles`; `market-state.ts` is the read-side facade (`latestCandle`,
`candles(symbol, tf, n)`, `latestMarkPrice`, `latestFundingRate`, `latestOpenInterest`)
that Phases 2-4 read from instead of each independently hitting REST. `live-runner.ts`
migrating onto it is a **future, separate change** — this phase only lands the store
itself, unused by existing call sites, so nothing about current paper-trading behavior
changes.

## Phase 2 — Feature Engine (design only, not built here)

`features/technical.ts` and `features/structure.ts` are adapters, not new math: they
take a `FuturesCandle[]` from `market-state` and call `src/tools/indicators.ts` /
`ConceptsEngine` respectively, reshaping the output into the flat, LLM-friendly field
names `snapshots/snapshot-builder.ts` needs (`ema_slope_1h`, `structure_1h.bullishBOS`,
etc.). `features/regime.ts` is the one actually-new piece: an ATR-percentile-based
volatility regime classifier (`low` / `normal` / `expanding`) and a trend-regime
classifier (EMA stack alignment across timeframes) — small, deterministic, no LLM.

## Phase 3 — Event Engine (design only, not built here)

`events/event-bus.ts`: a typed pub-sub (`on(eventType, handler)` / `emit(event)`),
in-process, no external queue — same complexity level as this repo's existing
`src/runtime` EventBus for the TUI, not a new architectural pattern for the codebase.
`events/detectors.ts` translates `ConceptsEngine`'s `PerBarSignals` booleans into
discrete named events on each new closed candle (`BOS`, `CHOCH`, `FVG_FILLED`,
`OB_MITIGATED`, `LIQUIDITY_SWEEP`, `VOLUME_SPIKE`) plus `NEW_{tf}_CANDLE` from
`market-state`'s WS feed, and `FUNDING_SPIKE`/`OI_SPIKE` from threshold checks against
`market-state`'s funding/OI history. Analysis (Phase 4→5) triggers off these events
instead of a fixed poll interval — this is what makes the pipeline event-driven rather
than "ask the LLM every N seconds."

## Phase 4 — Snapshot Builder (design only, not built here)

The one canonical payload every downstream consumer (LLM, risk gate, replay) reads —
raw Binance/library payloads never reach the LLM. `src/types/snapshot.ts` (zod, mirrors
`src/config/schema.ts`'s style):

```ts
export const MarketSnapshotSchema = z.object({
  symbol: z.string(),
  timestamp: z.number(),
  market: z.object({
    lastPrice: z.number(),
    markPrice: z.number(),
    spread: z.number(),
    fundingRate: z.number(),
    openInterest: z.number(),
  }),
  timeframes: z.record(z.enum(["1m","5m","15m","1h","4h","1d"]), z.object({
    trend: z.enum(["bullish", "bearish", "neutral"]),
    ema: z.object({ fast: z.number(), slow: z.number(), slope: z.number() }),
    rsi: z.number(),
    atr: z.number(),
    volatilityRegime: z.enum(["low", "normal", "expanding"]),
  })),
  structure: z.object({
    bos: z.boolean(),
    choch: z.boolean(),
    orderBlocks: z.array(z.object({ type: z.enum(["bullish","bearish"]), top: z.number(), bottom: z.number(), mitigated: z.boolean() })),
    fvgs: z.array(z.object({ type: z.enum(["bullish","bearish"]), top: z.number(), bottom: z.number(), mitigated: z.boolean() })),
    liquiditySweeps: z.array(z.object({ side: z.enum(["buyside","sellside"]), price: z.number(), time: z.number() })),
  }),
  events: z.array(z.string()),
  dataQuality: z.object({
    missingCandles: z.boolean(),
    stale: z.boolean(),
    reconnectNeeded: z.boolean(),
  }),
});
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;
```

`snapshot-builder.ts` populates this purely from `market-state` + `features` + the
last-N `events` for that symbol — no network calls of its own, no LLM calls. A
`dataQuality.stale: true` or `missingCandles: true` snapshot is a hard signal to Phase
5/6 to short-circuit to `AVOID` before spending an LLM call.

## Phase 5 — Ollama Reasoning Layer (design only, not built here)

Extends `ai-gate.ts`'s already-working pattern (tool-call schema, `Provider.chat`,
fail-closed on timeout/parse-error) rather than inventing a second LLM-calling
convention. `llm/prompt.ts` defines the tool schema (`OllamaToolSchema`, same shape
`ai-gate.ts`'s `DECIDE_TOOL` already uses):

```ts
const DECIDE_TOOL: OllamaToolSchema[] = [{
  type: "function",
  function: {
    name: "submit_trade_decision",
    description: "Submit a structured LONG/SHORT/AVOID decision for this MarketSnapshot. Use ONLY the data provided — never invent price levels, indicators, or structure not present in the snapshot.",
    parameters: {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["LONG", "SHORT", "AVOID"] },
        confidence: { type: "number", description: "0.0-1.0" },
        setupType: { type: "string", enum: ["continuation", "reversal", "breakout", "mean-reversion"] },
        entryZone: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
        stopLoss: { type: "number" },
        targets: { type: "array", items: { type: "number" } },
        invalidation: { type: "string" },
        requiredEvent: { type: "string" },
        noTradeReason: { type: "string", description: "Required when decision is AVOID: htf_conflict | weak_rr | late_entry | data_quality | no_trigger | trapped_between_levels" },
        evidence: { type: "array", items: { type: "string" }, maxItems: 5 },
      },
      required: ["decision", "confidence", "evidence"],
    },
  },
}];
```

System prompt rule, matching `ai-gate.ts`'s framing exactly: "only use provided
snapshot data; never invent indicators or price levels; if `dataQuality` is bad,
respond AVOID with `noTradeReason: data_quality`." `llm/decision-engine.ts` calls
`Provider.chat(messages, { tools: DECIDE_TOOL })`, validates the tool-call arguments
against a zod schema (same "never trust unvalidated model output on a money-affecting
field, schema or not" comment already in `ai-gate.ts`), and on any parse/validation
failure returns `AVOID` — never a silent fallback to "trade anyway."

## Risk / Decision Validator (propose/dispose gate)

`risk/decision-validator.ts` takes the LLM's proposed decision plus the snapshot it was
computed from and either approves or downgrades to `AVOID`, deterministically — the
LLM proposes, this disposes, same division of labor `ai-gate.ts` already established
for the narrower pre-trade-veto case:

- reject if RR (`(target - entry) / (entry - stop)`) is below a configured floor
- reject if the proposed direction conflicts with the 4H/1D `structure.trend` in the
  snapshot (HTF conflict)
- reject if `dataQuality.stale` or `missingCandles`
- reject if `requiredEvent` isn't present in the snapshot's recent `events` list
  (missing trigger — the setup hasn't actually happened yet)

## Replay / Backtest (Phase 6, design only, not built here)

`replay/snapshot-replay.ts` is specifically "replay historical candles through
snapshot-builder → LLM decision-engine → paper fill → stats," which is new — the
existing `runFuturesBacktest` replays through deterministic rule conditions only and
never calls an LLM. Structurally: walk `FuturesCandle[]` from a `market-state` seeded
with historical data, build a `MarketSnapshot` at each candle close, call the same
`decision-engine.ts` Phase 5 uses, feed `LONG`/`SHORT`/`AVOID` into a paper-fill
simulator, and score outcomes (win rate, profit factor, expectancy, precision by
setup type / symbol / volatility regime) — reusing `runFuturesBacktest`'s fill/PnL
math where the shapes line up, not a second simulation loop. This is expensive (one
Ollama call per candle close) and is explicitly a later phase — Phase 1-4 must exist
and be trustworthy before it's worth the compute.

## Broker interface (paper-first, swappable)

`src/brokerage/IBrokerage.ts` (`getAccount`/`submit`/`cancel`/`markToMarket`) is
already the right shape for "PaperBroker today, BinanceBroker later, same interface" —
it just has no crypto-futures implementation yet. Once Phase 1's `BinanceFuturesAdapter`
exists, a `BinanceBroker implements IBrokerage` wrapping it is a small, mechanical
follow-up: `submit()` calls `client.createOrder`, `getAccount()` calls
`client.getPositionRiskV3`/`getBalanceV3`, `markToMarket()` becomes a no-op (Binance
computes unrealized PnL server-side). **Not built in this change** — nothing today
constructs an `IBrokerage` for crypto futures, so there's no live call site to wire it
into yet, and wiring one prematurely is exactly the "build the execution engine first"
mistake this plan is structured to avoid.

## Safety notes

- `AGENTS.md`'s architecture decision #2 ("GET-only Binance tools — never send API
  keys") describes `src/tools/binance-client.ts` specifically, not the whole repo.
  `BinanceFuturesAdapter` is a new, explicitly separate, opt-in code path (requires
  `BINANCE_API_KEY`/`BINANCE_API_SECRET` env vars to construct at all) — it does not
  weaken that guarantee for the existing public tools.
- Defaults to Binance **testnet**. Reaching production requires an explicit
  `testnet: false` at the call site — never an env-var default flip.
- No call site in this change places a real order. Phase 1 lands the capability;
  nothing in the paper-trading loop is wired to use it.
