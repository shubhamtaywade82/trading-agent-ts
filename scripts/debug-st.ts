import { superTrendSeries, atrSeries, emaSeries } from "../src/tools/indicators.js";
import type { CandleHL } from "../src/tools/indicators.js";
import { parseKlineRows } from "../src/backtest/types.js";

async function main() {
  const all: any[] = [];
  let from = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const end = Date.now();
  while (from < end) {
    const url = new URL("/api/v3/klines", "https://api.binance.com");
    url.searchParams.set("symbol", "XRPUSDT");
    url.searchParams.set("interval", "1h");
    url.searchParams.set("limit", "1000");
    url.searchParams.set("startTime", String(from));
    const resp = await fetch(url);
    const rows = await resp.json() as unknown[][];
    if (rows.length === 0) break;
    all.push(...rows);
    from = Number(rows[rows.length - 1][0]) + 1;
    await new Promise(r => setTimeout(r, 100));
  }
  const candles = parseKlineRows(all);
  const closes = candles.map(c => c.close);
  console.log(`Candles: ${candles.length}`);

  // SuperTrend with different multipliers
  for (const mult of [1.5, 2.0, 2.5, 3.0]) {
    const st = superTrendSeries(candles as CandleHL[], 10, mult);
    let flips = 0;
    for (let i = 11; i < st.length; i++) {
      if (st[i].trend !== st[i-1].trend) flips++;
    }
    const dnBars = st.filter(s => s.trend === "down").length;
    console.log(`ST mult=${mult}: flips=${flips}, down=${((dnBars/st.length)*100).toFixed(1)}%`);
  }

  // EMA alignment - try different MA sets
  for (const periods of [[10, 20, 50], [20, 50, 200], [5, 10, 20]]) {
    const [p1, p2, p3] = periods;
    const e1 = [...Array(closes.length - p1).fill(NaN), ...emaSeries(closes, p1)];
    const e2 = [...Array(closes.length - p2).fill(NaN), ...emaSeries(closes, p2)];
    const e3 = [...Array(closes.length - p3).fill(NaN), ...emaSeries(closes, p3)];
    let alignL = 0, alignS = 0;
    for (let i = p3; i < candles.length; i++) {
      if (closes[i] > e1[i] && e1[i] > e2[i] && e2[i] > e3[i]) alignL++;
      if (closes[i] < e1[i] && e1[i] < e2[i] && e2[i] < e3[i]) alignS++;
    }
    console.log(`EMA alignment ${p1}/${p2}/${p3}: long=${alignL}, short=${alignS} (${((alignL+alignS)/candles.length*100).toFixed(1)}% of bars)`);
  }
}
main().catch(console.error);
