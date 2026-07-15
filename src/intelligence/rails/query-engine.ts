/**
 * Phase 9/11 — semantic query API over the knowledge graph. All name
 * lookups are case/underscore-insensitive; route lookup pattern-matches
 * `:param` segments.
 */

import { KnowledgeGraph, TraversalNode } from "./graph/graph.js";
import {
  Association,
  Callback,
  ControllerEntity,
  ModelEntity,
  RouteEntity,
  RsiEntity,
  ServiceEntity,
  SpecEntity,
  ViewEntity,
} from "./types.js";

export interface DependencyTrace {
  root: RsiEntity;
  nodes: TraversalNode[];
}

export class QueryEngine {
  constructor(private readonly graph: KnowledgeGraph) {}

  findModel(name: string): ModelEntity | undefined {
    return this.graph.findByName(name, "model")[0] as ModelEntity | undefined;
  }

  findController(name: string): ControllerEntity | undefined {
    const direct = this.graph.findByName(name, "controller")[0];
    if (direct) return direct as ControllerEntity;
    // Allow "users" / "Users" to resolve UsersController.
    return this.graph.findByName(`${name}Controller`, "controller")[0] as ControllerEntity | undefined;
  }

  findService(name: string): ServiceEntity | undefined {
    return this.graph.findByName(name, "service")[0] as ServiceEntity | undefined;
  }

  findView(name: string): ViewEntity | undefined {
    const direct = this.graph.findByName(name, "view")[0] as ViewEntity | undefined;
    if (direct) return direct;
    // Try matching by relPath pattern (e.g. "users/index" or "app/views/users/index.html.erb").
    return this.graph.findByName(name, "component")[0] as ViewEntity | undefined;
  }

  /** Views that serve a given controller (via renders_view edges). */
  viewsFor(controllerName: string): ViewEntity[] {
    const controller = this.findController(controllerName);
    if (!controller) return [];
    return this.graph
      .edgesFrom(controller.id, "renders_view")
      .map((e) => this.graph.getEntity(e.to))
      .filter((e): e is ViewEntity => e?.type === "view");
  }

  /** Find a route by path (exact or `:param`-pattern match) and optional verb. */
  findRoute(path: string, verb?: string): RouteEntity | undefined {
    const routes = this.graph.findByType("route") as RouteEntity[];
    const normalized = path.replace(/\/+$/, "") || "/";
    const wantVerb = verb?.toUpperCase();
    return (
      routes.find((r) => r.path === normalized && (!wantVerb || r.verb === wantVerb)) ??
      routes.find((r) => (!wantVerb || r.verb === wantVerb) && pathMatches(r.path, normalized))
    );
  }

  routesFor(controllerName: string): RouteEntity[] {
    const controller = this.findController(controllerName);
    if (!controller) return [];
    return this.graph
      .edgesTo(controller.id, "routes_to")
      .map((e) => this.graph.getEntity(e.from))
      .filter((e): e is RouteEntity => e?.type === "route");
  }

  findAssociations(modelName: string): Association[] {
    return this.findModel(modelName)?.associations ?? [];
  }

  findCallbacks(modelName: string): Callback[] {
    return this.findModel(modelName)?.callbacks ?? [];
  }

  /** Specs whose described subject resolves to the named entity. */
  findSpecs(entityName: string): SpecEntity[] {
    const specs: SpecEntity[] = [];
    for (const entity of this.graph.findByName(entityName)) {
      for (const edge of this.graph.edgesFrom(entity.id, "tested_by")) {
        const spec = this.graph.getEntity(edge.to);
        if (spec?.type === "spec") specs.push(spec as SpecEntity);
      }
      for (const edge of this.graph.edgesTo(entity.id, "tested_by")) {
        const spec = this.graph.getEntity(edge.from);
        if (spec?.type === "spec") specs.push(spec as SpecEntity);
      }
    }
    // Fall back to name matching (`User` → spec describing "User").
    if (!specs.length) {
      for (const spec of this.graph.findByType("spec") as SpecEntity[]) {
        if (spec.subjectName && normalize(spec.subjectName) === normalize(entityName)) specs.push(spec);
      }
    }
    return dedupe(specs);
  }

  /**
   * Trace what an entity depends on (`dependencies`, outgoing edges) or
   * what depends on it (`dependents`, incoming edges).
   */
  traceDependency(
    entityName: string,
    options: { direction?: "dependencies" | "dependents"; maxDepth?: number } = {},
  ): DependencyTrace | undefined {
    const root = this.graph.findByName(entityName)[0];
    if (!root) return undefined;
    const nodes = this.graph.traverse(root.id, {
      direction: options.direction === "dependents" ? "in" : "out",
      maxDepth: options.maxDepth ?? 3,
    });
    return { root, nodes };
  }

  search(term: string): RsiEntity[] {
    const needle = normalize(term);
    return this.graph.allEntities().filter((e) => normalize(e.name).includes(needle));
  }
}

function pathMatches(routePath: string, requestPath: string): boolean {
  const routeSegs = routePath.split("/").filter(Boolean);
  const reqSegs = requestPath.split("/").filter(Boolean);
  if (routeSegs.length !== reqSegs.length) return false;
  return routeSegs.every((seg, i) => seg.startsWith(":") || seg === reqSegs[i]);
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[_:]/g, "");
}

function dedupe(specs: SpecEntity[]): SpecEntity[] {
  const seen = new Set<string>();
  return specs.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}
