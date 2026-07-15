import * as fs from "node:fs";
import * as path from "node:path";
import { parseAslFile, validateTaskSpec } from "../asl/parser.js";
import { getAslFiles } from "../asl/commands.js";
import { AslTaskSpec } from "../asl/types.js";
import { SemanticPlugin, DiscoveredEntity, SemanticQuery, QueryResult, PluginKind } from "./types.js";
import { SemanticOperation } from "../lsp/manager.js";

export class AslSemanticPlugin implements SemanticPlugin {
  readonly id = "asl";
  readonly kind: PluginKind = "repository";
  readonly name = "Agent Specification Language";

  private entities: DiscoveredEntity[] = [];

  constructor(private readonly workspaceRoot: string) {}

  supportsOperation(_filePath: string, op: SemanticOperation): boolean {
    return op === "workspaceSymbols" || op === "documentSymbols";
  }

  detect(): boolean {
    const devagentDir = path.join(this.workspaceRoot, ".devagent");
    return fs.existsSync(devagentDir);
  }

  async discover(): Promise<DiscoveredEntity[]> {
    const devagentDir = path.join(this.workspaceRoot, ".devagent");
    if (!fs.existsSync(devagentDir)) {
      this.entities = [];
      return [];
    }

    const files = getAslFiles(devagentDir).filter((f) => f.includes("/tasks/"));
    const discovered: DiscoveredEntity[] = [];

    for (const file of files) {
      try {
        const parsed = parseAslFile<AslTaskSpec>(file);
        if (validateTaskSpec(parsed.frontmatter, file).length === 0) {
          const spec = parsed.frontmatter;
          if (spec.targets) {
            for (const target of spec.targets) {
              if (target.entity) {
                discovered.push({
                  type: "AslTaskTarget",
                  name: target.entity,
                  filePath: file,
                  metadata: {
                    taskId: spec.id,
                    taskTitle: spec.title,
                    status: spec.status,
                    kind: spec.kind,
                  },
                });
              }
            }
          }
        }
      } catch {
        // Skip unparseable files
      }
    }

    this.entities = discovered;
    return discovered;
  }

  async update(_changedFiles: string[]): Promise<void> {
    await this.discover();
  }

  async query(query: SemanticQuery): Promise<QueryResult[]> {
    if (query.kind === "symbol" && query.term) {
      const results: QueryResult[] = [];
      const termLower = query.term.toLowerCase();

      for (const ent of this.entities) {
        if (ent.name.toLowerCase().includes(termLower)) {
          results.push({
            pluginId: this.id,
            entity: ent,
            score: ent.name.toLowerCase() === termLower ? 1.0 : 0.8,
            relationships: [],
          });
        }
      }
      return results;
    }
    return [];
  }
}
