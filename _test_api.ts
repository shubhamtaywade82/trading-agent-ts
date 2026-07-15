import "dotenv/config";
const now = Date.now();
const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;
const url = `https://api.binance.com/api/v3/klines?symbol=XRPUSDT&interval=1h&limit=3&startTime=${oneYearAgo}&endTime=${now}`;
console.log("Fetching:", url.slice(0, 150));
const r = await fetch(url);
const body = await r.json();
console.log("Status:", r.status, "Rows:", Array.isArray(body) ? body.length : JSON.stringify(body).slice(0, 200));

// Now test the tool invocation
import { Agent } from "./src/cli/agent.js";
const agent = new Agent({ config: { workspaceRoot: process.cwd(), tier: "local", model: "qwen2.5:0.5b" }});
const result = await agent.tools.registry.invoke("binance_futures_sweep", {
  symbol: "XRPUSDT", interval: "1h",
  direction: "short", entryType: "rsi_above",
  stopValues: [0.01, 0.02], targetValues: [0.03, 0.06],
  thresholdValues: [70, 75],
  leverage: 10, initialCapital: 10000, marginPerTradePct: 0.5,
  startTime: oneYearAgo, endTime: now,
});
console.log("Sweep result:", JSON.stringify(result).slice(0, 300));
