export type StepStatus =
  | "pending"
  | "analyzing"
  | "planning"
  | "implementing"
  | "testing"
  | "reviewing"
  | "completed"
  | "failed"
  | "skipped"
  | "blocked"
  | "paused"
  | "cancelled"
  | "rejected"
  | "rolledback"
  | "running"; // running kept for compatibility if needed

export interface PlanStep {
  id: string;
  description: string;
  status: StepStatus;
  dependencies: string[];
  rollbackCommand?: string;
  retryCount: number;
  priority?: "low" | "medium" | "high" | "critical";
}

export type StepOutcome =
  | { kind: "success"; output: Record<string, unknown> }
  | { kind: "retryable"; error: string }
  | { kind: "blocking"; error: string };

export interface StepRunner {
  run(step: PlanStep): Promise<StepOutcome>;
}

export interface HistoryEntry {
  stepId: string;
  outcome: StepOutcome;
  at: number;
}

export interface Planner {
  replan(remaining: PlanStep[], history: HistoryEntry[]): Promise<PlanStep[]>;
}
