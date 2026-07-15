import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetDefinitionTool, DiagnosticsTool } from "../../src/tools/lsp-tools.js";
import { LspManager } from "../../src/lsp/manager.js";

const workspaceRoot = mkdtempSync(join(tmpdir(), "lsp-tools-test-"));
writeFileSync(join(workspaceRoot, "foo.ts"), "export const x = 1;\n");

function fakeManager(overrides: Partial<LspManager> = {}): LspManager {
  return {
    workspaceRoot,
    ensureOpen: jest.fn().mockResolvedValue(true),
    isIndexing: jest.fn().mockReturnValue(false),
    getDefinition: jest.fn().mockResolvedValue([]),
    getDiagnostics: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as LspManager;
}

describe("LspTool.withSession — indexing flag", () => {
  it("does not add an indexing note when the server is fully indexed", async () => {
    const manager = fakeManager({ isIndexing: jest.fn().mockReturnValue(false) });
    const tool = new GetDefinitionTool(manager);

    const result = await tool.call({ path: "foo.ts", line: 0, character: 0 });

    expect(result.indexing).toBeUndefined();
    expect(result.note).toBeUndefined();
  });

  it("adds indexing:true and a note when the server is still indexing", async () => {
    const manager = fakeManager({ isIndexing: jest.fn().mockReturnValue(true) });
    const tool = new GetDefinitionTool(manager);

    const result = await tool.call({ path: "foo.ts", line: 0, character: 0 });

    expect(result.indexing).toBe(true);
    expect(result.note).toMatch(/still indexing/i);
    // The underlying result must still be present, not replaced.
    expect(result.definitions).toEqual([]);
  });

  it("applies to DiagnosticsTool too, now that it routes through withSession", async () => {
    const manager = fakeManager({ isIndexing: jest.fn().mockReturnValue(true) });
    const tool = new DiagnosticsTool(manager);

    const result = await tool.call({ path: "foo.ts" });

    expect(result.indexing).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });
});
