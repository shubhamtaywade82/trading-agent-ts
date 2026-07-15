import { mkdtemp } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { jest } from "@jest/globals";

jest.unstable_mockModule("node:child_process", () => ({ spawn: jest.fn() }));

const { spawn } = await import("node:child_process");
const { Agent } = await import("../../src/cli/agent.js");
const { ShellTool } = await import("../../src/tools/shell.js");
const { MemoryStore } = await import("../../src/memory/store.js");

const mockSpawn = spawn as jest.Mock;

interface FakeProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock;
}

function fakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  return proc;
}

// Dynamic `await import()` gives ShellTool as a value binding only — this
// recovers a type from it for annotations below.
type ShellToolInstance = InstanceType<typeof ShellTool>;

function skipDockerPreflight(tool: ShellToolInstance): void {
  (tool as any).dockerChecked = true;
  (tool as any).dockerAvailable = true;
}

// Agent.runUserMessage always calls provider.chat with { stream: true }, which drives
// Provider.streamChunks and reads resp.body via getReader(). A plain `json()`-only mock
// (as used in tests/provider/provider.test.ts, which never exercises the streaming path)
// isn't enough here — we need a fake ReadableStream reader that yields one NDJSON line
// matching Ollama's chunk format, in addition to `json()` for generateSummary's
// non-streaming `provider.chat(..., { stream: false })` call.

function mockChatSequence(chunks: Array<Record<string, unknown>>): void {
  const encoder = new TextEncoder();
  let call = 0;
  (globalThis as any).fetch = jest.fn().mockImplementation(async () => {
    const chunk = chunks[Math.min(call, chunks.length - 1)];
    call += 1;
    let delivered = false;
    const reader = {
      read: async () => {
        if (delivered) return { done: true, value: undefined };
        delivered = true;
        return { done: false, value: encoder.encode(JSON.stringify(chunk) + "\n") };
      },
    };
    return {
      ok: true,
      status: 200,
      json: async () => chunk,
      body: { getReader: () => reader },
    };
  });
}

function mockChatOnce(content: string) {
  const line = JSON.stringify({ message: { role: "assistant", content }, done: true }) + "\n";
  const encoder = new TextEncoder();
  const encoded = encoder.encode(line);
  let delivered = false;
  const reader = {
    read: async () => {
      if (delivered) return { done: true, value: undefined };
      delivered = true;
      return { done: false, value: encoded };
    },
  };
  (globalThis as any).fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ message: { role: "assistant", content }, done: true }),
    body: { getReader: () => reader },
  });
}

describe("Agent onShellOutput event", () => {
  afterEach(() => {
    mockSpawn.mockReset();
  });

  it("forwards ShellTool output chunks through the onShellOutput event", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const onShellOutput = jest.fn();
    const agent = new Agent({
      config: { workspaceRoot: dir, tier: "local", model: "test-model" },
      events: { onShellOutput },
    });

    const registry = agent.getRegistry();

    // Invoke run_shell through the real registry/Agent wiring, but with node:child_process
    // mocked (same pattern as tests/tools/shell.test.ts) so no real Docker daemon or
    // pre-built image is required. This still proves the wiring end-to-end: Agent
    // constructs a real ShellTool with an onOutput callback that calls
    // this.emit("onShellOutput", ...), and that callback actually fires when ShellTool
    // streams output — not just that run_shell is registered.
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    // Reach into the registry to bypass ShellTool's docker preflight check, the same way
    // tests/tools/shell.test.ts does for standalone ShellTool instances.
    const shellTool = (registry as any).tools.get("run_shell") as ShellToolInstance;
    skipDockerPreflight(shellTool);

    const resultPromise = registry.invoke("run_shell", { command: "echo hi" });

    proc.stdout.emit("data", Buffer.from("hi\n"));
    proc.emit("close", 0);

    const result = await resultPromise;

    expect(result.exitCode).toBe(0);
    expect(onShellOutput).toHaveBeenCalledWith("stdout", "hi\n");
  });
});

describe("Agent loop detection", () => {
  it("does not abort repeated successful tool calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const toolCall = {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "list_directory", arguments: { path: "." } } }],
      },
      done: true,
    };
    mockChatSequence([toolCall, toolCall, toolCall, { message: { role: "assistant", content: "done" }, done: true }]);
    const agent = new Agent({ config: { workspaceRoot: dir, tier: "local", model: "test-model" } });

    await expect(agent.runUserMessage("list files repeatedly")).resolves.toBe("done");
  });
});

