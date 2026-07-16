// WARNING (2026-07-16): same duplicate-signal-logic caveat as
// scripts/signal-scanner.ts — this does not call the validated detectors in
// src/tools/backtest-tools.ts.
import { ichimokuSeries } from "../src/tools/indicators.js";
import type { CandleHL } from "../src/tools/indicators.js";
import { parseKlineRows } from "../src/backtest/types.js";

async function fetchLatest(symbol: string, interval: string, limit = 200) {
  const url = new URL("/api/v3/klines", "https://api.binance.com");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  const resp = await fetch(url);
  return parseKlineRows(await resp.json() as unknown[][]);
}

function liqSweepShort(candles: any[]) {
  const out: any[] = [];
  for (let i = 10; i < candles.length; i++) {
    const look = 5;
    const left = candles.slice(i - look, i);
    const right = candles.slice(i + 1, i + 1 + look);
    if (right.length < look) continue;
    const leftHigh = Math.max(...left.map((c: any) => c.high));
    const rightHigh = Math.max(...right.map((c: any) => c.high));
    if (candles[i].high > leftHigh && candles[i].high > rightHigh &&
        candles[i].low < candles[i - 1].low && candles[i].close < candles[i].open) {
      out.push({ idx: i });
    }
  }
  return out;
}

function bearishFvg(candles: any[]) {
  const out: any[] = [];
  for (let i = 2; i < candles.length; i++) {
    if (candles[i - 2].low > candles[i].high) out.push({ idx: i });
  }
  return out;
}

async function main() {
  for (const symbol of ["XRPUSDT", "ETHUSDT", "SOLUSDT"]) {
    for (const tf of ["15m", "1h", "4h"]) {
      const candles = await fetchLatest(symbol, tf);
      console.log(`${symbol} ${tf}: ${candles.length} candles`);

      const ls = liqSweepShort(candles);
      const fvg = bearishFvg(candles);
      const ichi = ichimokuSeries(candles as CandleHL[]);
      const recentIchi = ichi.filter((s, i) => s.cloud === "below" && i >= candles.length - 10);

      const recentLs = ls.filter(s => s.idx >= candles.length - 10);
      const recentFvg = fvg.filter(s => s.idx >= candles.length - 10);

      if (recentLs.length) console.log(`  Liq Sweep: ${JSON.stringify(recentLs.map(s => candles.length - 1 - s.idx + ' bars ago'))}`);
      if (recentFvg.length) console.log(`  FVG: ${JSON.stringify(recentFvg.map(s => candles.length - 1 - s.idx + ' bars ago'))}`);
      if (recentIchi.length) console.log(`  Ichimoku Below Cloud (last 10 bars)`);
    }
  }
}
main().catch(console.error);
