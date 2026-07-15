#!/usr/bin/env tsx
import "dotenv/config";
import { smaSeries, emaSeries, rsiSeries, macdSeries, bollingerSeries } from "./src/tools/indicators.js";

const API_BASE = "https://api.binance.com";

interface Candle {
  openTime: number; open: number; high: number; low: number; close: number; volume: number;
}
interface Trade {
  entryTime: string; exitTime: string; entryPrice: number; exitPrice: number;
  direction: "long" | "short"; returnPct: number; pnlUsd: number; exitReason: string;
}
interface FuturesMetrics {
  totalTrades: number; winRate: number; profitFactor: number; expectancyPct: number;
  totalReturnPct: number; totalPnlUsd: number; maxDrawdownPct: number; maxDrawdownUsd: number;
  sharpeRatio: number; avgHoldBars: number;
}

function parseKlineRows(rows: unknown[][]): Candle[] {
  return rows.map(r => ({ openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }));
}

async function fetchAllKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let from = startTime;
  while (from < endTime) {
    const url = new URL(`${API_BASE}/api/v3/klines`);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("startTime", String(from));
    url.searchParams.set("endTime", String(endTime));
    const res = await fetch(url);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    const c = parseKlineRows(rows);
    all.push(...c);
    from = c[c.length - 1].openTime + 1;
    await new Promise(r => setTimeout(r, 200));
  }
  return all;
}

interface IndicatorSeries {
  closes: number[];
  sma: Map<number, number[]>; ema: Map<number, number[]>;
  rsi: Map<number, number[]>;
  macd: Array<{ macd: number; signal: number; histogram: number }>;
  bollinger: Array<{ upper: number; middle: number; lower: number }>;
}

function buildSeries(candles: Candle[], conditions: { type: string; period?: number }[]): IndicatorSeries {
  const closes = candles.map(c => c.close);
  const smaP = new Set<number>(); const emaP = new Set<number>(); const rsiP = new Set<number>();
  let needMacd = false; let needBB = false;
  for (const c of conditions) {
    if (c.type.includes("sma")) smaP.add(c.period ?? 20);
    if (c.type.includes("ema")) emaP.add(c.period ?? 20);
    if (c.type.includes("rsi")) rsiP.add(c.period ?? 14);
    if (c.type.includes("macd")) needMacd = true;
    if (c.type.includes("bollinger")) needBB = true;
  }
  const sma = new Map<number, number[]>(); const ema = new Map<number, number[]>();
  const rsi = new Map<number, number[]>();
  for (const p of smaP) sma.set(p, smaSeries(closes, p));
  for (const p of emaP) {
    const raw = emaSeries(closes, p); const pad = closes.length - raw.length;
    ema.set(p, [...Array(Math.max(0, pad)).fill(NaN), ...raw]);
  }
  for (const p of rsiP) rsi.set(p, rsiSeries(closes, p));
  return { closes, sma, ema, rsi, macd: needMacd ? macdSeries(closes) : [], bollinger: needBB ? bollingerSeries(closes) : [] };
}

function evalCond(cond: { type: string; period?: number; value?: number }, s: IndicatorSeries, i: number): boolean {
  const v = (m: Map<number, number[]>, p: number) => m.get(p)?.[i];
  switch (cond.type) {
    case "rsi_below": { const x = v(s.rsi, cond.period ?? 14); return x !== undefined && !Number.isNaN(x) && x < (cond.value ?? 30); }
    case "rsi_above": { const x = v(s.rsi, cond.period ?? 14); return x !== undefined && !Number.isNaN(x) && x > (cond.value ?? 70); }
    case "price_above_sma": { const x = v(s.sma, cond.period ?? 20); return x !== undefined && !Number.isNaN(x) && s.closes[i] > x; }
    case "price_below_sma": { const x = v(s.sma, cond.period ?? 20); return x !== undefined && !Number.isNaN(x) && s.closes[i] < x; }
    case "price_above_ema": { const x = v(s.ema, cond.period ?? 20); return x !== undefined && !Number.isNaN(x) && s.closes[i] > x; }
    case "price_below_ema": { const x = v(s.ema, cond.period ?? 20); return x !== undefined && !Number.isNaN(x) && s.closes[i] < x; }
    case "macd_bullish_cross": { const cur = s.macd[i]; const prev = s.macd[i-1]; return !!cur && !!prev && !Number.isNaN(cur.macd) && !Number.isNaN(prev.macd) && prev.macd <= prev.signal && cur.macd > cur.signal; }
    case "macd_bearish_cross": { const cur = s.macd[i]; const prev = s.macd[i-1]; return !!cur && !!prev && !Number.isNaN(cur.macd) && !Number.isNaN(prev.macd) && prev.macd >= prev.signal && cur.macd < cur.signal; }
    case "bollinger_touch_lower": { const b = s.bollinger[i]; return !!b && !Number.isNaN(b.lower) && s.closes[i] <= b.lower; }
    case "bollinger_touch_upper": { const b = s.bollinger[i]; return !!b && !Number.isNaN(b.upper) && s.closes[i] >= b.upper; }
    default: return false;
  }
}

