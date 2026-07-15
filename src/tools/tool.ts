import { OllamaToolSchema } from "../provider/provider.js";

export class ToolError extends Error {}

export abstract class Tool {
  abstract get name(): string;
  abstract get description(): string;

  get tags(): string[] {
    return [];
  }

  get capabilities(): string[] {
    return [];
  }

  get parameters(): Record<string, unknown> {
    return { type: "object", properties: {}, required: [] };
  }

  get schema(): OllamaToolSchema {
    return {
      type: "function",
      function: { name: this.name, description: this.description, parameters: this.parameters },
    };
  }

  abstract call(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}
