import { IntelligenceRouter } from "./router.js";
import { FileContext } from "./provider.js";
import type { RailsContextBuilder } from "./rails/context-builder.js";

export class SemanticContextBuilder {
  constructor(
    private readonly intelligence: IntelligenceRouter,
    private readonly railsContext?: RailsContextBuilder,
  ) {}

  /**
   * Build task-level context: Rails semantic context (when the workspace is
   * a Rails app) prepended to nothing else for now — callers combine it with
   * per-file context as needed.
   */
  buildTaskContext(request: string): string {
    if (!this.railsContext) return "";
    return this.railsContext.buildContext(request).text;
  }

  async buildFileContext(filePath: string): Promise<FileContext> {
    return this.intelligence.buildFileContext(filePath);
  }

  async buildWorkspaceContext(filePaths: string[]): Promise<Map<string, FileContext>> {
    const results = new Map<string, FileContext>();
    const entries = await Promise.allSettled(
      filePaths.map(async (fp) => {
        const ctx = await this.buildFileContext(fp);
        return { fp, ctx };
      }),
    );
    for (const entry of entries) {
      if (entry.status === "fulfilled") {
        results.set(entry.value.fp, entry.value.ctx);
      }
    }
    return results;
  }

  async buildSymbolSummary(filePath: string): Promise<string> {
    const ctx = await this.buildFileContext(filePath);
    if (ctx.symbols && ctx.symbols.length > 0) {
      const lines = ctx.symbols.map((s) => {
        const loc = s.location?.range
          ? ` L${s.location.range.start.line}`
          : "";
        return `${symbolKindName(s.kind)} ${s.name}${loc}`;
      });
      return `Symbols (${ctx.symbols.length}):\n${lines.join("\n")}`;
    }
    if (ctx.content) {
      return ctx.content.length > 2000 ? ctx.content.slice(0, 2000) + "\n..." : ctx.content;
    }
    return "(empty)";
  }
}

function symbolKindName(kind: number): string {
  const names: Record<number, string> = {
    1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class",
    6: "Method", 7: "Property", 8: "Field", 9: "Constructor", 10: "Enum",
    11: "Interface", 12: "Function", 13: "Variable", 14: "Constant",
    15: "String", 16: "Number", 17: "Boolean", 18: "Array",
    19: "Object", 20: "Key", 21: "Null", 22: "EnumMember",
    23: "Struct", 24: "Event", 25: "Operator", 26: "TypeParameter",
  };
  return names[kind] ?? "Symbol";
}
