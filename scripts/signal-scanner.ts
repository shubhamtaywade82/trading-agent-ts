/**
 * WARNING (2026-07-16): this scanner's signal generators (liqSweep,
 * bearishFVG, etc, defined below) are hand-rolled duplicates, inconsistent
 * with the validated smcBearishLiqSweep/bearish_fvg/etc detectors in
 * src/tools/backtest-tools.ts. It will report signals firing that the real
 * backtested strategy definitions in strategies.json would NOT have fired
 * on, and vice versa. Do not trust its live-signal output as "the same
 * strategy that was backtested" until it's rewired to call the real
 * detectors (or the real engine's condition-evaluation switch) instead.
 *
 * Multi-strategy, multi-timeframe signal scanner.
 * Checks ALL strategies from strategies.json against live data.
 * Reports every firing signal on the latest closed bar.
 * 
 * Usage: npx tsx scripts/signal-scanner.ts           (one-shot scan)
 *        npx tsx scripts/signal-scanner.ts --watch   (runs every 5 min)
 */
import { readFileSync } from "fs";
import {
  ichimokuSeries, adxSeries, bollingerSeries, emaSeries, smaSeries,
  rsiSeries, superTrendSeries
} from "../src/tools/indicators.js";
import type { CandleHL } from "../src/tools/indicators.js";
import { parseKlineRows } from "../src/backtest/types.js";

async function fetchLatest(symbol: string, interval: string, limit = 300) {
  const url = new URL("/api/v3/klines", "https://api.binance.com");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  const resp = await fetch(url);
  return parseKlineRows(await resp.json() as unknown[][]);
}

// ====== SIGNAL GENERATORS (bar-level check) ======
function liqSweep(candles: any[], i: number): boolean {
  const look = 5;
  if (i < look + 2 || i >= candles.length - look) return false;
  const left = candles.slice(i - look, i);
  const right = candles.slice(i + 1, i + 1 + look);
  if (right.length < look) return false;
  const lh = Math.max(...left.map(c => c.high));
  const rh = Math.max(...right.map(c => c.high));
  return candles[i].high > lh && candles[i].high > rh && candles[i].low < candles[i - 1].low && candles[i].close < candles[i].open;
}

function bearishFVG(candles: any[], i: number): boolean {
  return i >= 2 && candles[i - 2].low > candles[i].high;
}

function bullishLiqFvg(candles: any[], i: number): boolean {
  const look = 5;
  if (i < look + 2 || i >= candles.length) return false;
  const left = candles.slice(i - look, i);
  const ll = Math.min(...left.map(c => c.low));
  if (candles[i].low < ll && candles[i].close > candles[i].open) {
    for (let j = i + 1; j < Math.min(i + 5, candles.length); j++) {
      if (candles[i].low > candles[j].high) return true;
    }
  }
  return false;
}

function volSpike(candles: any[], i: number, volSma: number[], mult: number): boolean {
  return candles[i].volume > volSma[i] * mult && candles[i].close < candles[i].open;
}

// ====== MAIN ======
interface Signal { symbol: string; strategy: string; direction: string; tf: string; price: number; time: string; }

