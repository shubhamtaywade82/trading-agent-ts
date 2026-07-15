import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { LspManager } from "../lsp/manager.js";
import { LanguageRegistry } from "../lsp/registry.js";
import { SemanticIndex } from "../intelligence/rails/index.js";
import { WorkspaceKnowledgeEngine } from "../intelligence/knowledge-engine.js";
import { LspSemanticPlugin } from "../intelligence/semantic-plugin.js";
import { RailsSemanticPlugin } from "../intelligence/rails/rails-plugin.js";
import { AslSemanticPlugin } from "../intelligence/asl-plugin.js";
import type { SemanticQuery, CompositeResult } from "../intelligence/types.js";
import type { LspServerState } from "../lsp/protocol.js";

export interface AgentIntelligenceOptions {
  workspaceRoot: string;
  languages?: Record<string, Partial<import("../lsp/registry.js").LanguageProviderConfig>>;
  lspConfig?: import("../lsp/config.js").LspGlobalConfig;
  prewarm?: string[];
  onDiagnostics?: (filePath: string, diagnostics: unknown[]) => void;
  onServerStateChange?: (servers: LspServerState[]) => void;
}

export class AgentIntelligence {
  readonly lspManager: LspManager;
  readonly railsIndex: SemanticIndex;
  readonly knowledgeEngine: WorkspaceKnowledgeEngine;

  constructor(opts: AgentIntelligenceOptions) {
    const langRegistry = new LanguageRegistry(
      opts.languages as Record<string, Partial<import("../lsp/registry.js").LanguageProviderConfig>> | undefined,
    );

    this.lspManager = new LspManager({
      workspaceRoot: opts.workspaceRoot,
      registry: langRegistry,
      lspConfig: opts.lspConfig ?? {},
      events: {
        onDiagnostics: opts.onDiagnostics,
        onServerStateChange: opts.onServerStateChange,
      },
    });

    if (opts.prewarm && opts.prewarm.length > 0) {
      this.lspManager.prewarm(opts.prewarm).catch(() => {});
    }

    const devagentDir = join(opts.workspaceRoot, ".devagent");
    mkdirSync(devagentDir, { recursive: true });

    this.railsIndex = SemanticIndex.create(opts.workspaceRoot, {
      cachePath: join(devagentDir, "rails-index.db"),
    });

    if (this.railsIndex.enabled) {
      this.railsIndex.build().catch(() => {});
    }

    this.knowledgeEngine = new WorkspaceKnowledgeEngine();
    this.knowledgeEngine.register(new LspSemanticPlugin(this.lspManager));
    this.knowledgeEngine.register(new RailsSemanticPlugin(this.railsIndex));
    this.knowledgeEngine.register(new AslSemanticPlugin(opts.workspaceRoot));
  }

  feedRailsIndex(toolName: string, args: Record<string, unknown>, result: Record<string, unknown>): void {
    if (!this.railsIndex.enabled || result.error) return;
    const MUTATING = new Set(["write_file", "patch_file", "append_file", "delete_file", "move_file", "copy_file"]);
    if (!MUTATING.has(toolName)) return;
    const paths = [args.path, args.source, args.destination, args.from, args.to].filter(
      (p): p is string => typeof p === "string" && (p.endsWith(".rb") || p.endsWith("Gemfile.lock")),
    );
    if (paths.length) this.railsIndex.update(paths).catch(() => {});
  }

  async semanticQuery(query: SemanticQuery): Promise<CompositeResult> {
    return this.knowledgeEngine.query(query);
  }

  get enabledPlugins(): string[] {
    return this.knowledgeEngine
      .getPlugins()
      .filter((p) => p.detect())
      .map((p) => p.id);
  }
}
