#!/usr/bin/env tsx
import "dotenv/config";
import { smaSeries, emaSeries, rsiSeries, macdSeries, bollingerSeries } from "./src/tools/indicators.js";

const API_BASE = "https://api.binance.com";

interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Trade {
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  direction: "long" | "short";
  returnPct: number;
  pnlUsd: number;
  exitReason: string;
}

interface FuturesMetrics {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  expectancyPct: number;
  totalReturnPct: number;
  totalPnlUsd: number;
  maxDrawdownPct: number;
  maxDrawdownUsd: number;
  sharpeRatio: number;
  avgHoldBars: number;
  equityCurve: number[];
}

function parseKlineRows(rows: unknown[][]): Candle[] {
  return rows.map((row) => ({
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  }));
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
    const candles = parseKlineRows(rows);
    all.push(...candles);
    from = candles[candles.length - 1].openTime + 1;
    await new Promise(r => setTimeout(r, 300));
    process.stdout.write(".");
  }
  return all;
}

interface IndicatorSeries {
  closes: number[];
  sma: Map<number, number[]>;
  ema: Map<number, number[]>;
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
    const raw = emaSeries(closes, p);
    const pad = closes.length - raw.length;
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
    case "macd_bullish_cross": {
      const cur = s.macd[i]; const prev = s.macd[i - 1];
      return !!cur && !!prev && !Number.isNaN(cur.macd) && !Number.isNaN(prev.macd) && prev.macd <= prev.signal && cur.macd > cur.signal;
    }
    case "macd_bearish_cross": {
      const cur = s.macd[i]; const prev = s.macd[i - 1];
      return !!cur && !!prev && !Number.isNaN(cur.macd) && !Number.isNaN(prev.macd) && prev.macd >= prev.signal && cur.macd < cur.signal;
    }
    case "bollinger_touch_lower": { const b = s.bollinger[i]; return !!b && !Number.isNaN(b.lower) && s.closes[i] <= b.lower; }
    case "bollinger_touch_upper": { const b = s.bollinger[i]; return !!b && !Number.isNaN(b.upper) && s.closes[i] >= b.upper; }
    default: return false;
  }
}

