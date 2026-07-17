#!/usr/bin/env tsx
// Autonomous paper trading, fullscreen terminal UI (alt-screen buffer, same
// as vim/htop/the main devagent TUI) — takes over the whole viewport instead
// of scrolling console text.
//
// Usage: npx tsx scripts/paper-trade-tui.tsx [--poll-seconds=60] [--no-analyst] [--no-notify] [--no-eval]
import "dotenv/config";
import React from "react";
import { render } from "ink";
import { LivePaperRunner, DEFAULT_RUNNER_CONFIG } from "../src/paper-trading/live-runner.js";
import { TradeAnalyst } from "../src/paper-trading/trade-analyst.js";
import { ReadinessMonitor } from "../src/paper-trading/readiness.js";
import { FillNotifier } from "../src/paper-trading/notifier.js";
import { TradeEvaluator } from "../src/paper-trading/trade-evaluator.js";
import { PaperTradingDashboard } from "../src/tui/PaperTradingDashboard.js";

const pollArg = process.argv.find(a => a.startsWith("--poll-seconds="));
const pollSeconds = pollArg ? Number(pollArg.split("=")[1]) : 60;
const analystEnabled = !process.argv.includes("--no-analyst");
const notifyEnabled = !process.argv.includes("--no-notify");
const evaluatorEnabled = !process.argv.includes("--no-eval");
const telegramConfigured = !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID;

const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";

function enterFullscreen() {
  if (process.stdout.isTTY) process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE);
}
function exitFullscreen() {
  if (process.stdout.isTTY) process.stdout.write(CURSOR_SHOW + ALT_SCREEN_OFF);
}

const runner = new LivePaperRunner();
const analyst = analystEnabled ? new TradeAnalyst() : null;
const readiness = new ReadinessMonitor({ notifyTelegram: notifyEnabled && telegramConfigured });
const fillNotifier = notifyEnabled && telegramConfigured ? new FillNotifier({ journalFile: DEFAULT_RUNNER_CONFIG.journalFile }) : null;
const evaluator = evaluatorEnabled ? new TradeEvaluator() : null;

enterFullscreen();

let exited = false;
function cleanExit(code = 0) {
  if (exited) return;
  exited = true;
  runner.stop();
  analyst?.stop();
  evaluator?.stop();
  exitFullscreen();
  process.exit(code);
}
process.on("SIGINT", () => cleanExit(0));
process.on("SIGTERM", () => cleanExit(0));
process.on("uncaughtException", (e) => { exitFullscreen(); console.error(e); process.exit(1); });

const { waitUntilExit } = render(
  React.createElement(PaperTradingDashboard, {
    runner, analyst, readiness, fillNotifier, evaluator, pollMs: pollSeconds * 1000,
    journalFile: DEFAULT_RUNNER_CONFIG.journalFile,
    onExit: () => cleanExit(0),
  }),
);

await waitUntilExit();
cleanExit(0);
