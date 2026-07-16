import { Tool } from "./tool.js";
import { parseKlineRows, StrategyConfig, BacktestMetrics, Candle } from "../backtest/types.js";
import { runBacktest } from "../backtest/engine.js";
import { walkForward, monteCarlo, paramSweep, ParamRange } from "../backtest/analysis.js";
import { smaSeries, emaSeries, rsiSeries, macdSeries, bollingerSeries } from "./indicators.js";
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
async function fetchCandlesRange(
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

    const result = runFuturesBacktest(candles, entry, direction, stopPct, targetPct, feeBps, maxHoldBars, initialCapital, leverage, marginPerTradePct) as any;
    return { symbol, interval, candles: candles.length, direction, leverage, initialCapital, ...(result.metrics as Record<string, unknown>) };
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
            const result = runFuturesBacktest(candles, entry, direction, sp, tp, 5, 96, initialCapital, leverage, marginPerTradePct) as any;
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

// ── Futures backtest engine (shared between the two tools above) ──
function runFuturesBacktest(
  candles: Candle[],
  entryConditions: { type: string; period?: number; value?: number }[],
  direction: "long" | "short",
  stopPct: number, targetPct: number, feeBps: number, maxHoldBars: number,
  initialCapital: number, leverage: number, marginPerTradePct: number,
): Record<string, unknown> {

  const closes = candles.map(c => c.close);
  const smaP = new Set<number>(); const emaP = new Set<number>(); const rsiP = new Set<number>();
  let needMacd = false; let needBB = false;
  const condTypes = entryConditions.map(c => c.type);
  for (const t of condTypes) {
    if (t.includes("sma")) smaP.add(entryConditions.find(c => c.type === t)?.period ?? 20);
    if (t.includes("ema")) emaP.add(entryConditions.find(c => c.type === t)?.period ?? 20);
    if (t.includes("rsi")) rsiP.add(entryConditions.find(c => c.type === t)?.period ?? 14);
    if (t.includes("macd")) needMacd = true;
    if (t.includes("bollinger")) needBB = true;
  }
  const smaMap = new Map<number, number[]>();
  const emaMap = new Map<number, number[]>();
  const rsiMap = new Map<number, number[]>();
  for (const p of smaP) smaMap.set(p, smaSeries(closes, p));
  for (const p of emaP) { const raw = emaSeries(closes, p); emaMap.set(p, [...Array(Math.max(0, closes.length - raw.length)).fill(NaN), ...raw]); }
  for (const p of rsiP) rsiMap.set(p, rsiSeries(closes, p));
  const macdArr = needMacd ? macdSeries(closes) : [];
  const bbArr = needBB ? bollingerSeries(closes) : [];

  const feeFrac = feeBps / 10000;
  let capital = initialCapital;
  const eq: number[] = [capital];
  const returns: number[] = [];
  let trades = 0; let wins = 0; let losses = 0;
  let grossProfit = 0; let grossLoss = 0;

  let i = 0;
  while (i < candles.length) {
    const allTrue = entryConditions.every(c => {
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
        default: return false;
      }
    });
    if (!allTrue) { i++; continue; }

    const entryPrice = candles[i].close;
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
      if (direction === "long" ? b.low <= liqPrice : b.high >= liqPrice) { exitIdx = j; exitPrice = liqPrice; break; }
      if (direction === "long" ? b.low <= stopPrice : b.high >= stopPrice) { exitIdx = j; exitPrice = stopPrice; break; }
      if (direction === "long" ? b.high >= targetPrice : b.low <= targetPrice) { exitIdx = j; exitPrice = targetPrice; break; }
      if (j === i + maxHoldBars) { exitIdx = j; exitPrice = b.close; }
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
function smcSwingHighs(closes: number[], lookback: number): boolean[] {
  return closes.map((_, i) => {
    if (i < lookback || i >= closes.length - lookback) return false;
    for (let j = i - lookback; j <= i + lookback; j++) if (j !== i && closes[j] >= closes[i]) return false;
    return true;
  });
}
function smcSwingLows(closes: number[], lookback: number): boolean[] {
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
function smcBullishLiqSweep(candles: Candle[], lows: boolean[], i: number, lb: number): boolean {
  if (i < 1) return false;
  for (let j = i - 1; j >= Math.max(0, i - lb); j--)
    if (lows[j] && candles[i - 1].low < candles[j].low && candles[i].close > candles[j].low) return true;
  return false;
}
function smcBearishLiqSweep(candles: Candle[], highs: boolean[], i: number, lb: number): boolean {
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
