# AGENTS.md – TradingAgent‑TS Project Overview

## 1. Project Purpose

**TradingAgent‑TS** is a TypeScript‑based trading-agent runtime that enables LLM‑driven quantitative trading assistants. It provides:

- **Capability-based model routing** (`src/provider/`) — `ModelCatalog` discovers installed local + Ollama Cloud models, tags them by capability, and a `Router` picks a local-first candidate per request with fallback.
- **Binance market data tools** — public REST API access (no auth) for spot, USD-M futures, COIN-M futures; technical indicators (SMA, EMA, RSI, MACD, Bollinger Bands); order book with bid/ask imbalance; futures funding rate + open interest; multi-symbol screener.
- **Real-time WebSocket streams** (`src/exchange/binance-stream.ts`) — live ticker prices, liquidation feed, price alerts with condition-based triggers.
- **Backtesting engine** (`src/backtest/`) — rule-based strategy backtesting against real historical klines with entry conditions, stop/target risk model, trade log, win rate, expectancy, profit factor, max drawdown.
- **Quantitative analysis tools** — walk-forward analysis (edge stability across time windows), Monte Carlo simulation (bootstrap resampling of trade sequences), parameter sweep (grid search over strategy parameters).
- **Paper trading** (`src/exchange/paper-trading.ts`) — simulated positions marked-to-market against live prices, no real exchange, no API keys.
- **Technical indicators** (`src/tools/indicators.ts`) — deterministic math functions for SMA, EMA, RSI, MACD, Bollinger Bands.
- **Checkpoint/resume** — orchestrator persists plan state after every step transition; crashed multi-step tasks resume without re-running completed steps.
- **Browser automation** — lazily-launched headless Chromium (Playwright) for web scraping.
- **Docker-sandboxed shell execution** — every shell tool call runs in an isolated container with no network, bounded memory/CPU, and hard timeouts.
- **Plugin-style tool registry** — 20+ trading and utility tools exposed to the LLM via JSON schemas.
- **Learning + memory** — episode recording, grading, reflection, and SQLite conversation store.

---

## 2. Tech Stack

| Layer | Technology |
|------|--------------|
| **Language** | TypeScript (target ES2022) |
| **Runtime** | Node.js >= 20 |
| **Package manager** | npm |
| **Testing** | Jest with `ts-jest` preset |
| **Linting** | ESLint with `@typescript-eslint` plugin |
| **Formatting** | Prettier (120 char width, trailing commas, semicolons) |
| **CLI / UI** | Ink (React-style terminal UI) |
| **Docker sandbox** | Custom image `tradingagent-sandbox:latest` used by `ShellTool` |
| **LLM provider** | Ollama REST API — local (`http://localhost:11434`) or cloud (`OLLAMA_API_KEY`) |
| **Local database** | `better-sqlite3` — agent memory and conversation store |
| **Build** | TypeScript compiler (`tsc`) producing `dist/` |

---

## 3. Key Tools

**Market data:** `binance_public_api`, `binance_technical_indicators`, `binance_order_book`, `binance_futures_stats`, `binance_screener`, `binance_watch_price`/`binance_unwatch_price`, `binance_liquidations`, `binance_price_alert`.

**Quant research:** `binance_backtest`, `binance_walk_forward`, `binance_monte_carlo`, `binance_param_sweep`, `binance_paper_trade`.

**Utility:** Filesystem (read/write/edit/search), `git`, `docker`, `github`, `sqlite_query`, `shell` (sandboxed), browser automation, project tools (test/lint/format/build).

---

## 4. Architecture Decisions

1. **Single Source of Truth** — All UI components read from `src/runtime/store.ts`. Events flow from actors -> EventBus -> reduce -> new immutable state.
2. **GET-only Binance tools** — Public API tools never send API keys. Safe for any path within the allowed endpoint prefixes.
3. **Capability-based model routing** — Routes non-critical turns to `quick` models, avoids tying up the primary model.
4. **Deterministic indicators** — Technical indicators are pure math functions, not LLM guesses from raw candle numbers.
5. **Docker-sandboxed shell** — Every command runs with no network, limited resources, and 2 MiB output ceiling.
6. **Loop detection** — Tracks repeated tool-call signatures to avoid infinite retry cycles.
7. **Checkpoint/resume** — Plan state persists after every step; crashed runs resume without re-doing completed work.
8. **Environment-driven configuration** — All settings overridable via `TRADINGAGENT_*` env vars.

---

## 5. Getting Started

```bash
npm install
npm test
npm run dev    # start TUI
```

Dependencies: Node.js >= 20, Ollama running locally (or `OLLAMA_API_KEY`), Docker (for sandboxed shell), `gh` CLI on PATH (for github tool).
