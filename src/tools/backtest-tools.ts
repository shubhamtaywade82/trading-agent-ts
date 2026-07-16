import { Tool } from "./tool.js";
import { parseKlineRows, StrategyConfig, BacktestMetrics, Candle } from "../backtest/types.js";
import { runBacktest } from "../backtest/engine.js";
import { walkForward, monteCarlo, paramSweep, ParamRange } from "../backtest/analysis.js";
import { smaSeries, emaSeries, rsiSeries, macdSeries, bollingerSeries, superTrendSeries, adxSeries, ichimokuSeries } from "./indicators.js";
import { detectOrderBlockZones, buildObRetestSignals } from "./orderblocks.js";
import { runPortfolioBacktest } from "../backtest/portfolio.js";

const CONDITION_SCHEMA = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: [
        "rsi_below", "rsi_above", "price_above_sma", "price_below_sma",
        "price_above_ema", "price_below_ema", "macd_bullish_cross",
        "macd_bearish_cross", "bollinger_touch_lower", "bollinger_touch_upper",
        "bearish_ob", "bullish_ob", "bearish_fvg", "bullish_fvg",
        "bearish_liq_sweep", "bullish_liq_sweep", "bearish_displacement", "bullish_displacement",
        "bearish_liq_ob", "bullish_liq_ob", "bearish_liq_fvg", "bullish_liq_fvg",
        "bearish_htf_trend_short", "bullish_htf_trend_long",
        "supertrend_bullish_flip", "supertrend_bearish_flip",
        "adx_bullish_trend", "adx_bearish_trend", "adx_di_cross_long", "adx_di_cross_short",
        "ichimoku_bullish_breakout", "ichimoku_bearish_breakout",
        "ichimoku_above_cloud_long", "ichimoku_below_cloud_short",
        "volume_spike_long", "volume_spike_short",
        "ob_retest_long", "ob_retest_short",
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

// ── Multi-batch klines fetcher (exceeds 1000-candle limit) ──
export async function fetchCandlesRange(
  symbol: string, interval: string, startTime: number, endTime: number,
): Promise<{ candles: ReturnType<typeof parseKlineRows> } | { error: string; message: string }> {
  const all: ReturnType<typeof parseKlineRows> = [];
  let from = startTime;
  try {
    while (from < endTime) {
      const url = new URL("/api/v3/klines", "https://api.binance.com");
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("interval", interval);
      url.searchParams.set("limit", "1000");
      url.searchParams.set("startTime", String(from));
      url.searchParams.set("endTime", String(endTime));
      const response = await fetch(url, { method: "GET" });
      const body = await response.json();
      if (!response.ok) return { error: "BinanceApiError", message: JSON.stringify(body) };
      const rows = body as unknown[][];
      if (rows.length === 0) break;
      const candles = parseKlineRows(rows);
      all.push(...candles);
      from = candles[candles.length - 1].openTime + 1;
      await new Promise(r => setTimeout(r, 250));
    }
    return { candles: all };
  } catch (e) {
    return { error: "RequestError", message: (e as Error).message };
  }
}

export class BinanceFuturesBacktestTool extends Tool {
  get name(): string { return "binance_futures_backtest"; }
  get description(): string {
    return (
      "Futures-style backtest with leverage, capital tracking, and stop/target/liquidation. " +
      "Fetches multi-batch historical klines (1 year+ supported via startTime/endTime). " +
      "Simulates a single position at a time with full margin deployment and liquidation at 1/leverage."
    );
  }
  get tags(): string[] { return ["binance", "backtest", "futures", "quant-research"]; }
  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        symbol: { type: "string" },
        interval: { type: "string", description: "e.g. 1h, 4h, 1d" },
        limit: { type: "number", description: "Max candles (default 500). Use startTime/endTime for more." },
        startTime: { type: "number", description: "Unix ms start (overrides limit-based fetch)" },
        endTime: { type: "number", description: "Unix ms end, default now" },
        direction: { type: "string", enum: ["long", "short"] },
        entry: { type: "array", items: CONDITION_SCHEMA, description: "AND of entry conditions" },
        stopPct: { type: "number", description: "Stop loss as fraction, e.g. 0.02 = 2%" },
        targetPct: { type: "number", description: "Take profit as fraction, e.g. 0.04 = 4%" },
        feeBps: { type: "number", description: "Round-trip fee in bps, default 5" },
        maxHoldBars: { type: "number", description: "Max bars before timeout exit, default 96" },
        initialCapital: { type: "number", description: "Starting capital in USD, default 10000" },
        leverage: { type: "number", description: "Leverage multiplier, default 1 (spot). Max 125." },
        marginPerTradePct: { type: "number", description: "Fraction of capital per trade, default 0.5 (50%)" },
        slippageBps: { type: "number", description: "One-way slippage in bps applied to entries and stop/timeout exits, default 0" },
      },
      required: ["symbol", "direction", "entry", "stopPct", "targetPct"],
    };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = String(args.symbol ?? "");
    const interval = typeof args.interval === "string" ? args.interval : "1h";
    const limit = Math.min(Number(args.limit ?? 500) || 500, 1000);
    const direction = args.direction as "long" | "short";
    const entry = args.entry as { type: string; period?: number; value?: number }[];
    const stopPct = Number(args.stopPct ?? 0.02);
    const targetPct = Number(args.targetPct ?? 0.04);
    const feeBps = Number(args.feeBps ?? 5);
    const maxHoldBars = Number(args.maxHoldBars ?? 96);
    const initialCapital = Number(args.initialCapital ?? 10000);
    const leverage = Number(args.leverage ?? 1);
    const marginPerTradePct = Number(args.marginPerTradePct ?? 0.5);
    const slippageBps = Number(args.slippageBps ?? 0);

    let candles: ReturnType<typeof parseKlineRows>;
    if (args.startTime) {
      const endTime = Number(args.endTime ?? Date.now());
      const fetched = await fetchCandlesRange(symbol, interval, Number(args.startTime), endTime);
      if ("error" in fetched) return fetched;
      candles = fetched.candles;
    } else {
      const fetched = await fetchCandles(symbol, interval, limit);
      if ("error" in fetched) return fetched;
      candles = fetched.candles;
    }

    const result = runFuturesBacktest(candles, entry, direction, stopPct, targetPct, feeBps, maxHoldBars, initialCapital, leverage, marginPerTradePct, slippageBps) as any;
    return { symbol, interval, candles: candles.length, direction, leverage, initialCapital, ...(result.metrics as Record<string, unknown>) };
  }
}

// Day-trader-sane defaults per timeframe: lower timeframes get tighter
// stop/target grids (a 5m candle's typical move is a fraction of an hourly
// candle's) and shorter lookback (a 5m strategy's "regime" is weeks, not a
// year — and pulling 1yr of 5m candles is ~105k rows / ~105 paginated
// fetches per symbol); higher timeframes get wider grids and longer lookback
// since a 1d strategy needs multiple years to accumulate a usable trade count.
const TIMEFRAME_DEFAULTS: Record<string, { lookbackDays: number; stopValues: number[]; targetValues: number[]; maxHoldBars: number }> = {
  "5m": { lookbackDays: 45, stopValues: [0.003, 0.005, 0.008, 0.01], targetValues: [0.005, 0.01, 0.015, 0.02], maxHoldBars: 48 },   // 4h max hold
  "15m": { lookbackDays: 90, stopValues: [0.005, 0.008, 0.01, 0.015], targetValues: [0.01, 0.02, 0.03], maxHoldBars: 48 },          // 12h max hold
  "30m": { lookbackDays: 180, stopValues: [0.008, 0.012, 0.02], targetValues: [0.015, 0.03, 0.04], maxHoldBars: 48 },               // 24h max hold
  "1h": { lookbackDays: 365, stopValues: [0.01, 0.02, 0.03], targetValues: [0.02, 0.04, 0.06, 0.12], maxHoldBars: 48 },             // 2d max hold
  "2h": { lookbackDays: 365, stopValues: [0.015, 0.025, 0.04], targetValues: [0.03, 0.06, 0.10], maxHoldBars: 48 },                 // 4d max hold
  "4h": { lookbackDays: 730, stopValues: [0.02, 0.03, 0.05], targetValues: [0.04, 0.08, 0.15], maxHoldBars: 42 },                   // 7d max hold
  "1d": { lookbackDays: 1095, stopValues: [0.03, 0.05, 0.08], targetValues: [0.06, 0.12, 0.25], maxHoldBars: 20 },                  // 20d max hold
};

