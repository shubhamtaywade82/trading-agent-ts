import { BinanceSignalFusionTool } from "../src/tools/backtest-tools.js";
import { readFileSync } from "fs";

const strategies = JSON.parse(readFileSync("strategies.json", "utf-8"));

const toolInput: Record<string, any> = {
  initialCapital: strategies.config.initialCapital ?? 10000,
  leverage: 10,
  marginPerTradePct: 0.1,
  confluentAddPct: 0.5,
  interval: strategies.config.interval ?? "1h",
  startTime: Date.now() - 365 * 24 * 60 * 60 * 1000,
  endTime: Date.now(),
  strategies: {},
};

for (const [sym, strats] of Object.entries(strategies.symbols)) {
  toolInput.strategies[sym] = (strats as any[]).map((s: any) => ({
    id: s.id,
    label: s.label,
    direction: s.direction,
    signalType: s.entry[0].type,
    signalPeriod: s.entry[0].period,
    signalValue: s.entry[0].value,
    stopPct: s.risk.stopPct,
    targetPct: s.risk.targetPct,
  }));
}

const tool = new BinanceSignalFusionTool();
console.log("\n=== SIGNAL FUSION BACKTEST ===");
console.log(`Symbols: ${Object.keys(toolInput.strategies).join(", ")}`);
console.log(`Interval: ${toolInput.interval}`);
console.log(`Capital: $${toolInput.initialCapital} @ ${toolInput.leverage}x`);
console.log(`Confluence add: ${toolInput.confluentAddPct * 100}%\n`);

const result = await tool.call(toolInput);

console.log(`Capital: $${result.initialCapital.toLocaleString()} → $${result.finalCapital.toLocaleString()}`);
console.log(`Return: ${(result.totalReturnPct * 100).toFixed(2)}% | PnL: \$${result.totalPnlUsd.toLocaleString()}`);
console.log(`Max DD: ${(result.maxDrawdownPct * 100).toFixed(2)}%`);
console.log(`Total trades: ${result.totalTrades}`);

console.log(`\n── Strategy Entry Counts ──`);
for (const [id, count] of Object.entries(result.strategyEntryCounts as Record<string, number>).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${id}: ${count} entries`);
}

const totalConf = Object.values(result.confluenceEvents as Record<string, number>).reduce((s: number, v) => s + v, 0);
console.log(`\n── Confluence Events: ${totalConf} ──`);
for (const [key, count] of Object.entries(result.confluenceEvents as Record<string, number>).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${key}: ${count}`);
}

// Per-direction breakdown
const trades = result.trades as any[];
const entries = trades.filter((t: any) => t.type === "entry");
const bySymbol: Record<string, { entries: number; exits: number; pnl: number }> = {};
for (const e of entries) {
  if (!bySymbol[e.sym]) bySymbol[e.sym] = { entries: 0, exits: 0, pnl: 0 };
  bySymbol[e.sym].entries++;
}
for (const x of trades.filter((t: any) => t.type === "exit")) {
  if (!bySymbol[x.sym]) bySymbol[x.sym] = { entries: 0, exits: 0, pnl: 0 };
  bySymbol[x.sym].exits++;
  bySymbol[x.sym].pnl += x.pnl;
}
console.log("\n── Per-Symbol ──");
for (const [sym, d] of Object.entries(bySymbol)) {
  const wins = trades.filter((t: any) => t.type === "exit" && t.sym === sym && t.pnl > 0).length;
  const total = trades.filter((t: any) => t.type === "exit" && t.sym === sym).length;
  console.log(`  ${sym}: ${d.entries} entries → ${d.exits} exits, \$${Math.round(d.pnl).toLocaleString()} PnL, ${total > 0 ? ((wins/total)*100).toFixed(0) : 'N/A'}% WR`);
}
