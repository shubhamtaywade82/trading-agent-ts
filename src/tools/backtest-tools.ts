import { Tool } from "./tool.js";
import { parseKlineRows, StrategyConfig } from "../backtest/types.js";
import { runBacktest } from "../backtest/engine.js";
import { walkForward, monteCarlo, paramSweep, ParamRange } from "../backtest/analysis.js";

const CONDITION_SCHEMA = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: [
        "rsi_below", "rsi_above", "price_above_sma", "price_below_sma",
        "price_above_ema", "price_below_ema", "macd_bullish_cross",
        "macd_bearish_cross", "bollinger_touch_lower", "bollinger_touch_upper",
      ],
    },
    period: { type: "number", description: "Indicator period, e.g. 14 for RSI, 20 for SMA/EMA/Bollinger" },
    value: { type: "number", description: "Threshold, e.g. 30 for rsi_below" },
  },
  required: ["type"],
};

const STRATEGY_SCHEMA = {
  type: "object",
  properties: {
    direction: { type: "string", enum: ["long", "short"] },
    entry: { type: "array", items: CONDITION_SCHEMA, description: "AND of conditions — all must be true to enter" },
    risk: {
      type: "object",
      properties: { stopPct: { type: "number", description: "e.g. 0.02 for 2%" }, targetPct: { type: "number" } },
      required: ["stopPct", "targetPct"],
    },
    feeBps: { type: "number", description: "Round-trip fee in basis points, default 10 (0.1%)" },
    maxHoldBars: { type: "number", description: "Force-exit after N candles, default 200" },
  },
  required: ["direction", "entry", "risk"],
};

async function fetchCandles(symbol: string, interval: string, limit: number): Promise<{ candles: ReturnType<typeof parseKlineRows> } | { error: string; message: string }> {
  const url = new URL("/api/v3/klines", "https://api.binance.com");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  try {
    const response = await fetch(url, { method: "GET" });
    const body = await response.json();
    if (!response.ok) return { error: "BinanceApiError", message: JSON.stringify(body) };
    return { candles: parseKlineRows(body as unknown[][]) };
  } catch (e) {
    return { error: "RequestError", message: (e as Error).message };
  }
}

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

  get tags(): string[] {
    return ["binance", "backtest", "quant-research"];
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        symbol: { type: "string" },
        interval: { type: "string", description: "e.g. 1h, 4h, 1d" },
        limit: { type: "number", description: "Candles to fetch, max 1000 (default 500)" },
        strategy: STRATEGY_SCHEMA,
      },
      required: ["symbol", "interval", "strategy"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = String(args.symbol ?? "");
    const interval = typeof args.interval === "string" ? args.interval : "1h";
    const limit = Math.min(Number(args.limit ?? 500) || 500, 1000);
    const strategy = args.strategy as StrategyConfig;

    const fetched = await fetchCandles(symbol, interval, limit);
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

  get tags(): string[] {
    return ["binance", "backtest", "walk-forward", "quant-research"];
  }

  get parameters(): Record<string, unknown> {
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
    const symbol = String(args.symbol ?? "");
    const interval = typeof args.interval === "string" ? args.interval : "1h";
    const limit = Math.min(Number(args.limit ?? 500) || 500, 1000);
    const strategy = args.strategy as StrategyConfig;
    const folds = Number(args.folds ?? 4) || 4;

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

  get tags(): string[] {
    return ["binance", "backtest", "monte-carlo", "quant-research"];
  }

  get parameters(): Record<string, unknown> {
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
    const symbol = String(args.symbol ?? "");
    const interval = typeof args.interval === "string" ? args.interval : "1h";
    const limit = Math.min(Number(args.limit ?? 500) || 500, 1000);
    const strategy = args.strategy as StrategyConfig;
    const simulations = Number(args.simulations ?? 1000) || 1000;

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

  get tags(): string[] {
    return ["binance", "backtest", "param-sweep", "quant-research"];
  }

  get parameters(): Record<string, unknown> {
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
    const symbol = String(args.symbol ?? "");
    const interval = typeof args.interval === "string" ? args.interval : "1h";
    const limit = Math.min(Number(args.limit ?? 500) || 500, 1000);
    const strategy = args.strategy as StrategyConfig;
    const ranges = args.ranges as ParamRange[];

    const fetched = await fetchCandles(symbol, interval, limit);
    if ("error" in fetched) return fetched;

    const results = paramSweep(fetched.candles, strategy, ranges);
    return { symbol, interval, combinationsTested: results.length, top: results.slice(0, 10), bottom: results.slice(-5) };
  }
}