export class BinanceMultiTimeframeSweepTool extends Tool {
  get name(): string { return "binance_multi_timeframe_sweep"; }
  get description(): string {
    return (
      "Grid-search a strategy's stop/target parameters ACROSS MULTIPLE TIMEFRAMES (5m through 1d) " +
      "in one call, using day-trader-appropriate default stop/target ranges and lookback windows per " +
      "timeframe (tighter risk + shorter lookback on 5m/15m, wider + longer on 4h/1d — override via " +
      "stopValues/targetValues to sweep the same grid on every timeframe instead). Every combo is " +
      "automatically split-sample tested (first half of the window vs second half, independently) — " +
      "a combo only counts as a candidate if it clears minTrades AND is net positive in BOTH halves. " +
      "This is the validation step baked in, not a separate manual check. Entry supports multiple " +
      "AND'd conditions for confluence entries (e.g. liquidity sweep + ADX trend filter together)."
    );
  }
  get tags(): string[] { return ["binance", "backtest", "futures", "multi-timeframe", "param-sweep", "quant-research"]; }
  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        symbol: { type: "string" },
        direction: { type: "string", enum: ["long", "short"] },
        entry: { type: "array", items: CONDITION_SCHEMA, description: "AND of entry conditions — supports multi-signal confluence entries" },
        intervals: { type: "array", items: { type: "string", enum: Object.keys(TIMEFRAME_DEFAULTS) }, description: "Default: all of 15m, 30m, 1h, 4h (day-trade + swing spread). Pass explicitly to include 5m, 2h, 1d." },
        stopValues: { type: "array", items: { type: "number" }, description: "Override the built-in per-timeframe stop grid for ALL swept intervals" },
        targetValues: { type: "array", items: { type: "number" }, description: "Override the built-in per-timeframe target grid for ALL swept intervals" },
        minTrades: { type: "number", description: "Minimum trades over the full window to count as a candidate, default 15" },
        initialCapital: { type: "number", default: 10000 },
        leverage: { type: "number", default: 5 },
        marginPerTradePct: { type: "number", default: 0.05 },
        slippageBps: { type: "number", default: 3 },
        feeBps: { type: "number", default: 5 },
      },
      required: ["symbol", "direction", "entry"],
    };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = String(args.symbol ?? "");
    const direction = args.direction as "long" | "short";
    const entry = args.entry as { type: string; period?: number; value?: number }[];
    const intervals = (args.intervals as string[]) ?? ["15m", "30m", "1h", "4h"];
    const overrideStops = args.stopValues as number[] | undefined;
    const overrideTargets = args.targetValues as number[] | undefined;
    const minTrades = Number(args.minTrades ?? 15);
    const initialCapital = Number(args.initialCapital ?? 10000);
    const leverage = Number(args.leverage ?? 5);
    const marginPerTradePct = Number(args.marginPerTradePct ?? 0.05);
    const slippageBps = Number(args.slippageBps ?? 3);
    const feeBps = Number(args.feeBps ?? 5);

    const perInterval: Record<string, unknown> = {};

    for (const interval of intervals) {
      const cfg = TIMEFRAME_DEFAULTS[interval];
      if (!cfg) { perInterval[interval] = { error: "UnknownInterval", message: `No day-trader defaults for interval ${interval}` }; continue; }

      const endTime = Date.now();
      const startTime = endTime - cfg.lookbackDays * 24 * 60 * 60 * 1000;
      const fetched = await fetchCandlesRange(symbol, interval, startTime, endTime);
      if ("error" in fetched) { perInterval[interval] = fetched; continue; }
      const candles = fetched.candles;
      const mid = startTime + (endTime - startTime) / 2;
      const midIdx = candles.findIndex(c => c.openTime >= mid);
      const h1 = candles.slice(0, midIdx < 0 ? candles.length : midIdx);
      const h2 = candles.slice(midIdx < 0 ? candles.length : midIdx);

      const stops = overrideStops ?? cfg.stopValues;
      const targets = overrideTargets ?? cfg.targetValues;
      const results: any[] = [];
      for (const sp of stops) {
        for (const tp of targets) {
          const full = runFuturesBacktest(candles, entry, direction, sp, tp, feeBps, cfg.maxHoldBars, initialCapital, leverage, marginPerTradePct, slippageBps) as any;
          const m = full.metrics;
          if (m.totalTrades < minTrades) continue;
          const r1 = runFuturesBacktest(h1, entry, direction, sp, tp, feeBps, cfg.maxHoldBars, initialCapital, leverage, marginPerTradePct, slippageBps) as any;
          const r2 = runFuturesBacktest(h2, entry, direction, sp, tp, feeBps, cfg.maxHoldBars, initialCapital, leverage, marginPerTradePct, slippageBps) as any;
          const bothHalvesPositive = r1.metrics.totalPnlUsd > 0 && r2.metrics.totalPnlUsd > 0;
          results.push({
            stopPct: sp, targetPct: tp, trades: m.totalTrades, winRate: m.winRate, pf: m.profitFactor,
            sharpe: m.sharpeRatio, pnlUsd: m.totalPnlUsd, returnPct: m.totalReturnPct, maxDDPct: m.maxDrawdownPct,
            h1: { trades: r1.metrics.totalTrades, pnlUsd: r1.metrics.totalPnlUsd },
            h2: { trades: r2.metrics.totalTrades, pnlUsd: r2.metrics.totalPnlUsd },
            bothHalvesPositive,
            verdict: bothHalvesPositive ? "SURVIVES" : "REGIME_FRAGILE",
          });
        }
      }
      results.sort((a, b) => (b.verdict === "SURVIVES" ? 1 : 0) - (a.verdict === "SURVIVES" ? 1 : 0) || b.sharpe - a.sharpe);
      perInterval[interval] = {
        candles: candles.length, lookbackDays: cfg.lookbackDays, maxHoldBars: cfg.maxHoldBars,
        combosTested: stops.length * targets.length, combosWithMinTrades: results.length,
        survivors: results.filter(r => r.verdict === "SURVIVES"),
        best: results[0] ?? null,
        allResults: results,
      };
    }

    return { symbol, direction, entry, intervals, perInterval };
  }
}

