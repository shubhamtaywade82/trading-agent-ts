/**
 * Phases 4–7 — the in-memory knowledge graph. Entities are nodes keyed by
 * stable id (`${type}:${name}`); edges carry a RelationshipType. Secondary
 * indexes give O(1) lookup by type, name, and file; `removeByFile` is the
 * primitive incremental updates are built on.
 */

import { Edge, EntityType, RelationshipType, RsiEntity } from "../types.js";

export interface TraverseOptions {
  direction?: "out" | "in" | "both";
  edgeTypes?: RelationshipType[];
  maxDepth?: number;
}

export interface TraversalNode {
  entity: RsiEntity;
  depth: number;
  /** Edge that led to this node (undefined for the start node). */
  via?: Edge;
}

export interface GraphStats {
  nodes: number;
  edges: number;
  byType: Record<string, number>;
  files: number;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[_:]/g, "");
}

export class KnowledgeGraph {
  private entities = new Map<string, RsiEntity>();
  private edges: Edge[] = [];
  private outgoing = new Map<string, Edge[]>();
  private incoming = new Map<string, Edge[]>();
  private byType = new Map<EntityType, Set<string>>();
  private byName = new Map<string, Set<string>>();
  private byFile = new Map<string, Set<string>>();

  addEntity(entity: RsiEntity): void {
    if (this.entities.has(entity.id)) this.removeEntity(entity.id);
    this.entities.set(entity.id, entity);
    indexAdd(this.byType, entity.type, entity.id);
    indexAdd(this.byName, normalizeName(entity.name), entity.id);
    indexAdd(this.byFile, entity.file, entity.id);
  }

  removeEntity(id: string): void {
    const entity = this.entities.get(id);
    if (!entity) return;
    this.entities.delete(id);
    indexRemove(this.byType, entity.type, id);
    indexRemove(this.byName, normalizeName(entity.name), id);
    indexRemove(this.byFile, entity.file, id);
    this.removeEdgesFor(id);
  }

  /** Drop every entity extracted from a file, along with their edges. */
  removeByFile(relPath: string): string[] {
    const ids = [...(this.byFile.get(relPath) ?? [])];
    for (const id of ids) this.removeEntity(id);
    return ids;
  }

  addEdge(edge: Edge): void {
    this.edges.push(edge);
    indexPush(this.outgoing, edge.from, edge);
    indexPush(this.incoming, edge.to, edge);
  }

  removeEdgesFor(id: string): void {
    const touched = [...(this.outgoing.get(id) ?? []), ...(this.incoming.get(id) ?? [])];
    if (!touched.length) return;
    const gone = new Set(touched);
    this.edges = this.edges.filter((e) => !gone.has(e));
    this.outgoing.delete(id);
    this.incoming.delete(id);
    for (const edge of touched) {
      const other = edge.from === id ? edge.to : edge.from;
      const otherOut = this.outgoing.get(other);
      if (otherOut) this.outgoing.set(other, otherOut.filter((e) => !gone.has(e)));
      const otherIn = this.incoming.get(other);
      if (otherIn) this.incoming.set(other, otherIn.filter((e) => !gone.has(e)));
    }
  }

  /** Remove all edges (used before re-resolving relationship intents). */
  clearEdges(): void {
    this.edges = [];
    this.outgoing.clear();
    this.incoming.clear();
  }

  getEntity(id: string): RsiEntity | undefined {
    return this.entities.get(id);
  }

  /** Case/underscore-insensitive name lookup, optionally scoped to a type. */
  findByName(name: string, type?: EntityType): RsiEntity[] {
    const ids = this.byName.get(normalizeName(name)) ?? new Set();
    const found = [...ids]
      .map((id) => this.entities.get(id))
      .filter((e): e is RsiEntity => e != null);
    return type ? found.filter((e) => e.type === type) : found;
  }

  findByType(type: EntityType): RsiEntity[] {
    return [...(this.byType.get(type) ?? [])]
      .map((id) => this.entities.get(id))
      .filter((e): e is RsiEntity => e != null);
  }

  findByFile(relPath: string): RsiEntity[] {
    return [...(this.byFile.get(relPath) ?? [])]
      .map((id) => this.entities.get(id))
      .filter((e): e is RsiEntity => e != null);
  }

  edgesFrom(id: string, type?: RelationshipType): Edge[] {
    const edges = this.outgoing.get(id) ?? [];
    return type ? edges.filter((e) => e.type === type) : edges;
  }

  edgesTo(id: string, type?: RelationshipType): Edge[] {
    const edges = this.incoming.get(id) ?? [];
    return type ? edges.filter((e) => e.type === type) : edges;
  }

  allEntities(): RsiEntity[] {
    return [...this.entities.values()];
  }

  allEdges(): Edge[] {
    return [...this.edges];
  }

  /** BFS traversal from a start entity. The start node is included at depth 0. */
  traverse(startId: string, options: TraverseOptions = {}): TraversalNode[] {
    const { direction = "out", edgeTypes, maxDepth = 3 } = options;
    const start = this.entities.get(startId);
    if (!start) return [];

    const visited = new Set<string>([startId]);
    const result: TraversalNode[] = [{ entity: start, depth: 0 }];
    let frontier: { id: string; depth: number }[] = [{ id: startId, depth: 0 }];

    while (frontier.length) {
      const next: typeof frontier = [];
      for (const { id, depth } of frontier) {
        if (depth >= maxDepth) continue;
        const candidates: { edge: Edge; neighbor: string }[] = [];
        if (direction === "out" || direction === "both") {
          for (const edge of this.outgoing.get(id) ?? []) candidates.push({ edge, neighbor: edge.to });
        }
        if (direction === "in" || direction === "both") {
          for (const edge of this.incoming.get(id) ?? []) candidates.push({ edge, neighbor: edge.from });
        }
        for (const { edge, neighbor } of candidates) {
          if (edgeTypes && !edgeTypes.includes(edge.type)) continue;
          if (visited.has(neighbor)) continue;
          const entity = this.entities.get(neighbor);
          if (!entity) continue;
          visited.add(neighbor);
          result.push({ entity, depth: depth + 1, via: edge });
          next.push({ id: neighbor, depth: depth + 1 });
        }
      }
      frontier = next;
    }
    return result;
  }

  stats(): GraphStats {
    const byType: Record<string, number> = {};
    for (const [type, ids] of this.byType) {
      if (ids.size) byType[type] = ids.size;
    }
    return {
      nodes: this.entities.size,
      edges: this.edges.length,
      byType,
      files: [...this.byFile.values()].filter((s) => s.size > 0).length,
    };
  }

  clear(): void {
    this.entities.clear();
    this.edges = [];
    this.outgoing.clear();
    this.incoming.clear();
    this.byType.clear();
    this.byName.clear();
    this.byFile.clear();
  }
}

function indexAdd<K>(index: Map<K, Set<string>>, key: K, id: string): void {
  const set = index.get(key);
  if (set) set.add(id);
  else index.set(key, new Set([id]));
}

function indexRemove<K>(index: Map<K, Set<string>>, key: K, id: string): void {
  index.get(key)?.delete(id);
}

function indexPush(index: Map<string, Edge[]>, key: string, edge: Edge): void {
  const list = index.get(key);
  if (list) list.push(edge);
  else index.set(key, [edge]);
}
