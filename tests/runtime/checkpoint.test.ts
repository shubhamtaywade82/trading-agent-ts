import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CheckpointStore, sanitizeResumedSteps } from "../../src/runtime/checkpoint.js";
import { PlanStep } from "../../src/orchestrator/types.js";

function makeStep(id: string, status: PlanStep["status"]): PlanStep {
  return { id, description: id, status, dependencies: [], retryCount: 0 };
}

describe("CheckpointStore", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "checkpoint-test-"));
    path = join(dir, "checkpoint.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("load returns null when no checkpoint file exists", () => {
    const store = new CheckpointStore(path);
    expect(store.load()).toBeNull();
  });

  it("saves and loads a checkpoint, stamping updatedAt", () => {
    const store = new CheckpointStore(path);
    store.save({ steps: [makeStep("a", "completed")], history: [], replanCount: 1 });

    const loaded = store.load();
    expect(loaded?.steps).toEqual([makeStep("a", "completed")]);
    expect(loaded?.replanCount).toBe(1);
    expect(typeof loaded?.updatedAt).toBe("number");
  });

  it("creates the parent directory if missing", () => {
    const nestedPath = join(dir, "nested", "checkpoint.json");
    const store = new CheckpointStore(nestedPath);
    store.save({ steps: [], history: [], replanCount: 0 });
    expect(existsSync(nestedPath)).toBe(true);
  });

  it("does not leave a .tmp file behind after a save", () => {
    const store = new CheckpointStore(path);
    store.save({ steps: [], history: [], replanCount: 0 });
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it("overwrites the previous checkpoint on repeated saves", () => {
    const store = new CheckpointStore(path);
    store.save({ steps: [makeStep("a", "pending")], history: [], replanCount: 0 });
    store.save({ steps: [makeStep("a", "completed")], history: [], replanCount: 0 });

    expect(store.load()?.steps[0].status).toBe("completed");
  });

  it("clear removes the checkpoint file", () => {
    const store = new CheckpointStore(path);
    store.save({ steps: [], history: [], replanCount: 0 });
    store.clear();
    expect(store.load()).toBeNull();
  });

  it("clear is a no-op when no checkpoint exists", () => {
    const store = new CheckpointStore(path);
    expect(() => store.clear()).not.toThrow();
  });

  it("returns null instead of throwing on corrupt JSON", () => {
    const store = new CheckpointStore(path);
    store.save({ steps: [], history: [], replanCount: 0 });
    writeFileSync(path, "{not valid json");
    expect(store.load()).toBeNull();
  });

  it("survives a process kill mid-write (old checkpoint intact, no .tmp leak)", () => {
    const store = new CheckpointStore(path);
    store.save({ steps: [makeStep("a", "pending")], history: [], replanCount: 0 });
    // Simulate a crash between the tmp write and the rename: the real file
    // must still hold the last complete checkpoint.
    expect(JSON.parse(readFileSync(path, "utf8")).steps[0].status).toBe("pending");
  });
});

describe("sanitizeResumedSteps", () => {
  it("resets non-terminal statuses to pending", () => {
    const steps = [
      makeStep("a", "analyzing"),
      makeStep("b", "implementing"),
      makeStep("c", "reviewing"),
      makeStep("d", "failed"),
      makeStep("e", "skipped"),
      makeStep("f", "blocked"),
      makeStep("g", "running"),
    ];
    const sanitized = sanitizeResumedSteps(steps);
    expect(sanitized.map((s) => s.status)).toEqual(["pending", "pending", "pending", "pending", "pending", "pending", "pending"]);
  });

  it("keeps completed, cancelled, and rolledback statuses as-is", () => {
    const steps = [makeStep("a", "completed"), makeStep("b", "cancelled"), makeStep("c", "rolledback")];
    expect(sanitizeResumedSteps(steps).map((s) => s.status)).toEqual(["completed", "cancelled", "rolledback"]);
  });

  it("does not mutate the input steps", () => {
    const steps = [makeStep("a", "implementing")];
    sanitizeResumedSteps(steps);
    expect(steps[0].status).toBe("implementing");
  });
});
