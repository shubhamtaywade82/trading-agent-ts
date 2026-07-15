import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Tool } from "../tools/tool.js";
import { McpToolAdapter } from "./mcp-tool-adapter.js";

export async function connectMcpServer(command: string, args: string[] = []): Promise<Tool[]> {
  const transport = new StdioClientTransport({ command, args });
  const client = new Client({ name: "devagent", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const { tools } = await client.listTools();
  return tools.map(
    (t) =>
      new McpToolAdapter(client, {
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema as Record<string, unknown>,
      }),
  );
}
