import { Tool } from "./tool.js";
import { resolveWorkspacePath } from "./path-utils.js";
import { LspManager } from "../lsp/manager.js";
import { uriToPath } from "../lsp/protocol.js";

abstract class LspTool extends Tool {
  constructor(protected lsp: LspManager) {
    super();
  }

  protected async withSession<T extends Record<string, unknown>>(
    args: Record<string, unknown>,
    fn: (filePath: string, lsp: LspManager) => Promise<T>,
  ): Promise<T> {
    const filePath = this.resolveFile(args);
    await this.lsp.ensureOpen(filePath);
    const result = await fn(filePath, this.lsp);
    // The server may still be doing initial project indexing — an empty
    // result right now doesn't mean there's nothing to find, just that the
    // server hasn't gotten there yet. Flag it so callers retry instead of
    // concluding "no results".
    if (this.lsp.isIndexing(filePath)) {
      return { ...result, indexing: true, note: "Language server is still indexing this project — results may be incomplete. Retry in a few seconds." };
    }
    return result;
  }

  protected resolveFile(args: Record<string, unknown>): string {
    const root = this.lsp.workspaceRoot;
    return resolveWorkspacePath(root, args.path as string);
  }
}

export class GetDefinitionTool extends LspTool {
  name = "get_definition";
  description = "Find the definition location of a symbol at a cursor position in a file";

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root" },
        line: { type: "number", description: "0-based line number" },
        character: { type: "number", description: "0-based character offset in the line" },
      },
      required: ["path", "line", "character"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withSession(args, async (filePath) => {
      const locations = await this.lsp.getDefinition(filePath, args.line as number, args.character as number);
      return {
        definitions: locations.map((l) => ({
          uri: uriToPath(l.uri),
          range: l.range,
        })),
        count: locations.length,
      };
    });
  }
}

export class FindReferencesTool extends LspTool {
  name = "find_references";
  description = "Find all references to a symbol at a cursor position across the workspace";

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root" },
        line: { type: "number", description: "0-based line number" },
        character: { type: "number", description: "0-based character offset in the line" },
        includeDeclaration: { type: "boolean", description: "Include the declaration site (default: false)" },
      },
      required: ["path", "line", "character"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withSession(args, async (filePath) => {
      const includeDecl = args.includeDeclaration as boolean | undefined;
      const locations = await this.lsp.getReferences(filePath, args.line as number, args.character as number, includeDecl);
      return {
        references: locations.map((l) => ({
          uri: uriToPath(l.uri),
          range: l.range,
        })),
        count: locations.length,
      };
    });
  }
}

export class RenameSymbolTool extends LspTool {
  name = "rename_symbol";
  description = "Rename a symbol across the entire workspace, returning the required edits";

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root" },
        line: { type: "number", description: "0-based line number" },
        character: { type: "number", description: "0-based character offset in the line" },
        newName: { type: "string", description: "The new name for the symbol" },
      },
      required: ["path", "line", "character", "newName"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withSession(args, async (filePath) => {
      const edit = await this.lsp.renameSymbol(filePath, args.line as number, args.character as number, args.newName as string);
      if (!edit) return { changes: [], error: "Rename not supported or symbol not found" };

      const changes = edit.changes
        ? Object.entries(edit.changes).map(([uri, textEdits]) => ({
            file: uriToPath(uri),
            edits: textEdits,
          }))
        : edit.documentChanges
          ? edit.documentChanges.map((dc: any) => ({
              file: uriToPath(dc.textDocument?.uri ?? ""),
              edits: dc.edits ?? [],
            }))
          : [];

      return {
        changes,
        filesAffected: changes.length,
      };
    });
  }
}

export class WorkspaceSymbolsTool extends LspTool {
  name = "workspace_symbols";
  description = "Search for symbols across the entire workspace by name query";

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        query: { type: "string", description: "Symbol name or partial name to search for" },
      },
      required: ["query"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = args.query as string;
    const symbols = await this.lsp.getWorkspaceSymbols(query);
    return {
      symbols: symbols.map((s) => ({
        name: s.name,
        kind: s.kind,
        containerName: s.containerName,
        location: {
          uri: uriToPath(s.location.uri),
          range: s.location.range,
        },
      })),
      count: symbols.length,
    };
  }
}

export class DocumentSymbolsTool extends LspTool {
  name = "document_symbols";
  description = "List all symbols (classes, functions, variables, etc.) defined in a file";

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root" },
      },
      required: ["path"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const filePath = this.resolveFile(args);
    await this.lsp.ensureOpen(filePath);
    const symbols = await this.lsp.getDocumentSymbols(filePath);
    return {
      symbols: symbols.map((s) => ({
        name: s.name,
        kind: s.kind,
        containerName: s.containerName,
        location: {
          uri: uriToPath(s.location.uri),
          range: s.location.range,
        },
      })),
      count: symbols.length,
    };
  }
}

