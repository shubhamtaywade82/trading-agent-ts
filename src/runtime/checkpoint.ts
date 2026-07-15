import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PlanStep, HistoryEntry, StepStatus } from "../orchestrator/types.js";

export interface CheckpointData {
  steps: PlanStep[];
  history: HistoryEntry[];
  replanCount: number;
  updatedAt: number;
}

// Non-terminal statuses can't be trusted after a crash — the step may or may
// not have finished the work it was doing when the process died. Reset them
// to "pending" so the orchestrator retries them; "completed" steps are kept
// so a resumed run doesn't redo finished work.
const TRUSTED_ON_RESUME: ReadonlySet<StepStatus> = new Set(["completed", "cancelled", "rolledback"]);

export function sanitizeResumedSteps(steps: PlanStep[]): PlanStep[] {
  return steps.map((step) => (TRUSTED_ON_RESUME.has(step.status) ? step : { ...step, status: "pending" }));
}

export class CheckpointStore {
  constructor(private readonly path: string) {}

  save(data: Omit<CheckpointData, "updatedAt">): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const full: CheckpointData = { ...data, updatedAt: Date.now() };
    // Atomic write: a crash mid-write leaves the old checkpoint intact instead
    // of a half-written, unparseable JSON file.
    const tmpPath = `${this.path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(full, null, 2));
    renameSync(tmpPath, this.path);
  }

  load(): CheckpointData | null {
    if (!existsSync(this.path)) return null;
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as CheckpointData;
    } catch {
      return null;
    }
  }

  clear(): void {
    if (existsSync(this.path)) unlinkSync(this.path);
  }
}
