/**
 * Task state machine. Transitions outside this table are rejected so the
 * task graph can never drift into an inconsistent shape.
 */

import { Task, TaskStatus } from "./types.js";

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["running", "blocked", "cancelled"],
  blocked: ["queued", "running", "cancelled"],
  running: ["completed", "failed", "blocked", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Apply a status change to one task in a graph. Invalid transitions are
 * ignored (the graph is returned unchanged) rather than thrown, because
 * events can arrive late or duplicated from concurrent actors.
 */
export function applyTaskTransition(tasks: Task[], taskId: string, status: TaskStatus, progress?: number): Task[] {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return tasks;
  const statusChanges = task.status !== status;
  if (statusChanges && !canTransition(task.status, status)) return tasks;
  if (!statusChanges && progress === undefined) return tasks;
  return tasks.map((t) => (t.id === taskId ? { ...t, status, progress: progress ?? t.progress } : t));
}

/** Tasks whose dependencies are all completed and are ready to run. */
export function readyTasks(tasks: Task[]): Task[] {
  const done = new Set(tasks.filter((t) => t.status === "completed").map((t) => t.id));
  return tasks.filter(
    (t) => (t.status === "queued" || t.status === "blocked") && t.dependencies.every((d) => done.has(d)),
  );
}