export class BinanceFuturesSweepTool extends Tool {
  get name(): string { return "binance_futures_sweep"; }
  get description(): string {
    return (
      "Grid-search over futures backtest parameters (stopPct, targetPct, entry thresholds, entry periods) " +
      "with leverage and capital tracking. Returns top 15 combos sorted by Sharpe ratio. " +
      "Useful for finding optimal risk parameters for a given strategy on futures data."
    );
  }
  get tags(): string[] { return ["binance", "backtest", "futures", "param-sweep", "quant-research"]; }
  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        symbol: { type: "string" },
        interval: { type: "string" },
        startTime: { type: "number", description: "Unix ms start" },
        endTime: { type: "number", description: "Unix ms end" },
        direction: { type: "string", enum: ["long", "short"] },
        entryType: { type: "string", description: "Condition type, e.g. rsi_above, price_above_ema, macd_bearish_cross" },
        entryPeriod: { type: "number", description: "Fixed period for indicator (applied if not swept)" },
        entryValue: { type: "number", description: "Fixed threshold (applied if not swept)" },
        initialCapital: { type: "number", default: 10000 },
        leverage: { type: "number", default: 10 },
        marginPerTradePct: { type: "number", default: 0.5 },
        stopValues: { type: "array", items: { type: "number" }, description: "Stop % values to sweep, e.g. [0.01, 0.02, 0.03]" },
        targetValues: { type: "array", items: { type: "number" }, description: "Target % values to sweep, e.g. [0.02, 0.04, 0.06]" },
        thresholdValues: { type: "array", items: { type: "number" }, description: "Entry threshold values (for rsi_below/above)" },
        periodValues: { type: "array", items: { type: "number" }, description: "Indicator period values" },
        slippageBps: { type: "number", description: "One-way slippage in bps applied to entries and stop/timeout exits, default 0" },
      },
      required: ["symbol", "direction", "entryType"],
    };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = String(args.symbol ?? "");
    const interval = typeof args.interval === "string" ? args.interval : "1h";
    const direction = args.direction as "long" | "short";
    const entryType = String(args.entryType ?? "");
    const entryPeriod = args.entryPeriod as number | undefined;
    const entryValue = args.entryValue as number | undefined;
    const initialCapital = Number(args.initialCapital ?? 10000);
    const leverage = Number(args.leverage ?? 10);
    const marginPerTradePct = Number(args.marginPerTradePct ?? 0.5);
    const stopValues = (args.stopValues as number[]) ?? [0.01, 0.02, 0.03];
    const targetValues = (args.targetValues as number[]) ?? [0.02, 0.04, 0.06];
    const thresholdValues = args.thresholdValues as number[] | undefined;
    const periodValues = args.periodValues as number[] | undefined;
    const slippageBps = Number(args.slippageBps ?? 0);

    const endTime = Number(args.endTime ?? Date.now());
    const startTime = Number(args.startTime ?? (endTime - 365 * 24 * 60 * 60 * 1000));
    const fetched = await fetchCandlesRange(symbol, interval, startTime, endTime);
    if ("error" in fetched) return fetched;
    const candles = fetched.candles;

    interface Entry { trades: number; winRate: number; pf: number; sharpe: number; returnPct: number; pnlUsd: number; maxDDPct: number; stopPct: number; targetPct: number; value?: number; period?: number; }

    const allResults: Entry[] = [];
    for (const sp of stopValues) {
      for (const tp of targetValues) {
        const threshVals = thresholdValues ?? (entryType.includes("rsi") ? [undefined] : [undefined]);
        const perVals = periodValues ?? (entryType.includes("ema") || entryType.includes("sma") || entryType.includes("rsi") ? [undefined] : [undefined]);
        for (const tv of threshVals) {
          for (const pv of perVals) {
            const entry = [{ type: entryType }] as { type: string; period?: number; value?: number }[];
            if (tv !== undefined) entry[0].value = tv;
            if (pv !== undefined) entry[0].period = pv;
            if (entryPeriod !== undefined && entry[0].period === undefined) entry[0].period = entryPeriod;
            if (entryValue !== undefined && entry[0].value === undefined) entry[0].value = entryValue;
            const result = runFuturesBacktest(candles, entry, direction, sp, tp, 5, 96, initialCapital, leverage, marginPerTradePct, slippageBps) as any;
            if ((result.metrics as any).totalTrades >= 10) {
              const m = result.metrics as any;
              allResults.push({
                trades: m.totalTrades, winRate: m.winRate,
                pf: m.profitFactor, sharpe: m.sharpeRatio,
                returnPct: m.totalReturnPct, pnlUsd: m.totalPnlUsd ?? m.totalReturnPct * initialCapital,
                maxDDPct: m.maxDrawdownPct,
                stopPct: sp, targetPct: tp, value: tv, period: pv,
              });
            }
          }
        }
      }
    }

    allResults.sort((a, b) => b.sharpe - a.sharpe);
    const best = allResults.filter(r => r.sharpe > 1).slice(0, 15);
    return { symbol, interval, candles: candles.length, initialCapital, leverage, combinationsTested: allResults.length, top: best.length > 0 ? best : allResults.slice(0, 10) };
  }
}

