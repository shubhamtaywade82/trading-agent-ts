import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ChatMessage } from "../provider/provider.js";

/** Persists the LLM conversation transcript so a killed/restarted session can
 * pick back up with the model still remembering prior turns, mirroring the
 * plan-level CheckpointStore (src/runtime/checkpoint.ts) — same atomic-write
 * shape, opt-in resume rather than silent auto-load. */
export class SessionStore {
  constructor(private readonly path: string) {}

  save(messages: ChatMessage[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmpPath = `${this.path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(messages, null, 2));
    renameSync(tmpPath, this.path);
  }

  load(): ChatMessage[] | null {
    if (!existsSync(this.path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      return Array.isArray(parsed) ? (parsed as ChatMessage[]) : null;
    } catch {
      return null;
    }
  }

  clear(): void {
    if (existsSync(this.path)) unlinkSync(this.path);
  }
}
