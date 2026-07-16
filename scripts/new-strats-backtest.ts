// WARNING (2026-07-16): standalone hand-rolled backtest loop, not the real
// shared engine (runFuturesBacktest), no split-sample check. The signal
// types this tested (ichimoku_below_cloud_short, adx_di_cross_short,
// volume_spike_short) have since been wired into the real engine
// (src/tools/backtest-tools.ts) and validated with split-sample there —
// see scripts/day-trader-sweep.ts and strategies.json for trustworthy numbers.
import { ichimokuSeries, adxSeries, bollingerSeries, emaSeries, smaSeries } from "../src/tools/indicators.js";
import type { CandleHL } from "../src/tools/indicators.js";
import { parseKlineRows, type Candle } from "../src/backtest/types.js";

async function fetchRange(symbol: string, interval: string, days: number) {
  const all: any[] = [];
  let from = Date.now() - days * 24 * 60 * 60 * 1000;
  const end = Date.now();
  while (from < end) {
    const url = new URL("/api/v3/klines", "https://api.binance.com");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("startTime", String(from));
    const resp = await fetch(url);
    const rows = await resp.json() as unknown[][];
    if (rows.length === 0) break;
    all.push(...rows);
    from = Number(rows[rows.length - 1][0]) + 1;
    await new Promise(r => setTimeout(r, 50));
  }
  return parseKlineRows(all);
}

interface Trade { side: "long" | "short"; entryIdx: number; exitIdx: number; entryPrice: number; exitPrice: number; pnlPct: number; pnlUsd: number; }

function runBacktest(
  candles: Candle[],
  signals: Array<{ idx: number; side: "long" | "short" }>,
  stopPct: number,
  targetPct: number,
  maxHoldBars: number,
  initialCapital: number,
  leverage: number,
  marginPerTrade: number,
): Trade[] {
  const feeFrac = 5 / 10000;
  const trades: Trade[] = [];
  let capital = initialCapital;
  const used = new Set<number>();

  for (const sig of signals) {
    if (used.has(sig.idx)) continue;
    if (capital <= 0) break;
    const i = sig.idx;
    const entryPrice = candles[i].close;
    const margin = capital * marginPerTrade;
    const notional = margin * leverage;
    const qty = notional / entryPrice;
    const stopPrice = sig.side === "long" ? entryPrice * (1 - stopPct) : entryPrice * (1 + stopPct);
    const targetPrice = sig.side === "long" ? entryPrice * (1 + targetPct) : entryPrice * (1 - targetPct);
    const liqPrice = sig.side === "long" ? entryPrice * (1 - 1 / leverage + 0.005) : entryPrice * (1 + 1 / leverage - 0.005);

    let exitIdx = candles.length - 1;
    let exitPrice = candles[exitIdx].close;
    for (let j = i + 1; j < candles.length && j <= i + maxHoldBars; j++) {
      const b = candles[j];
      if (sig.side === "long" ? b.low <= liqPrice : b.high >= liqPrice) { exitIdx = j; exitPrice = liqPrice; break; }
      if (sig.side === "long" ? b.low <= stopPrice : b.high >= stopPrice) { exitIdx = j; exitPrice = stopPrice; break; }
      if (sig.side === "long" ? b.high >= targetPrice : b.low <= targetPrice) { exitIdx = j; exitPrice = targetPrice; break; }
      if (j === i + maxHoldBars) { exitIdx = j; exitPrice = b.close; }
    }
    const rawPnl = (exitPrice - entryPrice) * (sig.side === "long" ? 1 : -1) * qty;
    const pnl = rawPnl - notional * feeFrac;
    capital += pnl;
    const pnlPct = pnl / margin;

    trades.push({ side: sig.side, entryIdx: i, exitIdx, entryPrice, exitPrice, pnlPct, pnlUsd: pnl });
    for (let k = i; k <= exitIdx; k++) used.add(k);
  }

  return trades;
}

