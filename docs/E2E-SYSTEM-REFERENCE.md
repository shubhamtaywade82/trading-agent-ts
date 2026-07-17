# trading-agent-ts — End-to-End System Reference

Purpose of this document: a complete, self-contained description of this repository for use as context in an external AI research/consulting conversation (architecture review, live-execution design, risk-engine advice, etc.). Written from direct code inspection, not marketing copy — every claim below is traceable to a file path.

Snapshot date: 2026-07-17.

---

## 1. One-paragraph summary

TypeScript/Node.js system with two halves that share a codebase but run independently:

1. **A general-purpose terminal LLM coding/ops agent** ("DevAgent") — Ink-based TUI, tool-calling loop over Ollama models (local + cloud), with tools for filesystem, git, docker, shell (sandboxed), browser automation, and Binance market data. This is the `src/tui`, `src/orchestrator`, `src/tools`, `src/runtime` core.
2. **A crypto-futures paper-trading research rig** built on top of that same tool infrastructure — a rule-based (not ML-based) strategy pool, backtested on real Binance historical data, run forward as simulated (paper) trades against live Binance prices, with an LLM used only for advisory commentary, never for entry/exit decisions. This is `src/paper-trading/*`, `src/exchange/*`, `strategies.json`, `scripts/autonomous-trading-daemon.ts`.

**No live order execution exists anywhere in the codebase.** No exchange API keys, no HMAC-signed requests, no order-placement calls. This is deliberate, not an oversight — see §1a.

---

## 1a. Project goal / phased plan

Stated intent, current phase:

1. **Phase 1 (current): paper trading only.** Run the strategy pool live-simulated against real Binance prices (§5.4–5.6) until enough real paper-trading data has accumulated to pass the deterministic readiness gate (`src/paper-trading/readiness.ts`, §5.5) — minimum trade counts, live PF/win-rate holding up against the backtest reference, no persistent drift-monitor alerts. No live order code is being written during this phase.
2. **Phase 2 (later, gated on Phase 1 data): live execution via CoinDCX.** Once paper-trading readiness is met, wire a live execution layer against **CoinDCX** — both order execution (place/cancel/modify) and user/account operations (balance, margin, position sync). Not started; no CoinDCX code exists yet (§6.4). This repo's paper-trading output (validated strategy pool + risk gates) is meant to be the input a future CoinDCX execution layer consumes, not something built in parallel with it.

Do not add live-order-placement code (to CoinDCX or any exchange) until explicitly asked — the working assumption for all changes in the meantime is paper-trading-only.

---

## 2. Repository layout

```
src/
├── provider/        Ollama REST client (local + cloud tiers), model catalog, capability-based router
├── exchange/
│   ├── binance-stream.ts   WebSocket manager: ticker, liquidation feed, kline streams, price alerts
│   └── paper-trading.ts    Minimal in-memory paper position tracker (superseded by src/paper-trading/live-runner.ts for the real daemon)
├── backtest/         Backtest engine (runFuturesBacktest), walk-forward, Monte Carlo, param sweep, portfolio math
├── paper-trading/    The real paper-trading system (see §5) — live-runner, circuit-breaker, drift-monitor,
│                     readiness gate, trade-analyst (LLM), trade-evaluator (LLM), research-pipeline, notifier
├── tools/            20+ tool implementations exposed to the LLM: binance-tools, backtest-tools, filesystem,
│                     git, docker, shell (sandboxed), browser, github, database, search, edit, project tools
├── orchestrator/     Plan-step state machine, dependency-aware execution, loop detection, checkpoint/resume
├── runtime/          Event bus, state store, config constants, session/task-machine
├── tui/              Ink terminal UI (DevAgent) — zones, agent bridge, plan generator
├── interaction/      Slash commands, keybindings, history, autocomplete, picker
├── skills/           Skill loader/registry/resolver (markdown-defined agent skills)
├── benchmark/        Model scoring harness (JSON validity, tool-calling accuracy, latency)
├── mcp/              MCP client + tool adapter (Model Context Protocol)
└── layout/           Terminal layout primitives (strips, truncation, theme)

scripts/              ~30 one-off research scripts (sweeps, verification passes) + the 4 operational entry points:
  autonomous-trading-daemon.ts   Main long-running paper-trading process
  daemon-watchdog.sh             Crash-restart supervisor for the daemon
  paper-trade-runner.ts          Minimal single-shot runner (no daemon extras)
  paper-trade-tui.tsx            Ink dashboard for live paper-trading state
  paper-trade-chat.ts            Read-only chat interface over trading state

strategies.json       The validated strategy pool (data, not code) — see §6
docs/                 SPEC.md (TUI design contract), FINAL-REPORT.md (research history, see §6.3), requirements/
tests/                Jest suite mirroring src/ structure
```

