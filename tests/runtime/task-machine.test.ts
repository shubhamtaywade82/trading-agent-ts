import { applyTaskTransition, canTransition, readyTasks } from "../../src/runtime/task-machine.js";
import { Task } from "../../src/runtime/types.js";

function task(id: string, status: Task["status"], deps: string[] = []): Task {
  return { id, title: id, status, dependencies: deps };
}

describe("task state machine", () => {
  it("allows the documented transitions", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "completed")).toBe(true);
    expect(canTransition("running", "failed")).toBe(true);
    expect(canTransition("failed", "queued")).toBe(true);
    expect(canTransition("blocked", "running")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(canTransition("completed", "running")).toBe(false);
    expect(canTransition("cancelled", "queued")).toBe(false);
    expect(canTransition("queued", "completed")).toBe(false);
  });

  it("applyTaskTransition updates only on valid transitions", () => {
    const tasks = [task("a", "queued"), task("b", "completed")];
    const next = applyTaskTransition(tasks, "a", "running", 0.5);
    expect(next.find((t) => t.id === "a")).toMatchObject({ status: "running", progress: 0.5 });

    const unchanged = applyTaskTransition(next, "b", "running");
    expect(unchanged).toBe(next);
  });

  it("applyTaskTransition ignores unknown tasks", () => {
    const tasks = [task("a", "queued")];
    expect(applyTaskTransition(tasks, "zzz", "running")).toBe(tasks);
  });

  it("updates progress without a status change", () => {
    const tasks = [task("a", "running")];
    const next = applyTaskTransition(tasks, "a", "running", 0.9);
    expect(next[0].progress).toBe(0.9);
  });

  it("readyTasks returns queued/blocked tasks whose deps completed", () => {
    const tasks = [
      task("a", "completed"),
      task("b", "queued", ["a"]),
      task("c", "queued", ["b"]),
      task("d", "blocked", ["a"]),
    ];
    expect(readyTasks(tasks).map((t) => t.id)).toEqual(["b", "d"]);
  });
});
