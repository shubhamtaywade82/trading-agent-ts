import { searchItems } from "../../src/interaction/search.js";
import { builtinCommands } from "../../src/interaction/slash-commands.js";
import { initialRuntimeState, reduce } from "../../src/runtime/store.js";

describe("searchItems", () => {
  it("indexes every source and routes to the owning view", () => {
    let s = initialRuntimeState({ workspace: "w", model: "m" });
    s = reduce(s, { type: "conversation.message", role: "user", text: "review auth middleware" });
    s = reduce(s, { type: "logs.appended", level: "error", source: "shell", message: "exit code 1" });
    s = reduce(s, { type: "memory.updated", items: [{ key: "style", value: "prefer functional", kind: "style" }] });
    s = reduce(s, {
      type: "task.created",
      task: { id: "t1", title: "Fix docker build", status: "queued", dependencies: [] },
    });
    s = reduce(s, { type: "tool.started", id: "tc1", name: "edit_file", args: {} });
    s = reduce(s, {
      type: "git.changed",
      git: { branch: "main", ahead: 0, behind: 0, files: [{ path: "src/auth.ts", status: "modified", staged: false }] },
    });

    const items = searchItems(s, builtinCommands());
    const byView = (view: string) => items.filter((i) => i.view === view);

    expect(byView("conversation").some((i) => i.label.includes("review auth"))).toBe(true);
    expect(byView("logs").some((i) => i.label.includes("exit code 1"))).toBe(true);
    expect(byView("memory").some((i) => i.label.includes("style"))).toBe(true);
    expect(byView("tasks").some((i) => i.label.includes("Fix docker build"))).toBe(true);
    expect(byView("execution").some((i) => i.label === "edit_file")).toBe(true);
    expect(byView("git").some((i) => i.label === "src/auth.ts")).toBe(true);
    expect(items.some((i) => i.label === "/help")).toBe(true);
  });

  it("truncates long first lines", () => {
    let s = initialRuntimeState();
    s = reduce(s, { type: "conversation.message", role: "user", text: "x".repeat(200) });
    const item = searchItems(s, builtinCommands()).find((i) => i.id === "chat:0")!;
    expect(item.label.length).toBeLessThanOrEqual(80);
    expect(item.label.endsWith("…")).toBe(true);
  });
});
