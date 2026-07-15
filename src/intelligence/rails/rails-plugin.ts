import { SemanticIndex } from "./indexer.js";
import type { RsiEntity } from "./types.js";
import type { SemanticPlugin, DiscoveredEntity, SemanticQuery, QueryResult, PluginKind } from "../types.js";
import type { SemanticOperation } from "../../lsp/manager.js";

export class RailsSemanticPlugin implements SemanticPlugin {
  readonly id = "rails";
  readonly kind: PluginKind = "framework";
  readonly name = "Rails Semantic Index";

  constructor(private readonly index: SemanticIndex) {}

  supportsOperation(_filePath: string, _op: SemanticOperation): boolean {
    return false;
  }

  detect(): boolean {
    return this.index.enabled;
  }

  async discover(): Promise<DiscoveredEntity[]> {
    if (!this.index.enabled) return [];
    await this.index.build();
    return this.index.graph.allEntities().map((entity) => ({
      type: entity.type,
      name: entity.name,
      filePath: entity.file,
      metadata: { line: entity.line },
    }));
  }

  async update(changedFiles: string[]): Promise<void> {
    if (!this.index.enabled) return;
    await this.index.update(changedFiles);
  }

  async query(query: SemanticQuery): Promise<QueryResult[]> {
    if (!this.index.enabled) return [];
    const results: QueryResult[] = [];

    const collectRelationships = (id: string): string[] => {
      const out = this.index.graph.edgesFrom(id).map((e) => `${e.type} ${e.to.split(":")[1] ?? e.to}`);
      const inc = this.index.graph.edgesTo(id).map((e) => `${e.type} ${e.from.split(":")[1] ?? e.from}`);
      return [...out, ...inc];
    };

    const addEntity = (entity: RsiEntity) => {
      results.push({
        pluginId: this.id,
        entity: { type: entity.type, name: entity.name, filePath: entity.file, metadata: { line: entity.line } },
        score: 1,
        relationships: collectRelationships(entity.id),
      });
    };

    const entities = this.index.graph.allEntities();
    switch (query.kind) {
      case "route":
        this.index.graph.findByName(query.term, "route").forEach(addEntity);
        break;
      case "association":
        this.index.graph.findByName(query.term, "model").forEach(addEntity);
        break;
      case "symbol":
      case "custom":
      default:
        this.index.graph.findByName(query.term).forEach(addEntity);
        break;
    }

    return results;
  }
}
