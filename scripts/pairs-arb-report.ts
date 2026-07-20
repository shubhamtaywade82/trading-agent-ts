// Reads .trading-agent/pairs-arb-trades.jsonl and reports closed-position
// count / total PnL / win rate per pair. Informational only — same as
// funding-arb-report.ts, no strategies.json-style promotion gate here either
// (promotion happens via scripts/pairs-arb-sweep.ts before a pair ever goes
// live, not after).
import { readFileSync, existsSync } from "fs";
import { summarizePairsArbJournal } from "../src/paper-trading/pairs-arb.js";

const JOURNAL_FILE = ".trading-agent/pairs-arb-trades.jsonl";

function main() {
  if (!existsSync(JOURNAL_FILE)) {
    console.log("No journal yet — no pairs-arb candidate has been promoted into the daemon's active list.");
    return;
  }
  const lines = readFileSync(JOURNAL_FILE, "utf-8").split("\n").filter(Boolean);
  const entries = lines.map(l => JSON.parse(l));
  const summary = summarizePairsArbJournal(entries);
  console.log("Pairs-arb report\n");
  for (const [id, s] of Object.entries(summary)) {
    console.log(`${id}: ${s.closedCount} closed, totalPnL=$${s.totalPnlUsd.toFixed(2)}, winRate=${(s.winRate * 100).toFixed(0)}%`);
  }
  if (Object.keys(summary).length === 0) console.log("No closed positions yet.");
}

main();
