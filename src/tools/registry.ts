import { Tool, ToolError } from "./tool.js";
import { OllamaToolSchema } from "../provider/provider.js";

export class Registry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  getTools(): Tool[] {
    return [...this.tools.values()];
  }

  schemas(): OllamaToolSchema[] {
    return [...this.tools.values()].map((t) => t.schema);
  }

  async invoke(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new ToolError("tool args must be an object");
      }
      const tool = this.tools.get(name);
      if (!tool) throw new ToolError(`unknown tool: ${name}`);
      return await tool.call(args);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      return { error: err.constructor.name, message: err.message };
    }
  }
}