function computeStats(trades: Trade[], capital: number) {
  if (trades.length === 0) return { trades: 0 };
  const wins = trades.filter(t => t.pnlUsd > 0);
  const losses = trades.filter(t => t.pnlUsd <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0));
  const returns = trades.map(t => t.pnlPct);
  const avgR = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance = returns.length > 1 ? returns.reduce((s, v) => s + (v - avgR) ** 2, 0) / (returns.length - 1) : 0;
  const sharpe = Math.sqrt(365 * 24) * avgR / (Math.sqrt(variance) || 1);
  const totalRet = totalPnl / capital;

  let peak = capital; let mdd = 0; let eq = capital;
  for (const t of trades) {
    eq += t.pnlUsd;
    if (eq > peak) peak = eq;
    mdd = Math.max(mdd, (peak - eq) / peak);
  }

  return {
    trades: trades.length,
    wins: wins.length,
    winRate: ((wins.length / trades.length) * 100).toFixed(1) + "%",
    totalPnlUsd: totalPnl.toFixed(2),
    totalReturnPct: (totalRet * 100).toFixed(1) + "%",
    avgReturnPct: (avgR * 100).toFixed(2) + "%",
    profitFactor: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "inf",
    maxDD: (mdd * 100).toFixed(1) + "%",
    sharpe: sharpe.toFixed(2),
    expectancy: (avgR * 100).toFixed(2) + "%",
  };
}

interface StratResult { name: string; [key: string]: any; }

