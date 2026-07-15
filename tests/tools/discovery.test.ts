import { Tool } from "../../src/tools/tool.js";
import { DynamicToolSelector } from "../../src/tools/discovery.js";
import { Provider, ChatMessage } from "../../src/provider/provider.js";

class MockTool extends Tool {
  constructor(
    private readonly _name: string,
    private readonly _desc: string,
    private readonly _caps: string[] = [],
    private readonly _tags: string[] = []
  ) {
    super();
  }

  get name() {
    return this._name;
  }

  get description() {
    return this._desc;
  }

  override get capabilities() {
    return this._caps;
  }

  override get tags() {
    return this._tags;
  }

  async call() {
    return {};
  }
}

describe("DynamicToolSelector", () => {
  const fileTool = new MockTool("read_file", "Read a file", ["File System"], ["read", "open"]);
  const shellTool = new MockTool("run_shell", "Run terminal command", ["Terminal"], ["sh", "execute"]);
  const gitTool = new MockTool("git", "Run git operations", ["Git"], ["commit", "status"]);
  const tools = [fileTool, shellTool, gitTool];

  describe("Heuristic Selection", () => {
    it("matches tools by name tokens", async () => {
      const selector = new DynamicToolSelector({ mode: "heuristic" });
      const selected = await selector.selectTools("read something from a file", [], tools);
      
      expect(selected.map(t => t.name)).toContain("read_file");
    });

    it("matches tools by tags", async () => {
      const selector = new DynamicToolSelector({ mode: "heuristic" });
      const selected = await selector.selectTools("check the status of the repository", [], tools);

      expect(selected.map(t => t.name)).toContain("git");
    });

    it("matches tools by capabilities", async () => {
      const selector = new DynamicToolSelector({ mode: "heuristic" });
      const selected = await selector.selectTools("open terminal and run a script", [], tools);

      expect(selected.map(t => t.name)).toContain("run_shell");
    });

    it("includes baseline tools if matches are scarce", async () => {
      const selector = new DynamicToolSelector({ mode: "heuristic" });
      const selected = await selector.selectTools("completely unrelated text", [], tools);

      expect(selected.map(t => t.name)).toContain("read_file");
      expect(selected.map(t => t.name)).toContain("run_shell");
    });
  });

  describe("LLM Selection", () => {
    it("calls provider.chat and returns parsed tools", async () => {
      const mockProvider = {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: '["read_file"]'
          }
        })
      } as unknown as Provider;

      const selector = new DynamicToolSelector({ mode: "llm", provider: mockProvider });
      const selected = await selector.selectTools("open file", [], tools);

      expect(mockProvider.chat).toHaveBeenCalled();
      expect(selected.length).toBe(1);
      expect(selected[0].name).toBe("read_file");
    });

    it("strips markdown json blocks from provider response", async () => {
      const mockProvider = {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: '```json\n["run_shell"]\n```'
          }
        })
      } as unknown as Provider;

      const selector = new DynamicToolSelector({ mode: "llm", provider: mockProvider });
      const selected = await selector.selectTools("run cmd", [], tools);

      expect(selected.length).toBe(1);
      expect(selected[0].name).toBe("run_shell");
    });

    it("falls back to heuristic if provider chat throws", async () => {
      const mockProvider = {
        chat: jest.fn().mockRejectedValue(new Error("Ollama down"))
      } as unknown as Provider;

      const selector = new DynamicToolSelector({ mode: "llm", provider: mockProvider });
      const selected = await selector.selectTools("status of git", [], tools);

      expect(selected.map(t => t.name)).toContain("git");
    });
  });

  describe("Hybrid Selection", () => {
    it("skips LLM call if heuristic scores are high enough", async () => {
      const mockProvider = {
        chat: jest.fn()
      } as unknown as Provider;

      const selector = new DynamicToolSelector({ mode: "hybrid", provider: mockProvider });
      const selected = await selector.selectTools("read_file the config", [], tools);

      expect(mockProvider.chat).not.toHaveBeenCalled();
      expect(selected.map(t => t.name)).toContain("read_file");
    });

    it("calls LLM if heuristic scores are low or ambiguous", async () => {
      const mockProvider = {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: '["git"]'
          }
        })
      } as unknown as Provider;

      const selector = new DynamicToolSelector({ mode: "hybrid", provider: mockProvider });
      // "do something" is very ambiguous and won't hit high scores for file/shell
      const selected = await selector.selectTools("do something complex", [], tools);

      expect(mockProvider.chat).toHaveBeenCalled();
      expect(selected.map(t => t.name)).toContain("git");
    });
  });
});