---

## 3. Tech stack

| Layer | Technology |
|---|---|
| Language | TypeScript, ES2022 target, strict, ESM (`"type": "module"`) |
| Runtime | Node.js >= 20 |
| LLM provider | Ollama REST API — local (`http://localhost:11434`) or Ollama Cloud (`OLLAMA_API_KEY`) |
| Default model | `qwen3.5:4b` (local); paper-trading LLM components default to `gpt-oss:20b` (cloud) |
| Market data | Binance public REST + WebSocket (spot, USD-M futures, COIN-M futures) — no auth, no order endpoints |
| Persistence | Flat JSON state files + JSONL append-only journals under `.trading-agent/`; `better-sqlite3` for the DevAgent's own conversation memory (unrelated to trading state) |
| TUI | Ink (React for terminals) |
| Testing | Jest + ts-jest (ESM preset), `tests/` mirrors `src/` |
| Sandboxing | Docker container for shell-tool command execution (no network, resource limits) |
| Notifications | Telegram Bot API (optional), terminal bell |

No database server, no message queue, no container orchestration, no cloud infra config anywhere in the repo. Single Node process(es), local disk state.

---

## 4. The DevAgent half (general tool-calling agent)

Not trading-specific — this is the substrate. Relevant because the paper-trading system's LLM components (`TradeAnalyst`, `TradeEvaluator`) reuse its `Provider`/`Router` classes.

- **`Provider`** (`src/provider/provider.ts`): thin REST client wrapping Ollama's chat API, typed errors (`RateLimitError`, `TimeoutError`, `ProviderError`).
- **`Router`** (`src/provider/router.ts`): given a `Capability` tag (e.g. `"reasoning"`, `"quick"`, `"tools"`), picks a candidate model from the `ModelCatalog`, tries local tier first, falls back through candidates on recoverable errors (rate limit, timeout, "model doesn't support tools"). Not a load balancer — sequential fallback only, no cost/latency-aware routing.
- **`ModelCatalog`** (`src/provider/catalog.ts`): discovers installed local models + configured cloud models, tags by capability.
- **Orchestrator** (`src/orchestrator/orchestrator.ts`): explicit state machine per plan step (`pending → analyzing → planning → implementing → testing → reviewing → completed`, plus `blocked`/`failed`/`rejected`/`rolledback`/`cancelled` branches with a defined transition table). Retries capped (`DEFAULT_MAX_RETRIES=3`), replans capped (`DEFAULT_MAX_REPLANS=5`). Backed by `CheckpointStore` so a crashed run resumes without re-running completed steps.
- **Loop detector** (`src/orchestrator/loop-detector.ts`): flags repeated identical tool-call signatures to break infinite retry loops.
- **Tool registry** (`src/tools/registry.ts`): ~20+ tools, JSON-schema described, dispatched to the LLM's tool-calling turns. Binance tools are GET-only (see §5.1); shell tool runs inside a Docker sandbox with no network, bounded CPU/memory, 2 MiB output ceiling, and a timeout.
- **TUI** (`src/tui/`): fixed-layout terminal UI per `docs/SPEC.md` — Header / Active View / Activity Strip / Prompt / Context Strip, always-visible zones, no page navigation, semantic-only color (green=healthy, red=error, purple=model activity, etc.). Single source of truth is `src/runtime/store.ts`, updated via an event bus (`src/runtime/events.ts`) that every "actor" (conversation, planner, executor, tasks, git, logs, memory, models, mcp) publishes to.