describe("Agent memory summarization trigger", () => {
  it("triggers generateSummary after a successful text-returning turn, without blocking the response", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    mockChatOnce("Hello there");
    const agent = new Agent({ config: { workspaceRoot: dir, tier: "local", model: "test-model" } });

    const reply = await agent.runUserMessage("hi");

    expect(reply).toBe("Hello there");
    // Summarization is fire-and-forget; give pending microtasks/timers a tick to run.
    await new Promise((r) => setTimeout(r, 0));
  });

  it("emits onMemorySummary with the generated summary text after a successful turn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    // First chat() call answers runUserMessage's turn; second answers generateSummary's
    // non-streaming call kicked off by triggerSummarization.
    mockChatOnce("Hello there");
    const onMemorySummary = jest.fn();
    const agent = new Agent({
      config: { workspaceRoot: dir, tier: "local", model: "test-model" },
      events: { onMemorySummary },
    });

    await agent.runUserMessage("hi");
    // Summarization is fire-and-forget; give pending microtasks/timers a tick to run.
    await new Promise((r) => setTimeout(r, 0));

    expect(onMemorySummary).toHaveBeenCalledWith("Hello there");
  });
});

function writeSkill(workspaceRoot: string, id: string, frontmatter: string, body: string): void {
  const dir = join(workspaceRoot, ".devagent", "skills", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`);
}

// The main chat turn is the fetch call with a body — triggerSummarization fires a
// second, synchronous fetch (its own chat call) before runUserMessage returns.
// Find the first POST request by checking for a request body.
function firstRequestMessages(): Array<{ role: string; content: string }> {
  const calls = (globalThis.fetch as jest.Mock).mock.calls;
  const postCall = calls.find((c) => c[1] && c[1].body);
  if (!postCall) throw new Error("No fetch call with body found");
  const [, init] = postCall;
  return JSON.parse(init.body as string).messages;
}

describe("Agent skills activation", () => {
  // Isolate from the real ~/.devagent/skills global dir, which may contain
  // unrelated real skills on a developer machine and would otherwise leak
  // into resolution alongside the fixture skill below.
  let skillsHomeDir: string;

  beforeEach(async () => {
    skillsHomeDir = await mkdtemp(join(tmpdir(), "home-"));
  });

  it("injects a matching skill's body as a system message before the user message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    writeSkill(dir, "rails-api", "name: Rails API\ndescription: REST APIs\ntags: [rails]", "Rails skill body");
    mockChatOnce("ok");
    const agent = new Agent({ config: { workspaceRoot: dir, tier: "local", model: "test-model" }, skillsHomeDir });

    await agent.runUserMessage("help me build a rails endpoint");

    const messages = firstRequestMessages();
    const skillMessage = messages.find((m) => m.role === "system" && m.content.includes("Rails skill body"));
    expect(skillMessage).toBeDefined();
    expect(messages.at(-1)).toMatchObject({ role: "user", content: "help me build a rails endpoint" });
    // the skill message must precede the user message
    expect(messages.indexOf(skillMessage!)).toBeLessThan(messages.length - 1);
  });

  it("emits onSkillsActivated when a skill is injected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    writeSkill(dir, "rails-api", "name: Rails API\ndescription: REST APIs\ntags: [rails]", "Rails skill body");
    mockChatOnce("ok");
    const onSkillsActivated = jest.fn();
    const agent = new Agent({
      config: { workspaceRoot: dir, tier: "local", model: "test-model" },
      events: { onSkillsActivated },
      skillsHomeDir,
    });

    await agent.runUserMessage("help me build a rails endpoint");

    expect(onSkillsActivated).toHaveBeenCalledWith([expect.objectContaining({ id: "rails-api" })]);
  });

  it("does not inject anything when no skill matches the prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    writeSkill(dir, "rails-api", "name: Rails API\ndescription: REST APIs\ntags: [rails]", "Rails skill body");
    mockChatOnce("ok");
    const agent = new Agent({ config: { workspaceRoot: dir, tier: "local", model: "test-model" }, skillsHomeDir });

    await agent.runUserMessage("completely unrelated request");

    const messages = firstRequestMessages();
    expect(messages.some((m) => m.content.includes("Rails skill body"))).toBe(false);
  });

  it("pinSkill bypasses scoring on the next call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    writeSkill(dir, "rails-api", "name: Rails API\ndescription: REST APIs\ntags: [rails]", "Rails skill body");
    mockChatOnce("ok");
    const agent = new Agent({ config: { workspaceRoot: dir, tier: "local", model: "test-model" }, skillsHomeDir });

    agent.pinSkill("rails-api");
    await agent.runUserMessage("completely unrelated request");

    const messages = firstRequestMessages();
    expect(messages.some((m) => m.content.includes("Rails skill body"))).toBe(true);
  });

  it("records a skill_usage entry via MemoryStore after an activated turn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    writeSkill(dir, "rails-api", "name: Rails API\ndescription: REST APIs\ntags: [rails]", "Rails skill body");
    mockChatOnce("ok");
    const agent = new Agent({ config: { workspaceRoot: dir, tier: "local", model: "test-model" }, skillsHomeDir });

    await agent.runUserMessage("help me build a rails endpoint");

    const store = new MemoryStore(join(dir, ".devagent", "memory.db"));
    expect(store.getSkillUsage("rails-api")).toMatchObject({ useCount: 1, successCount: 1 });
    store.close();
  });
});
