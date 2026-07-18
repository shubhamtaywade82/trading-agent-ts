// Minimal, purpose-built notification senders — deliberately NOT a copy of
// Janus's telegram.ts (rate limiter, circuit breaker, retry_after handling):
// those exist there because Janus sends frequent alert-engine traffic. This
// module fires at most once per strategy/portfolio readiness transition —
// a handful of messages over a paper-trading run's lifetime, not a stream.
// Reuses the SAME env var names as Janus (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
// so one .env value works across both repos.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export function terminalBell(): void {
  if (process.stdout.isTTY) process.stdout.write("\x07");
}

// Watches the paper-trading journal and sends a Telegram alert for every new
// position_fill (open/add/reduce/close/flip) — a live trade blotter in your
// pocket. Purely an observer: reads the journal file, tracks how many lines
// it has already notified via a persisted line count (so a restart doesn't
// re-blast every historical fill), never touches trading state.
export class FillNotifier {
  private stateFile: string;
  private journalFile: string;
  private lastLineCount = 0;

  constructor(opts: { journalFile: string; stateFile?: string }) {
    this.journalFile = opts.journalFile;
    this.stateFile = opts.stateFile ?? ".trading-agent/fill-notifier-state.json";
    if (existsSync(this.stateFile)) {
      try { this.lastLineCount = JSON.parse(readFileSync(this.stateFile, "utf-8")).lastLineCount ?? 0; } catch { /* start from 0 */ }
    }
  }

  private saveState() {
    const dir = dirname(this.stateFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify({ lastLineCount: this.lastLineCount }));
  }

  async checkAndNotify(): Promise<number> {
    if (!existsSync(this.journalFile)) return 0;
    const lines = readFileSync(this.journalFile, "utf-8").trim().split("\n").filter(Boolean);
    if (lines.length <= this.lastLineCount) return 0;
    const newLines = lines.slice(this.lastLineCount);
    this.lastLineCount = lines.length;
    this.saveState();

    let sent = 0;
    for (const line of newLines) {
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      let text: string | null = null;
      if (e.type === "position_fill") {
        const posAfter = e.positionAfter ? ` | position now: ${e.positionAfter.direction ?? "flat"} ${e.positionAfter.qty ?? 0}` : "";
        if (e.action === "open" || e.action === "add" || e.action === "flip_open") {
          const verb = e.action === "add" ? "ADD" : e.action === "flip_open" ? "FLIP→OPEN" : "OPEN";
          text = `${e.direction === "short" ? "🔻" : "🔺"} ${verb} ${e.symbol} ${e.tf} (${e.strategyId})\n@ ${e.price?.toFixed(6)}  qty ${e.qty?.toFixed(4)}${posAfter}`;
        } else if (e.action === "reduce" || e.action === "close" || e.action === "flip_close") {
          const emoji = (e.realizedPnl ?? 0) > 0 ? "✅" : "🛑";
          const verb = e.action === "reduce" ? "REDUCE" : e.action === "flip_close" ? "FLIP→CLOSE" : "CLOSE";
          text = `${emoji} ${verb} ${e.symbol} (${e.strategyId}, ${e.reason})\n@ ${e.price?.toFixed(6)}  realizedPnl $${e.realizedPnl?.toFixed(2)}${posAfter}`;
        }
      }
      if (text && await sendTelegram(text)) sent++;
    }
    return sent;
  }
}

export async function sendTelegram(text: string): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return false; // silently skip — not configured is a valid state
  const apiBase = (process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org").replace(/\/$/, "");
  try {
    const res = await fetch(`${apiBase}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false; // never let a notification failure affect trading
  }
}
