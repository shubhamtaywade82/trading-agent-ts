import type { parseKlineRows } from "../backtest/types.js";

import { fetchCandles, fetchCandlesRange, fetchOpenInterestHist, alignOiToCandles } from "./backtest-fetch.js";
import { runFuturesBacktest } from "./backtest-futures.js";
import { CONDITION_SCHEMA } from "./backtest-shared.js";
import { buildSignalEvaluator } from "./backtest-signals.js";
import { Tool } from "./tool.js";

export class BinanceFuturesBacktestTool extends Tool {
  get name(): string { return "binance_futures_backtest"; }
  get description(): string {
    return (
      "Futures-style backtest with leverage, capital tracking, and stop/target/liquidation. " +
      "Fetches multi-batch historical klines (1 year+ supported via startTime/endTime). " +
      "Simulates a single position at a time with full margin deployment and liquidation at 1/leverage."
    );
  }
  override get tags(): string[] { return ["binance", "backtest", "futures", "quant-research"]; }
  override get parameters(): Record<string, unknown> {
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
    const symbol = String(args["symbol"] ?? "");
    const interval = typeof args["interval"] === "string" ? args["interval"] : "1h";
    const limit = Math.min(Number(args["limit"] ?? 500) || 500, 1000);
    const direction = args["direction"] as "long" | "short";
    const entry = args["entry"] as Array<{ type: string; period?: number; value?: number }>;
    const stopPct = Number(args["stopPct"] ?? 0.02);
    const targetPct = Number(args["targetPct"] ?? 0.04);
    const feeBps = Number(args["feeBps"] ?? 5);
    const maxHoldBars = Number(args["maxHoldBars"] ?? 96);
    const initialCapital = Number(args["initialCapital"] ?? 10_000);
    const leverage = Number(args["leverage"] ?? 1);
    const marginPerTradePct = Number(args["marginPerTradePct"] ?? 0.5);
    const slippageBps = Number(args["slippageBps"] ?? 0);

    let candles: ReturnType<typeof parseKlineRows>;
    if (args["startTime"]) {
      const endTime = Number(args["endTime"] ?? Date.now());
      const fetched = await fetchCandlesRange(symbol, interval, Number(args["startTime"]), endTime);
      if ("error" in fetched) return fetched;
      candles = fetched.candles;
    } else {
      const fetched = await fetchCandles(symbol, interval, limit);
      if ("error" in fetched) return fetched;
      candles = fetched.candles;
    }

    let evaluatorOrEntry: typeof entry | ((i: number) => boolean) = entry;
    if (entry.some(c => c.type.startsWith("oi_"))) {
      const first = candles[0];
      const last = candles.at(-1);
      if (first === undefined || last === undefined) {
        return { error: "NoCandles", message: `No candles fetched for ${symbol} ${interval}` };
      }
      const oiStart = first.openTime;
      const oiEnd = last.openTime + 1;
      const oiResult = await fetchOpenInterestHist(symbol, interval, oiStart, oiEnd);
      if ("error" in oiResult) return oiResult;
      const oiSeries = alignOiToCandles(candles, oiResult.points);
      evaluatorOrEntry = buildSignalEvaluator(candles, entry, { oi: oiSeries });
    }

    const result = runFuturesBacktest(candles, evaluatorOrEntry, direction, stopPct, targetPct, feeBps, maxHoldBars, initialCapital, leverage, marginPerTradePct, slippageBps) as any;
    return { symbol, interval, candles: candles.length, direction, leverage, initialCapital, ...(result.metrics as Record<string, unknown>) };
  }
}

