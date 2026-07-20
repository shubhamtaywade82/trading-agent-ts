// Extends day-trader-sweep.ts's exact methodology (same signal library, same
// split-sample gate, same MIN_TRADES bar) to symbols not yet in strategies.json's
// pool (which only covers XRPUSDT/ETHUSDT/SOLUSDT). Reuses the proven signal
// set as-is rather than inventing new ones — this is market-coverage alpha
// hunting, not parameter p-hacking on already-tested data.
import { fetchCandlesRange, runFuturesBacktest } from "../src/tools/backtest-tools.js";
import { writeFileSync } from "fs";

const SYMBOLS = ["BTCUSDT", "DOGEUSDT"];
const INTERVAL_CFG: Record<string, { lookbackDays: number; stopValues: number[]; targetValues: number[]; maxHoldBars: number }> = {
  "15m": { lookbackDays: 90, stopValues: [0.005, 0.008, 0.01, 0.015], targetValues: [0.01, 0.02, 0.03], maxHoldBars: 48 },
  "30m": { lookbackDays: 180, stopValues: [0.008, 0.012, 0.02], targetValues: [0.015, 0.03, 0.04], maxHoldBars: 48 },
  "1h": { lookbackDays: 365, stopValues: [0.01, 0.02, 0.03], targetValues: [0.02, 0.04, 0.06, 0.12], maxHoldBars: 48 },
  "4h": { lookbackDays: 730, stopValues: [0.02, 0.03, 0.05], targetValues: [0.04, 0.08, 0.15], maxHoldBars: 42 },
};
const INTERVALS = Object.keys(INTERVAL_CFG);

const SIGNALS = [
  { id: "bearish_liq_ob", direction: "short", entry: [{ type: "bearish_liq_ob" }] },
  { id: "bearish_liq_fvg", direction: "short", entry: [{ type: "bearish_liq_fvg" }] },
  { id: "bearish_liq_sweep", direction: "short", entry: [{ type: "bearish_liq_sweep" }] },
  { id: "bullish_liq_fvg", direction: "long", entry: [{ type: "bullish_liq_fvg" }] },
  { id: "bearish_fvg", direction: "short", entry: [{ type: "bearish_fvg" }] },
  { id: "rsi_above_80", direction: "short", entry: [{ type: "rsi_above", period: 14, value: 80 }] },
  { id: "ichimoku_bearish_breakout", direction: "short", entry: [{ type: "ichimoku_bearish_breakout" }] },
  { id: "ichimoku_below_cloud_short", direction: "short", entry: [{ type: "ichimoku_below_cloud_short" }] },
  { id: "adx_di_cross_short", direction: "short", entry: [{ type: "adx_di_cross_short", value: 20 }] },
  { id: "volume_spike_short", direction: "short", entry: [{ type: "volume_spike_short" }] },
];

const MIN_TRADES = 15;
const SLIPPAGE_BPS = 3;
const INITIAL_CAPITAL = 10000;
const LEVERAGE = 10;       // screen sizing — realistic-sizing re-verify happens on survivors only
const MARGIN_PCT = 0.5;
const FEE_BPS = 5;

const out: any = { generatedAt: new Date().toISOString(), screenSizing: { leverage: LEVERAGE, marginPerTradePct: MARGIN_PCT }, symbols: {} };

for (const symbol of SYMBOLS) {
  out.symbols[symbol] = {};
  console.log(`\n########## ${symbol} ##########`);
  for (const interval of INTERVALS) {
    const cfg = INTERVAL_CFG[interval];
    const endTime = Date.now();
    const startTime = endTime - cfg.lookbackDays * 24 * 60 * 60 * 1000;
    const fetched = await fetchCandlesRange(symbol, interval, startTime, endTime);
    if ("error" in fetched) { console.log(`${symbol} ${interval}: FETCH ERROR ${fetched.message}`); continue; }
    const candles = fetched.candles;
    const mid = startTime + (endTime - startTime) / 2;
    const midIdx = candles.findIndex(c => c.openTime >= mid);
    const h1 = candles.slice(0, midIdx < 0 ? candles.length : midIdx);
    const h2 = candles.slice(midIdx < 0 ? candles.length : midIdx);

    console.log(`\n=== ${symbol} @ ${interval} (${candles.length} candles, ${cfg.lookbackDays}d lookback) ===`);
    out.symbols[symbol][interval] = { candles: candles.length, lookbackDays: cfg.lookbackDays, signals: {} };

    for (const sig of SIGNALS) {
      let best: any = null;
      const results: any[] = [];
      for (const sp of cfg.stopValues) {
        for (const tp of cfg.targetValues) {
          const full: any = runFuturesBacktest(candles, sig.entry, sig.direction as "long" | "short", sp, tp, FEE_BPS, cfg.maxHoldBars, INITIAL_CAPITAL, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS);
          if (full.metrics.totalTrades < MIN_TRADES) continue;
          const r1: any = runFuturesBacktest(h1, sig.entry, sig.direction as "long" | "short", sp, tp, FEE_BPS, cfg.maxHoldBars, INITIAL_CAPITAL, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS);
          const r2: any = runFuturesBacktest(h2, sig.entry, sig.direction as "long" | "short", sp, tp, FEE_BPS, cfg.maxHoldBars, INITIAL_CAPITAL, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS);
          const bothHalvesPositive = r1.metrics.totalPnlUsd > 0 && r2.metrics.totalPnlUsd > 0;
          const rec = {
            stopPct: sp, targetPct: tp, trades: full.metrics.totalTrades, winRate: full.metrics.winRate,
            pf: full.metrics.profitFactor, sharpe: full.metrics.sharpeRatio, pnlUsd: full.metrics.totalPnlUsd,
            maxDDPct: full.metrics.maxDrawdownPct, bothHalvesPositive,
            verdict: bothHalvesPositive ? "SURVIVES" : "REGIME_FRAGILE",
          };
          results.push(rec);
          if (bothHalvesPositive && (!best || rec.sharpe > best.sharpe)) best = rec;
        }
      }
      out.symbols[symbol][interval].signals[sig.id] = { best, combosTested: results.length, allResults: results };
      if (best) {
        console.log(`  ${sig.id}: BEST stop=${(best.stopPct*100).toFixed(1)}% target=${(best.targetPct*100).toFixed(1)}% -> trades=${best.trades} WR=${(best.winRate*100).toFixed(0)}% PF=${best.pf.toFixed(2)} sharpe=${best.sharpe.toFixed(1)} pnl=$${Math.round(best.pnlUsd)} maxDD=${(best.maxDDPct*100).toFixed(1)}%`);
      } else {
        console.log(`  ${sig.id}: no surviving combo (${results.length} combos had >= ${MIN_TRADES} trades)`);
      }
    }
  }
}

writeFileSync("scripts/new-symbols-sweep-output.json", JSON.stringify(out, null, 2));
console.log("\nWrote scripts/new-symbols-sweep-output.json");
