import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { Fill, OrderIntent, Signal } from "../domain/types.js";

export interface JournalEntry {
  ts: number;
  state: string;
  signal?: Signal;
  intent?: OrderIntent;
  fill?: Fill;
}

export class TradeJournal {
  constructor(private readonly filePath = "logs/journal.jsonl") {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  append(entry: JournalEntry): void {
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
  }
}
