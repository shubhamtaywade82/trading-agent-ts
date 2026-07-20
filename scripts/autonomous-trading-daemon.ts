#!/usr/bin/env tsx
// Unified autonomous paper-trading daemon: one process running every piece
// built this session — event-driven entries, REST safety net, circuit
// breaker, drift monitor, weekly research/promotion pipeline, AI analyst,
// per-trade evaluator, readiness gate, Telegram/bell alerts. Meant to run
// under scripts/daemon-watchdog.sh for crash-restart supervision.
//
// TUI (paper-trade-tui.tsx) and chat (paper-trade-chat.ts) stay separate,
// lightweight, read-the-same-files viewers — they don't need to live inside
// this process.
//
// Usage: npx tsx scripts/autonomous-trading-daemon.ts [--poll-seconds=60]
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { LivePaperRunner, DEFAULT_RUNNER_CONFIG } from "../src/paper-trading/live-runner.js";
import { TradeAnalyst } from "../src/paper-trading/trade-analyst.js";
import { TradeEvaluator } from "../src/paper-trading/trade-evaluator.js";
import { ReadinessMonitor } from "../src/paper-trading/readiness.js";
import { FillNotifier, sendTelegram } from "../src/paper-trading/notifier.js";
import { BinanceStreamManager } from "../src/exchange/binance-stream.js";
import { StrategyCircuitBreaker } from "../src/paper-trading/circuit-breaker.js";
import { DriftMonitor } from "../src/paper-trading/drift-monitor.js";
import { ResearchPipeline } from "../src/paper-trading/research-pipeline.js";
import { PnlAdaptor } from "../src/paper-trading/pnl-adaptor.js";
import { ShadowSignalTracker, CandidateSignal } from "../src/paper-trading/shadow-signal-tracker.js";
import { fetchOrderBookImbalance } from "../src/tools/binance-tools.js";

const pollArg = process.argv.find(a => a.startsWith("--poll-seconds="));
const pollSeconds = pollArg ? Number(pollArg.split("=")[1]) : 60;
const telegramConfigured = !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID;

const HEARTBEAT_FILE = ".trading-agent/daemon-heartbeat.json";
const RESEARCH_SCHEDULE_FILE = ".trading-agent/research-schedule-state.json";
const RESEARCH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // weekly

const runner = new LivePaperRunner();
const stream = new BinanceStreamManager();
const analyst = new TradeAnalyst();
const evaluator = new TradeEvaluator();
const readiness = new ReadinessMonitor({ notifyTelegram: telegramConfigured });
const fillNotifier = telegramConfigured ? new FillNotifier({ journalFile: DEFAULT_RUNNER_CONFIG.journalFile }) : null;
const circuitBreaker = new StrategyCircuitBreaker(runner, { notifyTelegram: telegramConfigured }, stream);
const driftMonitor = new DriftMonitor({ notifyTelegram: telegramConfigured });
const researchPipeline = new ResearchPipeline({ notifyTelegram: telegramConfigured }, runner);
// dryRun-only until TRADINGAGENT_PNL_ADAPTOR_LIVE=true is explicitly set --
// see pnl-adaptor.ts's header for why this ships conservative by default.
const pnlAdaptorLive = process.env.TRADINGAGENT_PNL_ADAPTOR_LIVE === "true";
const pnlAdaptor = new PnlAdaptor({ notifyTelegram: telegramConfigured, dryRun: !pnlAdaptorLive }, runner);

const OBI_SYMBOLS = ["XRPUSDT", "ETHUSDT", "SOLUSDT"];
const obiCandidates: CandidateSignal[] = OBI_SYMBOLS.map(symbol => ({
  id: `obi-${symbol}`,
  symbol,
  shadow: true,
  stopPct: 0.015,
  targetPct: 0.03,
  maxHoldMs: 4 * 60 * 60 * 1000,
  checkFire: async () => {
    const result = await fetchOrderBookImbalance(symbol, "usdm", 50);
    if ("error" in result) return null;
    if (result.imbalance > 0.3) return "long";
    if (result.imbalance < -0.3) return "short";
    return null;
  },
}));
const shadowTracker = new ShadowSignalTracker(obiCandidates, stream);

let tickCount = 0;
let lastFillCount = 0;
const startedAt = Date.now();

function writeHeartbeat() {
  const dir = dirname(HEARTBEAT_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(HEARTBEAT_FILE, JSON.stringify({
    pid: process.pid, startedAt: new Date(startedAt).toISOString(), now: new Date().toISOString(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000), tickCount, lastFillCount,
    strategies: runner.getStatus().length,
  }, null, 2));
}

console.log("=== Autonomous Trading Daemon ===");
console.log(`PID: ${process.pid}  Poll: ${pollSeconds}s  Telegram: ${telegramConfigured ? "on" : "off"}`);
console.log(`Strategies: ${runner.getStatus().length}`);
console.log(`Heartbeat: ${HEARTBEAT_FILE}`);

let stopping = false;
async function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  console.log(`\nShutting down (${reason})...`);
  runner.stop();
  analyst.stop();
  evaluator.stop();
  circuitBreaker.stop();
  driftMonitor.stop();
  pnlAdaptor.stop();
  shadowTracker.stop();
  stream.closeAll();
  writeHeartbeat();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (e) => {
  console.error("Uncaught exception — exiting for watchdog restart:", e);
  writeHeartbeat();
  process.exit(1);
});

