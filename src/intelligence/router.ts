import { readFileSync } from "node:fs";
import type {
  Location,
  SymbolInformation,
  Hover,
  Diagnostic,
  CodeAction,
  CompletionItem,
  SignatureHelp,
  TextEdit,
} from "vscode-languageserver-protocol";
import { LspManager, SemanticOperation } from "../lsp/manager.js";
import { LanguageIntelligenceProvider, FileContext } from "./provider.js";

class TextFallbackProvider implements LanguageIntelligenceProvider {
  supportsOperation(_filePath: string, op: SemanticOperation): boolean {
    return op === "diagnostics" || op === "documentSymbols" || op === "workspaceSymbols";
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async findDefinition(_filePath: string, _line: number, _character: number): Promise<Location[]> {
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async findReferences(_filePath: string, _line: number, _character: number, _includeDeclaration?: boolean): Promise<Location[]> {
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async listDocumentSymbols(_filePath: string): Promise<SymbolInformation[]> {
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async listWorkspaceSymbols(_query: string): Promise<SymbolInformation[]> {
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getHover(_filePath: string, _line: number, _character: number): Promise<Hover | null> {
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getDiagnostics(_filePath: string): Promise<Diagnostic[]> {
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getCodeActions(_filePath: string, _line: number, _character: number): Promise<CodeAction[]> {
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getCompletion(_filePath: string, _line: number, _character: number): Promise<CompletionItem[]> {
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getSignatureHelp(_filePath: string, _line: number, _character: number): Promise<SignatureHelp | null> {
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async formatDocument(_filePath: string): Promise<TextEdit[]> {
    return [];
  }

  async buildFileContext(filePath: string): Promise<FileContext> {
    let content = "";
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      content = "";
    }
    return { path: filePath, content, size: Math.ceil(content.length / 4) };
  }
}

export class IntelligenceRouter implements LanguageIntelligenceProvider {
  private lsp: LspManager;
  private fallback: TextFallbackProvider;

  constructor(lsp: LspManager) {
    this.lsp = lsp;
    this.fallback = new TextFallbackProvider();
  }

  supportsOperation(filePath: string, op: SemanticOperation): boolean {
    if (this.lsp.supports(filePath, op)) return true;
    return this.fallback.supportsOperation(filePath, op);
  }

  async findDefinition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<Location[]> {
    if (this.lsp.supports(filePath, "definition")) {
      return this.lsp.getDefinition(filePath, line, character);
    }
    return this.fallback.findDefinition(filePath, line, character);
  }

  async findReferences(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration?: boolean,
  ): Promise<Location[]> {
    if (this.lsp.supports(filePath, "references")) {
      return this.lsp.getReferences(filePath, line, character, includeDeclaration);
    }
    return this.fallback.findReferences(filePath, line, character);
  }

  async listDocumentSymbols(filePath: string): Promise<SymbolInformation[]> {
    if (this.lsp.supports(filePath, "documentSymbols")) {
      return this.lsp.getDocumentSymbols(filePath);
    }
    return this.fallback.listDocumentSymbols(filePath);
  }

  async listWorkspaceSymbols(query: string): Promise<SymbolInformation[]> {
    if (query.length > 0) {
      return this.lsp.getWorkspaceSymbols(query);
    }
    return this.fallback.listWorkspaceSymbols(query);
  }

  async getHover(
    filePath: string,
    line: number,
    character: number,
  ): Promise<Hover | null> {
    if (this.lsp.supports(filePath, "hover")) {
      return this.lsp.getHover(filePath, line, character);
    }
    return this.fallback.getHover(filePath, line, character);
  }

  async getDiagnostics(filePath: string): Promise<Diagnostic[]> {
    if (this.lsp.supports(filePath, "diagnostics")) {
      return this.lsp.getDiagnostics(filePath);
    }
    return this.fallback.getDiagnostics(filePath);
  }

  async getCodeActions(
    filePath: string,
    line: number,
    character: number,
  ): Promise<CodeAction[]> {
    if (this.lsp.supports(filePath, "codeActions")) {
      return this.lsp.getCodeActions(filePath, line, character);
    }
    return this.fallback.getCodeActions(filePath, line, character);
  }

  async getCompletion(
    filePath: string,
    line: number,
    character: number,
  ): Promise<CompletionItem[]> {
    if (this.lsp.supports(filePath, "completion")) {
      return this.lsp.getCompletion(filePath, line, character);
    }
    return this.fallback.getCompletion(filePath, line, character);
  }

  async getSignatureHelp(
    filePath: string,
    line: number,
    character: number,
  ): Promise<SignatureHelp | null> {
    if (this.lsp.supports(filePath, "signatureHelp")) {
      return this.lsp.getSignatureHelp(filePath, line, character);
    }
    return this.fallback.getSignatureHelp(filePath, line, character);
  }

  async formatDocument(filePath: string): Promise<TextEdit[]> {
    if (this.lsp.supports(filePath, "formatting")) {
      return this.lsp.formatDocument(filePath);
    }
    return this.fallback.formatDocument(filePath);
  }

  async buildFileContext(filePath: string): Promise<FileContext> {
    try {
      if (this.lsp.supports(filePath, "documentSymbols")) {
        const [symbols, diagnostics] = await Promise.all([
          this.lsp.getDocumentSymbols(filePath),
          this.lsp.getDiagnostics(filePath),
        ]);
        return {
          path: filePath,
          symbols,
          diagnostics,
          size: this.estimateTokens(symbols, diagnostics),
        };
      }
    } catch {
      // fall through to text fallback
    }
    return this.fallback.buildFileContext(filePath);
  }

  private estimateTokens(symbols: SymbolInformation[], diagnostics: Diagnostic[]): number {
    let count = 0;
    for (const s of symbols) {
      count += s.name.length / 4 + 2;
    }
    for (const d of diagnostics) {
      const msgLen = typeof d.message === "string" ? d.message.length : 0;
      count += msgLen / 4 + 2;
    }
    return Math.max(1, Math.ceil(count));
  }
}