This half is a coding/ops assistant framework, not a trading engine. It matters for the trading half only as the LLM plumbing the advisory components reuse, and as the tool-calling substrate a human/LLM operator could use to inspect/manage the trading daemon interactively.

---

## 5. The paper-trading half (the actual trading system)

### 5.1 Market data access (`src/tools/binance-tools.ts`)

Public REST only, three market types:

| Market | Base | Path prefixes |
|---|---|---|
| Spot | `api.binance.com` | `/api/v3/` |
| USD-M futures | `fapi.binance.com` | `/fapi/v1/`, `/fapi/v2/`, `/futures/data/` |
| COIN-M futures | `dapi.binance.com` | `/dapi/v1/` |

Exposed capabilities: klines, order book + bid/ask imbalance, funding rate + open interest, liquidation WebSocket feed, multi-symbol screener, price watch/alert. **No signed requests anywhere** — grepped for `HMAC`/`signature`/`X-MBX-APIKEY` across the entire `src/` and `scripts/` tree, zero matches outside of an unrelated `loop-detector.ts` variable literally named `signature` (a dedup hash, not a crypto signature).

### 5.2 Backtest engine (`src/backtest/`)

`runFuturesBacktest` is the single source of truth for signal evaluation — every other component (research pipeline, readiness gate, live-runner) either calls it directly or calls `buildSignalEvaluator` (`src/tools/backtest-tools.ts`), the same underlying function. This matters: the codebase's own audit history (see §6.3) found and discarded *three separate hand-rolled duplicate backtest engines* written by earlier research scripts that reimplemented signal logic independently and produced fabricated/overfit results. The current design deliberately funnels everything through one evaluator to prevent that class of bug recurring.

Supports: walk-forward analysis, Monte Carlo (bootstrap resampling of trade sequences), parameter grid sweep, split-sample / N-fold out-of-sample validation, realistic sizing (leverage, margin-per-trade, fee bps, slippage bps), sub-bar exit resolution (5m granularity for resolving whether stop or target hit first within a native bar).

### 5.3 Strategy pool (`strategies.json`)

Data file, not code — 17 strategies across 3 symbols (XRPUSDT, ETHUSDT, SOLUSDT) as of this snapshot. Each entry: `id`, `direction`, `tf` (15m–4h, no 5m or 1d in current pool), `entry` conditions (composable signal types — see below), `risk.stopPct`/`targetPct`, `maxHoldBars`, and backtested `metrics` (Sharpe, PF, win rate, trade count, PnL, max drawdown).

Signal types in the pool (all rule-based technical/SMC-ICT patterns, no ML):
`bearish_liq_ob`, `bearish_liq_fvg`, `bearish_liq_sweep`, `bullish_liq_fvg`, `bearish_fvg`, `ichimoku_bearish_breakout`, `adx_di_cross_short`, `rsi_above`, `ichimoku_below_cloud_short`, `ob_retest_short` (SMC order-block mitigation entry, ATR-adaptive).

Pool-wide sizing config: `leverage: 5`, `marginPerTradePct: 0.05`, `feeBps: 5`, `slippageBps: 3`, `initialCapital: 10000` (per strategy, isolated buckets — see §5.4).

The file's own embedded `_verification` block is a candid research log, not filler — it documents rejecting three prior "results" (one scanner that silently returned 0 trades for a signal type, one script claiming 95% win rates that never actually called the real backtest engine, one "FINAL-REPORT" whose every claim's trade count was off 5–20x on re-verification). Treat any strategy metrics as validated **only** insofar as they passed the pool's stated 3-fold split-sample + train/forward-holdout gate — this history is worth surfacing to an external reviewer as evidence the pool has already been adversarially checked once, not as a red flag.

### 5.4 Live paper-trading engine (`src/paper-trading/live-runner.ts`)

The real engine (distinct from the smaller `src/exchange/paper-trading.ts`, which is a toy/manual position tracker used elsewhere).