// Event-driven entry trigger (sub-second on candle close) — REST poll below
// remains the safety net for stop/target/liquidation checks either way.
await runner.attachStream(stream).catch(e => console.error("Kline stream attach failed (REST poll still covers entries):", e));
// Ticker feed for mark-to-market: totalUnrealizedPnl() (used by the daily
// loss halt, see circuit-breaker.ts) reads stream.getLatest() per symbol.
await Promise.all(runner.getSymbols().map(sym => stream.subscribe(sym)))
  .catch(e => console.error("Ticker stream subscribe failed (daily halt falls back to realized-only):", e));

runner.start(pollSeconds * 1000, async (result) => {
  tickCount++;
  lastFillCount = result.fills;
  writeHeartbeat();
  if (result.fills > 0) {
    await fillNotifier?.checkAndNotify();
    const { newlyReady, portfolioNewlyReady } = await readiness.check();
    for (const s of newlyReady) console.log(`🟢 READY FOR LIVE: ${s.label} — ${s.trades} trades, WR ${(s.liveWinRate*100).toFixed(0)}%, PF ${s.livePf.toFixed(2)}`);
    if (portfolioNewlyReady) console.log("🟢🟢 PORTFOLIO READY FOR LIVE");
  }
}).catch(e => {
  console.error("Runner crashed:", e);
  process.exit(1);
});

analyst.start(5 * 60 * 1000).catch(e => console.error("Analyst loop crashed (trading unaffected):", e));
evaluator.start(30_000).catch(e => console.error("Evaluator loop crashed (trading unaffected):", e));
circuitBreaker.start(5 * 60 * 1000, (r) => {
  for (const id of r.pausedNow) console.log(`🟠 CIRCUIT BREAKER paused ${id}`);
  for (const id of r.resumedNow) console.log(`🟢 CIRCUIT BREAKER resumed ${id}`);
}).catch(e => console.error("Circuit breaker loop crashed (trading unaffected):", e));
shadowTracker.start(pollSeconds * 1000, (r) => {
  for (const id of r.opened) console.log(`🔍 SHADOW fired: ${id}`);
  for (const c of r.closed) console.log(`🔍 SHADOW closed: ${c.id} (${c.reason})`);
}).catch(e => console.error("Shadow tracker loop crashed (trading unaffected):", e));
driftMonitor.start(5 * 60 * 1000, (r) => {
  for (const a of r.alerts) console.log(a);
}).catch(e => console.error("Drift monitor loop crashed (trading unaffected):", e));
pnlAdaptor.start(60 * 60 * 1000, (r) => {
  for (const id of r.resized) console.log(`${pnlAdaptorLive ? "⚖️" : "⚖️ [dry-run]"} PNL ADAPTOR resized ${id}`);
  for (const id of r.pruned) console.log(`${pnlAdaptorLive ? "🔴" : "🔴 [dry-run]"} PNL ADAPTOR pruned ${id}`);
}).catch(e => console.error("PnL adaptor loop crashed (trading unaffected):", e));

// Weekly research/promotion cycle — self-paced against a persisted
// last-run timestamp so a restart doesn't re-trigger it early.
async function researchScheduler() {
  while (!stopping) {
    let lastRunAt = 0;
    if (existsSync(RESEARCH_SCHEDULE_FILE)) {
      try { lastRunAt = JSON.parse(readFileSync(RESEARCH_SCHEDULE_FILE, "utf-8")).lastRunAt ?? 0; } catch { /* run now */ }
    }
    if (Date.now() - lastRunAt >= RESEARCH_INTERVAL_MS) {
      console.log("🔬 Starting weekly research cycle...");
      try {
        const result = await researchPipeline.runCycle();
        console.log(`🔬 Research cycle done: ${result.tested} combos tested, ${result.candidateCount} candidates, ${result.promoted.length} promoted (${result.promoted.join(", ") || "none"})`);
      } catch (e) {
        console.error("Research cycle failed:", e);
        if (telegramConfigured) await sendTelegram(`⚠️ Research cycle failed: ${(e as Error).message}`);
      }
      const dir = dirname(RESEARCH_SCHEDULE_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(RESEARCH_SCHEDULE_FILE, JSON.stringify({ lastRunAt: Date.now() }));
    }
    await new Promise(r => setTimeout(r, 60 * 60 * 1000)); // check hourly
  }
}
researchScheduler().catch(e => console.error("Research scheduler crashed (trading unaffected):", e));

writeHeartbeat();