function runFuturesBacktest(
  candles: Candle[],
  entryConditions: { type: string; period?: number; value?: number }[],
  direction: "long" | "short",
  risk: { stopPct: number; targetPct: number },
  feeBps: number,
  maxHoldBars: number,
  initialCapital: number,
  leverage: number,
  marginPerTradePct: number,  // fraction of capital deployed per trade
): { trades: Trade[]; metrics: FuturesMetrics } {
  const s = buildSeries(candles, entryConditions);
  const feeFrac = feeBps / 10000;
  const trades: Trade[] = [];
  let capital = initialCapital;
  const equityCurve: number[] = [capital];

  let i = 0;
  while (i < candles.length) {
    const allTrue = entryConditions.every(c => evalCond(c, s, i));
    if (!allTrue) { i++; continue; }

    const entryPrice = candles[i].close;
    const margin = capital * marginPerTradePct;
    const notional = margin * leverage;
    const quantity = notional / entryPrice;

    const stopPrice = direction === "long"
      ? entryPrice * (1 - risk.stopPct)
      : entryPrice * (1 + risk.stopPct);
    const targetPrice = direction === "long"
      ? entryPrice * (1 + risk.targetPct)
      : entryPrice * (1 - risk.targetPct);
    const liqPrice = direction === "long"
      ? entryPrice * (1 - 1 / leverage + 0.005)  // 0.5% buffer before full liquidation
      : entryPrice * (1 + 1 / leverage - 0.005);

    let exitIndex = candles.length - 1;
    let exitPrice = candles[exitIndex].close;
    let exitReason = "end-of-data";

    for (let j = i + 1; j < candles.length && j <= i + maxHoldBars; j++) {
      const bar = candles[j];
      const hitLiq = direction === "long" ? bar.low <= liqPrice : bar.high >= liqPrice;
      const hitStop = direction === "long" ? bar.low <= stopPrice : bar.high >= stopPrice;
      const hitTarget = direction === "long" ? bar.high >= targetPrice : bar.low <= targetPrice;

      if (hitLiq) { exitIndex = j; exitPrice = liqPrice; exitReason = "liquidation"; break; }
      if (hitStop) { exitIndex = j; exitPrice = stopPrice; exitReason = "stop"; break; }
      if (hitTarget) { exitIndex = j; exitPrice = targetPrice; exitReason = "target"; break; }
      if (j === i + maxHoldBars) { exitIndex = j; exitPrice = bar.close; exitReason = "timeout"; }
    }

    const rawReturn = direction === "long"
      ? (exitPrice - entryPrice) / entryPrice
      : (entryPrice - exitPrice) / entryPrice;
    const pnlNotional = (exitPrice - entryPrice) * (direction === "long" ? 1 : -1) * quantity;
    const fee = notional * feeFrac;
    const pnlNet = pnlNotional - fee;
    const returnOnMargin = pnlNet / margin;

    capital += pnlNet;
    equityCurve.push(capital);

    trades.push({
      entryTime: new Date(candles[i].openTime).toISOString().slice(0, 16),
      exitTime: new Date(candles[exitIndex].openTime).toISOString().slice(0, 16),
      entryPrice, exitPrice, direction,
      returnPct: returnOnMargin,
      pnlUsd: Math.round(pnlNet * 100) / 100,
      exitReason,
    });

    i = exitIndex + 1;
  }

  const wins = trades.filter(t => t.pnlUsd > 0);
  const losses = trades.filter(t => t.pnlUsd <= 0);
  const totalTrades = trades.length;
  const winRate = totalTrades > 0 ? wins.length / totalTrades : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlUsd, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlUsd, 0) / losses.length : 0;
  const totalPnlUsd = capital - initialCapital;
  const totalReturnPct = totalPnlUsd / initialCapital;
  const grossProfit = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const expectancyPct = totalTrades > 0 ? totalPnlUsd / initialCapital / totalTrades : 0;

  let peak = initialCapital;
  let maxDrawdownPct = 0;
  let maxDrawdownUsd = 0;
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > maxDrawdownPct) { maxDrawdownPct = dd; maxDrawdownUsd = peak - eq; }
  }

  const returns = trades.map(t => t.returnPct);
  const avgR = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance = returns.length > 1 ? returns.reduce((s, v) => s + (v - avgR) ** 2, 0) / (returns.length - 1) : 0;
  const sharpeRatio = Math.sqrt(365) * avgR / (Math.sqrt(variance) || 1);
  const avgHoldBars = trades.length > 0 ? trades.reduce((s, t) => {
    const [ey, em, ed] = t.exitTime.split("-").map(Number);
    const [eny, enm, end] = t.entryTime.split("-").map(Number);
    const [exh] = t.exitTime.split("T")[1]?.split(":").map(Number) ?? [0];
    const [enh] = t.entryTime.split("T")[1]?.split(":").map(Number) ?? [0];
    return s + (ed - end) * 24 + (exh - enh);
  }, 0) / trades.length : 0;

  return { trades, metrics: { totalTrades, winRate, profitFactor, expectancyPct, totalReturnPct, totalPnlUsd, maxDrawdownPct, maxDrawdownUsd, sharpeRatio, avgHoldBars, equityCurve } };
}

