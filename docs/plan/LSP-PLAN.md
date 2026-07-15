Let me explore the current codebase to understand the existing architecture before formulating the plan.
âExplore Task â Explore current codebase architecture
â³ 53 toolcalls Â· 2m 10s
ctrl+x down view subagents

+ Thought: 30.5s
Now let me examine a few key files to understand integration points more precisely.
âRead src/runtime/types.ts
âRead src/runtime/events.ts
âRead src/runtime/store.ts
+ Thought: 324ms
âRead src/tools/registry.ts
âRead src/agent.ts
âRead src/tools/tool.ts
+ Thought: 354ms
â±Glob "src/**/agent*.ts" in . (3 matches)
âRead src/provider/provider.ts
âRead src/provider/router.ts
+ Thought: 423ms
âRead src/cli/agent.ts
âRead src/tui/agent-bridge.ts
âRead src/mcp/client.ts
+ Thought: 578ms
âRead src/cli/config.ts
âExplore Task â Explore TUI and orchestrator files
â³ 38 toolcalls Â· 1m 10s
ctrl+x down view subagents
+ Thought: 2.0s
Now I have a complete picture. Let me present the plan.
LSP Integration Plan for DevAgent-TS
Overview
This is a horizontal architecture layer â not a single feature. It touches the tool system, runtime state, event bus, TUI, planner, and adds an entirely new subsystem (src/lsp/ + src/intelligence/).
Based on the codebase analysis, here is the phased plan:
Phase 1: Foundation â LSP Manager & Protocol Layer
New dependencies (package.json):

- vscode-languageserver-protocol â Protocol message types (InitializeParams, Diagnostic, Location, etc.)
+ vscode-languageserver-types â Position, Range, SymbolInformation, etc.
+ (No vscode-languageclient â it's tied to VS Code's API; we build a lean client)
New files:
File Purpose
src/lsp/protocol.ts Re-export LSP types, pathToUri/uriToPath helpers
src/lsp/client.ts JSON-RPC over stdio â sendRequest(method, params), sendNotification(method, params), handles Content-Length framing, response-ID matching
src/lsp/session.ts LspServerSession â wraps a spawned LSP server process with its capabilities, open documents map, pending request map, and lifecycle state
src/lsp/registry.ts LanguageRegistry â maps extensions â provider config via static built-in table + user config override
src/lsp/capabilities.ts LspCapabilities struct, derives from ServerCapabilities.InitializeResult
src/lsp/pool.ts LspPool â tracks running/idle/stopped sessions per workspace, enforces maxServers and idle timeout
src/lsp/manager.ts LspManager â the main actor: owns the pool, provides high-level API (findDefinition, getReferences, etc.), manages file open/change/close lifecycle
src/lsp/config.ts Types for language provider config (which servers to start, their args)
Key design decisions:
+ JSON-RPC over stdio: LSP uses Content-Length: N\r\n\r\n{...} framing. We implement this directly using Node ChildProcess.spawn() with stdin/stdout pipes. This avoids heavyweight SDK dependencies.
+ Per-workspace isolation: Each unique workspace root gets its own server session per language. The key is workspacePath + languageId.
+ File tracking: Each LspServerSession tracks which documents are open (didOpen/didClose), and sends didChange on file modifications. Documents are tracked by URI.
Phase 2: Semantic Tools â 12 New LSP-Powered Tools
New file: src/tools/lsp-tools.ts
Each tool extends the existing Tool base class and follows the same pattern as SearchCodeTool (parameters as JSON schema, returns structured JSON):
Tool Name LSP Method
get_definition textDocument/definition
find_references textDocument/references
rename_symbol textDocument/rename
workspace_symbols workspace/symbol
document_symbols textDocument/documentSymbol
hover textDocument/hover
diagnostics (pushed via textDocument/publishDiagnostics, cached)
code_actions textDocument/codeAction
format_document textDocument/formatting
signature_help textDocument/signatureHelp
completion textDocument/completion
semantic_tokens textDocument/semanticTokens/full
Integration with existing Registry â registered in Agent constructor (e.g., agent.ts:86-104):
this.registry.register(new GetDefinitionTool(lspManager))
    .register(new FindReferencesTool(lspManager))
    // ...
Guard: Each tool checks LspManager.supports(filePath, operation) before executing, returning a clear error if the LSP is not available for that file type.
Phase 3: Language Intelligence Layer (Abstract Router)
New directory: src/intelligence/
This is the abstraction that ensures the planner never knows which backend produced the result.
src/intelligence/provider.ts:
interface LanguageIntelligenceProvider {
  findDefinition(path, line, char): Promise<Location[]>;
  findReferences(path, line, char): Promise<Location[]>;
  listDocumentSymbols(path): Promise<SymbolInformation[]>;
  listWorkspaceSymbols(query): Promise<SymbolInformation[]>;
  getHover(path, line, char): Promise<Hover | null>;
  getDiagnostics(path): Promise<Diagnostic[]>;
  // ... one method per SemanticOperation
}
src/intelligence/router.ts â LanguageIntelligenceRouter implements the interface with a priority chain:

1. LSP (if server is running for this language and supports the operation)
2. Tree-sitter (if available for this language, Phase 4)
3. Text fallback (wraps existing SearchCodeTool + ReadFileTool for grep-level answers)
src/intelligence/context-builder.ts â The key planner integration:
class SemanticContextBuilder {
  async buildContext(filePath: string): FileContext {
    // Returns: { symbols, diagnostics, imports, dependencies }
    // Instead of loading 5000 lines, sends ~300 tokens of structured info
    // Only reads full file content when LSP is unavailable
  }
}
Phase 4: Runtime Integration
Modified files:
src/runtime/types.ts:

