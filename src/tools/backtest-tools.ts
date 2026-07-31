import { walkForward, monteCarlo, paramSweep, type ParamRange } from "../backtest/analysis.js";
import { runBacktest } from "../backtest/engine.js";
import { runPortfolioBacktest } from "../backtest/portfolio.js";
import { parseKlineRows, type StrategyConfig } from "../backtest/types.js";

import { fetchCandles } from "./backtest-fetch.js";
import { STRATEGY_SCHEMA } from "./backtest-shared.js";
import { Tool } from "./tool.js";

// Re-exports — public API surface of this module, unchanged by the split.
export { fetchCandlesRange, fetchOpenInterestHist, alignOiToCandles } from "./backtest-fetch.js";
export { BinanceSignalFusionTool } from "./backtest-fusion-tools.js";
export { BinanceFuturesBacktestTool, BinanceMultiTimeframeSweepTool, BinanceFuturesSweepTool } from "./backtest-futures-tools.js";
export { runFuturesBacktest, smcSwingHighs, smcSwingLows, smcBullishLiqSweep, smcBearishLiqSweep, type TradeRecord } from "./backtest-futures.js";
export { buildSignalEvaluator } from "./backtest-signals.js";

export class BinanceBacktestTool extends Tool {
  get name(): string {
    return "binance_backtest";
  }

  get description(): string {
    return (
      "Backtest a rule-based strategy (entry conditions + stop/target risk model) against real " +
      "historical Binance spot klines. Returns trade log, win rate, expectancy, profit factor, " +
      "max drawdown. This is a hypothesis TEST, not a strategy generator — define the hypothesis " +
      "first, then use this to see if it held up historically."
    );
  }

  override get tags(): string[] {
    return ["binance", "backtest", "quant-research"];
  }

  override get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        symbol: { type: "string" },
        interval: { type: "string", description: "e.g. 1h, 4h, 1d" },
        limit: { type: "number", description: "Candles to fetch, max 1000 (default 500)" },
        market: { type: "string", enum: ["usdm", "spot"], description: "Default: usdm (USD-M Futures)" },
        strategy: STRATEGY_SCHEMA,
      },
      required: ["symbol", "interval", "strategy"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = String(args["symbol"] ?? "");
    const interval = typeof args["interval"] === "string" ? args["interval"] : "1h";
    const limit = Math.min(Number(args["limit"] ?? 500) || 500, 1000);
    const market = (args["market"] as "spot" | "usdm") || "usdm";
    const strategy = args["strategy"] as StrategyConfig;
    const fetched = await fetchCandles(symbol, interval, limit, market);
    if ("error" in fetched) return fetched;
    const result = runBacktest(fetched.candles, strategy);
    return {
      symbol,
      interval,
      candles: fetched.candles.length,
      metrics: result.metrics,
      sampleTrades: result.trades.slice(0, 10),
      totalTradesReturned: result.trades.length,
    };
  }
}
export class BinanceWalkForwardTool extends Tool {
  get name(): string {
    return "binance_walk_forward";
  }

  get description(): string {
    return (
      "Split historical candles into sequential time windows and backtest the same strategy on " +
      "each independently — checks whether an edge is stable across regimes/time, or only worked " +
      "in one lucky window. Reports per-window expectancy and a stability score (lower = more " +
      "consistent). This is a stability check across time, not a re-optimizing walk-forward — no " +
      "parameter search happens per fold."
    );
  }

  override get tags(): string[] {
    return ["binance", "backtest", "walk-forward", "quant-research"];
  }

  override get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        symbol: { type: "string" },
        interval: { type: "string" },
        limit: { type: "number", description: "Candles to fetch, max 1000 (default 500)" },
        strategy: STRATEGY_SCHEMA,
        folds: { type: "number", description: "Number of sequential windows, default 4" },
      },
      required: ["symbol", "interval", "strategy"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = String(args["symbol"] ?? "");
    const interval = typeof args["interval"] === "string" ? args["interval"] : "1h";
    const limit = Math.min(Number(args["limit"] ?? 500) || 500, 1000);
    const strategy = args["strategy"] as StrategyConfig;
    const folds = Number(args["folds"] ?? 4) || 4;
    const fetched = await fetchCandles(symbol, interval, limit);
    if ("error" in fetched) return fetched;
    const result = walkForward(fetched.candles, strategy, folds);
    return {
      symbol,
      interval,
      candles: fetched.candles.length,
      windows: result.windows,
      expectancyStability: result.expectancyStability,
      consistentDirection: result.consistentDirection,
    };
  }
}
export class BinanceMonteCarloTool extends Tool {
  get name(): string {
    return "binance_monte_carlo";
  }

  get description(): string {
    return (
      "Bootstrap-resample a strategy's historical trade sequence to test how much of its equity " +
      "curve depends on trade order (luck) versus the edge itself. Runs the backtest once to get " +
      "the trade sample, then reshuffles it thousands of times. Reports median/5th/95th percentile " +
      "return and probability of a net loss over the sample. A wide p5-p95 spread or high loss " +
      "probability means the historical result isn't robust even if it looked good."
    );
  }

  override get tags(): string[] {
    return ["binance", "backtest", "monte-carlo", "quant-research"];
  }

