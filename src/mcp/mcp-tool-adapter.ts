import { Tool } from "../tools/tool.js";

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpClientLike {
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

export class McpToolAdapter extends Tool {
  constructor(
    private readonly client: McpClientLike,
    private readonly descriptor: McpToolDescriptor,
  ) {
    super();
  }

  get name(): string {
    return this.descriptor.name;
  }

  get description(): string {
    return this.descriptor.description;
  }

  get parameters(): Record<string, unknown> {
    return this.descriptor.inputSchema;
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.callTool({ name: this.descriptor.name, arguments: args });
  }
}