export class HoverTool extends LspTool {
  name = "hover";
  description = "Get type information and documentation for a symbol at a cursor position";

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root" },
        line: { type: "number", description: "0-based line number" },
        character: { type: "number", description: "0-based character offset in the line" },
      },
      required: ["path", "line", "character"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withSession(args, async (filePath) => {
      const hover = await this.lsp.getHover(filePath, args.line as number, args.character as number);
      if (!hover) return { contents: null, message: "No hover information available" };

      const content = hover.contents;
      const contentsStr = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((c: any) => (typeof c === "string" ? c : c.value ?? "")).join("\n")
          : (content as any).value ?? JSON.stringify(content);

      return {
        contents: contentsStr,
        range: hover.range ?? null,
      };
    });
  }
}

export class DiagnosticsTool extends LspTool {
  name = "diagnostics";
  description = "Get all diagnostics (errors, warnings, hints) reported for a file by the language server";

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root" },
      },
      required: ["path"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withSession(args, async (filePath) => {
      const diagnostics = await this.lsp.getDiagnostics(filePath);
      return {
        diagnostics: diagnostics.map((d) => ({
          range: d.range,
          severity: d.severity,
          message: d.message,
          source: d.source,
          code: d.code,
        })),
        count: diagnostics.length,
        hasErrors: diagnostics.some((d) => d.severity === 1),
        hasWarnings: diagnostics.some((d) => d.severity === 2),
      };
    });
  }
}

export class CodeActionsTool extends LspTool {
  name = "code_actions";
  description = "Get available code actions (quick fixes, refactorings, etc.) at a cursor position";

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root" },
        line: { type: "number", description: "0-based line number" },
        character: { type: "number", description: "0-based character offset in the line" },
      },
      required: ["path", "line", "character"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withSession(args, async (filePath) => {
      const actions = await this.lsp.getCodeActions(filePath, args.line as number, args.character as number);
      return {
        actions: actions.map((a: Record<string, unknown>) => ({
          title: a.title as string,
          kind: a.kind as string,
        })),
        count: actions.length,
      };
    });
  }
}

export class FormatDocumentTool extends LspTool {
  name = "format_document";
  description = "Format an entire file using the language server's formatter";

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root" },
      },
      required: ["path"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const filePath = this.resolveFile(args);
    await this.lsp.ensureOpen(filePath);
    const edits = await this.lsp.formatDocument(filePath);
    return {
      edits: edits.map((e) => ({
        range: e.range,
        newText: e.newText,
      })),
      count: edits.length,
    };
  }
}

export class SignatureHelpTool extends LspTool {
  name = "signature_help";
  description = "Get signature information for a function call at a cursor position";

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root" },
        line: { type: "number", description: "0-based line number" },
        character: { type: "number", description: "0-based character offset in the line" },
      },
      required: ["path", "line", "character"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withSession(args, async (filePath) => {
      const help = await this.lsp.getSignatureHelp(filePath, args.line as number, args.character as number);
      if (!help) return { signatures: [], activeSignature: -1 };

      return {
        signatures: help.signatures.map((s) => ({
          label: s.label,
          documentation: s.documentation,
          parameters: s.parameters?.map((p) => ({
            label: typeof p.label === "string" ? p.label : JSON.stringify(p.label),
            documentation: p.documentation,
          })),
        })),
        activeSignature: help.activeSignature,
        activeParameter: help.activeParameter,
      };
    });
  }
}

export class CompletionTool extends LspTool {
  name = "completion";
  description = "Get code completion suggestions at a cursor position";

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root" },
        line: { type: "number", description: "0-based line number" },
        character: { type: "number", description: "0-based character offset in the line" },
      },
      required: ["path", "line", "character"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withSession(args, async (filePath) => {
      const items = await this.lsp.getCompletion(filePath, args.line as number, args.character as number);
      return {
        completions: items.map((i) => ({
          label: i.label,
          kind: i.kind,
          detail: i.detail,
          documentation: i.documentation,
        })),
        count: items.length,
      };
    });
  }
}

export class SemanticTokensTool extends LspTool {
  name = "semantic_tokens";
  description = "Get semantic token coloring data for a file (provides token types and modifiers)";

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root" },
      },
      required: ["path"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const filePath = this.resolveFile(args);
    await this.lsp.ensureOpen(filePath);
    const data = await this.lsp.getSemanticTokens(filePath);
    return {
      tokens: data ?? [],
      count: data ? data.length / 5 : 0,
    };
  }
}