async function scan(): Promise<Signal[]> {
  const raw = JSON.parse(readFileSync("strategies.json", "utf-8"));
  const signals: Signal[] = [];

  for (const [symbol, strats] of Object.entries(raw.symbols) as [string, any[]][]) {
    // Group by timeframe to minimize fetches
    const byTf = new Map<string, any[]>();
    for (const s of strats) {
      const tf = s.tf || "1h";
      if (!byTf.has(tf)) byTf.set(tf, []);
      byTf.get(tf)!.push(s);
    }

    for (const [tf, group] of byTf) {
      const candles = await fetchLatest(symbol, tf);
      if (candles.length < 60) continue;
      const i = candles.length - 1; // latest closed bar
      const closes = candles.map(c => c.close);
      const volumes = candles.map(c => c.volume);

      // Precompute shared indicators
      const ichi = ichimokuSeries(candles as CandleHL[]);
      const adx14 = adxSeries(candles as CandleHL[], 14);
      const bb = bollingerSeries(closes, 20, 2);
      const rsi14 = rsiSeries(closes, 14);
      const rsi7 = rsiSeries(closes, 7);
      const volSma20 = smaSeries(volumes, 20);
      const st = superTrendSeries(candles as CandleHL[], 7, 1);
      const st12 = superTrendSeries(candles as CandleHL[], 7, 1.2);

      for (const s of group) {
        let fire = false;
        const entry = s.entry;

        // Single condition strategy — just check the type
        if (entry.length === 1) {
          const cond = entry[0];
          switch (cond.type) {
            case "bearish_liq_sweep": fire = liqSweep(candles, i); break;
            case "bearish_fvg": fire = bearishFVG(candles, i); break;
            case "bullish_liq_fvg": fire = bullishLiqFvg(candles, i); break;
            case "ichimoku_bearish_breakout": fire = i > 0 && ichi[i]?.cloud === "below" && ichi[i - 1]?.cloud !== "below"; break;
            case "adx_bearish_trend": { const a = adx14[i], p = adx14[i - 1]; fire = !!a && !!p && a.adx > (cond.value ?? 20) && a.minusDI > a.plusDI && p.minusDI <= p.plusDI; break; }
            case "supertrend_bearish_flip": fire = i > 0 && st[i]?.trend === "down" && st[i - 1]?.trend !== "down"; break;
            case "supertrend_bullish_flip": fire = i > 0 && st[i]?.trend === "up" && st[i - 1]?.trend !== "up"; break;
            case "rsi_above": { const r = (cond.period ?? 14) === 7 ? rsi7 : rsi14; fire = !isNaN(r[i]) && r[i] > (cond.value ?? 80) && r[i - 1] <= (cond.value ?? 80); break; }
            case "bollinger_touch_upper": fire = !isNaN(bb[i].upper) && closes[i] >= bb[i].upper && closes[i - 1] < bb[i - 1].upper; break;
            case "bollinger_touch_lower": fire = !isNaN(bb[i].lower) && closes[i] <= bb[i].lower && closes[i - 1] > bb[i - 1].lower; break;
            case "vol_spike_short": fire = volSpike(candles, i, volSma20, 2); break;
            default: fire = false;
          }
        } else {
          // Multi-condition (confluence) — ALL must fire
          fire = entry.every((cond: any) => {
            switch (cond.type) {
              case "bearish_liq_sweep": return liqSweep(candles, i);
              case "bearish_fvg": return bearishFVG(candles, i);
              case "ichimoku_bearish_breakout": return i > 0 && ichi[i]?.cloud === "below" && ichi[i - 1]?.cloud !== "below";
              case "adx_bearish_trend": { const a = adx14[i], p = adx14[i - 1]; return !!a && !!p && a.adx > (cond.value ?? 20) && a.minusDI > a.plusDI && p.minusDI <= p.plusDI; }
              case "vol_spike_short": return volSpike(candles, i, volSma20, 2);
              default: return false;
            }
          });
        }

        if (fire) {
          signals.push({
            symbol, tf, direction: s.direction, strategy: s.label,
            price: candles[i].close,
            time: new Date(candles[i].openTime).toISOString(),
          });
        }
      }
    }
  }
  return signals;
}

async function main() {
  const watch = process.argv.includes("--watch");

  if (watch) {
    console.log("Watching all strategies (checking every 5 min)...");
    while (true) {
      const sigs = await scan();
      const now = new Date().toISOString();
      if (sigs.length) {
        console.log(`\n[${now}] SIGNALS:`);
        for (const s of sigs) console.log(`  ${s.symbol.padEnd(8)} ${s.tf.padEnd(4)} ${s.direction.padEnd(5)} ${s.strategy.slice(0, 35).padEnd(35)} @ $${s.price.toFixed(4)}`);
      } else process.stdout.write(".");
      await new Promise(r => setTimeout(r, 300_000));
    }
  } else {
    console.log("Scanning...\n");
    const sigs = await scan();
    if (!sigs.length) { console.log("No signals on latest bar."); return; }
    console.log(`Symbol  TF    Dir   Strategy                             Price`);
    console.log(`------  ----  ----  -------                             -----`);
    for (const s of sigs) console.log(`${s.symbol.padEnd(8)} ${s.tf.padEnd(4)} ${s.direction.padEnd(5)} ${s.strategy.slice(0, 35).padEnd(35)} $${s.price.toFixed(4)}`);
    console.log(`\nWatch mode: npx tsx scripts/signal-scanner.ts --watch`);
  }
}
main().catch(console.error);
