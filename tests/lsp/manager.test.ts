import { LspManager } from "../../src/lsp/manager.js";

function managerWithFakeSession(sendRequestResult: unknown): LspManager {
  const manager = new LspManager({ workspaceRoot: "/workspace" });
  const fakeSession = {
    status: "running",
    capabilities: { documentSymbol: true },
    client: { sendRequest: jest.fn().mockResolvedValue(sendRequestResult) },
    lastActivity: 0,
  };
  (manager as any).getSession = async () => fakeSession;
  return manager;
}

describe("LspManager.getDocumentSymbols", () => {
  it("assigns the requested file's uri to flattened hierarchical DocumentSymbol results", async () => {
    // ruby-lsp (and others) return hierarchical DocumentSymbol[], which has no
    // per-symbol `location` — the uri used to be hardcoded to "" here.
    const hierarchical = [
      {
        name: "Foo",
        kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
        children: [{ name: "bar", kind: 6, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } }],
      },
    ];
    const manager = managerWithFakeSession(hierarchical);

    const symbols = await manager.getDocumentSymbols("/workspace/foo.rb");

    expect(symbols[0].location.uri).not.toBe("");
    expect(symbols[0].location.uri).toContain("foo.rb");
    expect(symbols[1].location.uri).toBe(symbols[0].location.uri);
    expect(symbols[1].containerName).toBe("Foo");
  });

  it("does not misclassify a childless top-level DocumentSymbol as flat SymbolInformation", async () => {
    // Regression: detecting the hierarchical shape via `"children" in result[0]`
    // misclassified a childless top-level symbol (e.g. a constant with no
    // nested members) as SymbolInformation, which then crashed on the missing
    // `.location`. Discriminating on `!("location" in result[0])` fixes this.
    const childless = [
      { name: "CONST", kind: 14, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } },
    ];
    const manager = managerWithFakeSession(childless);

    await expect(manager.getDocumentSymbols("/workspace/foo.rb")).resolves.toEqual([
      expect.objectContaining({ name: "CONST", location: expect.objectContaining({ uri: expect.stringContaining("foo.rb") }) }),
    ]);
  });

  it("passes through real flat SymbolInformation results unchanged", async () => {
    const flat = [
      { name: "Bar", kind: 5, location: { uri: "file:///workspace/bar.rb", range: {} }, containerName: "" },
    ];
    const manager = managerWithFakeSession(flat);

    const symbols = await manager.getDocumentSymbols("/workspace/bar.rb");

    expect(symbols).toEqual(flat);
  });

  it("returns an empty array when the server returns nothing", async () => {
    const manager = managerWithFakeSession(null);
    expect(await manager.getDocumentSymbols("/workspace/empty.rb")).toEqual([]);
  });
});

describe("LspManager.isIndexing", () => {
  it("returns false when there is no session for the file's language", () => {
    const manager = new LspManager({ workspaceRoot: "/workspace" });
    expect(manager.isIndexing("/workspace/foo.unknownext")).toBe(false);
  });

  it("reflects the underlying session's indexing state", () => {
    const manager = new LspManager({ workspaceRoot: "/workspace" });
    const registry = (manager as any).registry;
    jest.spyOn(registry, "getProviderForFile").mockReturnValue({ id: "ruby", language: "Ruby" });

    const fakeSession = { indexing: true };
    (manager as any).pool = { getSession: () => fakeSession };

    expect(manager.isIndexing("/workspace/foo.rb")).toBe(true);

    fakeSession.indexing = false;
    expect(manager.isIndexing("/workspace/foo.rb")).toBe(false);
  });
});
