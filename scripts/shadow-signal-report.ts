// Reads .trading-agent/shadow-trades.jsonl and reports fire count / win rate
// / profit factor / total PnL% per candidate — covers every shadow signal
// family sharing this journal (OBI, liquidation-cluster, ...), not just OBI;
// summarizeShadowJournal (shadow-signal-tracker.ts) is generic per candidate
// id. Prints only — never flips a candidate's shadow flag in
// autonomous-trading-daemon.ts. That's a manual, reviewed edit once a
// candidate's verdict reads SURVIVES.
import { readFileSync, existsSync } from "fs";
import { summarizeShadowJournal } from "../src/paper-trading/shadow-signal-tracker.js";

const JOURNAL_FILE = process.argv[2] ?? ".trading-agent/shadow-trades.jsonl";

function main() {
  if (!existsSync(JOURNAL_FILE)) {
    console.error(`No journal at ${JOURNAL_FILE} yet — the daemon hasn't run with shadow tracking on.`);
    process.exit(1);
  }
  const lines = readFileSync(JOURNAL_FILE, "utf-8").split("\n").filter(Boolean);
  const entries = lines.map(l => JSON.parse(l));
  const summary = summarizeShadowJournal(entries);

  console.log("Shadow-signal report\n");
  for (const [id, s] of Object.entries(summary)) {
    console.log(`${id}: ${s.fires} fires, ${s.wins}W/${s.losses}L (${(s.winRate * 100).toFixed(0)}%), PF=${s.pf.toFixed(2)}, totalPnL=${(s.totalPnlPct * 100).toFixed(2)}% — ${s.verdict}`);
  }
  if (Object.keys(summary).length === 0) console.log("No closed shadow trades yet.");
}

main();
