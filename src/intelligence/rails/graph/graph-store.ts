/**
 * Phase 14 — persistent on-disk graph cache (better-sqlite3, same pattern
 * as memory/store.ts). Freshness is a stat-only manifest hash: same hash →
 * load the cached graph instead of rescanning.
 */

import Database from "better-sqlite3";
import { Edge, RelationshipIntent, RsiEntity } from "../types.js";
import { KnowledgeGraph } from "./graph.js";

/** Bump when the persisted shape changes; mismatched caches are discarded. */
const SCHEMA_VERSION = "1";

export class GraphStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS edges (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL,
        meta TEXT
      );
      CREATE TABLE IF NOT EXISTS intents (
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
      CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file);
      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
    `);
  }

  /** True when the cache exists and matches both schema and manifest hash. */
  isFresh(manifestHash: string): boolean {
    return (
      this.getMeta("schema_version") === SCHEMA_VERSION &&
      this.getMeta("manifest_hash") === manifestHash
    );
  }

  /** Replace the persisted graph and intent list in one transaction. */
  save(graph: KnowledgeGraph, intents: RelationshipIntent[], manifestHash: string): void {
    const insertNode = this.db.prepare(
      "INSERT INTO nodes (id, type, name, file, line, data) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertEdge = this.db.prepare("INSERT INTO edges (from_id, to_id, type, meta) VALUES (?, ?, ?, ?)");
    const insertIntent = this.db.prepare("INSERT INTO intents (data) VALUES (?)");
    const setMeta = this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");

    this.db.transaction(() => {
      this.db.exec("DELETE FROM nodes; DELETE FROM edges; DELETE FROM intents;");
      for (const entity of graph.allEntities()) {
        insertNode.run(entity.id, entity.type, entity.name, entity.file, entity.line, JSON.stringify(entity));
      }
      for (const edge of graph.allEdges()) {
        insertEdge.run(edge.from, edge.to, edge.type, edge.meta ? JSON.stringify(edge.meta) : null);
      }
      for (const intent of intents) {
        insertIntent.run(JSON.stringify(intent));
      }
      setMeta.run("schema_version", SCHEMA_VERSION);
      setMeta.run("manifest_hash", manifestHash);
      setMeta.run("saved_at", String(Date.now()));
    })();
  }

  /** Load the persisted graph into `graph`. Returns intents, or null on empty/stale-schema cache. */
  load(graph: KnowledgeGraph): RelationshipIntent[] | null {
    if (this.getMeta("schema_version") !== SCHEMA_VERSION) return null;
    const nodes = this.db.prepare("SELECT data FROM nodes").all() as { data: string }[];
    if (!nodes.length) return null;

    graph.clear();
    for (const row of nodes) {
      graph.addEntity(JSON.parse(row.data) as RsiEntity);
    }
    const edges = this.db.prepare("SELECT from_id, to_id, type, meta FROM edges").all() as {
      from_id: string;
      to_id: string;
      type: string;
      meta: string | null;
    }[];
    for (const row of edges) {
      const edge: Edge = { from: row.from_id, to: row.to_id, type: row.type as Edge["type"] };
      if (row.meta) edge.meta = JSON.parse(row.meta) as Record<string, unknown>;
      graph.addEdge(edge);
    }
    const intents = this.db.prepare("SELECT data FROM intents").all() as { data: string }[];
    return intents.map((row) => JSON.parse(row.data) as RelationshipIntent);
  }

  savedAt(): number | undefined {
    const value = this.getMeta("saved_at");
    return value ? Number(value) : undefined;
  }

  close(): void {
    this.db.close();
  }

  private getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }
}
