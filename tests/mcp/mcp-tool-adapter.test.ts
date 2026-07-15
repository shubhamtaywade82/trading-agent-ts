import { McpToolAdapter } from "../../src/mcp/mcp-tool-adapter.js";

function fakeMcpClient(callResult: unknown) {
  return {
    callTool: jest.fn().mockResolvedValue(callResult),
  };
}

describe("McpToolAdapter", () => {
  it("exposes the remote tool's name, description, and JSON schema", () => {
    const client = fakeMcpClient({ content: [] });
    const adapter = new McpToolAdapter(client as any, {
      name: "github_search_issues",
      description: "Search GitHub issues",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    });

    expect(adapter.name).toBe("github_search_issues");
    expect(adapter.description).toBe("Search GitHub issues");
    expect(adapter.parameters).toEqual({ type: "object", properties: { query: { type: "string" } }, required: ["query"] });
  });

  it("forwards call() args to the underlying MCP client and returns its content", async () => {
    const client = fakeMcpClient({ content: [{ type: "text", text: "3 issues found" }] });
    const adapter = new McpToolAdapter(client as any, {
      name: "github_search_issues",
      description: "Search GitHub issues",
      inputSchema: { type: "object", properties: {}, required: [] },
    });

    const result = await adapter.call({ query: "bug" });

    expect(client.callTool).toHaveBeenCalledWith({ name: "github_search_issues", arguments: { query: "bug" } });
    expect(result.content).toEqual([{ type: "text", text: "3 issues found" }]);
  });
});