// ── Shared signal evaluator ──
// Precomputes every indicator array an entry-condition set might need, then
// returns a per-bar (i) => boolean check. This is THE single source of truth
// for "does this strategy's entry condition fire on bar i" — used by
// runFuturesBacktest below AND by the live paper-trading runner
// (src/paper-trading/live-runner.ts). Every prior round of this research hit
// the same bug repeatedly: a second, hand-rolled copy of this logic
// (mega-sweep.ts, walk-forward.ts, signal-scanner.ts, new-strats-backtest.ts)
// drifting from this one and producing numbers that don't reproduce. Do not
// reimplement this switch anywhere else — import buildSignalEvaluator.
export function buildSignalEvaluator(
  candles: Candle[],
  entryConditions: { type: string; period?: number; value?: number }[],
): (i: number) => boolean {
  const closes = candles.map(c => c.close);
  const smaP = new Set<number>(); const emaP = new Set<number>(); const rsiP = new Set<number>();
  let needMacd = false; let needBB = false; let needSmc = false;
  let needSuperTrend = false; let needAdx = false; let needIchimoku = false;
  const condTypes = entryConditions.map(c => c.type);
  const SMC_TYPES = new Set([
    "bearish_ob", "bullish_ob", "bearish_fvg", "bullish_fvg",
    "bearish_liq_sweep", "bullish_liq_sweep", "bearish_displacement", "bullish_displacement",
    "bearish_liq_ob", "bullish_liq_ob", "bearish_liq_fvg", "bullish_liq_fvg",
    "bearish_bos_displacement", "bullish_bos_displacement",
    "bearish_htf_trend_short", "bullish_htf_trend_long",
  ]);
  const SUPERTREND_TYPES = new Set(["supertrend_bullish_flip", "supertrend_bearish_flip"]);
  const ADX_TYPES = new Set(["adx_bullish_trend", "adx_bearish_trend", "adx_di_cross_long", "adx_di_cross_short"]);
  const ICHIMOKU_TYPES = new Set(["ichimoku_bullish_breakout", "ichimoku_bearish_breakout", "ichimoku_above_cloud_long", "ichimoku_below_cloud_short"]);
  let needVolume = false;
  for (const t of condTypes) {
    if (t.includes("sma")) smaP.add(entryConditions.find(c => c.type === t)?.period ?? 20);
    if (t.includes("ema")) emaP.add(entryConditions.find(c => c.type === t)?.period ?? 20);
    if (t.includes("rsi")) rsiP.add(entryConditions.find(c => c.type === t)?.period ?? 14);
    if (t.includes("macd")) needMacd = true;
    if (t.includes("bollinger")) needBB = true;
    if (SMC_TYPES.has(t)) needSmc = true;
    if (SUPERTREND_TYPES.has(t)) needSuperTrend = true;
    if (ADX_TYPES.has(t)) needAdx = true;
    if (ICHIMOKU_TYPES.has(t)) needIchimoku = true;
    if (t === "volume_spike_long" || t === "volume_spike_short") needVolume = true;
  }
  const smaMap = new Map<number, number[]>();
  const emaMap = new Map<number, number[]>();
  const rsiMap = new Map<number, number[]>();
  for (const p of smaP) smaMap.set(p, smaSeries(closes, p));
  for (const p of emaP) { const raw = emaSeries(closes, p); emaMap.set(p, [...Array(Math.max(0, closes.length - raw.length)).fill(NaN), ...raw]); }
  for (const p of rsiP) rsiMap.set(p, rsiSeries(closes, p));
  const macdArr = needMacd ? macdSeries(closes) : [];
  const bbArr = needBB ? bollingerSeries(closes) : [];

  // SMC/ICT precompute — same detectors the signal-fusion tool uses, wired
  // in here so single-strategy standalone backtests can actually test them
  // (previously only reachable inside BinanceSignalFusionTool).
  const n = closes.length;
  let ob_bull: boolean[] = [], ob_bear: boolean[] = [], fvg_bull: boolean[] = [], fvg_bear: boolean[] = [];
  let disp_bull: boolean[] = [], disp_bear: boolean[] = [], liq_bull: boolean[] = [], liq_bear: boolean[] = [];
  let liqob_bull: boolean[] = [], liqob_bear: boolean[] = [], liqfvg_bull: boolean[] = [], liqfvg_bear: boolean[] = [];
  let htfShort: boolean[] = [], htfLong: boolean[] = [];
  if (needSmc) {
    const sh = smcSwingHighs(closes, 5);
    const sl = smcSwingLows(closes, 5);
    ob_bull = new Array(n).fill(false); ob_bear = new Array(n).fill(false);
    fvg_bull = new Array(n).fill(false); fvg_bear = new Array(n).fill(false);
    disp_bull = new Array(n).fill(false); disp_bear = new Array(n).fill(false);
    liq_bull = new Array(n).fill(false); liq_bear = new Array(n).fill(false);
    liqob_bull = new Array(n).fill(false); liqob_bear = new Array(n).fill(false);
    liqfvg_bull = new Array(n).fill(false); liqfvg_bear = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      const oB = smcBullishOB(candles, i, 10) !== null;
      const oS = smcBearishOB(candles, i, 10) !== null;
      ob_bull[i] = oB; ob_bear[i] = oS;
      fvg_bull[i] = smcBullishFVG(candles, i);
      fvg_bear[i] = smcBearishFVG(candles, i);
      const d = smcDisplacement(candles, i);
      disp_bull[i] = d?.dir === "up"; disp_bear[i] = d?.dir === "down";
      liq_bull[i] = smcBullishLiqSweep(candles, sl, i, 20);
      liq_bear[i] = smcBearishLiqSweep(candles, sh, i, 20);
      liqob_bull[i] = liq_bull[i] && oB;
      liqob_bear[i] = liq_bear[i] && oS;
      liqfvg_bull[i] = liq_bull[i] && fvg_bull[i];
      liqfvg_bear[i] = liq_bear[i] && fvg_bear[i];
    }
    if (condTypes.includes("bearish_htf_trend_short")) {
      htfShort = new Array(n).fill(false);
      for (let i = 50; i < n; i++) {
        const avg = (closes[i - 1] + closes[i - 2] + closes[i - 3] + closes[i - 4] + closes[i - 5]) / 5;
        htfShort[i] = closes[i] < avg * 0.98 && ob_bear[i];
      }
    }
    if (condTypes.includes("bullish_htf_trend_long")) {
      htfLong = new Array(n).fill(false);
      for (let i = 50; i < n; i++) {
        const avg = (closes[i - 1] + closes[i - 2] + closes[i - 3] + closes[i - 4] + closes[i - 5]) / 5;
        htfLong[i] = closes[i] > avg * 1.02 && ob_bull[i];
      }
    }
  }

  // LuxAlgo-style trend indicators — SuperTrend (ATR-trailed flip), ADX/DMI
  // (trend strength + direction), Ichimoku Cloud (kumo breakout).
  const superTrend = needSuperTrend ? superTrendSeries(candles, 10, 3) : [];
  const adx = needAdx ? adxSeries(candles, 14) : [];
  const ichimoku = needIchimoku ? ichimokuSeries(candles) : [];
  const volSma20 = needVolume ? smaSeries(candles.map(c => c.volume), 20) : [];

  // OB zone-retest signals (mitigation entries — enter on retrace into a
  // fresh order-block zone, not at the impulse bar like bullish_ob/bearish_ob).
  // condition.value overrides the impulse threshold (× ATR), default 1.5.
  let obRetest: { long: boolean[]; short: boolean[] } | null = null;
  const obRetestCond = entryConditions.find(c => c.type === "ob_retest_long" || c.type === "ob_retest_short");
  if (obRetestCond) {
    const zones = detectOrderBlockZones(candles, { impulseThreshold: obRetestCond.value ?? 1.5 });
    obRetest = buildObRetestSignals(candles, zones);
  }

  return (i: number) => entryConditions.every(c => {
      const val = (m: Map<number, number[]>, p: number) => m.get(p)?.[i];
      switch (c.type) {
        case "rsi_below": { const x = val(rsiMap, c.period ?? 14); return x !== undefined && !Number.isNaN(x) && x < (c.value ?? 30); }
        case "rsi_above": { const x = val(rsiMap, c.period ?? 14); return x !== undefined && !Number.isNaN(x) && x > (c.value ?? 70); }
        case "price_above_sma": { const x = val(smaMap, c.period ?? 20); return x !== undefined && !Number.isNaN(x) && closes[i] > x; }
        case "price_below_sma": { const x = val(smaMap, c.period ?? 20); return x !== undefined && !Number.isNaN(x) && closes[i] < x; }
        case "price_above_ema": { const x = val(emaMap, c.period ?? 20); return x !== undefined && !Number.isNaN(x) && closes[i] > x; }
        case "price_below_ema": { const x = val(emaMap, c.period ?? 20); return x !== undefined && !Number.isNaN(x) && closes[i] < x; }
        case "macd_bullish_cross": { const cur = macdArr[i]; const prev = macdArr[i-1]; return !!cur && !!prev && !Number.isNaN(cur.macd) && !Number.isNaN(prev.macd) && prev.macd <= prev.signal && cur.macd > cur.signal; }
        case "macd_bearish_cross": { const cur = macdArr[i]; const prev = macdArr[i-1]; return !!cur && !!prev && !Number.isNaN(cur.macd) && !Number.isNaN(prev.macd) && prev.macd >= prev.signal && cur.macd < cur.signal; }
        case "bollinger_touch_lower": { const b = bbArr[i]; return !!b && !Number.isNaN(b.lower) && closes[i] <= b.lower; }
        case "bollinger_touch_upper": { const b = bbArr[i]; return !!b && !Number.isNaN(b.upper) && closes[i] >= b.upper; }
        case "bearish_ob": return ob_bear[i];
        case "bullish_ob": return ob_bull[i];
        case "bearish_fvg": return fvg_bear[i];
        case "bullish_fvg": return fvg_bull[i];
        case "bearish_liq_sweep": return liq_bear[i];
        case "bullish_liq_sweep": return liq_bull[i];
        case "bearish_displacement": case "bearish_bos_displacement": return disp_bear[i];
        case "bullish_displacement": case "bullish_bos_displacement": return disp_bull[i];
        case "bearish_liq_ob": return liqob_bear[i];
        case "bullish_liq_ob": return liqob_bull[i];
        case "bearish_liq_fvg": return liqfvg_bear[i];
        case "bullish_liq_fvg": return liqfvg_bull[i];
        case "bearish_htf_trend_short": return htfShort[i] ?? false;
        case "bullish_htf_trend_long": return htfLong[i] ?? false;
        case "supertrend_bullish_flip": return i > 0 && superTrend[i]?.trend === "up" && superTrend[i - 1]?.trend === "down";
        case "supertrend_bearish_flip": return i > 0 && superTrend[i]?.trend === "down" && superTrend[i - 1]?.trend === "up";
        case "adx_bullish_trend": { const a = adx[i]; return !!a && !Number.isNaN(a.adx) && a.adx > (c.value ?? 25) && a.plusDI > a.minusDI; }
        case "adx_bearish_trend": { const a = adx[i]; return !!a && !Number.isNaN(a.adx) && a.adx > (c.value ?? 25) && a.minusDI > a.plusDI; }
        case "ichimoku_bullish_breakout": return i > 0 && ichimoku[i]?.cloud === "above" && ichimoku[i - 1]?.cloud !== "above";
        case "ichimoku_bearish_breakout": return i > 0 && ichimoku[i]?.cloud === "below" && ichimoku[i - 1]?.cloud !== "below";
        case "ichimoku_above_cloud_long": return ichimoku[i]?.cloud === "above";
        case "ichimoku_below_cloud_short": return ichimoku[i]?.cloud === "below";
        case "adx_di_cross_long": { const a = adx[i]; const pv = adx[i - 1]; return i > 0 && !!a && !!pv && !Number.isNaN(a.adx) && a.adx > (c.value ?? 20) && a.plusDI > a.minusDI && pv.plusDI <= pv.minusDI; }
        case "adx_di_cross_short": { const a = adx[i]; const pv = adx[i - 1]; return i > 0 && !!a && !!pv && !Number.isNaN(a.adx) && a.adx > (c.value ?? 20) && a.minusDI > a.plusDI && pv.minusDI <= pv.plusDI; }
        case "volume_spike_long": return !Number.isNaN(volSma20[i]) && candles[i].volume > volSma20[i] * 2 && candles[i].close > candles[i].open;
        case "volume_spike_short": return !Number.isNaN(volSma20[i]) && candles[i].volume > volSma20[i] * 2 && candles[i].close < candles[i].open;
        case "ob_retest_long": return obRetest?.long[i] ?? false;
        case "ob_retest_short": return obRetest?.short[i] ?? false;
        default: return false;
      }
  });
}

