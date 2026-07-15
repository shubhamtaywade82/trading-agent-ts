import { LoopDetector } from "../../src/orchestrator/loop-detector.js";

describe("LoopDetector", () => {
  it("does not flag the first occurrence of a signature", () => {
    const detector = new LoopDetector();
    expect(detector.record("run_shell", { command: "ls" }, "ENOENT")).toBe(false);
  });

  it("allows two consecutive identical signature+errors", () => {
    const detector = new LoopDetector();
    expect(detector.record("run_shell", { command: "ls" }, "ENOENT")).toBe(false);
    expect(detector.record("run_shell", { command: "ls" }, "ENOENT")).toBe(false);
  });

  it("flags the third consecutive identical signature+error", () => {
    const detector = new LoopDetector();
    expect(detector.record("run_shell", { command: "ls" }, "ENOENT")).toBe(false);
    expect(detector.record("run_shell", { command: "ls" }, "ENOENT")).toBe(false);
    expect(detector.record("run_shell", { command: "ls" }, "ENOENT")).toBe(true);
  });

  it("does not flag when the arguments differ", () => {
    const detector = new LoopDetector();
    detector.record("run_shell", { command: "ls" }, "ENOENT");
    expect(detector.record("run_shell", { command: "pwd" }, "ENOENT")).toBe(false);
  });

  it("resets the count after an explicit reset", () => {
    const detector = new LoopDetector();
    detector.record("run_shell", { command: "ls" }, "ENOENT");
    detector.reset();
    expect(detector.record("run_shell", { command: "ls" }, "ENOENT")).toBe(false);
  });

  it("is insensitive to key order in the arguments object", () => {
    const detector = new LoopDetector();
    detector.record("write_file", { path: "a.txt", content: "x" }, "EACCES");
    detector.record("write_file", { content: "x", path: "a.txt" }, "EACCES");
    expect(detector.record("write_file", { content: "x", path: "a.txt" }, "EACCES")).toBe(true);
  });
});
