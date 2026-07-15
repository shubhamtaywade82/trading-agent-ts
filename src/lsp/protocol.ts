export type {
  Position,
  Range,
  Location,
  LocationLink,
  Diagnostic,
  DiagnosticSeverity,
  SymbolInformation,
  DocumentSymbol,
  SymbolKind,
  Hover,
  MarkupContent,
  MarkedString,
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  TextEdit,
  TextDocumentEdit,
  WorkspaceEdit,
  CodeAction,
  CodeActionKind,
  SemanticTokens,
  SemanticTokensDelta,
  ServerCapabilities,
  InitializeResult,
  TextDocumentContentChangeEvent,
  DidChangeTextDocumentParams,
  DidOpenTextDocumentParams,
  DidCloseTextDocumentParams,
  PublishDiagnosticsParams,
  DocumentFormattingParams,
  ReferenceParams,
  DefinitionParams,
  HoverParams,
  DocumentSymbolParams,
  CodeActionParams,
  RenameParams,
  CompletionParams,
  SignatureHelpParams,
  SemanticTokensParams,
  WorkspaceSymbolParams,
} from "vscode-languageserver-protocol";

import { URI } from "vscode-uri";

export function pathToUri(workspaceRoot: string, filePath: string): string {
  const absolute = filePath.startsWith("/") ? filePath : `${workspaceRoot}/${filePath}`;
  return URI.file(absolute).toString();
}

export function uriToPath(uri: string): string {
  return URI.parse(uri).fsPath;
}

export function lspSeverityToLabel(
  severity: number | undefined,
): "error" | "warning" | "info" | "hint" {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return "info";
  }
}

export interface LspServerState {
  language: string;
  status: "starting" | "running" | "idle" | "stopped" | "error";
  documentsCount: number;
  errorCount: number;
  /** True while the server has an open $/progress span (e.g. project
   * indexing) — "running" alone can't tell "no results" from "not indexed
   * yet"; queries made while this is true may return incomplete results. */
  indexing: boolean;
}
