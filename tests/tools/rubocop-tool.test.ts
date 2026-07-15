import { EventEmitter } from "node:events";
import { jest } from "@jest/globals";

jest.unstable_mockModule("node:child_process", () => ({ spawn: jest.fn() }));

const { spawn } = await import("node:child_process");
const { RunRubocopTool } = await import("../../src/tools/rubocop-tool.js");

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

describe("RunRubocopTool", () => {
  it("reports zero offenses for clean output", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const tool = new RunRubocopTool("/tmp/ws");
    const promise = tool.call({});

    proc.stdout.emit("data", Buffer.from(""));
    proc.stderr.emit("data", Buffer.from(""));
    proc.emit("close", 0);

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.offenseCount).toMatchObject({ total: 0, corrected: 0 });
  });

  it("parses offense counts from rubocop output", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const tool = new RunRubocopTool("/tmp/ws");
    const promise = tool.call({});

    proc.stdout.emit(
      "data",
      Buffer.from(
        [
          "app/models/user.rb:5:8: C: Style/StringLiterals: Prefer single-quoted strings when you don't need string interpolation or special symbols.",
          '  name = "foo"',
          "         ^^^^^^",
          "",
          "3 files inspected, 2 offenses detected, 1 offense corrected",
        ].join("\n"),
      ),
    );
    proc.stderr.emit("data", Buffer.from(""));
    proc.emit("close", 1);

    const result = await promise;
    expect(result.offenseCount).toMatchObject({ total: 2, corrected: 1 });
    expect(result.exitCode).toBe(1);
  });

  it("includes autoCorrect flag when passed", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const tool = new RunRubocopTool("/tmp/ws");
    const promise = tool.call({ autoCorrect: true });

    proc.stdout.emit("data", Buffer.from(""));
    proc.stderr.emit("data", Buffer.from(""));
    proc.emit("close", 0);

    const result = await promise;
    expect(result.command).toContain("--auto-correct");
  });

  it("includes target path when passed", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const tool = new RunRubocopTool("/tmp/ws");
    const promise = tool.call({ path: "app/models/user.rb" });

    proc.stdout.emit("data", Buffer.from(""));
    proc.stderr.emit("data", Buffer.from(""));
    proc.emit("close", 0);

    const result = await promise;
    expect(result.command).toContain("app/models/user.rb");
  });

  it("returns error on spawn failure", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const tool = new RunRubocopTool("/tmp/ws");
    const promise = tool.call({});

    proc.emit("error", new Error("bundle not found"));

    const result = await promise;
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("bundle not found");
  });

  it("exposes metadata", () => {
    const tool = new RunRubocopTool("/tmp/ws");
    expect(tool.name).toBe("run_rubocop");
    expect(tool.description).toContain("RuboCop");
    expect(tool.parameters).toBeDefined();
  });
});
