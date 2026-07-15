import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/cli/agent.js";
import { Planner } from "../../src/orchestrator/types.js";

const noopPlanner: Planner = { replan: async () => [] };

describe("Agent plan checkpoint/resume", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-resume-test-"));
    const encoder = new TextEncoder();
    (globalThis as any).fetch = jest.fn().mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.endsWith("/api/tags")) {
        return { ok: true, status: 200, json: async () => ({ models: [] }) };
      }
      const line = JSON.stringify({ message: { role: "assistant", content: "done" }, done: true }) + "\n";
      let delivered = false;
      const reader = {
        read: async () => {
          if (delivered) return { done: true, value: undefined };
          delivered = true;
          return { done: false, value: encoder.encode(line) };
        },
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({ message: { role: "assistant", content: "done" }, done: true }),
        body: { getReader: () => reader },
      };
    });
  });

  it("has no resumable plan when no checkpoint exists", () => {
    const agent = new Agent({ config: { workspaceRoot: tempDir, tier: "local", model: "m" } });
    expect(agent.hasResumablePlan()).toBe(false);
  });

  it("returns null from resumePlannedTask when no checkpoint exists", async () => {
    const agent = new Agent({ config: { workspaceRoot: tempDir, tier: "local", model: "m" } });
    await expect(agent.resumePlannedTask(noopPlanner)).resolves.toBeNull();
  });

  it("checkpoints progress during runPlannedTask and clears it on completion", async () => {
    const agent = new Agent({ config: { workspaceRoot: tempDir, tier: "local", model: "m" } });
    const steps = [
      { id: "a", description: "step a", status: "pending" as const, dependencies: [], retryCount: 0 },
      { id: "b", description: "step b", status: "pending" as const, dependencies: ["a"], retryCount: 0 },
    ];

    const result = await agent.runPlannedTask(steps, noopPlanner);

    expect(result.every((s) => s.status === "completed")).toBe(true);
    expect(agent.hasResumablePlan()).toBe(false);
  });

  it("resumes a plan left behind by a crashed process, skipping the completed step", async () => {
    // Simulate a prior process that finished "a" and crashed mid-"b" — write
    // the checkpoint a real crashed run would have left, without running one.
    const checkpointPath = join(tempDir, ".devagent", "checkpoint.json");
    await mkdir(join(tempDir, ".devagent"), { recursive: true });
    await writeFile(
      checkpointPath,
      JSON.stringify({
        steps: [
          { id: "a", description: "step a", status: "completed", dependencies: [], retryCount: 0 },
          { id: "b", description: "step b", status: "implementing", dependencies: ["a"], retryCount: 0 },
        ],
        history: [],
        replanCount: 0,
        updatedAt: Date.now(),
      }),
    );

    const agent = new Agent({ config: { workspaceRoot: tempDir, tier: "local", model: "m" } });
    expect(agent.hasResumablePlan()).toBe(true);

    const result = await agent.resumePlannedTask(noopPlanner);

    expect(result).not.toBeNull();
    expect(result!.find((s) => s.id === "a")?.status).toBe("completed");
    expect(result!.find((s) => s.id === "b")?.status).toBe("completed");
    // "a" was already completed at checkpoint time — it must never re-enter the chat loop.
    const chatBodies = (globalThis.fetch as jest.Mock).mock.calls
      .filter((c) => c[1]?.body)
      .map((c) => JSON.parse(c[1].body));
    const sawStepA = chatBodies.some((body) =>
      body.messages.some((m: { content?: string }) => m.content === "step a"),
    );
    expect(sawStepA).toBe(false);
    expect(agent.hasResumablePlan()).toBe(false);
  });
});

describe("Agent conversation session resume", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-session-test-"));
    const encoder = new TextEncoder();
    (globalThis as any).fetch = jest.fn().mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.endsWith("/api/tags")) {
        return { ok: true, status: 200, json: async () => ({ models: [] }) };
      }
      const line = JSON.stringify({ message: { role: "assistant", content: "done" }, done: true }) + "\n";
      let delivered = false;
      const reader = {
        read: async () => {
          if (delivered) return { done: true, value: undefined };
          delivered = true;
          return { done: false, value: encoder.encode(line) };
        },
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({ message: { role: "assistant", content: "done" }, done: true }),
        body: { getReader: () => reader },
      };
    });
  });

  it("has no resumable session for a fresh workspace", () => {
    const agent = new Agent({ config: { workspaceRoot: tempDir, tier: "local", model: "m" } });
    expect(agent.hasResumableSession()).toBe(false);
    expect(agent.resumeSession()).toBeNull();
  });

  it("persists the transcript after a turn and can resume it in a fresh Agent instance", async () => {
    const first = new Agent({ config: { workspaceRoot: tempDir, tier: "local", model: "m" } });
    await first.runUserMessage("what is 2+2");

    expect(first.hasResumableSession()).toBe(true);

    const second = new Agent({ config: { workspaceRoot: tempDir, tier: "local", model: "m" } });
    const restored = second.resumeSession();

    expect(restored).not.toBeNull();
    expect(restored!.some((m) => m.role === "user" && m.content === "what is 2+2")).toBe(true);
    expect(restored!.some((m) => m.role === "assistant" && m.content === "done")).toBe(true);
  });

  it("a follow-up turn after resuming sends the full prior transcript to the model", async () => {
    const first = new Agent({ config: { workspaceRoot: tempDir, tier: "local", model: "m" } });
    await first.runUserMessage("remember the number 42");

    const second = new Agent({ config: { workspaceRoot: tempDir, tier: "local", model: "m" } });
    second.resumeSession();
    await second.runUserMessage("what number did I say");

    const chatBodies = (globalThis.fetch as jest.Mock).mock.calls
      .filter((c) => c[1]?.body)
      .map((c) => JSON.parse(c[1].body));
    const lastCall = chatBodies[chatBodies.length - 1];
    expect(lastCall.messages.some((m: { content?: string }) => m.content === "remember the number 42")).toBe(true);
    expect(lastCall.messages.some((m: { content?: string }) => m.content === "what number did I say")).toBe(true);
  });

  it("resetContext clears the persisted session too", async () => {
    const agent = new Agent({ config: { workspaceRoot: tempDir, tier: "local", model: "m" } });
    await agent.runUserMessage("hello");
    expect(agent.hasResumableSession()).toBe(true);

    agent.resetContext();

    expect(agent.hasResumableSession()).toBe(false);
  });
});