function runFuturesBacktest(
  candles: Candle[],
  entryConditions: { type: string; period?: number; value?: number }[],
  direction: "long" | "short",
  stopPct: number, targetPct: number,
  feeBps: number, maxHoldBars: number,
  initialCapital: number, leverage: number, marginPerTradePct: number,
): { metrics: FuturesMetrics; equityCurve: number[] } {
  const s = buildSeries(candles, entryConditions);
  const feeFrac = feeBps / 10000;
  let capital = initialCapital;
  const eq: number[] = [capital];
  let trades = 0; let wins = 0; let losses = 0;
  let grossProfit = 0; let grossLoss = 0;
  const returns: number[] = [];

  let i = 0;
  while (i < candles.length) {
    if (!entryConditions.every(c => evalCond(c, s, i))) { i++; continue; }
    const entryPrice = candles[i].close;
    const margin = capital * marginPerTradePct;
    const notional = margin * leverage;
    const qty = notional / entryPrice;
    const stopPrice = direction === "long" ? entryPrice * (1 - stopPct) : entryPrice * (1 + stopPct);
    const targetPrice = direction === "long" ? entryPrice * (1 + targetPct) : entryPrice * (1 - targetPct);
    const liqPrice = direction === "long" ? entryPrice * (1 - 1/leverage + 0.005) : entryPrice * (1 + 1/leverage - 0.005);
    let exitIdx = candles.length - 1; let exitPrice = candles[exitIdx].close; let reason = "eod";
    for (let j = i + 1; j < candles.length && j <= i + maxHoldBars; j++) {
      const b = candles[j];
      if (direction === "long" ? b.low <= liqPrice : b.high >= liqPrice) { exitIdx = j; exitPrice = liqPrice; reason = "liq"; break; }
      if (direction === "long" ? b.low <= stopPrice : b.high >= stopPrice) { exitIdx = j; exitPrice = stopPrice; reason = "stop"; break; }
      if (direction === "long" ? b.high >= targetPrice : b.low <= targetPrice) { exitIdx = j; exitPrice = targetPrice; reason = "target"; break; }
      if (j === i + maxHoldBars) { exitIdx = j; exitPrice = b.close; reason = "timeout"; }
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

  return { metrics: { totalTrades: trades, winRate, profitFactor, expectancyPct, totalReturnPct, totalPnlUsd, maxDrawdownPct: mdd, maxDrawdownUsd: mddUsd, sharpeRatio, avgHoldBars: 0 }, equityCurve: eq };
}

async function main() {
  const SYMBOLS = ["XRPUSDT", "SOLUSDT", "ETHUSDT"];
  const INTERVAL = "1h";
  const now = Date.now();
  const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;
  const CAPITAL = 10000; const LEVERAGE = 10; const MARGIN_PCT = 0.5;

  interface StrategyDef {
    label: string; direction: "long" | "short";
    entry: { type: string; period?: number; value?: number }[];
    paramFields: { field: "stopPct" | "targetPct" | "value" | "period"; values: number[] }[];
  }

  const strategies: StrategyDef[] = [
    {
      label: "RSI short MR", direction: "short",
      entry: [{ type: "rsi_above", period: 14, value: 70 }],
      paramFields: [
        { field: "stopPct", values: [0.005, 0.01, 0.015, 0.02, 0.03] },
        { field: "targetPct", values: [0.02, 0.03, 0.04, 0.06, 0.08, 0.12] },
        { field: "value", values: [60, 65, 70, 75, 80] },
      ],
    },
    {
      label: "RSI long MR", direction: "long",
      entry: [{ type: "rsi_below", period: 14, value: 30 }],
      paramFields: [
        { field: "stopPct", values: [0.005, 0.01, 0.015, 0.02, 0.03] },
        { field: "targetPct", values: [0.02, 0.03, 0.04, 0.06, 0.08, 0.12] },
        { field: "value", values: [20, 25, 30, 35, 40] },
      ],
    },
    {
      label: "MACD bearish short", direction: "short",
      entry: [{ type: "macd_bearish_cross" }],
      paramFields: [
        { field: "stopPct", values: [0.005, 0.01, 0.015, 0.02, 0.03] },
        { field: "targetPct", values: [0.02, 0.03, 0.04, 0.06, 0.08, 0.12] },
      ],
    },
    {
      label: "MACD bullish long", direction: "long",
      entry: [{ type: "macd_bullish_cross" }],
      paramFields: [
        { field: "stopPct", values: [0.005, 0.01, 0.015, 0.02, 0.03] },
        { field: "targetPct", values: [0.02, 0.03, 0.04, 0.06, 0.08, 0.12] },
      ],
    },
    {
      label: "BB touch upper short", direction: "short",
      entry: [{ type: "bollinger_touch_upper" }],
      paramFields: [
        { field: "stopPct", values: [0.005, 0.01, 0.015, 0.02, 0.03] },
        { field: "targetPct", values: [0.02, 0.03, 0.04, 0.06, 0.08, 0.12] },
      ],
    },
    {
      label: "BB touch lower long", direction: "long",
      entry: [{ type: "bollinger_touch_lower" }],
      paramFields: [
        { field: "stopPct", values: [0.005, 0.01, 0.015, 0.02, 0.03] },
        { field: "targetPct", values: [0.02, 0.03, 0.04, 0.06, 0.08, 0.12] },
      ],
    },
    {
      label: "Price<EMA short", direction: "short",
      entry: [{ type: "price_below_ema", period: 20 }],
      paramFields: [
        { field: "stopPct", values: [0.005, 0.01, 0.015, 0.02, 0.03] },
        { field: "targetPct", values: [0.02, 0.03, 0.04, 0.06, 0.08, 0.12] },
        { field: "period", values: [10, 20, 30, 50, 100] },
      ],
    },
    {
      label: "Price>EMA long", direction: "long",
      entry: [{ type: "price_above_ema", period: 20 }],
      paramFields: [
        { field: "stopPct", values: [0.005, 0.01, 0.015, 0.02, 0.03] },
        { field: "targetPct", values: [0.02, 0.03, 0.04, 0.06, 0.08, 0.12] },
        { field: "period", values: [10, 20, 30, 50, 100] },
      ],
    },
  ];

  interface SweepResult {
    symbol: string; strategy: string; direction: "long" | "short";
    entryType: string;
    stopPct: number; targetPct: number;
    value?: number; period?: number;
    trades: number; winRate: number; pf: number; sharpe: number;
    returnPct: number; pnlUsd: number; maxDDPct: number;
  }

  for (const sym of SYMBOLS) {
    console.log(`\n📦 Fetching ${sym} 1h klines...`);
    process.stdout.write("  ");
    const candles = await fetchAllKlines(sym, INTERVAL, oneYearAgo, now);
    console.log(` ${candles.length} candles`);

    const allResults: SweepResult[] = [];

    for (const strat of strategies) {
      const stopVals = strat.paramFields.find(f => f.field === "stopPct")?.values ?? [0.02];
      const targetVals = strat.paramFields.find(f => f.field === "targetPct")?.values ?? [0.04];
      const valueVals = strat.paramFields.find(f => f.field === "value")?.values ?? [undefined];
      const periodVals = strat.paramFields.find(f => f.field === "period")?.values ?? [undefined];

      for (const stopPct of stopVals) {
        for (const targetPct of targetVals) {
          for (const value of valueVals) {
            for (const period of periodVals) {
              const entry = strat.entry.map(c => ({ ...c }));
              if (value !== undefined) entry[0].value = value;
              if (period !== undefined) entry[0].period = period;

              const result = runFuturesBacktest(candles, entry, strat.direction,
                stopPct, targetPct, 5, 96, CAPITAL, LEVERAGE, MARGIN_PCT);

              if (result.metrics.totalTrades >= 10) {
                allResults.push({
                  symbol: sym, strategy: strat.label,
                  direction: strat.direction, entryType: strat.entry[0].type,
                  stopPct, targetPct, value, period,
                  ...result.metrics,
                  pf: result.metrics.profitFactor,
                  sharpe: result.metrics.sharpeRatio,
                  returnPct: result.metrics.totalReturnPct,
                  pnlUsd: result.metrics.totalPnlUsd,
                  maxDDPct: result.metrics.maxDrawdownPct,
                });
              }
            }
          }
        }
      }
    }

    // Sort by Sharpe, display top 15
    allResults.sort((a, b) => b.sharpe - a.sharpe);
    const best = allResults.filter(r => r.sharpe > 1).length > 0
      ? allResults.slice(0, 15)
      : allResults.filter(r => r.pf > 1).slice(0, 10);

    if (best.length === 0) {
      console.log(`\n  ${sym}: No parameter combo produced edge. Showing best by Sharpe:\n`);
      const top3 = allResults.slice(0, 3);
      for (const r of top3) {
        console.log(`    ${r.strategy.padEnd(22)} S=${(r.stopPct*100).toFixed(1)}% T=${(r.targetPct*100).toFixed(1)}% ${r.value != null ? `thresh=${r.value}` : ""} ${r.period != null ? `per=${r.period}` : ""}  trades=${r.trades} WR=${(r.winRate*100).toFixed(0)}% PF=${r.pf.toFixed(2)} SR=${r.sharpe.toFixed(2)} PnL=$${(r.pnlUsd).toLocaleString()}`);
      }
      continue;
    }

    console.log(`\n  Top combos (sorted by Sharpe):\n`);
    console.log(`  ${"Strategy".padEnd(22)} ${"Params".padEnd(24)} ${"Trades".padEnd(6)} ${"WR".padEnd(5)} ${"PF".padEnd(6)} ${"Sharpe".padEnd(7)} ${"Return".padEnd(9)} ${"PnL".padEnd(12)} ${"MaxDD".padEnd(7)}`);
    console.log(`  ${"─".repeat(22)} ${"─".repeat(24)} ${"─".repeat(6)} ${"─".repeat(5)} ${"─".repeat(6)} ${"─".repeat(7)} ${"─".repeat(9)} ${"─".repeat(12)} ${"─".repeat(7)}`);
    for (const r of best) {
      const params = `S=${(r.stopPct*100).toFixed(1)}% T=${(r.targetPct*100).toFixed(1)}%${r.value != null ? ` V=${r.value}` : ""}${r.period != null ? ` P=${r.period}` : ""}`;
      console.log(`  ${r.strategy.padEnd(22)} ${params.padEnd(24)} ${String(r.trades).padEnd(6)} ${(r.winRate*100).toFixed(0).padEnd(4)}% ${r.pf.toFixed(2).padEnd(5)} ${r.sharpe.toFixed(2).padEnd(6)} ${(r.returnPct*100).toFixed(1).padEnd(7)}% $${Math.round(r.pnlUsd).toLocaleString().padEnd(10)} ${(r.maxDDPct*100).toFixed(1).padEnd(5)}%`);
    }

    // Walk-forward on top 3
    console.log(`\n  ── Walk-forward validation on top 3 ──\n`);
    for (const r of best.slice(0, 3)) {
      const foldSize = Math.floor(candles.length / 4);
      const foldResults: number[] = [];
      let allPositive = true;
      for (let f = 0; f < 4; f++) {
        const from = f * foldSize;
        const to = f === 3 ? candles.length : from + foldSize;
        const entry = [{ type: r.entryType, period: r.period ?? undefined, value: r.value ?? undefined }];
        const fr = runFuturesBacktest(candles.slice(from, to), entry as any, r.direction,
          r.stopPct, r.targetPct, 5, 96, CAPITAL, LEVERAGE, MARGIN_PCT);
        foldResults.push(fr.metrics.totalReturnPct);
        if (fr.metrics.totalReturnPct <= 0) allPositive = false;
      }
      const avg = foldResults.reduce((s, v) => s + v, 0) / foldResults.length;
      const stable = allPositive ? "⭐" : avg > 0 ? "📊" : "⚠️";
      console.log(`  ${stable} ${r.strategy.padEnd(22)} S=${(r.stopPct*100).toFixed(1)} T=${(r.targetPct*100).toFixed(1)}${r.value != null ? ` V=${r.value}` : ""}${r.period != null ? ` P=${r.period}` : ""}`);
      console.log(`      Fold returns: ${foldResults.map(v => (v*100).toFixed(1)+"%").join(", ")}`);
      console.log(`      Avg fold: ${(avg*100).toFixed(2)}%  All positive: ${allPositive}\n`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
