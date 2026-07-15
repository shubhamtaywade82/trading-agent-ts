#!/usr/bin/env tsx
import "dotenv/config";
import { Agent } from "./src/cli/agent.js";

const CAPITAL = 10000; const LEVERAGE = 10; const MARGIN_PCT = 0.5;
const STOPS = [0.005, 0.01, 0.015, 0.02, 0.03];
const TARGETS = [0.02, 0.03, 0.04, 0.06, 0.08, 0.12];
const NOW = Date.now();
const ONE_YEAR = NOW - 365 * 24 * 60 * 60 * 1000;

interface StratDef {
  label: string; direction: "long" | "short"; entryType: string;
  thresholdValues?: number[]; periodValues?: number[];
}

const strategies: StratDef[] = [
  { label: "RSI short MR", direction: "short", entryType: "rsi_above", thresholdValues: [60, 65, 70, 75, 80] },
  { label: "RSI long MR", direction: "long", entryType: "rsi_below", thresholdValues: [20, 25, 30, 35, 40] },
  { label: "MACD bearish short", direction: "short", entryType: "macd_bearish_cross" },
  { label: "MACD bullish long", direction: "long", entryType: "macd_bullish_cross" },
  { label: "BB touch upper short", direction: "short", entryType: "bollinger_touch_upper" },
  { label: "BB touch lower long", direction: "long", entryType: "bollinger_touch_lower" },
  { label: "Price<EMA short", direction: "short", entryType: "price_below_ema", periodValues: [10, 20, 30, 50, 100] },
  { label: "Price>EMA long", direction: "long", entryType: "price_above_ema", periodValues: [10, 20, 30, 50, 100] },
];

async function main() {
  const agent = new Agent({
    config: { workspaceRoot: process.cwd(), tier: "local", model: "qwen2.5:0.5b" },
  });

  const allResults: any[] = [];

  for (const sym of ["XRPUSDT", "SOLUSDT", "ETHUSDT"]) {
    console.log(`\n═══ ${sym} ═══\n`);
    for (const strat of strategies) {
      const args: Record<string, unknown> = {
        symbol: sym, interval: "1h",
        direction: strat.direction, entryType: strat.entryType,
        stopValues: STOPS, targetValues: TARGETS,
        initialCapital: CAPITAL, leverage: LEVERAGE, marginPerTradePct: MARGIN_PCT,
        startTime: ONE_YEAR, endTime: NOW,
      };
      if (strat.thresholdValues) args.thresholdValues = strat.thresholdValues;
      if (strat.periodValues) args.periodValues = strat.periodValues;

      process.stdout.write(`  ${strat.label.padEnd(22)} `);
      const r = await agent.tools.registry.invoke("binance_futures_sweep", args);
      if (r.top && (r.top as any[]).length > 0) {
        const best = (r.top as any[]).filter((t: any) => t.sharpe > 1);
        if (best.length > 0) {
          const b = best[0];
          console.log(`⭐ Sharpe=${b.sharpe.toFixed(2)} PF=${b.pf.toFixed(2)} WR=${(b.winRate*100).toFixed(0)}% PnL=$${Math.round(b.pnlUsd).toLocaleString()} DD=${(b.maxDDPct*100).toFixed(0)}% S=${(b.stopPct*100).toFixed(1)}% T=${(b.targetPct*100).toFixed(1)}% ${b.value != null ? `th=${b.value}` : ""} ${b.period != null ? `per=${b.period}` : ""}`);
          allResults.push({ symbol: sym, strategy: strat.label, ...b });
        } else {
          const b = (r.top as any[])[0];
          console.log(`  Sharpe=${b.sharpe.toFixed(2)} PF=${b.pf.toFixed(2)} PnL=$${Math.round(b.pnlUsd).toLocaleString()} (no >1 Sharpe combo)`);
        }
      } else {
        console.log(`— no data`);
      }
    }
  }

  allResults.sort((a, b) => (b.sharpe ?? 0) - (a.sharpe ?? 0));

  const markdown = `## Comprehensive Futures Sweep Results

### Configuration
- **Capital**: $${CAPITAL.toLocaleString()} @ ${LEVERAGE}x leverage
- **Data**: 1 year of 1h klines per symbol
- **Fee**: 5bps round-trip
- **Margin per trade**: ${MARGIN_PCT*100}% of equity
- **Risk sweep**: stop [${STOPS.map(s => s*100+"%").join(", ")}], target [${TARGETS.map(t => t*100+"%").join(", ")}]

### Top 15 Parameter Combos (by Sharpe)

| Rank | Symbol | Strategy | Stop | Target | Thresh | Period | Trades | WR | PF | Sharpe | PnL | MaxDD |
|------|---------|---------|------|--------|--------|--------|--------|-------|----|--------|------|-------|
${allResults.slice(0, 15).map((r, i) =>
  `| ${i+1} | ${r.symbol} | ${r.strategy} | ${(r.stopPct*100).toFixed(1)}% | ${(r.targetPct*100).toFixed(1)}% | ${r.value != null ? r.value : "—"} | ${r.period != null ? r.period : "—"} | ${r.trades} | ${(r.winRate*100).toFixed(0)}% | ${r.pf.toFixed(2)} | ${r.sharpe.toFixed(2)} | $${Math.round(r.pnlUsd).toLocaleString()} | ${(r.maxDDPct*100).toFixed(0)}% |`
).join("\n")}

### Summary by Symbol
| Symbol | Best Strategy | Sharpe | PF | PnL | MaxDD |
|--------|--------------|--------|----|------|-------|
${["XRPUSDT","SOLUSDT","ETHUSDT"].map(sym => {
  const symBest = allResults.filter(r => r.symbol === sym && r.sharpe > 1);
  if (symBest.length === 0) return `| ${sym} | — | — | — | — | — |`;
  const b = symBest[0];
  return `| ${sym} | ${b.strategy} | ${b.sharpe.toFixed(2)} | ${b.pf.toFixed(2)} | $${Math.round(b.pnlUsd).toLocaleString()} | ${(b.maxDDPct*100).toFixed(0)}% |`;
}).join("\n")}

### Count of profitable (Sharpe>1) strategies per symbol
${["XRPUSDT","SOLUSDT","ETHUSDT"].map(sym => {
  const n = allResults.filter(r => r.symbol === sym && r.sharpe > 1).length;
  return `- ${sym}: ${n} profitable combos`;
}).join("\n")}
`;

  console.log(`\n\n${markdown}`);

  // Feed to agent for LLM analysis
  console.log(`\n═══ Agent Analysis ═══\n`);
  const analysis = await agent.runUserMessage(
    `Here is our comprehensive futures parameter sweep across XRPUSDT, SOLUSDT, ETHUSDT with $10,000 capital at 10x leverage on 1 year of 1h data:\n\n${markdown}\n\nPlease analyze these results for actual trading edge. Answer concisely: 1) Which strategies have real edge vs overfit? 2) Are the risk parameters sensible? 3) Would you trade any of these live?`
  );
  console.log(`\n${analysis}`);
}

main().catch(e => { console.error(e); process.exit(1); });
