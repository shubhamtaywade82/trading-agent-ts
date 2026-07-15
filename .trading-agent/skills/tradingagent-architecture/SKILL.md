---
name: TradingAgent Architecture
description: Explains TradingAgent's actor model, runtime state store, and TUI overlay system so the agent can answer questions about its own architecture accurately.
tags: [architecture, runtime, tui, tradingagent, actors, overlays]
version: 0.1.0
---

# TradingAgent Architecture

TradingAgent models every subsystem as an always-alive **actor** (conversation, planner, executor, tasks,
git, logs, memory, models, mcp, skills). Actors never stop; only what is *observed* changes when a
view is focused. Views map to a frozen set of numbered keys 1-8 (see docs/SPEC.md §7-8); skills and a
few other subsystems are overlay-only and never occupy a numbered view slot.

State flows one way: actors publish events onto an EventBus; a single reducer (`src/runtime/store.ts`)
folds events into RuntimeState; the TUI renders RuntimeState and never mutates it directly.

The layout is frozen: Header, Active View, Activity Strip, Prompt, Context Strip — five zones, always
present, at every terminal size. Only content density changes as the terminal shrinks or grows; the
zones themselves never rearrange, and no zone is ever removed.

Overlays (command palette, model switcher, search everywhere, skills) are ephemeral: they render over
the Active View, never mutate runtime state directly, and always close with Esc. Every searchable
overlay reuses one component, `UniversalPicker`, rather than reimplementing list UI per overlay.
