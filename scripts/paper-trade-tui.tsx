#!/usr/bin/env tsx
// Autonomous paper trading terminal UI. Renders on the normal screen buffer
// (not alt-screen) so the terminal's native scrollback keeps working —
// alt-screen (vim/htop-style) was tried but its no-scrollback tradeoff isn't
// worth it for a dashboard nobody needs to review history on by scrolling up.
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

const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";

function hideCursor() {
  if (process.stdout.isTTY) process.stdout.write(CURSOR_HIDE);
}
function showCursor() {
  if (process.stdout.isTTY) process.stdout.write(CURSOR_SHOW);
}

const runner = new LivePaperRunner();
const analyst = analystEnabled ? new TradeAnalyst() : null;
const readiness = new ReadinessMonitor({ notifyTelegram: notifyEnabled && telegramConfigured });
const fillNotifier = notifyEnabled && telegramConfigured ? new FillNotifier({ journalFile: DEFAULT_RUNNER_CONFIG.journalFile }) : null;
const evaluator = evaluatorEnabled ? new TradeEvaluator() : null;

hideCursor();

let exited = false;
function cleanExit(code = 0) {
  if (exited) return;
  exited = true;
  runner.stop();
  analyst?.stop();
  evaluator?.stop();
  showCursor();
  process.exit(code);
}
process.on("SIGINT", () => cleanExit(0));
process.on("SIGTERM", () => cleanExit(0));
process.on("uncaughtException", (e) => { showCursor(); console.error(e); process.exit(1); });

const { waitUntilExit } = render(
  React.createElement(PaperTradingDashboard, {
    runner, analyst, readiness, fillNotifier, evaluator, pollMs: pollSeconds * 1000,
    journalFile: DEFAULT_RUNNER_CONFIG.journalFile,
    onExit: () => cleanExit(0),
  }),
  // incrementalRendering: rewrite only changed lines each tick instead of
  // erasing+redrawing the whole frame — this is the actual fix for the
  // flicker (visible only when scrolled to the bottom, i.e. watching the
  // live redraw zone). Normal screen buffer (no alt-screen) is unchanged,
  // so terminal scrollback still works.
  { incrementalRendering: true },
);

await waitUntilExit();
cleanExit(0);