**Design:**
- Each strategy trades its own **isolated virtual capital bucket** ($10k default) — not a shared/fusion pool — so live results stay directly comparable to that strategy's individually-backtested numbers.
- Two trigger paths into the same decision logic (`processGroup`): (a) REST poll every `pollMs` (default 60s) as a safety net that must see every closed candle for stop/target/liquidation checks; (b) WebSocket kline-close push (`attachStream`) for near-instant entry evaluation. Identical code path either way — the stream is purely an earlier trigger, not separate logic.
- Entries/exits only ever evaluate on **closed candles**, matching the backtest bar-for-bar. A separate `unrealizedPnl()` method exists purely for dashboard display against live tick price and never influences trading decisions.
- Fill model: `feeBps` (5), `slippageBps` (3) applied against entry price in the adverse direction, simulated liquidation price computed from leverage.
- State persists to `.trading-agent/paper-state.json` (survives restart); every fill (entry/exit) appended to `.trading-agent/paper-trades.jsonl` journal — the append-only source of truth all downstream analysis (circuit breaker, drift monitor, readiness gate, LLM evaluator) reconstructs from.
- Pool hot-reload (`reloadPool`): picks up strategies newly appended to `strategies.json` (e.g. by the auto-research pipeline) without a process restart; only ever adds, never mutates/removes.