async function main() {
  const symbols = ["XRPUSDT", "ETHUSDT", "SOLUSDT"];
  const allResults: StratResult[] = [];

  for (const symbol of symbols) {
    console.log(`\n====== ${symbol} ======`);
    const candles = await fetchRange(symbol, "1h", 365);
    console.log(`Candles: ${candles.length}`);
    const opens = candles.map(c => c.open);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);

    // === Ichimoku Below Cloud Short ===
    console.log(`\n--- Ichimoku Below Cloud Short ---`);
    // Use runFuturesBacktest condition logic: ichimoku_bearish_breakout = cloud changed to "below"
    const ichi = ichimokuSeries(candles as CandleHL[]);
    const ichiSignals: Array<{ idx: number; side: "long" | "short" }> = [];
    for (let i = 52; i < ichi.length; i++) {
      if (ichi[i]?.cloud === "below" && ichi[i - 1]?.cloud !== "below") {
        ichiSignals.push({ idx: i, side: "short" });
      }
    }
    console.log(`Signals: ${ichiSignals.length} (${(ichiSignals.length / candles.length * 8760).toFixed(1)}/yr)`);
    if (ichiSignals.length > 0) {
      for (const { stop, target } of [{ stop: 0.02, target: 0.06 }, { stop: 0.015, target: 0.08 }, { stop: 0.03, target: 0.05 }]) {
        const trades = runBacktest(candles, ichiSignals, stop, target, 48, 10000, 10, 0.1);
        const s = computeStats(trades, 10000);
        console.log(`  stop=${(stop*100).toFixed(0)}% target=${(target*100).toFixed(0)}%: ${s.trades} trades, WR ${s.winRate}, PnL $${s.totalPnlUsd}, SR ${s.sharpe}, DD ${s.maxDD}`);
      }
    }

    // === ADX-DI Cross Short ===
    console.log(`\n--- ADX-DI Cross Short ---`);
    const adx = adxSeries(candles as CandleHL[], 14);
    const adxSignals: Array<{ idx: number; side: "long" | "short" }> = [];
    for (let i = 16; i < adx.length; i++) {
      // +DI crosses below -DI AND ADX > 20 (trend strength)
      const cur = adx[i], prev = adx[i - 1];
      if (cur && prev && cur.adx > 20 && cur.minusDI > cur.plusDI && prev.minusDI <= prev.plusDI) {
        adxSignals.push({ idx: i, side: "short" });
      }
    }
    console.log(`Signals: ${adxSignals.length} (${(adxSignals.length / candles.length * 8760).toFixed(1)}/yr)`);
    if (adxSignals.length > 0) {
      for (const { stop, target } of [{ stop: 0.02, target: 0.06 }, { stop: 0.015, target: 0.08 }, { stop: 0.03, target: 0.05 }]) {
        const trades = runBacktest(candles, adxSignals, stop, target, 48, 10000, 10, 0.1);
        const s = computeStats(trades, 10000);
        console.log(`  stop=${(stop*100).toFixed(0)}% target=${(target*100).toFixed(0)}%: ${s.trades} trades, WR ${s.winRate}, PnL $${s.totalPnlUsd}, SR ${s.sharpe}, DD ${s.maxDD}`);
      }
    }

    // === Volume Spike Short ===
    console.log(`\n--- Volume Spike Short ---`);
    const volSma20 = smaSeries(volumes, 20);
    const volSignals: Array<{ idx: number; side: "long" | "short" }> = [];
    for (let i = 21; i < candles.length; i++) {
      // Volume > 2× SMA(volume,20) + bearish candle (close < open)
      if (volumes[i] > volSma20[i] * 2 && closes[i] < opens[i]) {
        volSignals.push({ idx: i, side: "short" });
      }
    }
    console.log(`Signals: ${volSignals.length} (${(volSignals.length / candles.length * 8760).toFixed(1)}/yr)`);
    if (volSignals.length > 0) {
      for (const { stop, target } of [{ stop: 0.02, target: 0.06 }, { stop: 0.015, target: 0.08 }, { stop: 0.03, target: 0.04 }]) {
        const trades = runBacktest(candles, volSignals, stop, target, 48, 10000, 10, 0.1);
        const s = computeStats(trades, 10000);
        console.log(`  stop=${(stop*100).toFixed(0)}% target=${(target*100).toFixed(0)}%: ${s.trades} trades, WR ${s.winRate}, PnL $${s.totalPnlUsd}, SR ${s.sharpe}, DD ${s.maxDD}`);
      }
    }

    // === BB Squeeze Long ===
    console.log(`\n--- BB Squeeze Long ---`);
    const bb = bollingerSeries(closes, 20, 2);
    // Precompute BB width
    const bbWidth = bb.map(b => !isNaN(b.upper) ? (b.upper - b.lower) / b.middle : NaN);
    const bbSignals: Array<{ idx: number; side: "long" | "short" }> = [];
    for (let i = 25; i < candles.length; i++) {
      // Squeeze: BB width at 3-month low (lookback 90 bars)
      const lookback = 90;
      const slice = bbWidth.slice(i - lookback + 1, i + 1).filter(v => !isNaN(v));
      if (slice.length < 30) continue;
      const minWidth = Math.min(...slice);
      const isSqueeze = !isNaN(bbWidth[i]) && bbWidth[i] <= minWidth * 1.05;
      // Enter long when price breaks above upper BB after squeeze
      if (isSqueeze && closes[i] > bb[i].upper && closes[i - 1] <= bb[i - 1].upper) {
        bbSignals.push({ idx: i, side: "long" });
      }
    }
    // Also try: price breaks above upper BB (no squeeze filter)
    const bbSimpleSignals: Array<{ idx: number; side: "long" | "short" }> = [];
    for (let i = 22; i < candles.length; i++) {
      if (closes[i] > bb[i].upper && closes[i - 1] < bb[i - 1].upper) {
        bbSimpleSignals.push({ idx: i, side: "long" });
      }
    }
    console.log(`BB breakout (no squeeze): ${bbSimpleSignals.length} (${(bbSimpleSignals.length / candles.length * 8760).toFixed(1)}/yr)`);
    console.log(`BB squeeze breakout: ${bbSignals.length} (${(bbSignals.length / candles.length * 8760).toFixed(1)}/yr)`);

    if (bbSimpleSignals.length > 0) {
      for (const { stop, target } of [{ stop: 0.02, target: 0.06 }, { stop: 0.015, target: 0.08 }, { stop: 0.025, target: 0.05 }]) {
        const trades = runBacktest(candles, bbSimpleSignals, stop, target, 48, 10000, 10, 0.1);
        const s = computeStats(trades, 10000);
        console.log(`  BB break (no sqz) stop=${(stop*100).toFixed(0)}% target=${(target*100).toFixed(0)}%: ${s.trades} trades, WR ${s.winRate}, PnL $${s.totalPnlUsd}, SR ${s.sharpe}, DD ${s.maxDD}`);
      }
    }
    if (bbSignals.length > 0) {
      for (const { stop, target } of [{ stop: 0.02, target: 0.06 }, { stop: 0.015, target: 0.08 }]) {
        const trades = runBacktest(candles, bbSignals, stop, target, 48, 10000, 10, 0.1);
        const s = computeStats(trades, 10000);
        console.log(`  BB squeeze stop=${(stop*100).toFixed(0)}% target=${(target*100).toFixed(0)}%: ${s.trades} trades, WR ${s.winRate}, PnL $${s.totalPnlUsd}, SR ${s.sharpe}, DD ${s.maxDD}`);
      }
    }
  }
}
main().catch(console.error);
