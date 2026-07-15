import { EditTracker } from "../../src/tui/edit-tracker.js";

describe("EditTracker", () => {
  it("returns an empty diff (all context) when content is unchanged", () => {
    const tracker = new EditTracker();
    tracker.snapshot("a.ts", "line1\nline2\n");

    const result = tracker.diff("a.ts", "line1\nline2\n");

    expect(result.every((l) => l.type === "context")).toBe(true);
  });

  it("marks added and removed lines when content changes", () => {
    const tracker = new EditTracker();
    tracker.snapshot("a.ts", "line1\nline2\n");

    const result = tracker.diff("a.ts", "line1\nline2changed\n");

    expect(result.some((l) => l.type === "remove" && l.text.includes("line2"))).toBe(true);
    expect(result.some((l) => l.type === "add" && l.text.includes("line2changed"))).toBe(true);
  });

  it("treats an untracked path as diffing against empty content", () => {
    const tracker = new EditTracker();

    const result = tracker.diff("new.ts", "brand new\n");

    expect(result).toEqual([{ type: "add", text: "brand new\n" }]);
  });

  it("reports whether a path has been snapshotted", () => {
    const tracker = new EditTracker();
    expect(tracker.hasSnapshot("a.ts")).toBe(false);

    tracker.snapshot("a.ts", "x");
    expect(tracker.hasSnapshot("a.ts")).toBe(true);
  });
});