// ── Futures backtest engine (shared between the two tools above) ──
export function runFuturesBacktest(
  candles: Candle[],
  entryConditions: { type: string; period?: number; value?: number }[],
  direction: "long" | "short",
  stopPct: number, targetPct: number, feeBps: number, maxHoldBars: number,
  initialCapital: number, leverage: number, marginPerTradePct: number,
  slippageBps = 0,
  // Optional per-candle entry gate for multi-timeframe bias filtering: entries
  // only allowed where entryMask[i] is true. Caller is responsible for building
  // the mask WITHOUT lookahead (i.e. from already-closed higher-timeframe bars).
  entryMask?: boolean[],
  // Optional sub-bar exit resolution: lower-timeframe candles (e.g. 5m) used
  // to determine WHICH of stop/target was hit first when both fall inside one
  // native bar (at native resolution the engine assumes stop-first —
  // pessimistic). barMs = the native timeframe's bar duration in ms; sub
  // candles are grouped into native bars by openTime.
  subBars?: { candles: Candle[]; barMs: number },
): Record<string, unknown> {

  const subMap = new Map<number, Candle[]>();
  if (subBars) {
    for (const sc of subBars.candles) {
      const key = Math.floor(sc.openTime / subBars.barMs) * subBars.barMs;
      const arr = subMap.get(key);
      if (arr) arr.push(sc); else subMap.set(key, [sc]);
    }
  }

  const evaluator = buildSignalEvaluator(candles, entryConditions);
  const slipFrac = slippageBps / 10000;
  const feeFrac = feeBps / 10000;
  let capital = initialCapital;
  const eq: number[] = [capital];
  const returns: number[] = [];
  let trades = 0; let wins = 0; let losses = 0;
  let grossProfit = 0; let grossLoss = 0;

  let i = 0;
  while (i < candles.length) {
    const allTrue = evaluator(i);
    if (!allTrue || (entryMask && !entryMask[i])) { i++; continue; }

    const rawEntry = candles[i].close;
    const entryPrice = direction === "long" ? rawEntry * (1 + slipFrac) : rawEntry * (1 - slipFrac);
    const margin = capital * marginPerTradePct;
    const notional = margin * leverage;
    const qty = notional / entryPrice;
    const stopPrice = direction === "long" ? entryPrice * (1 - stopPct) : entryPrice * (1 + stopPct);
    const targetPrice = direction === "long" ? entryPrice * (1 + targetPct) : entryPrice * (1 - targetPct);
    const liqPrice = direction === "long" ? entryPrice * (1 - 1/leverage + 0.005) : entryPrice * (1 + 1/leverage - 0.005);

    let exitIdx = candles.length - 1;
    let exitPrice = candles[exitIdx].close;
    for (let j = i + 1; j < candles.length && j <= i + maxHoldBars; j++) {
      const b = candles[j];
      const subs = subBars ? subMap.get(b.openTime) : undefined;
      if (subs && subs.length > 0) {
        // Sub-bar resolution: walk lower-TF candles chronologically, first
        // level touched wins (residual within-sub-bar ambiguity keeps the
        // conservative liq→stop→target order at 1/12th the bar size).
        let resolved = false;
        for (const s of subs) {
          if (direction === "long" ? s.low <= liqPrice : s.high >= liqPrice) { exitIdx = j; exitPrice = liqPrice; resolved = true; break; }
          if (direction === "long" ? s.low <= stopPrice : s.high >= stopPrice) { exitIdx = j; exitPrice = direction === "long" ? stopPrice * (1 - slipFrac) : stopPrice * (1 + slipFrac); resolved = true; break; }
          if (direction === "long" ? s.high >= targetPrice : s.low <= targetPrice) { exitIdx = j; exitPrice = targetPrice; resolved = true; break; }
        }
        if (resolved) break;
        if (j === i + maxHoldBars) { exitIdx = j; exitPrice = direction === "long" ? b.close * (1 - slipFrac) : b.close * (1 + slipFrac); }
        continue;
      }
      if (direction === "long" ? b.low <= liqPrice : b.high >= liqPrice) { exitIdx = j; exitPrice = liqPrice; break; }
      if (direction === "long" ? b.low <= stopPrice : b.high >= stopPrice) { exitIdx = j; exitPrice = direction === "long" ? stopPrice * (1 - slipFrac) : stopPrice * (1 + slipFrac); break; }
      if (direction === "long" ? b.high >= targetPrice : b.low <= targetPrice) { exitIdx = j; exitPrice = targetPrice; break; }
      if (j === i + maxHoldBars) { exitIdx = j; exitPrice = direction === "long" ? b.close * (1 - slipFrac) : b.close * (1 + slipFrac); }
    }
    const pnl = (exitPrice - entryPrice) * (direction === "long" ? 1 : -1) * qty - notional * feeFrac;
    capital += pnl; eq.push(capital);
    const ret = pnl / margin;
    returns.push(ret);
    trades++; if (pnl > 0) { wins++; grossProfit += pnl; } else { losses++; grossLoss += Math.abs(pnl); }
    i = exitIdx + 1;
  }

  const winRate = trades > 0 ? wins / trades : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const totalPnlUsd = capital - initialCapital;
  const totalReturnPct = totalPnlUsd / initialCapital;
  const expectancyPct = trades > 0 ? returns.reduce((s, v) => s + v, 0) / trades : 0;
  let peak = initialCapital; let mdd = 0; let mddUsd = 0;
  for (const e of eq) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > mdd) { mdd = dd; mddUsd = peak - e; } }
  const avgR = trades > 0 ? returns.reduce((s, v) => s + v, 0) / trades : 0;
  const variance = trades > 1 ? returns.reduce((s, v) => s + (v - avgR)**2, 0) / (trades - 1) : 0;
  const sharpeRatio = Math.sqrt(365 * 24) * avgR / (Math.sqrt(variance) || 1);
  const avgWinPct = wins > 0 ? returns.filter(r => r > 0).reduce((s, v) => s + v, 0) / wins : 0;
  const avgLossPct = losses > 0 ? returns.filter(r => r <= 0).reduce((s, v) => s + v, 0) / losses : 0;
  const maxDrawdownPct = mdd;

  return {
    metrics: {
      totalTrades: trades,
      winRate,
      avgWinPct,
      avgLossPct,
      expectancyPct,
      profitFactor,
      totalReturnPct,
      maxDrawdownPct,
      totalPnlUsd,
      sharpeRatio,
    },
    equityCurve: eq,
  };
}

