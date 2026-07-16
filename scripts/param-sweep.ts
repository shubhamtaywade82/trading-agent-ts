import { superTrendSeries, emaSeries } from "../src/tools/indicators.js";
import type { CandleHL } from "../src/tools/indicators.js";
import { parseKlineRows } from "../src/backtest/types.js";

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

async function main() {
  const symbols = ["XRPUSDT", "ETHUSDT", "SOLUSDT"];
  for (const symbol of symbols) {
    console.log(`\n=== ${symbol} ===`);
    const candles = await fetchRange(symbol, "1h", 365);
    console.log(`Candles: ${candles.length}`);
    const closes = candles.map(c => c.close);

    // SuperTrend sweep
    console.log(`\n--- SuperTrend sweep ---`);
    for (const period of [5, 7, 10, 14]) {
      for (const mult of [1.0, 1.2, 1.5, 2.0]) {
        const st = superTrendSeries(candles as CandleHL[], period, mult);
        let flips = 0;
        let upFlips = 0, dnFlips = 0;
        for (let i = period + 2; i < st.length; i++) {
          if (st[i].trend !== st[i-1].trend) {
            flips++;
            if (st[i].trend === "up") upFlips++;
            else dnFlips++;
          }
        }
        const dnPct = ((st.filter(s => s.trend === "down").length / st.length) * 100).toFixed(1);
        if (flips > 0) {
          const perYear = (flips / candles.length * 8760).toFixed(1);
          console.log(`  ST(${period}, ${mult}): flips=${flips} (${perYear}/yr), up=${upFlips} dn=${dnFlips}, down=${dnPct}%`);
        }
      }
    }

    // EMA alignment sweep - with threshold
    console.log(`\n--- EMA Alignment sweep (with 0.5% threshold) ---`);
    const combos = [[3,5,8], [5,8,13], [8,13,21], [5,10,20], [10,20,50]];
    for (const [p1, p2, p3] of combos) {
      const e1 = [...Array(closes.length - p1).fill(NaN), ...emaSeries(closes, p1)];
      const e2 = [...Array(closes.length - p2).fill(NaN), ...emaSeries(closes, p2)];
      const e3 = [...Array(closes.length - p3).fill(NaN), ...emaSeries(closes, p3)];
      let alignL = 0, alignS = 0;
      let threshL = 0, threshS = 0;
      for (let i = p3; i < candles.length; i++) {
        const c = closes[i];
        const alignedL = c > e1[i] && e1[i] > e2[i] && e2[i] > e3[i];
        const alignedS = c < e1[i] && e1[i] < e2[i] && e2[i] < e3[i];
        if (alignedL) alignL++;
        if (alignedS) alignS++;
        // With threshold: price within 0.5% of fastest MA
        if (alignedL && Math.abs(c - e1[i]) / e1[i] < 0.005) threshL++;
        if (alignedS && Math.abs(c - e1[i]) / e1[i] < 0.005) threshS++;
      }
      console.log(`  EMA ${p1}/${p2}/${p3}: L=${alignL} S=${alignS} | w/thresh: L=${threshL} S=${threshS}`);
    }
  }
}
main().catch(console.error);