- Add "lsp" to ActorId union (line 10)
+ Add LspServerState interface:
interface LspServerState {
  language: string;
  status: "starting" | "running" | "idle" | "stopped" | "error";
  documentsCount: number;
}
+ Add lspServers: LspServerState[] to RuntimeState (line 206)
+ Add "lsp" to VIEW_ORDER and ActorId list
src/runtime/events.ts:
+ Add { type: "lsp.changed"; servers: LspServerState[] }
+ Add { type: "lsp.diagnostics"; path: string; diagnostics: Diagnostic[] }
src/runtime/store.ts:
+ Add lsp.changed and lsp.diagnostics cases to reduce()
+ Initialize lspServers: [] in initialRuntimeState()
src/tui/agent-bridge.ts:
+ Wire additional events if needed (LSP diagnostics can flow through the existing logging system)
Phase 5: TUI Integration
src/tui/zones/ActivityStrip.tsx â Add LSP actor token:
Format: "LSP" with detail "TS:1 Rb:1 Py:0"
Color: green = all running, yellow = some idle, red = any error, gray = no servers
New overlay src/tui/overlays/LspOverlay.tsx (or extend ActorsOverlay):
Running:
  TypeScript   Ready   3 docs
  Ruby         Running 1 doc
  Python       Sleeping
  Go           Stopped
Diagnostics display â Add a diagnostics count to the status strip or as part of the execution view. Can increment the detail field on the LSP actor when diagnostics exist.
Add "lsp" to the view system â src/tui/index.ts VIEWS map. LSP view shows running/providers/diagnostics.
Phase 6: Config & Startup Integration
src/cli/config.ts â Add language provider config fields:
interface CliConfig {
  // existing fields...
  languages?: Record<string, LanguageProviderConfig>;
  lsp?: {
    idleTimeoutMs?: number;
    maxServers?: number;
    prewarm?: string[];
  };
}
src/cli/agent.ts â Modified constructor:
constructor(opts) {
  // existing init...
  this.lspManager = new LspManager({
    registry: LanguageRegistry.fromConfig(cfg.languages),
    workspaceRoot: cfg.workspaceRoot,
    pool: new LspPool({ idleTimeoutMs: cfg.lsp?.idleTimeoutMs ?? 300_000 }),
    bus,
  });

  // Register LSP tools
  this.registry
    .register(new GetDefinitionTool(this.lspManager))
    // ... all 12 LSP tools

  // Prewarm selected language servers
  for (const ext of cfg.lsp?.prewarm ?? ['.ts', '.tsx']) {
    this.lspManager.ensureServerForExtension(ext);
  }
}
src/tui/index.ts â Add lspManager to shellAgent facade for diagnostics display in TUI.
Phase 7: Planner Integration (Semantic Context Building)
src/orchestrator/context-builder.ts (new file):
+ Planner calls contextBuilder.build(filePath) instead of readFile(filePath) directly
+ Returns structured context: symbols (names + kinds + ranges), diagnostics, imports
+ Full file content is loaded only when LSP is unavailable or when the LLM specifically requests it
File-level priority in planner's system prompt:
When analyzing a file:

1. Use document_symbols to understand structure (classes, functions, imports)
2. Use hover for type information on specific symbols
3. Use diagnostics to find issues
4. Only use read_file when you need to see exact line content
Phase 8 (Future): Tree-sitter Fallback
Dependency: web-tree-sitter
src/intelligence/tree-sitter.ts:

- Load WASM grammars for languages where LSP is unavailable
+ Provides AST queries for document_symbols, definition (basic), references (basic)
+ Activated only when LanguageIntelligenceRouter.supports() returns true for Tree-sitter but false for LSP
Files Summary
New files (15):
src/lsp/protocol.ts
src/lsp/client.ts
src/lsp/session.ts
src/lsp/registry.ts
src/lsp/capabilities.ts
src/lsp/pool.ts
src/lsp/manager.ts
src/lsp/config.ts
src/tools/lsp-tools.ts          (single file, all 12 tools)
src/intelligence/provider.ts
src/intelligence/router.ts
src/intelligence/context-builder.ts
src/intelligence/tree-sitter.ts  (Phase 8)
src/tui/overlays/LspOverlay.tsx
Modified files (10):
package.json                     -- add deps
src/cli/config.ts                -- add LSP config fields
src/cli/agent.ts                 -- init LSP manager, register tools, prewarm
src/runtime/types.ts             -- add ActorId "lsp", LspServerState, lspServers in state
src/runtime/events.ts            -- add lsp.changed, lsp.diagnostics events
src/runtime/store.ts             -- handle new events in reducer
src/tui/index.ts                 -- add LSP view, shellAgent facade
src/tui/zones/ActivityStrip.tsx   -- add LSP actor token
src/tui/agent-bridge.ts          -- wire LSP events to bus
src/orchestrator/                -- (Phase 7) context builder integration
Key Questions for You

# Questions

What order should we implement the phases?
All at once (phases 1-7 in order)
Which language servers should we support initially?
All built-in registry languages
How should the new semantic tools coexist with existing text tools?
Keep both, let planner choose
