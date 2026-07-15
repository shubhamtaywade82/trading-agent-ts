import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConversation } from "../../src/cli/agent-conversation.js";
import { Agent } from "../../src/cli/agent.js";

describe("AgentConversation context pruning", () => {
  it("correctly prunes context once maxMessages limit is exceeded", () => {
    const convo = new AgentConversation();
    convo.init({ model: "test", workspaceRoot: ".", tier: "local" }, [], []);

    // Push 30 messages
    for (let i = 0; i < 30; i++) {
      convo.pushUserMessage(`Message ${i}`);
    }

    expect(convo.getMessages().length).toBe(31); // 1 system prompt + 30 user messages

    convo.pruneContext(25);

    const messages = convo.getMessages();
    expect(messages.length).toBe(12); // 1 system + 1 bypass notice + 10 recent
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("system");
    expect(messages[1].content).toContain("Bypassed 20 intermediate turns");
    expect(messages[2].content).toBe("Message 20");
    expect(messages[11].content).toBe("Message 29");
  });
});

describe("AgentConversation.loadMessages", () => {
  it("replaces the whole transcript", () => {
    const convo = new AgentConversation();
    convo.init({ model: "test", workspaceRoot: ".", tier: "local" }, [], []);
    convo.pushUserMessage("will be discarded");

    const restored = [
      { role: "system" as const, content: "old system prompt" },
      { role: "user" as const, content: "earlier question" },
      { role: "assistant" as const, content: "earlier answer" },
    ];
    convo.loadMessages(restored);

    expect(convo.getMessages()).toEqual(restored);
  });

  it("a stale loaded system prompt self-heals on the next refreshSystemPrompt call", () => {
    const convo = new AgentConversation();
    convo.loadMessages([
      { role: "system", content: "stale prompt" },
      { role: "user", content: "hi" },
    ]);

    convo.refreshSystemPrompt({ model: "test", workspaceRoot: ".", tier: "local", systemPrompt: "fresh prompt" }, [], []);

    expect(convo.getMessages()[0].content).toContain("fresh prompt");
    expect(convo.getMessages()[1]).toEqual({ role: "user", content: "hi" });
  });
});

describe("Agent non-critical task model delegation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-test-"));
    const encoder = new TextEncoder();
    (globalThis as any).fetch = jest.fn().mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/tags") || urlStr.includes("/v1/models")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [
              { name: "hermes3:latest" },
              { name: "opencode:latest" }
            ]
          })
        };
      }

      const line = JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true }) + "\n";
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
        json: async () => ({ message: { role: "assistant", content: "ok" }, done: true }),
        body: { getReader: () => reader },
      };
    });
  });

  it("delegates low priority text/doc tasks to hermes", async () => {
    const agent = new Agent({
      config: { workspaceRoot: tempDir, tier: "local", model: "original-model" },
    });

    expect(agent.currentModel).toBe("original-model");

    await agent.runUserMessage("Write a README file", "low");

    expect(agent.currentModel).toBe("original-model");
    // Verify it was switched to hermes during execution by checking the mock fetch history
    const calls = (globalThis.fetch as jest.Mock).mock.calls;
    const postCall = calls.find((c) => c[1] && c[1].body);
    expect(postCall).toBeDefined();
    const firstCallBody = JSON.parse(postCall![1].body);
    expect(firstCallBody.model).toBe("hermes3:latest");
  });

  it("delegates low priority code/test tasks to opencode", async () => {
    const encoder = new TextEncoder();
    (globalThis as any).fetch = jest.fn().mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/tags") || urlStr.includes("/v1/models")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [
              { name: "opencode:latest" },
              { name: "hermes3:latest" }
            ]
          })
        };
      }

      const line = JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true }) + "\n";
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
        json: async () => ({ message: { role: "assistant", content: "ok" }, done: true }),
        body: { getReader: () => reader },
      };
    });

    const agent = new Agent({
      config: { workspaceRoot: tempDir, tier: "local", model: "original-model" },
    });

    expect(agent.currentModel).toBe("original-model");

    await agent.runUserMessage("Run unit tests", "medium");

    expect(agent.currentModel).toBe("original-model");
    const calls = (globalThis.fetch as jest.Mock).mock.calls;
    const postCall = calls.find((c) => c[1] && c[1].body);
    expect(postCall).toBeDefined();
    const firstCallBody = JSON.parse(postCall![1].body);
    expect(firstCallBody.model).toBe("opencode:latest");
  });
});

describe("Agent vision/reasoning capability routing", () => {
  let tempDir: string;

  function mockFetchWithModels(models: string[]) {
    const encoder = new TextEncoder();
    (globalThis as any).fetch = jest.fn().mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/tags") || urlStr.includes("/v1/models")) {
        return { ok: true, status: 200, json: async () => ({ models: models.map((name) => ({ name })) }) };
      }
      const line = JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true }) + "\n";
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
        json: async () => ({ message: { role: "assistant", content: "ok" }, done: true }),
        body: { getReader: () => reader },
      };
    });
  }

  function chatCallBody(): { model: string } {
    const calls = (globalThis.fetch as jest.Mock).mock.calls;
    const postCall = calls.find((c) => c[1] && c[1].body);
    expect(postCall).toBeDefined();
    return JSON.parse(postCall![1].body);
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-test-"));
  });

  it("routes a screenshot-mentioning task to the installed vision model", async () => {
    mockFetchWithModels(["qwen3-vl:4b", "qwen3:8b"]);
    const agent = new Agent({ config: { workspaceRoot: tempDir, tier: "local", model: "original-model" } });

    await agent.runUserMessage("Look at this screenshot and tell me what's wrong with the layout");

    expect(chatCallBody().model).toBe("qwen3-vl:4b");
    expect(agent.currentModel).toBe("original-model");
  });

  it("routes an architecture question to the installed reasoning model", async () => {
    mockFetchWithModels(["deepseek-r1:8b", "qwen3:8b"]);
    const agent = new Agent({ config: { workspaceRoot: tempDir, tier: "local", model: "original-model" } });

    await agent.runUserMessage("What are the trade-offs of this architecture before we commit to it?");

    expect(chatCallBody().model).toBe("deepseek-r1:8b");
  });

  it("falls back to the primary model when no vision model is installed", async () => {
    mockFetchWithModels(["qwen3:8b"]); // no vision-capable model in the catalog
    const agent = new Agent({ config: { workspaceRoot: tempDir, tier: "local", model: "original-model" } });

    await agent.runUserMessage("Look at this screenshot and tell me what's wrong");

    expect(chatCallBody().model).toBe("original-model");
  });

  it("does not route a plain coding task to vision or reasoning", async () => {
    mockFetchWithModels(["qwen3-vl:4b", "deepseek-r1:8b"]);
    const agent = new Agent({ config: { workspaceRoot: tempDir, tier: "local", model: "original-model" } });

    await agent.runUserMessage("Add a null check to the parser");

    expect(chatCallBody().model).toBe("original-model");
  });
});