**Risk controls added 2026-07-17, verify against current file if reviewing later:**
- `volScale(candles, period=14)`: compares recent 14-bar ATR% against the whole-lookback-window average ATR%; scales entry margin down (clamped `[0.5, 1]`, downsize-only — never sizes up in quiet regimes) when current volatility is running hot relative to the strategy's validated baseline. Config flag `volSizing` (default on).
- `slippageMultiplier(candles, period=14)`: same ATR-ratio computation as `volScale` (factored into a shared `atrRatio` helper), but widen-only in the opposite direction — scales simulated entry slippage UP (clamped `[1, 3]`) when volatility is running hot, since real fills are worse in a hot market. Config flag `volSlippage` (default on). Applied only to entry fills; exits still fill exactly at stop/target/liquidation price (no slippage modeled on exit — a known simplification, not changed this pass).
- `fundingPnl(rates, notional, direction)`: on exit, if the hold spanned an 8-hour Binance funding boundary, fetches real historical funding rates from `/fapi/v1/fundingRate` and applies them to realized PnL (longs pay positive funding, shorts receive it). Config flag `funding` (default on). Applied against entry notional (not per-event mark notional) — a small deliberate approximation.
- `globalHalt` flag (set externally by the circuit breaker's daily-loss check) — blocks new entries pool-wide; open positions still manage normally.
- `totalUnrealizedPnl(stream)`: sums unrealized PnL across every open position, priced off the `BinanceStreamManager` ticker feed (`getLatest` per symbol). Display/risk-check only, same rule as the older `unrealizedPnl()` — never influences entry/exit decisions. Feeds the circuit breaker's mark-to-market daily-loss check (§5.5); positions with no live tick yet are skipped (best-effort).
- CoinDCX shadow price logging (`src/paper-trading/coindcx-shadow.ts`, `logCoinDcxBasis`): on every entry/exit fill, fetches CoinDCX's public spot ticker (no auth) for the same symbol and logs the Binance-vs-CoinDCX basis in bps to `.trading-agent/coindcx-basis.jsonl`. Fire-and-forget (not awaited), fully best-effort — CoinDCX being slow/unreachable never delays or affects a trading decision. Purpose: accumulate real cross-exchange divergence data during Phase 1 (§1a) so the eventual CoinDCX execution layer isn't flying blind on basis risk. Uses CoinDCX's spot ticker as a proxy (not futures) — noted as a simplification in the code comment. Config flag `coindcxShadow` (default on).

### 5.5 Risk / safety layer (`src/paper-trading/`)

| Module | What it does |
|---|---|
| `circuit-breaker.ts` (`StrategyCircuitBreaker`) | Per-strategy: pauses new entries if rolling PF (last 10 trades) drops below `pfFloor` (0.7) or `maxConsecutiveLosses` (5) hit. Auto-resumes after `cooldownTrades` (20) fresh pool trades if recovered. **Portfolio-wide** (added 2026-07-17): halts ALL new entries for the rest of the UTC day if today's realized **+ unrealized (mark-to-market, added same day)** PnL breaches `-dailyMaxLossPct` (3%) of total initial capital; auto-releases at next UTC day. The unrealized component requires a `BinanceStreamManager` passed into the constructor (the daemon does this); without it, the check degrades gracefully to realized-only. Never touches open positions in either case — exits always still execute. |
| `drift-monitor.ts` (`DriftMonitor`) | Proactively compares live win-rate/PF against the strategy's backtested reference, alerts once when a threshold is first crossed (re-arms if it recovers then drifts again). |
| `readiness.ts` (`ReadinessMonitor`, `assessReadiness`) | **Deterministic, not LLM-judged** — this is explicit in the code comments as a design principle. Per-strategy: ready only if `minTrades` (20) cleared, live PF ≥ `minProfitFactor` (1.2), win-rate divergence from backtest ≤ `maxWinRateDivergence` (0.15), and PnL positive. Portfolio-level: ready if ≥ `portfolioMinEvaluable` (3) strategies evaluable and ≥ `portfolioReadyFraction` (60%) of those are individually ready. Notifies once per strategy the first time it crosses the bar (state-tracked, restart-safe), explicitly states in the alert text that "ready" only means ready at the exact leverage/margin settings tested. |
| `trade-analyst.ts` (`TradeAnalyst`) | LLM, periodic batch (default every 5 min). Reads the trade journal, compares against backtest reference, writes commentary to its own log. Explicitly documented as read-only: "never touches LivePaperRunner, never sees strategies.json as anything but reference data, has no tool-calling surface." |
| `trade-evaluator.ts` (`TradeEvaluator`) | LLM, per-event (every entry and exit gets its own evaluation, not batched). Builds a prompt with recent candle context, asks for a 1–5 quality score plus 2–3 sentence reasoning. Runs as an async single-worker queue, fully decoupled from trading tick timing — falling behind just queues, nothing blocks. Output is a labeled research trail ("which setups the model rated highly that lost anyway") — explicitly not a live decision input. |
| `notifier.ts` | Telegram send + terminal bell. `FillNotifier` watches the journal for new fills and pushes alerts. |
| `research-pipeline.ts` (`ResearchPipeline`) | The **one place the system writes to `strategies.json` autonomously.** Weekly (configurable), sweeps the existing validated signal-type pool across new (symbol, timeframe, stop/target) combinations using the same `runFuturesBacktest` engine, requires a 3-fold contiguous-window OOS pass (every fold independently profitable) before promoting, caps promotions per cycle (3) and total pool size (40). New signal *types* are never invented here — only re-combinations of already-validated condition types. Promoted strategies start with their own fresh isolated capital bucket and get hot-reloaded into the running `LivePaperRunner` without restart. |

### 5.6 Daemon (`scripts/autonomous-trading-daemon.ts`)

Single long-running process wiring everything above together:
- `LivePaperRunner` + `BinanceStreamManager` (event-driven entries via `attachStream`'s kline subscriptions, REST poll as safety net; a separate ticker subscription per symbol, added 2026-07-17, feeds the circuit breaker's mark-to-market check)
- `TradeAnalyst`, `TradeEvaluator` (LLM commentary, 5min / event-driven respectively)
- `ReadinessMonitor` (checked after every tick with fills)
- `StrategyCircuitBreaker` (constructed with the stream so its daily-loss halt includes unrealized PnL, §5.5), `DriftMonitor` (5min interval each)
- `ResearchPipeline` (self-paced weekly scheduler, persisted last-run timestamp so a restart doesn't re-trigger early)
- Heartbeat file (`.trading-agent/daemon-heartbeat.json`) — PID, uptime, tick count, strategy count — written on every tick and on shutdown
- Graceful shutdown on SIGINT/SIGTERM; `uncaughtException` handler logs and exits (relies on the external watchdog to restart)

`scripts/daemon-watchdog.sh` — crash-restart supervisor, external to the Node process.

Two lighter-weight, read-only viewers run as **separate processes** reading the same state/journal files: `paper-trade-tui.tsx` (Ink dashboard) and `paper-trade-chat.ts` (chat-style read-only status interface). Neither writes trading state.

### 5.7 State files (all under `.trading-agent/`, gitignored, per-deployment)

| File | Written by | Contents |
|---|---|---|
| `paper-state.json` | LivePaperRunner | Per-strategy capital, open position, trade/win/loss counts |
| `paper-trades.jsonl` | LivePaperRunner | Append-only fill journal (entry/exit events) — the system's single source of ground truth |
| `circuit-breaker-state.json` | StrategyCircuitBreaker | Per-strategy pause state, reason, timestamps |
| `drift-monitor-state.json` / `drift-alerts.jsonl` | DriftMonitor | Alert-armed flags, alert log |
| `readiness-state.json` / `readiness.jsonl` | ReadinessMonitor | Notified-strategy tracking, readiness event log |
| `trade-evaluations.jsonl` | TradeEvaluator | Per-event LLM quality scores + reasoning |
| `research-cycles.jsonl` | ResearchPipeline | Every research cycle's tested/candidate/promoted summary |
| `research-schedule-state.json` | daemon | Last research-cycle run timestamp |
| `daemon-heartbeat.json` | daemon | Liveness/uptime info for the watchdog |
| `coindcx-basis.jsonl` | LivePaperRunner (via `coindcx-shadow.ts`) | Per-fill Binance-vs-CoinDCX basis in bps — read-only, best-effort, added 2026-07-17 |

---

## 6. What's proven vs. what's assumed

### 6.1 Proven (real historical Binance data, real backtest engine, split-sample/OOS validated)
- 17 rule-based strategies across 3 symbols, individually backtested with a 3-fold OOS gate and a 2.5yr-train / 2026-YTD-forward holdout pass.
- Fill realism at the backtest layer: fees, slippage, leverage, margin sizing all modeled.

### 6.2 Simulated but not yet live-verified
- Everything the `LivePaperRunner` produces is a live simulation against real Binance prices with the same fee/slippage/leverage model as the backtest — but it has never touched a real exchange account, real order book depth, or real fill queueing. Paper fills assume the strategy's stated price is achievable; a real order may slip more under real liquidity conditions, especially at size.
- Binance vs. CoinDCX gap: liquidity, spread, and available symbols differ between exchanges. Paper results were generated against **Binance** prices; the eventual live-execution target is **CoinDCX** (§1a). Expect some drift between paper and live performance from this alone, independent of code correctness. As of 2026-07-17 this is now partially instrumented — `coindcx-shadow.ts` logs the real Binance-vs-CoinDCX basis on every paper fill (§5.4) — but the drift monitor itself still only compares live-paper vs. backtest, not vs. this basis data; nothing yet acts on `coindcx-basis.jsonl` automatically.

### 6.3 Explicitly discredited (documented in `strategies.json`'s own `_verification` block and `docs/FINAL-REPORT.md`)
Three separate one-off research scripts (`scripts/mega-sweep.ts`, `scripts/walk-forward.ts`, and the claims in an earlier version of `docs/FINAL-REPORT.md`) each reimplemented their own duplicate signal-detection logic instead of calling the shared `runFuturesBacktest`/`buildSignalEvaluator`, had no or weak out-of-sample checks, and one picked best-Sharpe out of a large grid evaluated on the same window it reported results for (textbook overfitting). Spot-checks against the real engine found trade counts off by 5–20x and Sharpe ratios that were numerically invalid at very low sample sizes (e.g. Sharpe of -151,456,794,050,981,440 from a variance-estimator blowup at n≤2 trades). All such numbers were discarded; only results reproduced through the shared engine with a stated OOS methodology are in the current `strategies.json`. Worth surfacing to an external reviewer as a concrete example of the project's own error-correction process, and as a caution against trusting any *future* metric that didn't go through the same gate.

### 6.4 Not implemented at all
- **Live order execution** — no signed API client for any exchange, no order placement/cancellation/modification, no position query against a real account, no account balance/margin sync.
- **Multi-exchange abstraction** — everything is Binance-specific (`src/exchange/binance-stream.ts`, `src/tools/binance-tools.ts`); no exchange interface exists to swap in CoinDCX.
- **CoinDCX integration of any kind** — not referenced anywhere in the codebase as of this snapshot.
- Portfolio-level VaR/stress testing, multi-exchange arbitrage, smart order routing, iceberg orders, regulatory/compliance reporting — none present, and (per earlier conversation in this session) judged out of scope for a single retail-account bot at this trade frequency/timescale.

---

## 7. Configuration reference

### 7.1 Environment variables (all in `.env.example`)

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_HOST` | `http://localhost:11434` | Local Ollama server URL |
| `OLLAMA_API_KEY` | — | Ollama Cloud tier auth |
| `TRADINGAGENT_MODEL` | `qwen3.5:4b` | Default DevAgent model |
| `TRADINGAGENT_TIER` | `local` | `local` or `cloud` |
| `TRADINGAGENT_WORKSPACE` | cwd | Workspace root override |
| `TRADINGAGENT_TIMEOUT_MS` | `60000` | Request timeout |
| `TRADINGAGENT_SYSTEM_PROMPT` | built-in | Custom system prompt |
| `TRADINGAGENT_SHELL_IMAGE` | `tradingagent-sandbox:latest` | Docker sandbox image |
| `TRADINGAGENT_SHELL_TIMEOUT_SEC` | `30` | Shell command timeout |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` / `TELEGRAM_API_BASE` | — / — / `https://api.telegram.org` | Paper-trading notifications |
| `TRADINGAGENT_ANALYST_TIER` | `cloud` | LLM tier for TradeAnalyst/TradeEvaluator |
| `TRADINGAGENT_ANALYST_MODEL` | `gpt-oss:20b` (cloud) / `minicpm5-1b` (local) | Model for advisory LLM components |
| `TRADINGAGENT_MAX_CONVERSATION` / `_MAX_LOGS` / `_MAX_NOTIFICATIONS` / `_MAX_TOOL_CALLS` | — | DevAgent TUI buffer limits |
| `TRADINGAGENT_DEBUG_STDIN` | — | TUI debug flag |

### 7.2 npm scripts

```
npm run build              # tsc -> dist/
npm run dev                 # DevAgent TUI from source
npm test                    # jest
npm run lint / format:check
npm run benchmark           # model scoring harness
npm run paper-trade         # scripts/paper-trade-runner.ts (minimal, no daemon extras)
npm run paper-trade:tui      # Ink dashboard
npm run paper-trade:chat     # read-only chat status
npm run paper-trade:daemon   # scripts/autonomous-trading-daemon.ts — the real long-running system
```

---

## 8. Known limitations worth raising with an external reviewer

1. No live execution layer for any exchange (by design at this stage — user plans CoinDCX separately).
2. Paper fills are priced off Binance; live execution target is CoinDCX. Cross-exchange price/liquidity divergence isn't modeled anywhere yet.
3. Funding-rate PnL (added 2026-07-17) is applied against entry notional rather than per-event mark notional — a deliberate, small approximation.
4. No liquidation-gap modeling — if price gaps straight through a stop (rare at 5x leverage with a stop already inside the liquidation buffer, but possible in a flash move), the paper engine still fills at the stated stop/liquidation price rather than a worse gapped price.
5. ~~Daily-loss halt was realized-PnL-only~~ — resolved 2026-07-17: the daily-loss halt now includes unrealized (mark-to-market) PnL via a live ticker feed (§5.5). Volatility-scaled *sizing* is still forward-looking only (scales the next entry, not open exposure) — that part is unchanged and fine as-is, since per-trade stops already bound each open position's risk.
6. Single-process, single-machine deployment — no redundancy/failover beyond the watchdog script restarting a crashed process. Fine for a retail bot at this trade frequency; would need addressing before any "institutional-grade" framing.
7. The strategy pool's own backtested metrics come from a small sample by professional-quant standards (17 strategies, 3 symbols, ~1–3 years of history) — appropriate confidence intervals should scale accordingly when discussing expected live performance.

---

## 9. Changelog

Dated notes on functional changes to this system, kept so this document stays a live reference rather than a one-time snapshot.

- **2026-07-17** — Added 3 risk controls to the live paper-trading engine (§5.4, §5.5): portfolio-wide daily-loss halt (`StrategyCircuitBreaker`, `dailyMaxLossPct` 3%), volatility-aware position sizing (`volScale`, downsize-only ATR-based), and real Binance funding-rate PnL on exits (`fundingPnl`). All three are covered by `tests/paper-trading/risk-controls.test.ts`.
- **2026-07-17** — Fixed intermittent `FETCH ERROR ...: fetch failed` entries in the live-runner journal (visible in the paper-trading TUI's Recent Fills panel). Root cause: `fetchCandlesRange` (`src/tools/backtest-tools.ts`) had no retry — a transient network blip (DNS hiccup, connection reset) on any single paginated Binance kline request aborted that entire tick's fetch for the affected (symbol, timeframe) group, and the underlying cause (`e.cause` on Node's `fetch failed`) was discarded rather than logged. Fixed once in the shared `fetchCandlesRange`/`fetchWithRetry` path (3 retries, exponential backoff 500ms→1s→2s; real Binance 4xx/5xx responses still fail immediately, no retry) since every caller (live-runner, backtest tool, research pipeline, trade evaluator) routes through this one function. Requires a daemon/TUI process restart to pick up — verified fixed by re-running the exact failing (symbol, tf) groups live post-fix, all clean; the errors the user later saw in the TUI panel were confirmed to be the same pre-fix journal entries still sitting in the "last 8 events" display, not a recurrence.
- **2026-07-17** — Added WebSocket auto-reconnect to `BinanceStreamManager` (`src/exchange/binance-stream.ts`). Previously, `ws.on("close")` had no handler — Binance drops idle/long-lived connections routinely (~24h) or on network blips, and once dropped, `subscribeKline`'s event-driven entry trigger went silently dead until the whole process restarted (the REST poll in `LivePaperRunner.tick()` still caught stop/target/liquidation exits either way, but new entries stopped firing promptly). Fixed via one shared `connect()` helper used by `subscribe`/`subscribeKline`/`subscribeLiquidations`: resolves/rejects the original promise contract only on the first connection attempt, then silently reconnects on any later drop with exponential backoff (1s→2s→…→30s cap). `unsubscribe*`/`closeAll` mark the stream key as intentionally closed first, so deliberate teardowns don't trigger a reconnect loop.
- **2026-07-17** — Added 3 more paper-trading hardening pieces, all reviewed against an external blueprint and narrowed to what fits this system's determinism/scope principles (full triage in conversation history; declined items: RNG-based liquidation-gap modeling — breaks reproducibility, contradicts the system's deterministic-by-design principle; order-book-depth fill simulation — disproportionate complexity for swing-timeframe rule-based strategies; a 4-tier readiness-criteria rewrite — the existing gate is already the right shape):
  - **CoinDCX shadow price logger** (`src/paper-trading/coindcx-shadow.ts`, `logCoinDcxBasis`) — see §5.4/§6.2/§5.7 above.
  - **Mark-to-market intraday halt** — `LivePaperRunner.totalUnrealizedPnl(stream)` + `StrategyCircuitBreaker`'s daily-loss check now includes unrealized PnL, gated on a `BinanceStreamManager` ticker feed (daemon subscribes tickers for all pool symbols alongside the existing kline subscriptions). See §5.4/§5.5.
  - **Volatility-scaled slippage** — `slippageMultiplier(candles, period=14)`, sharing an `atrRatio` helper factored out of `volScale` (both existing tests still pass unchanged post-refactor). See §5.4.
  - New tests: `slippageMultiplier` cases added to `tests/paper-trading/risk-controls.test.ts` (11 tests total in that file now). `totalUnrealizedPnl` and the shadow logger were left without dedicated unit tests — both are thin best-effort wrappers over already-tested logic (`unrealizedPnl`, journal I/O) with low branching risk; add if either grows more logic later.
