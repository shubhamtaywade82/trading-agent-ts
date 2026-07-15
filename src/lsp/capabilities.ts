import type { ServerCapabilities } from "vscode-languageserver-protocol";

/**
 * Client capabilities advertised during `initialize`. Without these many
 * servers silently disable features — e.g. typescript-language-server only
 * pushes publishDiagnostics when the client declares support for them.
 */
export const CLIENT_CAPABILITIES: Record<string, unknown> = {
  textDocument: {
    synchronization: { didSave: true, dynamicRegistration: false },
    publishDiagnostics: { relatedInformation: true },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
    hover: { contentFormat: ["markdown", "plaintext"] },
    definition: { linkSupport: true },
    references: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    completion: { completionItem: { snippetSupport: false }, contextSupport: true },
    signatureHelp: {},
    codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "refactor", "source"] } } },
    rename: { prepareSupport: false },
    formatting: {},
    semanticTokens: {
      requests: { full: true },
      tokenTypes: [],
      tokenModifiers: [],
      formats: ["relative"],
    },
  },
  workspace: {
    symbol: {},
    workspaceFolders: true,
  },
};

export interface LspCapabilities {
  hover: boolean;
  completion: boolean;
  rename: boolean;
  definition: boolean;
  references: boolean;
  diagnostics: boolean;
  semanticTokens: boolean;
  formatting: boolean;
  codeAction: boolean;
  signatureHelp: boolean;
  documentSymbol: boolean;
  workspaceSymbol: boolean;
  /** Server supports pull diagnostics (textDocument/diagnostic). */
  pullDiagnostics: boolean;
}

export function deriveCapabilities(serverCaps: ServerCapabilities): LspCapabilities {
  const textDocument = serverCaps.textDocumentSync !== undefined;
  return {
    hover: !!serverCaps.hoverProvider,
    completion: !!serverCaps.completionProvider,
    rename: !!serverCaps.renameProvider,
    definition: !!(
      serverCaps.definitionProvider ||
      serverCaps.typeDefinitionProvider ||
      serverCaps.implementationProvider
    ),
    references: !!serverCaps.referencesProvider,
    diagnostics: textDocument && !!serverCaps.codeActionProvider,
    semanticTokens:
      !!serverCaps.semanticTokensProvider &&
      typeof serverCaps.semanticTokensProvider !== "boolean",
    formatting: !!serverCaps.documentFormattingProvider,
    codeAction: !!serverCaps.codeActionProvider,
    signatureHelp: !!serverCaps.signatureHelpProvider,
    documentSymbol: !!serverCaps.documentSymbolProvider,
    workspaceSymbol: !!serverCaps.workspaceSymbolProvider,
    pullDiagnostics: !!serverCaps.diagnosticProvider,
  };
}

export const NO_CAPABILITIES: LspCapabilities = {
  hover: false,
  completion: false,
  rename: false,
  definition: false,
  references: false,
  diagnostics: false,
  semanticTokens: false,
  formatting: false,
  codeAction: false,
  signatureHelp: false,
  documentSymbol: false,
  workspaceSymbol: false,
  pullDiagnostics: false,
};
