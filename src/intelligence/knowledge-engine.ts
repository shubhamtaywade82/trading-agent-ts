import type { SemanticPlugin, SemanticQuery, CompositeResult, QueryResult, DiscoveredEntity } from "./types.js";

export class WorkspaceKnowledgeEngine {
  private plugins: SemanticPlugin[] = [];

  register(plugin: SemanticPlugin): this {
    this.plugins.push(plugin);
    return this;
  }

  getPlugins(): SemanticPlugin[] {
    return [...this.plugins];
  }

  getPlugin(id: string): SemanticPlugin | undefined {
    return this.plugins.find((p) => p.id === id);
  }

  getPluginsByKind(kind: string): SemanticPlugin[] {
    return this.plugins.filter((p) => p.kind === kind);
  }

  async discoverAll(): Promise<Map<string, DiscoveredEntity[]>> {
    const results = new Map<string, DiscoveredEntity[]>();
    const entries = await Promise.allSettled(
      this.plugins.map(async (plugin) => {
        if (!plugin.detect()) return { id: plugin.id, entities: [] };
        const entities = await plugin.discover();
        return { id: plugin.id, entities };
      }),
    );
    for (const entry of entries) {
      if (entry.status === "fulfilled") {
        results.set(entry.value.id, entry.value.entities);
      }
    }
    return results;
  }

  async updateAll(changedFiles: string[]): Promise<void> {
    await Promise.allSettled(
      this.plugins.map((plugin) => {
        if (!plugin.detect()) return Promise.resolve();
        return plugin.update(changedFiles);
      }),
    );
  }

  async query(query: SemanticQuery): Promise<CompositeResult> {
    const byPlugin = new Map<string, QueryResult[]>();
    const all: QueryResult[] = [];

    const entries = await Promise.allSettled(
      this.plugins.map(async (plugin) => {
        if (!plugin.detect()) return [];
        return plugin.query(query);
      }),
    );

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.status === "fulfilled") {
        const results = entry.value;
        byPlugin.set(this.plugins[i].id, results);
        all.push(...results);
      }
    }

    all.sort((a, b) => b.score - a.score);

    return {
      results: all,
      byPlugin,
      summary: all.length > 0
        ? `Found ${all.length} result(s) across ${byPlugin.size} plugin(s)`
        : "No results found",
    };
  }
}
