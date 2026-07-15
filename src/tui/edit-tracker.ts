import { diffLines } from "diff";

export interface DiffLine {
  type: "add" | "remove" | "context";
  text: string;
}

export class EditTracker {
  private readonly snapshots = new Map<string, string>();

  snapshot(path: string, content: string): void {
    this.snapshots.set(path, content);
  }

  hasSnapshot(path: string): boolean {
    return this.snapshots.has(path);
  }

  diff(path: string, newContent: string): DiffLine[] {
    const before = this.snapshots.get(path) ?? "";
    const parts = diffLines(before, newContent);
    const lines: DiffLine[] = [];
    for (const part of parts) {
      const type: DiffLine["type"] = part.added ? "add" : part.removed ? "remove" : "context";
      lines.push({ type, text: part.value });
    }
    return lines;
  }
}
