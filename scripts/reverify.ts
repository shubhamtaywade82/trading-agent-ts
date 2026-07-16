import { BinanceFuturesBacktestTool } from "../src/tools/backtest-tools.js";
import { readFileSync, writeFileSync } from "fs";

const strategies = JSON.parse(readFileSync("strategies.json", "utf-8"));
const tool = new BinanceFuturesBacktestTool();
const endTime = Date.now();
const startTime = endTime - 365 * 24 * 60 * 60 * 1000;

// Realistic one-way slippage for these three pairs on Binance USDT-M futures.
// XRP/SOL are liquid but thinner than BTC/ETH — 3bps one-way (6bps round trip)
// is a reasonable floor for market-order fills at modest size; real slippage
// during liquidation cascades or thin-liquidity hours will be worse.
const SLIPPAGE_BPS = 3;
const MIN_TRADES_FOR_TRUST = 20;

const out: any = { config: strategies.config, signalTypes: strategies.signalTypes, symbols: {} };

for (const [sym, strats] of Object.entries(strategies.symbols) as [string, any[]][]) {
  out.symbols[sym] = [];
  console.log(`\n=== ${sym} ===`);
  for (const s of strats) {
    const half1 = { startTime, endTime: startTime + (endTime - startTime) / 2 };
    const half2 = { startTime: startTime + (endTime - startTime) / 2, endTime };

    const [full, w1, w2]: any[] = await Promise.all([
      tool.call({
        symbol: sym, interval: "1h", direction: s.direction, entry: s.entry,
        stopPct: s.risk.stopPct, targetPct: s.risk.targetPct, feeBps: 5, maxHoldBars: 48,
        initialCapital: 10000, leverage: 10, marginPerTradePct: 0.5,
        startTime, endTime, slippageBps: SLIPPAGE_BPS,
      }),
      tool.call({
        symbol: sym, interval: "1h", direction: s.direction, entry: s.entry,
        stopPct: s.risk.stopPct, targetPct: s.risk.targetPct, feeBps: 5, maxHoldBars: 48,
        initialCapital: 10000, leverage: 10, marginPerTradePct: 0.5,
        startTime: half1.startTime, endTime: half1.endTime, slippageBps: SLIPPAGE_BPS,
      }),
      tool.call({
        symbol: sym, interval: "1h", direction: s.direction, entry: s.entry,
        stopPct: s.risk.stopPct, targetPct: s.risk.targetPct, feeBps: 5, maxHoldBars: 48,
        initialCapital: 10000, leverage: 10, marginPerTradePct: 0.5,
        startTime: half2.startTime, endTime: half2.endTime, slippageBps: SLIPPAGE_BPS,
      }),
    ]);

    if (full.error) {
      console.log(`  ${s.label}: ERROR ${full.message}`);
      continue;
    }

    const bothHalvesPositive = (w1.totalPnlUsd ?? 0) > 0 && (w2.totalPnlUsd ?? 0) > 0;
    const sampleOk = full.totalTrades >= MIN_TRADES_FOR_TRUST;
    const verdict = !sampleOk ? "LOW_SAMPLE" : !bothHalvesPositive ? "REGIME_FRAGILE" : "SURVIVES";

    console.log(`  ${s.label}: trades=${full.totalTrades} WR=${(full.winRate*100).toFixed(0)}% PF=${full.profitFactor?.toFixed(2)} sharpe=${full.sharpeRatio?.toFixed(1)} pnl=$${Math.round(full.totalPnlUsd)} maxDD=${(full.maxDrawdownPct*100).toFixed(1)}%  [H1 pnl=$${Math.round(w1.totalPnlUsd)} trades=${w1.totalTrades} | H2 pnl=$${Math.round(w2.totalPnlUsd)} trades=${w2.totalTrades}]  -> ${verdict}`);

    out.symbols[sym].push({
      id: s.id, label: s.label, direction: s.direction, entry: s.entry, risk: s.risk,
      metrics: {
        sharpe: Number(full.sharpeRatio?.toFixed(2)), pf: Number(full.profitFactor?.toFixed(3)),
        winRate: Number(full.winRate.toFixed(3)), trades: full.totalTrades,
        pnlUsd: Math.round(full.totalPnlUsd), maxDDPct: Number(full.maxDrawdownPct.toFixed(3)),
      },
      halfSampleCheck: {
        h1: { trades: w1.totalTrades, pnlUsd: Math.round(w1.totalPnlUsd) },
        h2: { trades: w2.totalTrades, pnlUsd: Math.round(w2.totalPnlUsd) },
        bothHalvesPositive,
      },
      slippageBpsApplied: SLIPPAGE_BPS,
      verdict,
    });
  }
}

writeFileSync("scripts/reverify-output.json", JSON.stringify(out, null, 2));
console.log("\nWrote scripts/reverify-output.json");
