import { BinanceFuturesBacktestTool } from "../src/tools/backtest-tools.js";
import { writeFileSync } from "fs";

const tool = new BinanceFuturesBacktestTool();
const endTime = Date.now();
const startTime = endTime - 365 * 24 * 60 * 60 * 1000;
const mid = startTime + (endTime - startTime) / 2;

const SLIPPAGE_BPS = 3;
const MIN_TRADES = 20;
const SYMBOLS = ["XRPUSDT", "ETHUSDT", "SOLUSDT"];

// LuxAlgo-style indicators: SuperTrend (10, 3x ATR), ADX/DMI (14, thresh 25),
// Ichimoku Cloud kumo breakout. Stop/target picked as reasonable defaults per
// signal family, not tuned — this is a first-pass screen, not optimization.
const CANDIDATES = [
  { label: "SuperTrend Bullish Flip Long", direction: "long", entry: [{ type: "supertrend_bullish_flip" }], stopPct: 0.02, targetPct: 0.04 },
  { label: "SuperTrend Bearish Flip Short", direction: "short", entry: [{ type: "supertrend_bearish_flip" }], stopPct: 0.02, targetPct: 0.04 },
  { label: "ADX Bullish Trend Long", direction: "long", entry: [{ type: "adx_bullish_trend", value: 25 }], stopPct: 0.02, targetPct: 0.04 },
  { label: "ADX Bearish Trend Short", direction: "short", entry: [{ type: "adx_bearish_trend", value: 25 }], stopPct: 0.02, targetPct: 0.04 },
  { label: "Ichimoku Bullish Breakout Long", direction: "long", entry: [{ type: "ichimoku_bullish_breakout" }], stopPct: 0.02, targetPct: 0.04 },
  { label: "Ichimoku Bearish Breakout Short", direction: "short", entry: [{ type: "ichimoku_bearish_breakout" }], stopPct: 0.02, targetPct: 0.04 },
];

const out: any = { config: { leverage: 10, marginPerTradePct: 0.5, slippageBps: SLIPPAGE_BPS, feeBps: 5, maxHoldBars: 48, note: "robustness screen sizing — see reverify-realistic-size pattern for real numbers on survivors" }, symbols: {} };

for (const sym of SYMBOLS) {
  out.symbols[sym] = [];
  console.log(`\n=== ${sym} ===`);
  for (const c of CANDIDATES) {
    const [full, h1, h2]: any[] = await Promise.all([
      tool.call({ symbol: sym, interval: "1h", direction: c.direction, entry: c.entry, stopPct: c.stopPct, targetPct: c.targetPct, feeBps: 5, maxHoldBars: 48, initialCapital: 10000, leverage: 10, marginPerTradePct: 0.5, startTime, endTime, slippageBps: SLIPPAGE_BPS }),
      tool.call({ symbol: sym, interval: "1h", direction: c.direction, entry: c.entry, stopPct: c.stopPct, targetPct: c.targetPct, feeBps: 5, maxHoldBars: 48, initialCapital: 10000, leverage: 10, marginPerTradePct: 0.5, startTime, endTime: mid, slippageBps: SLIPPAGE_BPS }),
      tool.call({ symbol: sym, interval: "1h", direction: c.direction, entry: c.entry, stopPct: c.stopPct, targetPct: c.targetPct, feeBps: 5, maxHoldBars: 48, initialCapital: 10000, leverage: 10, marginPerTradePct: 0.5, startTime: mid, endTime, slippageBps: SLIPPAGE_BPS }),
    ]);
    if (full.error) { console.log(`  ${c.label}: ERROR ${full.message}`); continue; }
    const bothHalvesPositive = (h1.totalPnlUsd ?? 0) > 0 && (h2.totalPnlUsd ?? 0) > 0;
    const sampleOk = full.totalTrades >= MIN_TRADES;
    const verdict = !sampleOk ? "LOW_SAMPLE" : !bothHalvesPositive ? "REGIME_FRAGILE" : "SURVIVES";
    console.log(`  ${c.label}: trades=${full.totalTrades} WR=${(full.winRate*100).toFixed(0)}% PF=${full.profitFactor?.toFixed(2)} sharpe=${full.sharpeRatio?.toFixed(1)} pnl=$${Math.round(full.totalPnlUsd)} maxDD=${(full.maxDrawdownPct*100).toFixed(1)}%  [H1 $${Math.round(h1.totalPnlUsd)} n=${h1.totalTrades} | H2 $${Math.round(h2.totalPnlUsd)} n=${h2.totalTrades}] -> ${verdict}`);
    out.symbols[sym].push({
      label: c.label, direction: c.direction, entry: c.entry, risk: { stopPct: c.stopPct, targetPct: c.targetPct },
      metrics: { sharpe: Number(full.sharpeRatio?.toFixed(2)), pf: Number(full.profitFactor?.toFixed(3)), winRate: Number(full.winRate.toFixed(3)), trades: full.totalTrades, pnlUsd: Math.round(full.totalPnlUsd), maxDDPct: Number(full.maxDrawdownPct.toFixed(3)) },
      halfSampleCheck: { h1: { trades: h1.totalTrades, pnlUsd: Math.round(h1.totalPnlUsd) }, h2: { trades: h2.totalTrades, pnlUsd: Math.round(h2.totalPnlUsd) }, bothHalvesPositive },
      verdict,
    });
  }
}

writeFileSync("scripts/luxalgo-output.json", JSON.stringify(out, null, 2));
console.log("\nWrote scripts/luxalgo-output.json");
