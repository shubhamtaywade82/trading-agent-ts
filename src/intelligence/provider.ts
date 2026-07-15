import type { Location, SymbolInformation, Hover, Diagnostic, CodeAction, CompletionItem, SignatureHelp, TextEdit } from "vscode-languageserver-protocol";

export type SemanticOperation =
  | "definition"
  | "references"
  | "documentSymbols"
  | "workspaceSymbols"
  | "hover"
  | "diagnostics"
  | "codeActions"
  | "rename"
  | "completion"
  | "signatureHelp"
  | "formatting"
  | "semanticTokens";

export interface FileContext {
  path: string;
  symbols?: SymbolInformation[];
  diagnostics?: Diagnostic[];
  content?: string;
  size: number;
}

export interface LanguageIntelligenceProvider {
  supportsOperation(filePath: string, op: SemanticOperation): boolean;
  findDefinition(filePath: string, line: number, character: number): Promise<Location[]>;
  findReferences(filePath: string, line: number, character: number, includeDeclaration?: boolean): Promise<Location[]>;
  listDocumentSymbols(filePath: string): Promise<SymbolInformation[]>;
  listWorkspaceSymbols(query: string): Promise<SymbolInformation[]>;
  getHover(filePath: string, line: number, character: number): Promise<Hover | null>;
  getDiagnostics(filePath: string): Promise<Diagnostic[]>;
  getCodeActions(filePath: string, line: number, character: number): Promise<CodeAction[]>;
  getCompletion(filePath: string, line: number, character: number): Promise<CompletionItem[]>;
  getSignatureHelp(filePath: string, line: number, character: number): Promise<SignatureHelp | null>;
  formatDocument(filePath: string): Promise<TextEdit[]>;
  buildFileContext(filePath: string): Promise<FileContext>;
}
