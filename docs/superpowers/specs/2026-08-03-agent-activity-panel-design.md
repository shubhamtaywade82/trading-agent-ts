# Agent Activity Panel + TUI Visual Pass

## Context

The paper-trading terminal (`src/tui/PaperTradingDashboard.tsx`) had two rendering
bugs fixed this session: a broken sparkline glyph order (rendered as `_______`
instead of a real gradient) and a root-layout `justifyContent="space-between"` that
stretched blank space unevenly between every panel. With both fixed, the user asked
whether the result reads as a professional "agentic AI" trading system — it doesn't.
The dashboard shows execution state (equity, positions, strategy table) but nothing
about the autonomous control loop that runs underneath it: `StrategyCircuitBreaker`
(rolling-PF pause/resume, daily-loss halt), `PnlAdaptor` (live-PF-driven
resize/prune), `ReadinessMonitor` (ready-for-live crossings), and `AiEntryGate`
(LLM pre-trade veto, currently off — `strategies.json`'s `config.aiGate.mode` is
`"no-ai"`). These subsystems are real and already running (or configured to run);
the UI just never surfaces their decisions.

## Goal

Add one new panel that shows the control loop's recent decisions as a live,
chronological feed, and do a small visual pass (within the existing terminal
aesthetic — no new color system) so the dashboard reads as an active autonomous
system even during a session with zero trades.

## Non-Goals

- No new color/branding system (user's explicit call).
- No changes to trading logic, sizing, or any decision-making code — this is
  observability only.
- No LLM-narrated "agent voice" panel — the existing AI ANALYST panel already
  covers post-hoc LLM commentary; this spec doesn't touch it.
- Not wiring `TRADINGAGENT_AI_MODE=ai` on — the panel must work correctly with the
  AI-gate off (empty of `ai-gate`-sourced rows) and be ready for when it's on.

## Data model

Three JSONL/state sources already exist, one has a gap:

| Source | File | What's already logged |
|---|---|---|
| Fills + rule engine | `.trading-agent/paper-trades.jsonl` | `position_fill`, `ai_gate_decision`, `exposure_cap_blocked`, `trailing_phase_change`, `strategy_pruned`, `size_multiplier_updated` |
| PnL adaptor | `.trading-agent/pnl-adjustments.jsonl` | `resize`, `prune` actions with old/new value, live/backtest PF |
| Readiness | `.trading-agent/readiness.jsonl` | `strategy_ready`, `portfolio_ready` |
| Circuit breaker | — (gap) | Only `sendTelegram` + a state snapshot (`circuit-breaker-state.json`, current state only, no history) |

**Fix the gap**: add `eventsFile: string` to `CircuitBreakerConfig`
(`src/paper-trading/circuit-breaker.ts`, default
`.trading-agent/breaker-events.jsonl`), and append one line — matching
`PnlAdaptor.logAdjustment`'s existing shape (`{ts, type, strategyId, reason}`) —
from three call sites already in the file: `pause()`, `resume()`, and the daily-loss
halt/release branches inside `checkDailyLoss()`.

**Merge function**: new `readAgentEvents(cfg, n)` (co-located in
`PaperTradingDashboard.tsx`, following the existing `readLastJournalEvents`
pattern — no new file). Tails all three files, filters `paper-trades.jsonl` to the
five non-fill event types listed above (fills stay exclusive to RECENT FILLS, not
duplicated), tags each row with `source: "ai-gate" | "risk" | "breaker" | "adaptor"
| "readiness"`, sorts by `ts` descending, returns top N. Reuses the existing
`FeedEvent` type (already has `approved`, `rationale`, `strategyId`, `reason` —
no new type needed).

## Components

**`AgentActivityPanel`** (new, next to `RecentFillsPanel`, same table shell via the
existing `Panel`/`Col`/`Separator` helpers): columns TIME / SOURCE / STRATEGY /
DETAIL. SOURCE colored per tag (`ai-gate`=magenta, `breaker`=red for pause /
green for resume, `adaptor`=yellow, `risk`=gray, `readiness`=cyan). DETAIL
formatted per event type:

- `ai_gate_decision` → `APPROVE ×1.0: <rationale, truncated>` / `REJECT: <rationale>`
- `breaker_pause` / `breaker_resume` → the `reason` string circuit-breaker already
  produces
- `size_multiplier_updated` → `0.80× → 0.90×`
- `strategy_pruned` → `disabled: <reason>`
- `exposure_cap_blocked` → `capped: margin ceiling hit`
- `strategy_ready` / `portfolio_ready` → `ready for live: WR .. PF ..`

Hidden when empty, matching `RecentFillsPanel`'s existing convention (`if
(feed.length === 0) return <></>`).

## Visual pass (same aesthetic, no new palette)

- Header copy: `◆ PAPER TRADING TERMINAL` → `◆ AUTONOMOUS TRADING AGENT`.
- New status line under the header, always visible even with zero trades:
  `AI-GATE: OFF · BREAKER: ARMED · ADAPTOR: DRY-RUN · READINESS: 0/6` — derived
  from `runner`'s existing config (`aiMode`) plus a lightweight read of breaker/
  adaptor/readiness state files. This is the actual fix for "looks dead": the
  control loop's status is visible on frame one, independent of trade count.
- No changes to STRATEGIES table coloring or the PORTFOLIO/ACCOUNT panels.

## Testing

- Unit test for `readAgentEvents`: fixed fake lines across the three files →
  asserts correct merge order and `source` tagging.
- Unit test for circuit-breaker's new event log: `pause()`/`resume()`/daily-halt
  each write the expected line to `eventsFile`.
- No Ink snapshot testing (not used elsewhere in this repo).

## Out of scope, filed for later

Two much larger architecture documents were shared in this session — a full
SMC/ICT deterministic-structure + multi-agent LLM pipeline (Planner/Critic/Risk/
Executor/Monitor/Reflector), and a `Playbook`/`RegimeRouter` strategy catalog on
top of it. Neither is addressed here. Notably, `docs/superpowers/specs/
2026-07-28-smc-engine-consolidation-design.md` and `docs/superpowers/specs/
2026-08-02-binance-pipeline-architecture-design.md` already cover significant
overlapping ground (regime-adaptive strategy selection phased A/B/C, LLM
snapshot-reasoning pipeline) — the next design cycle for that work should start by
reading those two specs, not the freshly-pasted docs in isolation.
