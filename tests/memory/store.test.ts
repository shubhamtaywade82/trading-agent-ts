import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/memory/store.js";

describe("MemoryStore", () => {
  it("persists and retrieves recent messages in chronological order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-"));
    const store = new MemoryStore(join(dir, "devagent.db"));

    store.appendMessage("user", "first");
    store.appendMessage("assistant", "second");

    const messages = store.recentMessages(10);

    expect(messages.map((m) => m.content)).toEqual(["first", "second"]);
    store.close();
  });

  it("caps recentMessages to the requested limit, keeping the newest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-"));
    const store = new MemoryStore(join(dir, "devagent.db"));

    for (let i = 0; i < 5; i++) store.appendMessage("user", `msg-${i}`);

    const messages = store.recentMessages(2);

    expect(messages.map((m) => m.content)).toEqual(["msg-3", "msg-4"]);
    store.close();
  });

  it("stores and overwrites project notes by key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-"));
    const store = new MemoryStore(join(dir, "devagent.db"));

    store.setProjectNote("style", "2-space indent");
    store.setProjectNote("style", "4-space indent");

    expect(store.getProjectNote("style")).toBe("4-space indent");
    expect(store.getProjectNote("missing")).toBeUndefined();
    store.close();
  });

  it("survives reopening the same db file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-"));
    const path = join(dir, "devagent.db");
    const store1 = new MemoryStore(path);
    store1.appendMessage("user", "persisted");
    store1.close();

    const store2 = new MemoryStore(path);
    expect(store2.recentMessages(10).map((m) => m.content)).toEqual(["persisted"]);
    store2.close();
  });

  it("recordSkillUse inserts then increments use/success counts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-"));
    const store = new MemoryStore(join(dir, "devagent.db"));

    store.recordSkillUse("rails-api", true);
    expect(store.getSkillUsage("rails-api")).toMatchObject({ skillId: "rails-api", useCount: 1, successCount: 1 });

    store.recordSkillUse("rails-api", false);
    expect(store.getSkillUsage("rails-api")).toMatchObject({ useCount: 2, successCount: 1 });

    expect(store.getSkillUsage("never-used")).toBeUndefined();
    store.close();
  });

  it("allSkillUsage round-trips every recorded skill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-"));
    const store = new MemoryStore(join(dir, "devagent.db"));

    store.recordSkillUse("a", true);
    store.recordSkillUse("b", false);

    const all = store.allSkillUsage().sort((x, y) => x.skillId.localeCompare(y.skillId));
    expect(all).toMatchObject([
      { skillId: "a", useCount: 1, successCount: 1 },
      { skillId: "b", useCount: 1, successCount: 0 },
    ]);
    store.close();
  });

  it("stores and retrieves learnings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-"));
    const store = new MemoryStore(join(dir, "devagent.db"));

    store.addLearning("error_fix", "failing compilation", "use ES2022 target in tsconfig");
    store.addLearning("user_preference", "rspec tests", "always run bin/rspec");

    const learnings = store.getLearnings();
    expect(learnings).toHaveLength(2);
    expect(learnings[0]).toMatchObject({
      category: "user_preference",
      context: "rspec tests",
      lesson: "always run bin/rspec",
    });
    expect(learnings[1]).toMatchObject({
      category: "error_fix",
      context: "failing compilation",
      lesson: "use ES2022 target in tsconfig",
    });
    store.close();
  });
});
