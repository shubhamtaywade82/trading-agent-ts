/**
 * SemanticIndex — the RSI orchestrator. Discovery gates everything: a
 * non-Rails workspace yields a disabled instance whose queries cost
 * nothing. Scanners run isolated (one failure never kills the index) and
 * emit entities plus name-based relationship intents; intents are resolved
 * into edges once every scanner has finished, so scanner order is
 * irrelevant. Unresolved intents stay dangling and queryable.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { EventBus } from "../../runtime/events.js";
import { RailsContextBuilder } from "./context-builder.js";
import { KnowledgeGraph } from "./graph/graph.js";
import { GraphStore } from "./graph/graph-store.js";
import { QueryEngine } from "./query-engine.js";
import { buildManifest, manifestHash } from "./manifest.js";
import { ConcernScanner } from "./scanners/concern-scanner.js";
import { ControllerScanner } from "./scanners/controller-scanner.js";
import { GemScanner } from "./scanners/gem-scanner.js";
import { JobScanner } from "./scanners/job-scanner.js";
import { MailerScanner } from "./scanners/mailer-scanner.js";
import { MigrationScanner } from "./scanners/migration-scanner.js";
import { ModelScanner } from "./scanners/model-scanner.js";
import { PolicyScanner } from "./scanners/policy-scanner.js";
import { RoutesScanner } from "./scanners/routes-scanner.js";
import { RspecScanner } from "./scanners/rspec-scanner.js";
import { SchemaScanner } from "./scanners/schema-scanner.js";
import { ServiceScanner } from "./scanners/service-scanner.js";
import { ViewScanner } from "./scanners/view-scanner.js";
import { discoverWorkspace } from "./workspace-discovery.js";
import {
  IndexStatus,
  ManifestCategory,
  RelationshipIntent,
  RsiOptions,
  Scanner,
  ScannerError,
  SourceFile,
  WorkspaceInfo,
  WorkspaceManifest,
} from "./types.js";

const SCANNER_CATEGORIES: Record<string, ManifestCategory[]> = {
  gem: ["gemfileLock"],
  schema: ["schema"],
  routes: ["routes"],
  model: ["models"],
  controller: ["controllers"],
  service: ["services"],
  job: ["jobs"],
  mailer: ["mailers"],
  policy: ["policies"],
  concern: ["concerns"],
  rspec: ["specs"],
  migration: ["migrations"],
  view: ["views", "components"],
};

export class SemanticIndex {
  readonly enabled: boolean;
  readonly workspace: WorkspaceInfo;
  readonly graph = new KnowledgeGraph();

  private readonly root: string;
  private readonly options: RsiOptions;
  private readonly scanners: Scanner[];
  private readonly bus?: EventBus;
  private manifest: WorkspaceManifest | null = null;
  private intents: RelationshipIntent[] = [];
  private danglingIntents: RelationshipIntent[] = [];
  private scannerErrors: ScannerError[] = [];
  private state: IndexStatus["state"] = "idle";
  private lastBuiltAt?: number;
  private lastBuildMs?: number;
  private loadedFromCache = false;
  private buildPromise: Promise<void> | null = null;
  private queryEngine: QueryEngine | null = null;
  private railsContextBuilder: RailsContextBuilder | null = null;
  private store: GraphStore | null = null;
  private storeFailed = false;

  private constructor(workspace: WorkspaceInfo, options: RsiOptions, bus?: EventBus) {
    this.workspace = workspace;
    this.root = workspace.root;
    this.enabled = workspace.isRails;
    this.options = options;
    this.bus = bus;
    this.scanners = [
      new GemScanner(),
      new SchemaScanner(),
      new RoutesScanner(),
      new ModelScanner(),
      new ControllerScanner(),
      new ServiceScanner(),
      new JobScanner(),
      new MailerScanner(),
      new PolicyScanner(),
      new ConcernScanner(),
      new RspecScanner(),
      new MigrationScanner(),
      new ViewScanner(),
    ];
  }

  static create(root: string, options: RsiOptions = {}, bus?: EventBus): SemanticIndex {
    let workspace: WorkspaceInfo;
    try {
      workspace = discoverWorkspace(root);
    } catch {
      workspace = {
        root,
        isRails: false,
        isRuby: false,
        usesZeitwerk: false,
        apiOnly: false,
        testFramework: "unknown",
        engines: [],
      };
    }
    return new SemanticIndex(workspace, options, bus);
  }

  /** Register an additional scanner (later milestones extend the core set). */
  registerScanner(scanner: Scanner): void {
    this.scanners.push(scanner);
  }

  /** Full build. Concurrent calls share one in-flight build. */
  async build(): Promise<void> {
    if (!this.enabled) return;
    if (this.buildPromise) return this.buildPromise;
    this.buildPromise = this.doBuild().finally(() => {
      this.buildPromise = null;
    });
    return this.buildPromise;
  }

  private async doBuild(): Promise<void> {
    const started = Date.now();
    this.state = "building";
    this.publish("building");
    this.scannerErrors = [];

    try {
      this.manifest = buildManifest(this.workspace);

      if (this.tryLoadCache()) {
        this.state = "ready";
        this.lastBuiltAt = Date.now();
        this.lastBuildMs = Date.now() - started;
        this.loadedFromCache = true;
        this.publish("ready");
        return;
      }

      this.graph.clear();
      this.intents = [];

      for (const scanner of this.scanners) {
        const files = this.readFilesFor(scanner);
        try {
          const result = scanner.scan(files);
          for (const entity of result.entities) this.graph.addEntity(entity);
          this.intents.push(...result.intents);
        } catch (err) {
          this.scannerErrors.push({ scanner: scanner.name, error: String(err) });
        }
      }

      // Optional exec-based scanning (e.g. `bin/rails routes`)
      if (this.options.execRoutes) {
        for (const scanner of this.scanners) {
          if (!scanner.exec) continue;
          try {
            const result = await scanner.exec(this.root);
            if (result) {
              for (const entity of result.entities) this.graph.addEntity(entity);
              this.intents.push(...result.intents);
            }
          } catch (err) {
            this.scannerErrors.push({ scanner: scanner.name, error: `exec failed: ${err}` });
          }
        }
      }

      this.resolveIntents();
      this.saveCache();

      this.state = "ready";
      this.lastBuiltAt = Date.now();
      this.lastBuildMs = Date.now() - started;
      this.loadedFromCache = false;
      this.publish("ready");
    } catch (err) {
      this.state = "error";
      this.scannerErrors.push({ scanner: "(build)", error: String(err) });
      this.publish("error");
    }
  }

  /** Incremental update after files changed on disk. */
  async update(changedRelPaths: string[]): Promise<void> {
    if (!this.enabled || this.state !== "ready") return;
    const relevant = changedRelPaths
      .map((p) => p.replace(/\\/g, "/"))
      .filter((p) => this.scanners.some((s) => s.appliesTo(p)));
    if (!relevant.length) return;

    this.manifest = buildManifest(this.workspace);

    for (const relPath of relevant) this.graph.removeByFile(relPath);
    // Intents whose source entity was just removed must go with it.
    this.intents = this.intents.filter((i) => this.graph.getEntity(i.fromId) != null);

    for (const relPath of relevant) {
      const stillExists = this.manifest.files.some((f) => f.relPath === relPath);
      if (!stillExists) continue;

      for (const scanner of this.scanners) {
        if (!scanner.appliesTo(relPath)) continue;
        try {
          const content = readFileSync(join(this.root, relPath), "utf8");
          const result = scanner.scan([{ relPath, content }]);
          for (const entity of result.entities) this.graph.addEntity(entity);
          this.intents.push(...result.intents);
        } catch (err) {
          this.scannerErrors.push({ scanner: scanner.name, error: String(err) });
        }
      }
    }

    // Re-run exec-scanners if any relevant file changed (e.g. routes.rb → bin/rails routes)
    if (this.options.execRoutes) {
      const execRelevant = relevant.some((p) => this.scanners.some((s) => s.exec && s.appliesTo(p)));
      if (execRelevant) {
        for (const scanner of this.scanners) {
          if (!scanner.exec) continue;
          try {
            const result = await scanner.exec(this.root);
            if (result) {
              for (const entity of result.entities) this.graph.addEntity(entity);
              this.intents.push(...result.intents);
            }
          } catch (err) {
            this.scannerErrors.push({ scanner: scanner.name, error: `exec failed: ${err}` });
          }
        }
      }
    }

    this.resolveIntents();
    this.saveCache();
    this.lastBuiltAt = Date.now();
    this.publish("updated");
  }

  status(): IndexStatus {
    const stats = this.graph.stats();
    return {
      enabled: this.enabled,
      reason: this.enabled ? undefined : "not a Rails workspace",
      state: this.state,
      entityCount: stats.nodes,
      edgeCount: stats.edges,
      danglingIntents: this.danglingIntents.length,
      scannerErrors: [...this.scannerErrors],
      lastBuiltAt: this.lastBuiltAt,
      lastBuildMs: this.lastBuildMs,
      loadedFromCache: this.loadedFromCache,
      railsVersion: this.manifest?.workspace.railsVersion,
      rubyVersion: this.manifest?.workspace.rubyVersion,
      testFramework: this.manifest?.workspace.testFramework,
      byType: stats.byType,
    };
  }

  getManifest(): WorkspaceManifest | null {
    return this.manifest;
  }

  get query(): QueryEngine {
    if (!this.queryEngine) this.queryEngine = new QueryEngine(this.graph);
    return this.queryEngine;
  }

  get contextBuilder(): RailsContextBuilder {
    if (!this.railsContextBuilder) {
      this.railsContextBuilder = new RailsContextBuilder(this.query, this.graph, this.workspace);
    }
    return this.railsContextBuilder;
  }

  dispose(): void {
    this.closeCache();
    this.graph.clear();
  }

  // ─── internals ─────────────────────────────────────────────────────────

  private readFilesFor(scanner: Scanner): SourceFile[] {
    if (!this.manifest) return [];
    const categories = SCANNER_CATEGORIES[scanner.name] ?? [];
    const files: SourceFile[] = [];
    for (const category of categories) {
      for (const entry of this.manifest.categories[category] ?? []) {
        try {
          files.push({ relPath: entry.relPath, content: readFileSync(join(this.root, entry.relPath), "utf8") });
        } catch {
          // deleted between manifest and read — skip
        }
      }
    }
    return files;
  }

  /**
   * Resolve name-based intents into concrete edges. Runs over the full
   * intent list every time — it is in-memory and cheap relative to IO.
   */
  private resolveIntents(): void {
    this.graph.clearEdges();
    this.danglingIntents = [];
    for (const intent of this.intents) {
      if (!this.graph.getEntity(intent.fromId)) continue;
      const targets = this.graph.findByName(intent.toName, intent.toType);
      if (targets.length) {
        // `inverted` intents (e.g. spec → subject) flip so the edge reads
        // naturally: subject —tested_by→ spec.
        const inverted = intent.meta?.inverted === true;
        this.graph.addEdge({
          from: inverted ? targets[0].id : intent.fromId,
          to: inverted ? intent.fromId : targets[0].id,
          type: intent.relationship,
          meta: intent.meta,
        });
      } else {
        this.danglingIntents.push(intent);
      }
    }
  }

  private publish(status: "building" | "ready" | "updated" | "disabled" | "error"): void {
    if (!this.bus) return;
    const stats = this.graph.stats();
    this.bus.publish({
      type: "rails.index",
      status,
      entityCount: stats.nodes,
      edgeCount: stats.edges,
      scannerErrors: this.scannerErrors.map((e) => `${e.scanner}: ${e.error}`),
      durationMs: this.lastBuildMs,
      railsVersion: this.manifest?.workspace.railsVersion,
      rubyVersion: this.manifest?.workspace.rubyVersion,
      testFramework: this.manifest?.workspace.testFramework,
      byType: stats.byType,
    });
  }

  private getStore(): GraphStore | null {
    if (!this.options.cachePath || this.storeFailed) return null;
    if (!this.store) {
      try {
        this.store = new GraphStore(this.options.cachePath);
      } catch {
        // sqlite unavailable (native module mismatch, read-only fs, ...):
        // the index still works, it just rebuilds on every start.
        this.storeFailed = true;
        return null;
      }
    }
    return this.store;
  }

  private tryLoadCache(): boolean {
    const store = this.getStore();
    if (!store || !this.manifest) return false;
    try {
      if (!store.isFresh(manifestHash(this.manifest))) return false;
      const intents = store.load(this.graph);
      if (intents == null) return false;
      this.intents = intents;
      this.danglingIntents = intents.filter(
        (i) => this.graph.getEntity(i.fromId) != null && !this.graph.findByName(i.toName, i.toType).length,
      );
      return true;
    } catch {
      return false;
    }
  }

  private saveCache(): void {
    const store = this.getStore();
    if (!store || !this.manifest) return;
    try {
      store.save(this.graph, this.intents, manifestHash(this.manifest));
    } catch {
      this.storeFailed = true;
    }
  }

  private closeCache(): void {
    try {
      this.store?.close();
    } catch {
      // already closed
    }
    this.store = null;
  }
}

export { manifestHash };