// ── SMC/ICT market structure helpers (shared by signal-fusion tool) ──
export function smcSwingHighs(closes: number[], lookback: number): boolean[] {
  return closes.map((_, i) => {
    if (i < lookback || i >= closes.length - lookback) return false;
    for (let j = i - lookback; j <= i + lookback; j++) if (j !== i && closes[j] >= closes[i]) return false;
    return true;
  });
}
export function smcSwingLows(closes: number[], lookback: number): boolean[] {
  return closes.map((_, i) => {
    if (i < lookback || i >= closes.length - lookback) return false;
    for (let j = i - lookback; j <= i + lookback; j++) if (j !== i && closes[j] <= closes[i]) return false;
    return true;
  });
}
function smcBullishOB(candles: Candle[], i: number, lb: number): number | null {
  if (i < 2) return null;
  const body = Math.abs(candles[i].close - candles[i].open);
  const range = candles[i].high - candles[i].low;
  if (!(body > range * 0.6 && candles[i].close > candles[i - 1].high)) return null;
  for (let j = i - 1; j >= Math.max(1, i - lb); j--) if (candles[j].close < candles[j].open) return j;
  return null;
}
function smcBearishOB(candles: Candle[], i: number, lb: number): number | null {
  if (i < 2) return null;
  const body = Math.abs(candles[i].close - candles[i].open);
  const range = candles[i].high - candles[i].low;
  if (!(body > range * 0.6 && candles[i].close < candles[i - 1].low)) return null;
  for (let j = i - 1; j >= Math.max(1, i - lb); j--) if (candles[j].close > candles[j].open) return j;
  return null;
}
function smcBullishFVG(candles: Candle[], i: number): boolean {
  if (i < 1 || i >= candles.length - 1) return false;
  return candles[i - 1].high < candles[i + 1].low;
}
function smcBearishFVG(candles: Candle[], i: number): boolean {
  if (i < 1 || i >= candles.length - 1) return false;
  return candles[i - 1].low > candles[i + 1].high;
}
export function smcBullishLiqSweep(candles: Candle[], lows: boolean[], i: number, lb: number): boolean {
  if (i < 1) return false;
  for (let j = i - 1; j >= Math.max(0, i - lb); j--)
    if (lows[j] && candles[i - 1].low < candles[j].low && candles[i].close > candles[j].low) return true;
  return false;
}
export function smcBearishLiqSweep(candles: Candle[], highs: boolean[], i: number, lb: number): boolean {
  if (i < 1) return false;
  for (let j = i - 1; j >= Math.max(0, i - lb); j--)
    if (highs[j] && candles[i - 1].high > candles[j].high && candles[i].close < candles[j].high) return true;
  return false;
}
function smcDisplacement(candles: Candle[], i: number): { dir: "up" | "down"; strength: number } | null {
  if (i < 1) return null;
  const body = Math.abs(candles[i].close - candles[i].open);
  const avg = candles.slice(Math.max(0, i - 20), i).reduce((s, c) => s + Math.abs(c.close - c.open), 0) / 20;
  if (body > avg * 1.5 && candles[i].close > candles[i - 1].high) return { dir: "up", strength: body / avg };
  if (body > avg * 1.5 && candles[i].close < candles[i - 1].low) return { dir: "down", strength: body / avg };
  return null;
}