  override get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        symbol: { type: "string" },
        interval: { type: "string" },
        limit: { type: "number", description: "Candles to fetch, max 1000 (default 500)" },
        strategy: STRATEGY_SCHEMA,
        simulations: { type: "number", description: "Bootstrap resamples, default 1000" },
      },
      required: ["symbol", "interval", "strategy"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = String(args["symbol"] ?? "");
    const interval = typeof args["interval"] === "string" ? args["interval"] : "1h";
    const limit = Math.min(Number(args["limit"] ?? 500) || 500, 1000);
    const strategy = args["strategy"] as StrategyConfig;
    const simulations = Number(args["simulations"] ?? 1000) || 1000;
    const fetched = await fetchCandles(symbol, interval, limit);
    if ("error" in fetched) return fetched;
    const backtest = runBacktest(fetched.candles, strategy);
    if (backtest.trades.length === 0) {
      return { error: "NoTrades", message: "Strategy produced zero trades on this data — nothing to resample" };
    }
    const mc = monteCarlo(backtest.trades, simulations);
    return { symbol, interval, tradesInSample: backtest.trades.length, ...mc };
  }
}
export class BinanceParamSweepTool extends Tool {
  get name(): string {
    return "binance_param_sweep";
  }

  get description(): string {
    return (
      "Grid-search over strategy parameter ranges (e.g. RSI period 10-20, threshold 20-35) and " +
      "rank results by expectancy. NOT Bayesian optimization — plain grid search, appropriate for " +
      "small TA parameter spaces. A strategy whose best result is a narrow spike surrounded by " +
      "poor neighbors is parameter-sensitive (fragile); a broad plateau of good results across " +
      "nearby parameters is more robust — compare neighboring ranks, not just the top one."
    );
  }

  override get tags(): string[] {
    return ["binance", "backtest", "param-sweep", "quant-research"];
  }

  override get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        symbol: { type: "string" },
        interval: { type: "string" },
        limit: { type: "number", description: "Candles to fetch, max 1000 (default 500)" },
        strategy: STRATEGY_SCHEMA,
        ranges: {
          type: "array",
          items: {
            type: "object",
            properties: {
              conditionIndex: { type: "number", description: "Index into strategy.entry to vary" },
              field: { type: "string", enum: ["period", "value"] },
              values: { type: "array", items: { type: "number" } },
            },
            required: ["conditionIndex", "field", "values"],
          },
        },
      },
      required: ["symbol", "interval", "strategy", "ranges"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = String(args["symbol"] ?? "");
    const interval = typeof args["interval"] === "string" ? args["interval"] : "1h";
    const limit = Math.min(Number(args["limit"] ?? 500) || 500, 1000);
    const strategy = args["strategy"] as StrategyConfig;
    const ranges = args["ranges"] as ParamRange[];
    const fetched = await fetchCandles(symbol, interval, limit);
    if ("error" in fetched) return fetched;
    const results = paramSweep(fetched.candles, strategy, ranges);
    return { symbol, interval, combinationsTested: results.length, top: results.slice(0, 10), bottom: results.slice(-5) };
  }
}
export class BinancePortfolioBacktestTool extends Tool {
  get name(): string {
    return "binance_portfolio_backtest";
  }

  get description(): string {
    return (
      "Run a portfolio-level backtest across multiple Binance symbols. Chronologically simulates " +
      "trades while respecting capital constraints, maximum concurrent positions, and per-trade capital allocation."
    );
  }

  override get tags(): string[] {
    return ["binance", "backtest", "portfolio", "quant-research"];
  }

  override get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        symbols: { type: "array", items: { type: "string" }, description: "e.g. ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']" },
        interval: { type: "string", description: "e.g. 1h, 4h, 1d" },
        limit: { type: "number", description: "Candles to fetch per symbol, max 1000 (default 500)" },
        strategy: STRATEGY_SCHEMA,
        initialCapital: { type: "number", description: "Starting cash balance (default 10000)" },
        maxConcurrentPositions: { type: "number", description: "Maximum simultaneous open trades (default 5)" },
        allocationPerTradePct: { type: "number", description: "Capital fraction allocated per trade, e.g. 0.1 for 10% (default 0.1)" },
      },
      required: ["symbols", "interval", "strategy"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbols = (args["symbols"] as string[]) || [];
    const interval = typeof args["interval"] === "string" ? args["interval"] : "1h";
    const limit = Math.min(Number(args["limit"] ?? 500) || 500, 1000);
    const strategy = args["strategy"] as StrategyConfig;
    const initialCapital = Number(args["initialCapital"] ?? 10_000);
    const maxConcurrentPositions = Number(args["maxConcurrentPositions"] ?? 5);
    const allocationPerTradePct = Number(args["allocationPerTradePct"] ?? 0.1);
    if (symbols.length === 0) {
      return { error: "EmptySymbols", message: "Must provide at least one symbol for portfolio backtesting" };
    }
    const symbolsData: Record<string, ReturnType<typeof parseKlineRows>> = {};
    for (const symbol of symbols) {
      const fetched = await fetchCandles(symbol, interval, limit);
      if ("error" in fetched) {
        return { error: fetched.error, message: `Failed fetching candles for ${symbol}: ${fetched.message}` };
      }
      symbolsData[symbol] = fetched.candles;
    }
    const result = runPortfolioBacktest(symbolsData, {
      initialCapital,
      maxConcurrentPositions,
      allocationPerTradePct,
      strategy,
    });
    return {
      symbols,
      interval,
      candlesPerSymbol: limit,
      initialCapital,
      finalCapital: result.finalCapital,
      totalReturnPct: result.totalReturnPct,
      maxDrawdownPct: result.maxDrawdownPct,
      metrics: result.metrics,
      totalTradesExecuted: result.trades.length,
      sampleTrades: result.trades.slice(0, 15),
    };
  }
}