async function main() {
  const SYMBOLS = ["SOLUSDT", "ETHUSDT", "XRPUSDT"];
  const INTERVAL = "1h";
  const now = Date.now();
  const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;

  const RISK = { stopPct: 0.02, targetPct: 0.04 };
  const FEE_BPS = 5;
  const MAX_HOLD = 96;
  const CAPITAL = 10000;
  const LEVERAGE = 10;
  const MARGIN_PER_TRADE = 0.5;

  const strategies: { label: string; direction: "long" | "short"; entry: { type: string; period?: number; value?: number }[] }[] = [
    { label: "RSI short MR (>70)", direction: "short", entry: [{ type: "rsi_above", period: 14, value: 70 }] },
    { label: "RSI long MR (<30)", direction: "long", entry: [{ type: "rsi_below", period: 14, value: 30 }] },
    { label: "Price>EMA long", direction: "long", entry: [{ type: "price_above_ema", period: 20 }] },
    { label: "Price<EMA short", direction: "short", entry: [{ type: "price_below_ema", period: 20 }] },
    { label: "Bollinger touch lower long", direction: "long", entry: [{ type: "bollinger_touch_lower" }] },
    { label: "Bollinger touch upper short", direction: "short", entry: [{ type: "bollinger_touch_upper" }] },
    { label: "MACD bullish cross long", direction: "long", entry: [{ type: "macd_bullish_cross" }] },
    { label: "MACD bearish cross short", direction: "short", entry: [{ type: "macd_bearish_cross" }] },
    { label: "RSI<30+Price>EMA long combo", direction: "long", entry: [{ type: "rsi_below", period: 14, value: 30 }, { type: "price_above_ema", period: 20 }] },
    { label: "RSI>70+Price<EMA short combo", direction: "short", entry: [{ type: "rsi_above", period: 14, value: 70 }, { type: "price_below_ema", period: 20 }] },
  ];

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  FUTURES BACKTEST — $10,000 @ 10x leverage on 1 year 1h data`);
  console.log(`  Risk: ${RISK.stopPct*100}% stop / ${RISK.targetPct*100}% target`);
  console.log(`  ${MARGIN_PER_TRADE*100}% capital deployed per trade = $${(CAPITAL*MARGIN_PER_TRADE).toLocaleString()} margin`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  for (const sym of SYMBOLS) {
    console.log(`\n📦 Fetching ${sym} 1h klines (1 year)...`);
    process.stdout.write("  ");
    const candles = await fetchAllKlines(sym, INTERVAL, oneYearAgo, now);
    console.log(` ${candles.length} candles loaded`);

    console.log(`\n╔${"═".repeat(75)}╗`);
    console.log(`║  ${sym.padEnd(73)}║`);
    console.log(`╚${"═".repeat(75)}╝\n`);

    for (const strat of strategies) {
      if (strat.label.includes("combo")) continue;

      const result = runFuturesBacktest(
        candles, strat.entry, strat.direction,
        RISK, FEE_BPS, MAX_HOLD, CAPITAL, LEVERAGE, MARGIN_PER_TRADE,
      );

      const m = result.metrics;
      const pct = (v: number) => (v * 100).toFixed(2) + "%";
      const usd = (v: number) => "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      if (m.totalTrades > 0) {
        const verdict = m.profitFactor >= 1.5 && m.sharpeRatio > 1 ? "⭐" :
          m.profitFactor >= 1.0 ? "📊" : "⚠️";
        console.log(`  ${verdict} ${strat.label.padEnd(32)} ${String(m.totalTrades).padStart(3)} trades  WR=${(m.winRate*100).toFixed(0).padStart(2)}%  PF=${m.profitFactor.toFixed(2).padStart(5)}  SR=${m.sharpeRatio.toFixed(2).padStart(5)}`);
        console.log(`      Return: ${pct(m.totalReturnPct).padStart(8)}  PnL: ${usd(m.totalPnlUsd).padStart(10)}  MaxDD: ${pct(m.maxDrawdownPct).padStart(8)} (${usd(m.maxDrawdownUsd)})`);
        console.log(`      Expectancy: ${pct(m.expectancyPct).padStart(8)} per trade  Avg hold: ${m.avgHoldBars.toFixed(1)} bars`);
        console.log();
      }
    }

    // Also run combo strategies with label output
    for (const strat of strategies.filter(s => s.label.includes("combo"))) {
      const result = runFuturesBacktest(
        candles, strat.entry, strat.direction,
        RISK, FEE_BPS, MAX_HOLD, CAPITAL, LEVERAGE, MARGIN_PER_TRADE,
      );
      const m = result.metrics;
      if (m.totalTrades > 0) {
        const verdict = m.profitFactor >= 1.5 && m.sharpeRatio > 1 ? "⭐" :
          m.profitFactor >= 1.0 ? "📊" : "⚠️";
        console.log(`  ${verdict} ${strat.label.padEnd(32)} ${String(m.totalTrades).padStart(3)} trades  WR=${(m.winRate*100).toFixed(0).padStart(2)}%  PF=${m.profitFactor.toFixed(2).padStart(5)}  SR=${m.sharpeRatio.toFixed(2).padStart(5)}`);
        console.log(`      Return: ${pct(m.totalReturnPct).padStart(8)}  PnL: ${usd(m.totalPnlUsd).padStart(10)}  MaxDD: ${pct(m.maxDrawdownPct).padStart(8)} (${usd(m.maxDrawdownUsd)})`);
        console.log();
      }
    }
  }

  // ── Summary best-of ──
  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  BEST STRATEGIES (PF >= 1.5, ranked by Sharpe)`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
