#!/usr/bin/env tsx
// Autonomous paper trading — runs every strategy in strategies.json
// continuously, no human input, until stopped (Ctrl+C or SIGTERM).
//
// Usage: npx tsx scripts/paper-trade-runner.ts [--poll-seconds=60] [--no-analyst] [--no-notify] [--no-eval]
import "dotenv/config";
import { LivePaperRunner } from "../src/paper-trading/live-runner.js";
import { TradeAnalyst } from "../src/paper-trading/trade-analyst.js";
import { ReadinessMonitor } from "../src/paper-trading/readiness.js";
import { FillNotifier } from "../src/paper-trading/notifier.js";
import { TradeEvaluator } from "../src/paper-trading/trade-evaluator.js";

const pollArg = process.argv.find(a => a.startsWith("--poll-seconds="));
const pollSeconds = pollArg ? Number(pollArg.split("=")[1]) : 60;
const analystEnabled = !process.argv.includes("--no-analyst");
const notifyEnabled = !process.argv.includes("--no-notify");
const evaluatorEnabled = !process.argv.includes("--no-eval");
const telegramConfigured = !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID;

const runner = new LivePaperRunner();
const analyst = analystEnabled ? new TradeAnalyst() : null;
const readiness = new ReadinessMonitor({ notifyTelegram: notifyEnabled && telegramConfigured });
const fillNotifier = notifyEnabled && telegramConfigured ? new FillNotifier({ journalFile: ".trading-agent/paper-trades.jsonl" }) : null;
const evaluator = evaluatorEnabled ? new TradeEvaluator() : null;

console.log("=== Autonomous Paper Trading Runner ===");
console.log(`Poll interval: ${pollSeconds}s`);
console.log(`State: .trading-agent/paper-state.json`);
console.log(`Journal: .trading-agent/paper-trades.jsonl`);
console.log(`AI analyst: ${analystEnabled ? "on (read-only, .trading-agent/paper-trading-insights.md)" : "off"}`);
console.log(`Per-trade evaluator: ${evaluatorEnabled ? "on (read-only, .trading-agent/trade-evaluations.jsonl)" : "off"}`);
console.log(`Telegram alerts: ${notifyEnabled ? (telegramConfigured ? "on (readiness + fills)" : "off (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set)") : "off (--no-notify)"}`);
console.log(`Strategies loaded: ${runner.getStatus().length}\n`);

function printStatus() {
  const rows = runner.getStatus();
  const p = runner.getPortfolio();
  console.log(`\n[${new Date().toISOString()}] Portfolio: equity=$${(p.totalInitialCapital + p.totalRealizedPnl).toFixed(2)} available=$${p.availableBalance.toFixed(2)} usedMargin=$${p.usedMargin.toFixed(2)} open=${p.openPositions}/${p.symbolCount} symbols`);
  for (const r of rows) {
    console.log(`  ${r.symbol.padEnd(9)} ${r.id.padEnd(28)} attributedPnl=$${r.attributedPnl.toFixed(2).padStart(9)} trades=${String(r.trades).padStart(3)} WR=${r.winRate !== null ? (r.winRate*100).toFixed(0)+"%" : " -"}`);
  }
  for (const pos of runner.getSymbolPositions()) {
    console.log(`  OPEN ${pos.symbol}: ${pos.direction} ${pos.qty.toFixed(4)} @ avg ${pos.avgEntryPrice.toFixed(4)} (contributors: ${pos.contributingStrategyIds.join(", ")})`);
  }
  const totalPnl = rows.reduce((s, r) => s + r.attributedPnl, 0);
  console.log(`  TOTAL attributed realized PnL across ${rows.length} strategies: $${totalPnl.toFixed(2)}`);
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("\nShutting down — saving state...");
  runner.stop();
  analyst?.stop();
  evaluator?.stop();
  printStatus();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

runner.start(pollSeconds * 1000, async (result) => {
  if (result.fills > 0) {
    console.log(`[${new Date().toISOString()}] tick: ${result.groupsChecked} groups, ${result.fills} fill(s)`);
    printStatus();
    await fillNotifier?.checkAndNotify();
    const { newlyReady, portfolioNewlyReady } = await readiness.check();
    for (const s of newlyReady) console.log(`\n🟢 READY FOR LIVE: ${s.label} — ${s.trades} trades, WR ${(s.liveWinRate*100).toFixed(0)}%, PF ${s.livePf.toFixed(2)}, PnL $${s.totalPnl.toFixed(2)}`);
    if (portfolioNewlyReady) console.log(`\n🟢🟢 PORTFOLIO READY FOR LIVE`);
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

if (evaluator) {
  evaluator.start(30_000, (queueLen) => {
    const recent = evaluator.getRecentEvaluations(1)[0];
    if (recent) console.log(`\n[${new Date().toISOString()}] Trade eval (${recent.eventType}, ${recent.strategyId}, score ${recent.qualityScore ?? "?"}/5, queue ${queueLen}): ${recent.evaluation.slice(0, 200)}`);
  }).catch(e => {
    console.error("Trade evaluator loop crashed (trading continues unaffected):", e);
  });
}

// Periodic heartbeat + status even with no fills, so it's visibly alive.
setInterval(() => { if (!stopping) printStatus(); }, 15 * 60 * 1000);
