// Reads .trading-agent/funding-arb-trades.jsonl (closed positions) and
// .trading-agent/funding-arb-state.json (currently open) and reports realized
// PnL / funding collected / basis PnL per symbol, plus a best-effort live
// re-mark of any still-open position. Informational only — this signal has
// no strategies.json promotion path (see design spec), so this script isn't
// a decision gate the way the shadow-signal report is.
import { readFileSync, existsSync } from "fs";
import { summarizeFundingArbJournal, computeBasisPnl, FundingArbPosition } from "../src/paper-trading/funding-arb.js";
import { fetchSpotPrice, fetchFuturesStats } from "../src/tools/binance-tools.js";

const JOURNAL_FILE = ".trading-agent/funding-arb-trades.jsonl";
const STATE_FILE = ".trading-agent/funding-arb-state.json";

async function main() {
  if (existsSync(JOURNAL_FILE)) {
    const lines = readFileSync(JOURNAL_FILE, "utf-8").split("\n").filter(Boolean);
    const entries = lines.map(l => JSON.parse(l));
    const summary = summarizeFundingArbJournal(entries);
    console.log("Funding-arb report — closed positions\n");
    for (const [symbol, s] of Object.entries(summary)) {
      console.log(`${symbol}: ${s.closedCount} closed, realizedPnL=$${s.totalRealizedPnlUsd.toFixed(2)} (funding=$${s.totalFundingCollected.toFixed(2)}, basis=$${s.totalBasisPnl.toFixed(2)})`);
    }
    if (Object.keys(summary).length === 0) console.log("No closed positions yet.");
  } else {
    console.log("No journal yet — the daemon hasn't run with funding-arb tracking on.");
  }

  if (existsSync(STATE_FILE)) {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as Record<string, FundingArbPosition | null>;
    console.log("\nOpen positions (best-effort live mark)\n");
    for (const [symbol, pos] of Object.entries(state)) {
      if (!pos) continue;
      const [stats, spot] = await Promise.all([fetchFuturesStats(symbol), fetchSpotPrice(symbol)]);
      if ("error" in stats || "error" in spot) { console.log(`${symbol}: mark failed`); continue; }
      const currentBasis = stats.markPrice - spot.price;
      const basisPnl = computeBasisPnl(pos.qty, pos.entryBasis, currentBasis, pos.perpDirection);
      const unrealized = pos.accruedFundingUsd + basisPnl;
      console.log(`${symbol}: ${pos.perpDirection} perp, notional=$${pos.notional}, unrealized=$${unrealized.toFixed(2)} (funding=$${pos.accruedFundingUsd.toFixed(2)}, basis=$${basisPnl.toFixed(2)})`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
