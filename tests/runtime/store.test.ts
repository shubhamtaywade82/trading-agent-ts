import { EventBus } from "../../src/runtime/events.js";
import { initialRuntimeState, reduce, sanitizeText, Store } from "../../src/runtime/store.js";
import { RuntimeState } from "../../src/runtime/types.js";

function fresh(): RuntimeState {
  return initialRuntimeState({ workspace: "devagent", branch: "main", model: "qwen3:30b" });
}

describe("sanitizeText", () => {
  it("strips ANSI escape sequences and control chars", () => {
    expect(sanitizeText("a\x1b[31mred\x1b[0mb")).toBe("aredb");
    expect(sanitizeText("t\x1b]0;title\x07x")).toBe("tx");
    expect(sanitizeText("keep\nnewline\tand tab\rno-cr")).toBe("keep\nnewline\tand tabno-cr");
  });
});

describe("store reducer", () => {
  it("appends conversation messages and streams chunks into one entry", () => {
    let s = fresh();
    s = reduce(s, { type: "conversation.message", role: "user", text: "hi" });
    s = reduce(s, { type: "conversation.chunk", role: "assistant", chunk: "he" });
    s = reduce(s, { type: "conversation.chunk", role: "assistant", chunk: "llo" });
    expect(s.conversation).toHaveLength(2);
    expect(s.conversation[1]).toMatchObject({ kind: "text", role: "assistant", text: "hello" });
    expect(s.actors.conversation.health).toBe("active");
  });

  it("clears conversation", () => {
    let s = fresh();
    s = reduce(s, { type: "conversation.message", role: "user", text: "hi" });
    s = reduce(s, { type: "conversation.clear" });
    expect(s.conversation).toHaveLength(0);
  });

  it("tracks tool lifecycle and executor actor health", () => {
    let s = fresh();
    s = reduce(s, { type: "tool.started", id: "t1", name: "edit_file", args: { path: "a.ts" } });
    expect(s.execution.activeTool).toBe("edit_file");
    expect(s.actors.executor).toMatchObject({ health: "active", detail: "▶" });

    s = reduce(s, { type: "tool.completed", id: "t1", result: { ok: true } });
    expect(s.toolCalls[0]).toMatchObject({ status: "completed", result: { ok: true } });
    expect(s.execution.activeTool).toBeNull();
    expect(s.actors.executor).toMatchObject({ health: "healthy", detail: "✓" });
  });

  it("marks executor errored on tool failure", () => {
    let s = fresh();
    s = reduce(s, { type: "tool.started", id: "t1", name: "run_shell", args: {} });
    s = reduce(s, { type: "tool.failed", id: "t1", error: "exit 1" });
    expect(s.toolCalls[0]).toMatchObject({ status: "failed", error: "exit 1" });
    expect(s.actors.executor.health).toBe("error");
  });

  it("surfaces a top-level error as a visible notification, not just the executor glyph (regression: message was previously silent)", () => {
    let s = fresh();
    s = reduce(s, { type: "error", message: "Ollama local 400: model does not support tools" });
    expect(s.lastError).toBe("Ollama local 400: model does not support tools");
    expect(s.actors.executor).toMatchObject({ health: "error", detail: "✗" });
    expect(s.notifications[s.notifications.length - 1]).toMatchObject({
      kind: "error",
      text: "Ollama local 400: model does not support tools",
    });
  });

  it("applies task graph updates through the state machine", () => {
    let s = fresh();
    s = reduce(s, { type: "task.created", task: { id: "a", title: "A", status: "queued", dependencies: [] } });
    expect(s.actors.tasks.detail).toBe("1");
    s = reduce(s, { type: "task.progress", taskId: "a", status: "running", progress: 0.4 });
    expect(s.tasks[0]).toMatchObject({ status: "running", progress: 0.4 });
    s = reduce(s, { type: "task.progress", taskId: "a", status: "completed" });
    expect(s.actors.tasks.detail).toBe("✓");
    // invalid transition ignored
    const after = reduce(s, { type: "task.progress", taskId: "a", status: "running" });
    expect(after.tasks[0].status).toBe("completed");
  });

  it("updates git state and actor detail", () => {
    let s = fresh();
    s = reduce(s, {
      type: "git.changed",
      git: {
        branch: "main",
        ahead: 1,
        behind: 0,
        files: [
          { path: "a.ts", status: "modified", staged: false },
          { path: "b.ts", status: "added", staged: true },
        ],
      },
    });
    expect(s.actors.git).toMatchObject({ health: "waiting", detail: "2" });
  });

  it("appends sanitized logs and counts them", () => {
    let s = fresh();
    s = reduce(s, { type: "logs.appended", level: "info", source: "shell", message: "\x1b[32mok\x1b[0m" });
    expect(s.logs[0].message).toBe("ok");
    expect(s.actors.logs.detail).toBe("1");
  });

  it("handles approval request/resolve as a mode change", () => {
    let s = fresh();
    s = reduce(s, {
      type: "approval.requested",
      request: { id: "ap1", title: "Apply patch", summary: "3 files", filesChanged: 3, additions: 10, deletions: 2 },
    });
    expect(s.mode).toBe("approval");
    expect(s.actors.executor.health).toBe("waiting");
    s = reduce(s, { type: "approval.resolved", id: "ap1", approved: true });
    expect(s.approval).toBeNull();
    expect(s.mode).toBe("idle");
  });

  it("ignores approval.resolved for a stale id", () => {
    let s = fresh();
    s = reduce(s, {
      type: "approval.requested",
      request: { id: "ap1", title: "x", summary: "", filesChanged: 1, additions: 1, deletions: 0 },
    });
    const after = reduce(s, { type: "approval.resolved", id: "other", approved: true });
    expect(after.approval).not.toBeNull();
  });

  it("tracks model streaming and context", () => {
    let s = fresh();
    s = reduce(s, { type: "model.streaming", streaming: true, tokensPerSecond: 81 });
    expect(s.model).toMatchObject({ streaming: true, tokensPerSecond: 81 });
    expect(s.actors.models.health).toBe("thinking");
    s = reduce(s, { type: "context.changed", used: 48000, limit: 71000 });
    expect(s.model.contextUsed).toBe(48000);
  });

  it("bounds the log buffer", () => {
    let s = fresh();
    for (let i = 0; i < 600; i++) {
      s = reduce(s, { type: "logs.appended", level: "debug", source: "t", message: `m${i}` });
    }
    expect(s.logs.length).toBe(500);
    expect(s.logs[s.logs.length - 1].message).toBe("m599");
  });

  describe("skills.changed", () => {
    it("marks the actor muted with no skills at all", () => {
      const s = reduce(fresh(), { type: "skills.changed", skills: [] });
      expect(s.actors.skills).toMatchObject({ health: "muted", detail: "✓" });
      expect(s.skills).toEqual([]);
    });

    it("marks the actor healthy when skills exist but none are active", () => {
      const s = reduce(fresh(), {
        type: "skills.changed",
        skills: [{ id: "a", name: "A", tags: [], active: false }],
      });
      expect(s.actors.skills).toMatchObject({ health: "healthy", detail: "✓" });
    });

    it("marks the actor active and counts active skills", () => {
      const s = reduce(fresh(), {
        type: "skills.changed",
        skills: [
          { id: "a", name: "A", tags: [], active: true },
          { id: "b", name: "B", tags: [], active: false },
          { id: "c", name: "C", tags: [], active: true },
        ],
      });
      expect(s.actors.skills).toMatchObject({ health: "active", detail: "2" });
      expect(s.skills).toHaveLength(3);
    });
  });
});

