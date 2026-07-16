#!/usr/bin/env tsx
// Autonomous paper trading with a live Ink dashboard instead of scrolling
// console text. Same LivePaperRunner underneath — this only changes how
// status is displayed.
//
// Usage: npx tsx scripts/paper-trade-tui.tsx [--poll-seconds=60]
import React from "react";
import { render } from "ink";
import { LivePaperRunner, DEFAULT_RUNNER_CONFIG } from "../src/paper-trading/live-runner.js";
import { PaperTradingDashboard } from "../src/tui/PaperTradingDashboard.js";

const pollArg = process.argv.find(a => a.startsWith("--poll-seconds="));
const pollSeconds = pollArg ? Number(pollArg.split("=")[1]) : 60;

const runner = new LivePaperRunner();

const { waitUntilExit } = render(
  React.createElement(PaperTradingDashboard, { runner, pollMs: pollSeconds * 1000, journalFile: DEFAULT_RUNNER_CONFIG.journalFile }),
);

process.on("SIGTERM", () => { runner.stop(); process.exit(0); });

await waitUntilExit();