export class BinanceSignalFusionTool extends Tool {
  get name(): string { return "binance_signal_fusion"; }
  get description(): string {
    return (
      "Multi-strategy signal fusion backtest. Runs ALL strategies per symbol in parallel. " +
      "First strategy to trigger enters the trade. Additional same-side signals while in position " +
      "add confluence (increase position size). Tracks per-strategy contribution and confluence events."
    );
  }
  get tags(): string[] { return ["binance", "backtest", "fusion", "multi-strategy", "quant-research"]; }
  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        strategies: {
          type: "object",
          description: "Keys = symbol, value = array of strategy configs",
          properties: {},
        },
        initialCapital: { type: "number", default: 10000 },
        leverage: { type: "number", default: 10 },
        marginPerTradePct: { type: "number", default: 0.5 },
        confluentAddPct: { type: "number", default: 0.5, description: "Additional margin fraction on confluence signal" },
        interval: { type: "string", default: "1h" },
        startTime: { type: "number" },
        endTime: { type: "number" },
      },
      required: ["strategies"],
    };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const strategies = args.strategies as Record<string, any[]>;
    const initialCapital = Number(args.initialCapital ?? 10000);
    const leverage = Number(args.leverage ?? 10);
    const marginPerTradePct = Number(args.marginPerTradePct ?? 0.5);
    const confluentAddPct = Number(args.confluentAddPct ?? 0.5);
    const interval = String(args.interval ?? "1h");
    const endTime = Number(args.endTime ?? Date.now());
    const startTime = Number(args.startTime ?? (endTime - 365 * 24 * 60 * 60 * 1000));

    const symbolData: Record<string, Candle[]> = {};
    for (const sym of Object.keys(strategies)) {
      const fetched = await fetchCandlesRange(sym, interval, startTime, endTime);
      if ("error" in fetched) return fetched;
      symbolData[sym] = fetched.candles;
    }

    // ── Pre-compute ALL indicator arrays per symbol (O(n) pass) ──
    type PreComputed = {
      closes: number[]; sh: boolean[]; sl: boolean[];
      rsi: Record<number, (number | undefined)[]>;
      macd: { macd: number; signal: number }[];
      bb: { upper: number; lower: number; middle: number }[];
      ema: Record<number, number[]>;
      ob_bull: boolean[]; ob_bear: boolean[];
      fvg_bull: boolean[]; fvg_bear: boolean[];
      disp_bull: boolean[]; disp_bear: boolean[];
      liq_bull: boolean[]; liq_bear: boolean[];
      liqob_bull: boolean[]; liqob_bear: boolean[];
      liqfvg_bull: boolean[]; liqfvg_bear: boolean[];
      htfShort?: boolean[]; htfLong?: boolean[];
      superTrend?: { trend: "up" | "down" }[];
      adx?: { adx: number; plusDI: number; minusDI: number }[];
      ichimoku?: { cloud: "above" | "below" | "inside" }[];
      volSma20?: number[];
    };
    const pre: Record<string, PreComputed> = {};

    for (const [sym, candles] of Object.entries(symbolData)) {
      const closes = candles.map(c => c.close);
      const n = closes.length;
      const sh = smcSwingHighs(closes, 5);
      const sl = smcSwingLows(closes, 5);

      const needRsi = new Set<number>();
      const needEma = new Set<number>();
      for (const s of (strategies[sym] || [])) {
        if (s.signalType === "rsi_above" || s.signalType === "rsi_below") needRsi.add(s.signalPeriod ?? 14);
        if (s.signalType === "price_above_ema" || s.signalType === "price_below_ema") needEma.add(s.signalPeriod ?? 20);
      }
      const rsi: Record<number, (number | undefined)[]> = {};
      for (const p of needRsi) rsi[p] = rsiSeries(closes, p) as (number | undefined)[];

      const macd = macdSeries(closes) as { macd: number; signal: number }[];
      const bb = bollingerSeries(closes) as { upper: number; lower: number; middle: number }[];

      const ema: Record<number, number[]> = {};
      for (const p of needEma) {
        const raw = emaSeries(closes, p) as number[];
        ema[p] = [...Array(n - raw.length).fill(NaN), ...raw];
      }

      const ob_bull = new Array<boolean>(n).fill(false);
      const ob_bear = new Array<boolean>(n).fill(false);
      const fvg_bull = new Array<boolean>(n).fill(false);
      const fvg_bear = new Array<boolean>(n).fill(false);
      const disp_bull = new Array<boolean>(n).fill(false);
      const disp_bear = new Array<boolean>(n).fill(false);
      const liq_bull = new Array<boolean>(n).fill(false);
      const liq_bear = new Array<boolean>(n).fill(false);
      const liqob_bull = new Array<boolean>(n).fill(false);
      const liqob_bear = new Array<boolean>(n).fill(false);
      const liqfvg_bull = new Array<boolean>(n).fill(false);
      const liqfvg_bear = new Array<boolean>(n).fill(false);

      for (let i = 0; i < n; i++) {
        const oB = smcBullishOB(candles, i, 10) !== null;
        const oS = smcBearishOB(candles, i, 10) !== null;
        ob_bull[i] = oB; ob_bear[i] = oS;
        fvg_bull[i] = smcBullishFVG(candles, i);
        fvg_bear[i] = smcBearishFVG(candles, i);
        const d = smcDisplacement(candles, i);
        disp_bull[i] = d?.dir === "up"; disp_bear[i] = d?.dir === "down";
        liq_bull[i] = smcBullishLiqSweep(candles, sl, i, 20);
        liq_bear[i] = smcBearishLiqSweep(candles, sh, i, 20);
        liqob_bull[i] = liq_bull[i] && oB;
        liqob_bear[i] = liq_bear[i] && oS;
        liqfvg_bull[i] = liq_bull[i] && fvg_bull[i];
        liqfvg_bear[i] = liq_bear[i] && fvg_bear[i];
      }

      const extra: Partial<PreComputed> = {};
      for (const s of (strategies[sym] || [])) {
        if (s.signalType === "bearish_htf_trend_short") {
          extra.htfShort = new Array(n).fill(false);
          for (let i = 50; i < n; i++) {
            const avg = (closes[i - 1] + closes[i - 2] + closes[i - 3] + closes[i - 4] + closes[i - 5]) / 5;
            extra.htfShort[i] = closes[i] < avg * 0.98 && ob_bear[i];
          }
        }
        if (s.signalType === "bullish_htf_trend_long") {
          extra.htfLong = new Array(n).fill(false);
          for (let i = 50; i < n; i++) {
            const avg = (closes[i - 1] + closes[i - 2] + closes[i - 3] + closes[i - 4] + closes[i - 5]) / 5;
            extra.htfLong[i] = closes[i] > avg * 1.02 && ob_bull[i];
          }
        }
      }
      const needSuperTrend = (strategies[sym] || []).some(s => s.signalType === "supertrend_bullish_flip" || s.signalType === "supertrend_bearish_flip");
      const needAdx = (strategies[sym] || []).some(s => ["adx_bullish_trend", "adx_bearish_trend", "adx_di_cross_long", "adx_di_cross_short"].includes(s.signalType));
      const needIchimoku = (strategies[sym] || []).some(s => ["ichimoku_bullish_breakout", "ichimoku_bearish_breakout", "ichimoku_above_cloud_long", "ichimoku_below_cloud_short"].includes(s.signalType));
      const needVolume = (strategies[sym] || []).some(s => s.signalType === "volume_spike_long" || s.signalType === "volume_spike_short");
      if (needSuperTrend) extra.superTrend = superTrendSeries(candles, 10, 3);
      if (needAdx) extra.adx = adxSeries(candles, 14);
      if (needIchimoku) extra.ichimoku = ichimokuSeries(candles);
      if (needVolume) extra.volSma20 = smaSeries(candles.map(c => c.volume), 20);

      pre[sym] = { closes, sh, sl, rsi, macd, bb, ema, ob_bull, ob_bear, fvg_bull, fvg_bear, disp_bull, disp_bear, liq_bull, liq_bear, liqob_bull, liqob_bear, liqfvg_bull, liqfvg_bear, ...extra };
    }

    const positions: Record<string, any> = {};
    for (const sym of Object.keys(strategies)) positions[sym] = null;

    const eqCurve: number[] = [initialCapital];
    let capital = initialCapital;
    const tradeLog: any[] = [];
    const stratCounts: Record<string, number> = {};
    const confluences: Record<string, number> = {};
    const feeFrac = 5 / 10000;
    const maxLen = Math.max(...Object.values(symbolData).map(c => c.length));

    for (let i = 50; i < maxLen; i++) {
      if (i % 10 === 0) eqCurve.push(capital);
      for (const [sym, candles] of Object.entries(symbolData)) {
        if (i >= candles.length) continue;
        const p = pre[sym];
        const stratList = strategies[sym] || [];

        const triggered: { strat: any; dir: string }[] = [];
        for (const s of stratList) {
          const sig = s.signalType; const per = s.signalPeriod ?? 14; const val = s.signalValue;
          let hit = false;

          if (sig === "rsi_above") { const a = p.rsi[per]; hit = a?.[i] !== undefined && !isNaN(a[i]!) && a[i]! > (val ?? 70); }
          else if (sig === "rsi_below") { const a = p.rsi[per]; hit = a?.[i] !== undefined && !isNaN(a[i]!) && a[i]! < (val ?? 30); }
          else if (sig === "macd_bearish_cross") { const c = p.macd[i]; const v = p.macd[i - 1]; hit = !!c && !!v && !isNaN(c.macd) && !isNaN(v.macd) && v.macd >= v.signal && c.macd < c.signal; }
          else if (sig === "macd_bullish_cross") { const c = p.macd[i]; const v = p.macd[i - 1]; hit = !!c && !!v && !isNaN(c.macd) && !isNaN(v.macd) && v.macd <= v.signal && c.macd > c.signal; }
          else if (sig === "bollinger_touch_upper") { const b = p.bb[i]; hit = !!b && !isNaN(b.upper) && candles[i].close >= b.upper; }
          else if (sig === "bollinger_touch_lower") { const b = p.bb[i]; hit = !!b && !isNaN(b.lower) && candles[i].close <= b.lower; }
          else if (sig === "price_above_ema") { const a = p.ema[per]; hit = a?.[i] !== undefined && !isNaN(a[i]) && candles[i].close > a[i]; }
          else if (sig === "price_below_ema") { const a = p.ema[per]; hit = a?.[i] !== undefined && !isNaN(a[i]) && candles[i].close < a[i]; }
          else if (sig === "bearish_ob") hit = p.ob_bear[i];
          else if (sig === "bullish_ob") hit = p.ob_bull[i];
          else if (sig === "bearish_fvg") hit = p.fvg_bear[i];
          else if (sig === "bullish_fvg") hit = p.fvg_bull[i];
          else if (sig === "bearish_liq_sweep") hit = p.liq_bear[i];
          else if (sig === "bullish_liq_sweep") hit = p.liq_bull[i];
          else if (sig === "bearish_displacement") hit = p.disp_bear[i];
          else if (sig === "bullish_displacement") hit = p.disp_bull[i];
          else if (sig === "bearish_liq_ob") hit = p.liqob_bear[i];
          else if (sig === "bullish_liq_ob") hit = p.liqob_bull[i];
          else if (sig === "bearish_liq_fvg") hit = p.liqfvg_bear[i];
          else if (sig === "bullish_liq_fvg") hit = p.liqfvg_bull[i];
          else if (sig === "bearish_bos_displacement") hit = p.disp_bear[i];
          else if (sig === "bullish_bos_displacement") hit = p.disp_bull[i];
          else if (sig === "bearish_htf_trend_short") hit = p.htfShort?.[i] ?? false;
          else if (sig === "bullish_htf_trend_long") hit = p.htfLong?.[i] ?? false;
          else if (sig === "supertrend_bullish_flip") hit = i > 0 && p.superTrend?.[i]?.trend === "up" && p.superTrend?.[i - 1]?.trend === "down";
          else if (sig === "supertrend_bearish_flip") hit = i > 0 && p.superTrend?.[i]?.trend === "down" && p.superTrend?.[i - 1]?.trend === "up";
          else if (sig === "adx_bullish_trend") { const a = p.adx?.[i]; hit = !!a && !isNaN(a.adx) && a.adx > (val ?? 25) && a.plusDI > a.minusDI; }
          else if (sig === "adx_bearish_trend") { const a = p.adx?.[i]; hit = !!a && !isNaN(a.adx) && a.adx > (val ?? 25) && a.minusDI > a.plusDI; }
          else if (sig === "ichimoku_bullish_breakout") hit = i > 0 && p.ichimoku?.[i]?.cloud === "above" && p.ichimoku?.[i - 1]?.cloud !== "above";
          else if (sig === "ichimoku_bearish_breakout") hit = i > 0 && p.ichimoku?.[i]?.cloud === "below" && p.ichimoku?.[i - 1]?.cloud !== "below";
          else if (sig === "ichimoku_above_cloud_long") hit = p.ichimoku?.[i]?.cloud === "above";
          else if (sig === "ichimoku_below_cloud_short") hit = p.ichimoku?.[i]?.cloud === "below";
          else if (sig === "adx_di_cross_long") { const a = p.adx?.[i]; const pv = p.adx?.[i - 1]; hit = i > 0 && !!a && !!pv && !isNaN(a.adx) && a.adx > (val ?? 20) && a.plusDI > a.minusDI && pv.plusDI <= pv.minusDI; }
          else if (sig === "adx_di_cross_short") { const a = p.adx?.[i]; const pv = p.adx?.[i - 1]; hit = i > 0 && !!a && !!pv && !isNaN(a.adx) && a.adx > (val ?? 20) && a.minusDI > a.plusDI && pv.minusDI <= pv.plusDI; }
          else if (sig === "volume_spike_long") { const vs = p.volSma20?.[i]; hit = vs !== undefined && !isNaN(vs) && candles[i].volume > vs * 2 && candles[i].close > candles[i].open; }
          else if (sig === "volume_spike_short") { const vs = p.volSma20?.[i]; hit = vs !== undefined && !isNaN(vs) && candles[i].volume > vs * 2 && candles[i].close < candles[i].open; }

          if (hit) triggered.push({ strat: s, dir: s.direction });
        }

        if (triggered.length === 0) continue;

        const pos = positions[sym];
        if (!pos) {
          const t = triggered[0];
          const ep = candles[i].close;
          if (capital <= 0) continue;
          const baseMargin = Math.min(capital * marginPerTradePct, capital * 0.5);
          const notional = baseMargin * leverage;
          const qty = notional / ep;
          const dir = t.dir;
          const sp = dir === "long" ? ep * (1 - t.strat.stopPct) : ep * (1 + t.strat.stopPct);
          const tp = dir === "long" ? ep * (1 + t.strat.targetPct) : ep * (1 - t.strat.targetPct);
          const liq = dir === "long" ? ep * (1 - 1 / leverage + 0.005) : ep * (1 + 1 / leverage - 0.005);

          positions[sym] = { direction: dir, entryPrice: ep, entryIdx: i, margin: baseMargin, notional, qty, stopPrice: sp, targetPrice: tp, liqPrice: liq, baseMargin, confluences: [], entryStrat: t.strat.id || t.strat.label };
          stratCounts[t.strat.id || t.strat.label] = (stratCounts[t.strat.id || t.strat.label] || 0) + 1;
          tradeLog.push({ type: "entry", sym, time: new Date(candles[i].openTime).toISOString(), dir, price: ep, strat: t.strat.label, margin: baseMargin });
        } else {
          const sameSide = triggered.filter(t => t.dir === pos.direction);
          for (const t of sameSide) {
            const sig = t.strat.signalType;
            const isTrivialFilter = sig === "price_below_ema" || sig === "price_above_ema" || sig === "bollinger_touch_upper" || sig === "bollinger_touch_lower";
            if (isTrivialFilter) continue;
            const key = `confluence:${t.strat.label}`;
            confluences[key] = (confluences[key] || 0) + 1;
            if (pos.confluences.length < 3) {
              const addMargin = pos.baseMargin * confluentAddPct;
              const addNotional = addMargin * leverage;
              pos.margin += addMargin;
              pos.notional += addNotional;
              pos.qty += addNotional / candles[i].close;
              pos.confluences.push(t.strat.label);
              tradeLog.push({ type: "confluence_add", sym, time: new Date(candles[i].openTime).toISOString(), dir: pos.direction, price: candles[i].close, strat: t.strat.label, addMargin });
            }
          }
        }
      }

      for (const [sym, pos] of Object.entries(positions)) {
        if (!pos) continue;
        const candles = symbolData[sym];
        if (i >= candles.length) continue;
        const bar = candles[i];
        const dir = pos.direction;
        const hitLiq = dir === "long" ? bar.low <= pos.liqPrice : bar.high >= pos.liqPrice;
        const hitStop = dir === "long" ? bar.low <= pos.stopPrice : bar.high >= pos.stopPrice;
        const hitTarget = dir === "long" ? bar.high >= pos.targetPrice : bar.low <= pos.targetPrice;

        if (hitLiq || hitStop || hitTarget || i - pos.entryIdx >= 48) {
          let xp: number; let reason: string;
          if (hitLiq) { xp = pos.liqPrice; reason = "liquidation"; }
          else if (hitStop) { xp = pos.stopPrice; reason = "stop"; }
          else if (hitTarget) { xp = pos.targetPrice; reason = "target"; }
          else { xp = bar.close; reason = "timeout"; }
          const pnl = (xp - pos.entryPrice) * (dir === "long" ? 1 : -1) * pos.qty - pos.notional * feeFrac;
          capital += pnl; if (capital < 0) capital = 0;
          tradeLog.push({ type: "exit", sym, time: new Date(bar.openTime).toISOString(), dir, price: xp, reason, pnl: Math.round(pnl * 100) / 100, entryStrat: pos.entryStrat, confluences: pos.confluences.length });
          positions[sym] = null;
        }
      }
    }

    for (const [sym, pos] of Object.entries(positions)) {
      if (!pos) continue;
      const candles = symbolData[sym];
      const xp = candles[candles.length - 1].close;
      const pnl = (xp - pos.entryPrice) * (pos.direction === "long" ? 1 : -1) * pos.qty - pos.notional * feeFrac;
      capital += pnl; if (capital < 0) capital = 0;
      positions[sym] = null;
    }

    const totalPnl = capital - initialCapital;
    let peak = initialCapital; let mdd = 0;
    for (const e of eqCurve) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > mdd) mdd = dd; }

    return {
      initialCapital, finalCapital: Math.round(capital * 100) / 100,
      totalReturnPct: totalPnl / initialCapital,
      totalPnlUsd: Math.round(totalPnl * 100) / 100,
      maxDrawdownPct: mdd,
      totalTrades: tradeLog.filter(t => t.type === "entry").length,
      trades: tradeLog,
      strategyEntryCounts: stratCounts,
      confluenceEvents: confluences,
    };
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

  get tags(): string[] {
    return ["binance", "backtest", "portfolio", "quant-research"];
  }

  get parameters(): Record<string, unknown> {
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
    const symbols = (args.symbols as string[]) || [];
    const interval = typeof args.interval === "string" ? args.interval : "1h";
    const limit = Math.min(Number(args.limit ?? 500) || 500, 1000);
    const strategy = args.strategy as StrategyConfig;
    const initialCapital = Number(args.initialCapital ?? 10000);
    const maxConcurrentPositions = Number(args.maxConcurrentPositions ?? 5);
    const allocationPerTradePct = Number(args.allocationPerTradePct ?? 0.10);

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
