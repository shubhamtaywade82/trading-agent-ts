import { EventEmitter } from "node:events";
import { jest } from "@jest/globals";

// jest.mock's auto-hoisting doesn't apply to real ESM — mock explicitly and
// import both the mock and the module under test dynamically, after the
// mock is registered (see https://jestjs.io/docs/ecmascript-modules).
jest.unstable_mockModule("node:child_process", () => ({ spawn: jest.fn() }));

const { spawn } = await import("node:child_process");
const { RunRSpecTool } = await import("../../src/tools/rspec-tool.js");

const mockSpawn = spawn as jest.Mock;

interface FakeProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function fakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

afterEach(() => {
  mockSpawn.mockReset();
});

describe("RunRSpecTool", () => {
  it("reports passing tests", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const tool = new RunRSpecTool("/tmp/ws");
    const promise = tool.call({});

    proc.stdout.emit(
      "data",
      Buffer.from(
        [
          "User",
          "  validates name",
          "  validates email",
          "",
          "Finished in 0.42 seconds",
          "2 examples, 0 failures",
        ].join("\n"),
      ),
    );
    proc.stderr.emit("data", Buffer.from(""));
    proc.emit("close", 0);

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.examples).toBe(2);
    expect(result.failures).toBe(0);
    expect(result.duration).toBe(0.42);
  });

  it("reports failing tests with counts", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const tool = new RunRSpecTool("/tmp/ws");
    const promise = tool.call({});

    proc.stdout.emit(
      "data",
      Buffer.from(
        [
          "User",
          "  validates name (FAILED - 1)",
          "",
          "Finished in 0.15 seconds",
          "1 example, 1 failure",
        ].join("\n"),
      ),
    );
    proc.stderr.emit("data", Buffer.from(""));
    proc.emit("close", 1);

    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.examples).toBe(1);
    expect(result.failures).toBe(1);
  });

  it("reports pending tests", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const tool = new RunRSpecTool("/tmp/ws");
    const promise = tool.call({});

    proc.stdout.emit(
      "data",
      Buffer.from(
        [
          "Finished in 0.01 seconds",
          "5 examples, 1 failure, 2 pending",
        ].join("\n"),
      ),
    );
    proc.stderr.emit("data", Buffer.from(""));
    proc.emit("close", 1);

    const result = await promise;
    expect(result.examples).toBe(5);
    expect(result.failures).toBe(1);
    expect(result.pending).toBe(2);
  });

  it("includes target path when passed", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const tool = new RunRSpecTool("/tmp/ws");
    const promise = tool.call({ path: "spec/models/user_spec.rb" });

    proc.stdout.emit("data", Buffer.from(""));
    proc.stderr.emit("data", Buffer.from(""));
    proc.emit("close", 0);

    const result = await promise;
    expect(result.command).toContain("spec/models/user_spec.rb");
  });

  it("appends line number when provided", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const tool = new RunRSpecTool("/tmp/ws");
    const promise = tool.call({ path: "spec/models/user_spec.rb", line: 42 });

    proc.stdout.emit("data", Buffer.from(""));
    proc.stderr.emit("data", Buffer.from(""));
    proc.emit("close", 0);

    const result = await promise;
    expect(result.command).toContain("spec/models/user_spec.rb:42");
  });

  it("supports format parameter", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const tool = new RunRSpecTool("/tmp/ws");
    const promise = tool.call({ format: "json" });

    proc.stdout.emit("data", Buffer.from("{}"));
    proc.stderr.emit("data", Buffer.from(""));
    proc.emit("close", 0);

    const result = await promise;
    expect(result.command).toContain("--format json");
  });

  it("returns error on spawn failure", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const tool = new RunRSpecTool("/tmp/ws");
    const promise = tool.call({});

    proc.emit("error", new Error("bundle not found"));

    const result = await promise;
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("bundle not found");
  });

  it("exposes metadata", () => {
    const tool = new RunRSpecTool("/tmp/ws");
    expect(tool.name).toBe("run_rspec");
    expect(tool.description).toContain("RSpec");
    expect(tool.parameters).toBeDefined();
  });
});