// Day-trader-sane defaults per timeframe: lower timeframes get tighter
// Stop/target grids (a 5m candle's typical move is a fraction of an hourly
// Candle's) and shorter lookback (a 5m strategy's "regime" is weeks, not a
// Year — and pulling 1yr of 5m candles is ~105k rows / ~105 paginated
// Fetches per symbol); higher timeframes get wider grids and longer lookback
// Since a 1d strategy needs multiple years to accumulate a usable trade count.
const TIMEFRAME_DEFAULTS: Record<string, { lookbackDays: number; stopValues: number[]; targetValues: number[]; maxHoldBars: number }> = {
  "5m": { lookbackDays: 45, stopValues: [0.003, 0.005, 0.008, 0.01], targetValues: [0.005, 0.01, 0.015, 0.02], maxHoldBars: 48 },   // 4h max hold
  "15m": { lookbackDays: 90, stopValues: [0.005, 0.008, 0.01, 0.015], targetValues: [0.01, 0.02, 0.03], maxHoldBars: 48 },          // 12h max hold
  "30m": { lookbackDays: 180, stopValues: [0.008, 0.012, 0.02], targetValues: [0.015, 0.03, 0.04], maxHoldBars: 48 },               // 24h max hold
  "1h": { lookbackDays: 365, stopValues: [0.01, 0.02, 0.03], targetValues: [0.02, 0.04, 0.06, 0.12], maxHoldBars: 48 },             // 2d max hold
  "2h": { lookbackDays: 365, stopValues: [0.015, 0.025, 0.04], targetValues: [0.03, 0.06, 0.1], maxHoldBars: 48 },                 // 4d max hold
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
  override get tags(): string[] { return ["binance", "backtest", "futures", "multi-timeframe", "param-sweep", "quant-research"]; }
  override get parameters(): Record<string, unknown> {
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
        initialCapital: { type: "number", default: 10_000 },
        leverage: { type: "number", default: 5 },
        marginPerTradePct: { type: "number", default: 0.05 },
        slippageBps: { type: "number", default: 3 },
        feeBps: { type: "number", default: 5 },
      },
      required: ["symbol", "direction", "entry"],
    };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = String(args["symbol"] ?? "");
    const direction = args["direction"] as "long" | "short";
    const entry = args["entry"] as Array<{ type: string; period?: number; value?: number }>;
    const intervals = (args["intervals"] as string[]) ?? ["15m", "30m", "1h", "4h"];
    const overrideStops = args["stopValues"] as number[] | undefined;
    const overrideTargets = args["targetValues"] as number[] | undefined;
    const minTrades = Number(args["minTrades"] ?? 15);
    const initialCapital = Number(args["initialCapital"] ?? 10_000);
    const leverage = Number(args["leverage"] ?? 5);
    const marginPerTradePct = Number(args["marginPerTradePct"] ?? 0.05);
    const slippageBps = Number(args["slippageBps"] ?? 3);
    const feeBps = Number(args["feeBps"] ?? 5);

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
  override get tags(): string[] { return ["binance", "backtest", "futures", "param-sweep", "quant-research"]; }
  override get parameters(): Record<string, unknown> {
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
        initialCapital: { type: "number", default: 10_000 },
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
    const symbol = String(args["symbol"] ?? "");
    const interval = typeof args["interval"] === "string" ? args["interval"] : "1h";
    const direction = args["direction"] as "long" | "short";
    const entryType = String(args["entryType"] ?? "");
    const entryPeriod = args["entryPeriod"] as number | undefined;
    const entryValue = args["entryValue"] as number | undefined;
    const initialCapital = Number(args["initialCapital"] ?? 10_000);
    const leverage = Number(args["leverage"] ?? 10);
    const marginPerTradePct = Number(args["marginPerTradePct"] ?? 0.5);
    const stopValues = (args["stopValues"] as number[]) ?? [0.01, 0.02, 0.03];
    const targetValues = (args["targetValues"] as number[]) ?? [0.02, 0.04, 0.06];
    const thresholdValues = args["thresholdValues"] as number[] | undefined;
    const periodValues = args["periodValues"] as number[] | undefined;
    const slippageBps = Number(args["slippageBps"] ?? 0);

    const endTime = Number(args["endTime"] ?? Date.now());
    const startTime = Number(args["startTime"] ?? (endTime - 365 * 24 * 60 * 60 * 1000));
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
            const cond = { type: entryType } as { type: string; period?: number; value?: number };
            if (tv !== undefined) cond.value = tv;
            if (pv !== undefined) cond.period = pv;
            if (entryPeriod !== undefined && cond.period === undefined) cond.period = entryPeriod;
            if (entryValue !== undefined && cond.value === undefined) cond.value = entryValue;
            const entry = [cond];
            const result = runFuturesBacktest(candles, entry, direction, sp, tp, 5, 96, initialCapital, leverage, marginPerTradePct, slippageBps) as any;
            if ((result.metrics).totalTrades >= 10) {
              const m = result.metrics;
              allResults.push({
                trades: m.totalTrades, winRate: m.winRate,
                pf: m.profitFactor, sharpe: m.sharpeRatio,
                returnPct: m.totalReturnPct, pnlUsd: m.totalPnlUsd ?? m.totalReturnPct * initialCapital,
                maxDDPct: m.maxDrawdownPct,
                stopPct: sp, targetPct: tp,
                ...(tv !== undefined && { value: tv }),
                ...(pv !== undefined && { period: pv }),
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
