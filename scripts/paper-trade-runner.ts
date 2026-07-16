#!/usr/bin/env tsx
// Autonomous paper trading — runs every strategy in strategies.json
// continuously, no human input, until stopped (Ctrl+C or SIGTERM).
//
// Usage: npx tsx scripts/paper-trade-runner.ts [--poll-seconds=60] [--no-analyst]
import { LivePaperRunner } from "../src/paper-trading/live-runner.js";
import { TradeAnalyst } from "../src/paper-trading/trade-analyst.js";

const pollArg = process.argv.find(a => a.startsWith("--poll-seconds="));
const pollSeconds = pollArg ? Number(pollArg.split("=")[1]) : 60;
const analystEnabled = !process.argv.includes("--no-analyst");

const runner = new LivePaperRunner();
const analyst = analystEnabled ? new TradeAnalyst() : null;

console.log("=== Autonomous Paper Trading Runner ===");
console.log(`Poll interval: ${pollSeconds}s`);
console.log(`State: .trading-agent/paper-state.json`);
console.log(`Journal: .trading-agent/paper-trades.jsonl`);
console.log(`AI analyst: ${analystEnabled ? "on (read-only, .trading-agent/paper-trading-insights.md)" : "off"}`);
console.log(`Strategies loaded: ${runner.getStatus().length}\n`);

function printStatus() {
  const rows = runner.getStatus();
  const p = runner.getPortfolio();
  console.log(`\n[${new Date().toISOString()}] Portfolio: equity=$${(p.totalInitialCapital + p.totalRealizedPnl).toFixed(2)} available=$${p.availableBalance.toFixed(2)} usedMargin=$${p.usedMargin.toFixed(2)} open=${p.openPositions}/${p.strategyCount}`);
  for (const r of rows) {
    const posStr = r.openPosition ? ` | OPEN @ ${r.openPosition.entryPrice.toFixed(4)} since ${r.openPosition.entryTime}` : "";
    console.log(`  ${r.symbol.padEnd(9)} ${r.id.padEnd(28)} cap=$${r.capital.toFixed(2).padStart(10)} pnl=$${r.pnl.toFixed(2).padStart(9)} trades=${String(r.trades).padStart(3)} WR=${r.winRate !== null ? (r.winRate*100).toFixed(0)+"%" : " -"}${posStr}`);
  }
  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
  console.log(`  TOTAL realized PnL across ${rows.length} strategies: $${totalPnl.toFixed(2)}`);
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("\nShutting down — saving state...");
  runner.stop();
  analyst?.stop();
  printStatus();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

runner.start(pollSeconds * 1000, (result) => {
  if (result.fills > 0) {
    console.log(`[${new Date().toISOString()}] tick: ${result.groupsChecked} groups, ${result.fills} fill(s)`);
    printStatus();
  }
}).catch(e => {
  console.error("Runner crashed:", e);
  process.exit(1);
});

if (analyst) {
  analyst.start(5 * 60 * 1000, (ran) => {
    if (!ran) return;
    const latest = analyst.getLatestSummary();
    console.log(`\n[${new Date().toISOString()}] AI analyst update (${latest?.tradesAnalyzed ?? 0} trades reviewed):`);
    console.log(latest?.summary ?? "(no summary — check .trading-agent/paper-trading-learnings.jsonl for error detail)");
  }).catch(e => {
    console.error("Analyst loop crashed (trading continues unaffected):", e);
  });
}

// Periodic heartbeat + status even with no fills, so it's visibly alive.
setInterval(() => { if (!stopping) printStatus(); }, 15 * 60 * 1000);
