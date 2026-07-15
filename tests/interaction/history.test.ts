import { HistoryManager } from "../../src/interaction/history.js";

describe("HistoryManager", () => {
  it("navigates up through history and back down to the draft", () => {
    const h = new HistoryManager(["first", "second"]);
    expect(h.up("draft")).toBe("second");
    expect(h.up("second")).toBe("first");
    expect(h.up("first")).toBe("first"); // clamped at oldest
    expect(h.down("first")).toBe("second");
    expect(h.down("second")).toBe("draft"); // restores draft
    expect(h.down("draft")).toBe("draft");
  });

  it("deduplicates entries, keeping the newest position", () => {
    const h = new HistoryManager();
    h.add("a");
    h.add("b");
    h.add("a");
    expect(h.all()).toEqual(["b", "a"]);
  });

  it("ignores blank entries", () => {
    const h = new HistoryManager();
    h.add("   ");
    expect(h.all()).toEqual([]);
  });

  it("caps history at max entries", () => {
    const h = new HistoryManager([], 3);
    for (const x of ["1", "2", "3", "4"]) h.add(x);
    expect(h.all()).toEqual(["2", "3", "4"]);
  });

  it("search finds the newest entry containing all terms", () => {
    const h = new HistoryManager(["review auth", "create tests", "fix docker auth"]);
    expect(h.search("auth")).toBe("fix docker auth");
    expect(h.search("review auth")).toBe("review auth");
    expect(h.search("zzz")).toBeNull();
  });
});
