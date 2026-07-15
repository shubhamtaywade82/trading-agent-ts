---
name: crypto-futures-ta
description: >
  Use when the user asks for technical analysis, a trading setup, a
  "strategy", a market "edge", entry/exit levels, or a trade idea on a
  crypto symbol (spot or futures) backed by Binance data. Triggers for:
  "technical analysis for X", "trading setup", "find an edge", "build a
  strategy", "should I long or short X", "SOLUSDT/BTCUSDT strategy",
  funding/open-interest reads, order-book reads.
tags: [binance, crypto, futures, technical-analysis, trading, trading-setup, quant-research, backtesting]
compatibility: >
  Requires the binance_* tools (src/tools/binance-tools.ts,
  src/tools/backtest-tools.ts, src/tools/paper-trading-tools.ts).
---

# Crypto Futures TA

CALL TOOLS. Do not describe a tool call, do not write JSON that looks
like a tool call — actually invoke the tool. Never state a number,
indicator value, or backtest result you did not get from a real tool
call this turn.

## Order of operations

1. `binance_technical_indicators` (symbol, market, interval) — real
   RSI/MACD/Bollinger/SMA/EMA.
2. `binance_order_book` and, for futures, `binance_futures_stats`.
3. Turn what you see into ONE testable rule (e.g. "RSI < 30 → long").
4. Call `binance_backtest` with that rule. Look at `metrics`: totalTrades,
   winRate, expectancyPct, maxDrawdownPct.
5. If totalTrades < 20, say the result is unconfirmed — small sample.
6. If it looks decent, call `binance_walk_forward` and
   `binance_monte_carlo` to check it's not a fluke.
7. Only give a "setup" (entry/stop/target) if steps 4-6 backed it with
   real numbers. Otherwise say no qualifying setup and stop.

Skip steps 3-7 for a quick "what's the RSI" question — just answer it.

## Tools

`binance_technical_indicators`, `binance_order_book`, `binance_futures_stats`,
`binance_screener`, `binance_watch_price`, `binance_price_alert`,
`binance_liquidations`, `binance_backtest`, `binance_walk_forward`,
`binance_monte_carlo`, `binance_param_sweep` (grid search, not Bayesian),
`binance_paper_trade` (simulated, no real money), `binance_public_api`
(generic GET for anything else, e.g. `/fapi/v1/fundingRate` history,
`/futures/data/openInterestHist`).

No order execution against a real exchange — not implemented, won't be
added without separate explicit authorization.
