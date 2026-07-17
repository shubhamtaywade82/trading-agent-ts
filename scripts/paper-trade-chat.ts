#!/usr/bin/env tsx
// Read-only chat interface over the paper-trading system. Ask about open
// positions, recent fills, readiness, per-trade evaluations, etc. — this
// process cannot place, close, or modify a trade (no such tool exists, see
// src/paper-trading/chat-assistant.ts). Runs independently of the actual
// trading bot; reads the same on-disk state/journal files.
//
// Usage: npx tsx scripts/paper-trade-chat.ts
import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ChatAssistant, DEFAULT_CHAT_CONFIG } from "../src/paper-trading/chat-assistant.js";

console.log("=== Paper Trading Chat Assistant (read-only) ===");
console.log(`Model: ${DEFAULT_CHAT_CONFIG.model} (${DEFAULT_CHAT_CONFIG.tier})`);
console.log("This assistant can only query status — it cannot place, close, or modify any trade.");
console.log("Ask things like: \"what positions are open\", \"is anything ready for live\", \"why hasn't xrp-liq-sweep-short-2h fired\".");
console.log("Type 'exit' or Ctrl+C to quit.\n");

const assistant = new ChatAssistant();
const rl = readline.createInterface({ input: stdin, output: stdout });

while (true) {
  const line = await rl.question("> ");
  const trimmed = line.trim();
  if (!trimmed) continue;
  if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") break;

  try {
    const reply = await assistant.ask(trimmed);
    console.log(`\n${reply}\n`);
  } catch (e) {
    console.error(`\nError: ${(e as Error).message}\n`);
  }
}

rl.close();
console.log("Goodbye.");