describe("Store", () => {
  it("notifies subscribers on change and supports bus attachment", () => {
    const store = new Store(fresh());
    const bus = new EventBus();
    store.attach(bus);
    const seen: string[] = [];
    store.subscribe((s) => seen.push(s.status));
    bus.publish({ type: "status.changed", status: "working" });
    expect(seen).toEqual(["working"]);
    expect(store.getState().status).toBe("working");
  });

  it("does not notify when an event is a no-op", () => {
    const store = new Store(fresh());
    let calls = 0;
    store.subscribe(() => calls++);
    store.apply({ type: "approval.resolved", id: "nope", approved: false });
    expect(calls).toBe(0);
  });
});

describe("rails.index event", () => {
  it("stores rails index state", () => {
    let s = fresh();
    s = reduce(s, {
      type: "rails.index",
      status: "ready",
      entityCount: 42,
      edgeCount: 17,
      scannerErrors: ["model: boom"],
    });
    expect(s.rails).toEqual({ status: "ready", entityCount: 42, edgeCount: 17, scannerErrors: ["model: boom"] });
  });

  it("defaults missing counts to zero", () => {
    let s = fresh();
    s = reduce(s, { type: "rails.index", status: "building" });
    expect(s.rails).toEqual({ status: "building", entityCount: 0, edgeCount: 0, scannerErrors: [] });
  });
});
