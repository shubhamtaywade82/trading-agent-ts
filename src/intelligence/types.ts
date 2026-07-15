import type { Location, SymbolInformation, Hover, Diagnostic, CodeAction, CompletionItem, SignatureHelp, TextEdit } from "vscode-languageserver-protocol";

export type SemanticOperation =
  | "definition" | "references" | "documentSymbols" | "workspaceSymbols"
  | "hover" | "diagnostics" | "codeActions" | "rename"
  | "completion" | "signatureHelp" | "formatting" | "semanticTokens";

export type PluginKind = "language" | "framework" | "repository";

export interface SemanticPlugin {
  readonly id: string;
  readonly kind: PluginKind;
  readonly name: string;
  supportsOperation(filePath: string, op: SemanticOperation): boolean;
  detect(): boolean;

  discover(): Promise<DiscoveredEntity[]>;
  update(changedFiles: string[]): Promise<void>;
  query(query: SemanticQuery): Promise<QueryResult[]>;
}

export interface DiscoveredEntity {
  type: string;
  name: string;
  filePath: string;
  metadata: Record<string, unknown>;
}

export interface SemanticQuery {
  kind: "symbol" | "dependency" | "callgraph" | "type" | "route" | "association" | "custom";
  term: string;
  scope?: string;
  filters?: Record<string, unknown>;
}

export interface QueryResult {
  pluginId: string;
  entity: DiscoveredEntity;
  score: number;
  relationships: string[];
}

export interface CompositeResult {
  results: QueryResult[];
  byPlugin: Map<string, QueryResult[]>;
  summary: string;
}
