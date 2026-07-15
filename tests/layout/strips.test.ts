import { activityStripTokens, contextStripTokens, headerTokens } from "../../src/layout/strips.js";
import { initialRuntimeState, reduce } from "../../src/runtime/store.js";
import { RuntimeState } from "../../src/runtime/types.js";

function fresh(): RuntimeState {
  return initialRuntimeState({ workspace: "ollama-agent", branch: "main", model: "qwen3:30b" });
}

describe("activityStripTokens", () => {
  it("emits one token per actor in the plan's format", () => {
    let s = fresh();
    s = reduce(s, { type: "task.created", task: { id: "a", title: "A", status: "queued", dependencies: [] } });
    s = reduce(s, { type: "task.created", task: { id: "b", title: "B", status: "queued", dependencies: [] } });
    s = reduce(s, { type: "task.created", task: { id: "c", title: "C", status: "queued", dependencies: [] } });
    s = reduce(s, { type: "tool.started", id: "t1", name: "edit_file", args: {} });
    const texts = activityStripTokens(s).map((t) => t.text);
    expect(texts).toContain("Tasks3");
    expect(texts).toContain("Exec▶");
  });

  it("errored actors get top priority so they never drop out", () => {
    let s = fresh();
    s = reduce(s, { type: "tool.started", id: "t1", name: "x", args: {} });
    s = reduce(s, { type: "tool.failed", id: "t1", error: "boom" });
    const exec = activityStripTokens(s).find((t) => t.text.startsWith("Exec"));
    expect(exec).toMatchObject({ priority: 0, color: "red" });
  });

  it("includes token usage when a context limit is known", () => {
    let s = fresh();
    s = reduce(s, { type: "context.changed", used: 48000, limit: 71000 });
    const texts = activityStripTokens(s).map((t) => t.text);
    expect(texts).toContain("Tok48k/71k");
  });

  it("shows a skills token once a skill is active", () => {
    let s = fresh();
    s = reduce(s, {
      type: "skills.changed",
      skills: [{ id: "a", name: "A", tags: [], active: true }],
    });
    const texts = activityStripTokens(s).map((t) => t.text);
    expect(texts).toContain("Skl1");
  });
});

describe("contextStripTokens", () => {
  it("idle mode shows the NORMAL strip", () => {
    const texts = contextStripTokens(fresh()).map((t) => t.text);
    expect(texts).toEqual(["Mode:Code", "Model:qwen3:30b", "Workspace:ollama-agent", "Ctrl+P Palette"]);
  });

  it("streaming mode shows generation state", () => {
    let s = fresh();
    s = reduce(s, { type: "mode.changed", mode: "streaming" });
    s = reduce(s, { type: "model.streaming", streaming: true, tokensPerSecond: 81 });
    const texts = contextStripTokens(s).map((t) => t.text);
    expect(texts[0]).toBe("Generating...");
    expect(texts).toContain("81 tok/s");
    expect(texts).toContain("Ctrl+C Stop Generation");
  });

  it("approval mode shows the approval hints", () => {
    let s = fresh();
    s = reduce(s, {
      type: "approval.requested",
      request: { id: "1", title: "t", summary: "s", filesChanged: 3, additions: 128, deletions: 4 },
    });
    const texts = contextStripTokens(s).map((t) => t.text);
    expect(texts[0]).toBe("Waiting for approval");
    expect(texts).toContain("3 files +128 -4");
    expect(texts).toContain("Enter Approve");
  });

  it("git view gets a view-specific strip while idle", () => {
    let s = fresh();
    s = reduce(s, {
      type: "git.changed",
      git: { branch: "main", ahead: 2, behind: 0, files: [{ path: "a.ts", status: "modified", staged: false }] },
    });
    const texts = contextStripTokens(s, "git").map((t) => t.text);
    expect(texts).toEqual(["Branch:main", "Modified:1", "Ahead:2", "Behind:0"]);
  });

  it("logs view gets level counts while idle", () => {
    let s = fresh();
    s = reduce(s, { type: "logs.appended", level: "info", source: "t", message: "a" });
    s = reduce(s, { type: "logs.appended", level: "error", source: "t", message: "b" });
    const texts = contextStripTokens(s, "logs").map((t) => t.text);
    expect(texts).toContain("INFO:1");
    expect(texts).toContain("ERROR:1");
  });

  it("mode strips override view strips (planning wins over git view)", () => {
    let s = fresh();
    s = reduce(s, { type: "mode.changed", mode: "planning" });
    const texts = contextStripTokens(s, "git").map((t) => t.text);
    expect(texts[0]).toBe("Planning");
  });
});

describe("headerTokens", () => {
  it("shows product, model, workspace, branch, mode, and clock", () => {
    const now = new Date(2026, 0, 1, 10, 42, 11).getTime();
    const texts = headerTokens(fresh(), now).map((t) => t.text);
    expect(texts).toEqual(["DevAgent", "ollama-agent", "qwen3:30b", "⎇ main", "Code", "IDLE", "10:42"]);
  });
});
