# TradingAgent TS

A TypeScript trading agent runtime built on Ollama (local + cloud), with capability-based model routing, Binance market data tools, backtesting, paper trading, and quantitative analysis.

## Architecture

```
src/
├── provider/       Ollama REST client (local + cloud), model catalog, capability router
├── exchange/       Binance WebSocket stream manager, paper trading engine
├── backtest/       Backtest engine, walk-forward analysis, Monte Carlo, parameter sweep
├── benchmark/      Model scoring harness (JSON validity, tool-calling, latency)
├── orchestrator/   Plan steps, parallel dependency-aware execution, checkpoint/resume
├── runtime/        State store, event bus, checkpoint store, config constants
├── tools/          20+ tools: binance (market data, indicators, backtest), filesystem, git, docker, shell, browser
├── cli/            Agent class, conversation manager, config loader
├── tui/            Ink terminal UI
├── skills/         Skill loader/registry/resolver
├── learning/       Episode recording, grading, reflection
├── memory/         SQLite-backed conversation memory + summarizer
└── mcp/            MCP client + tool adapter
```

## Key Features

- **Binance market data** — Public REST API (spot/USD-M/COIN-M), technical indicators (SMA/EMA/RSI/MACD/Bollinger), order book imbalance, futures funding rate + open interest, multi-symbol screener.
- **Real-time WebSocket streams** — Live ticker prices, liquidation feed, price alerts with condition-based triggers.
- **Backtesting** — Rule-based strategies against real historical klines. Walk-forward stability checks, Monte Carlo robustness tests, parameter grid search.
- **Paper trading** — Simulated positions marked-to-market against live prices. No real exchange, no API keys, no risk.
- **Capability-based model routing** — Route market analysis to `reasoning` models, quick scans to `quick` models.
- **Checkpoint/resume** — Crashed multi-step tasks resume without re-running completed steps.
- **Docker-sandboxed shell** — Safe command execution in isolated containers.

## Requirements

- Node.js >= 20
- Ollama running locally, or `OLLAMA_API_KEY` set for cloud tier
- Docker (for sandboxed shell tool)
- `gh` CLI on PATH (for github tool)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL (local tier) |
| `OLLAMA_API_KEY` | — | Primary API key for cloud tier |
| `TRADINGAGENT_MODEL` | `qwen3.5:4b` | Default model tag |
| `TRADINGAGENT_TIER` | `local` | `local` or `cloud` |
| `TRADINGAGENT_WORKSPACE` | auto-detected | Workspace root override |
| `TRADINGAGENT_TIMEOUT_MS` | — | Request timeout in milliseconds |
| `TRADINGAGENT_SYSTEM_PROMPT` | *(built-in)* | Custom system prompt |
| `TRADINGAGENT_SHELL_IMAGE` | `tradingagent-sandbox:latest` | Docker image for sandbox |
| `TRADINGAGENT_SHELL_TIMEOUT_SEC` | `30` | Shell command timeout |

## Development

```bash
npm install
npm test          # jest
npm run build     # TypeScript -> dist/
npm run dev       # start TUI from source
npm run benchmark # score installed models
```
