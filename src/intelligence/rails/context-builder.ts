/**
 * Phase 10 — the Rails context builder. Extracts candidate entity names
 * from a task description, queries the graph, and assembles a compact
 * markdown context block within a ~1200-token budget (chars/4 estimate),
 * truncating least-relevant sections first.
 */

import { QueryEngine } from "./query-engine.js";
import { ControllerEntity, ModelEntity, RouteEntity, RsiEntity, TableEntity, ViewEntity, WorkspaceInfo } from "./types.js";
import { KnowledgeGraph } from "./graph/graph.js";

export interface RailsContext {
  text: string;
  tokenEstimate: number;
  entities: string[];
}

const DEFAULT_TOKEN_BUDGET = 1200;

export class RailsContextBuilder {
  constructor(
    private readonly query: QueryEngine,
    private readonly graph: KnowledgeGraph,
    private readonly workspace: WorkspaceInfo,
  ) {}

  buildContext(request: string, tokenBudget = DEFAULT_TOKEN_BUDGET): RailsContext {
    const candidates = extractCandidates(request);
    const sections: string[] = [];
    const matched: string[] = [];

    sections.push(this.header());

    for (const pathLike of candidates.paths) {
      const route = this.query.findRoute(pathLike);
      if (route) {
        sections.push(this.routeSection(route));
        matched.push(route.id);
      }
    }

    for (const name of candidates.names) {
      for (const entity of this.lookup(name)) {
        if (matched.includes(entity.id)) continue;
        matched.push(entity.id);
        sections.push(this.entitySection(entity));
      }
    }

    // Assemble within budget: header + route/entity sections in order,
    // dropping from the end (least relevant last) once over budget.
    const budgetChars = tokenBudget * 4;
    let text = "";
    for (const section of sections) {
      if (text.length + section.length > budgetChars) break;
      text += (text ? "\n\n" : "") + section;
    }

    return { text, tokenEstimate: Math.ceil(text.length / 4), entities: matched };
  }

  private lookup(name: string): RsiEntity[] {
    const out: RsiEntity[] = [];
    const model = this.query.findModel(name);
    if (model) out.push(model);
    const controller = this.query.findController(name);
    if (controller) out.push(controller);
    const service = this.query.findService(name);
    if (service) out.push(service);
    return out;
  }

  private header(): string {
    const stats = this.graph.stats();
    const parts = [
      `Rails ${this.workspace.railsVersion ?? "?"}`,
      `Ruby ${this.workspace.rubyVersion ?? "?"}`,
      this.workspace.apiOnly ? "API-only" : null,
      `${this.workspace.testFramework} tests`,
      `${stats.nodes} indexed entities`,
    ].filter(Boolean);
    return `## Rails workspace\n${parts.join(" · ")}`;
  }

  private routeSection(route: RouteEntity): string {
    const lines = [`## Route ${route.verb} ${route.path}`, `- handled by \`${route.controller}#${route.action}\` (${route.file}:${route.line})`];
    const target = this.graph.edgesFrom(route.id, "routes_to")[0];
    if (target) {
      const controller = this.graph.getEntity(target.to);
      if (controller) lines.push(this.entitySection(controller));
    }
    return lines.join("\n");
  }

  private entitySection(entity: RsiEntity): string {
    switch (entity.type) {
      case "model":
        return this.modelSection(entity as ModelEntity);
      case "controller":
        return this.genericSection(entity, controllerDetails(entity));
      case "view":
      case "component":
        return this.viewSection(entity as ViewEntity);
      default:
        return this.genericSection(entity, []);
    }
  }

  private modelSection(model: ModelEntity): string {
    const lines = [`## Model ${model.name} (${model.file}:${model.line})`];
    const tableEdge = this.graph.edgesFrom(model.id, "backed_by_table")[0];
    const table = tableEdge ? (this.graph.getEntity(tableEdge.to) as TableEntity | undefined) : undefined;
    if (table) {
      lines.push(`- table \`${table.name}\`: ${table.columns.map((c) => `${c.name}:${c.columnType}`).join(", ")}`);
    }
    if (model.associations.length) {
      lines.push(`- associations: ${model.associations.map((a) => `${a.kind} :${a.name}${a.through ? ` (through :${a.through})` : ""}`).join("; ")}`);
    }
    if (model.validations.length) {
      lines.push(`- validations: ${model.validations.map((v) => `${v.attributes.join("/") || "custom"} (${v.rules.join(", ")})`).join("; ")}`);
    }
    if (model.callbacks.length) {
      lines.push(`- callbacks: ${model.callbacks.map((c) => `${c.kind} :${c.handler}`).join("; ")}`);
    }
    if (model.scopes.length) {
      lines.push(`- scopes: ${model.scopes.map((s) => s.name).join(", ")}`);
    }
    const specs = this.query.findSpecs(model.name);
    if (specs.length) {
      lines.push(`- specs: ${specs.map((s) => s.file).join(", ")}`);
    }
    const views = this.graph.edgesTo(model.id, "references_model")
      .map((e) => this.graph.getEntity(e.from))
      .filter((e): e is ViewEntity => e?.type === "view" || e?.type === "component");
    if (views.length) {
      lines.push(`- referenced in: ${views.map((v) => v.file).join(", ")}`);
    }
    return lines.join("\n");
  }

  private viewSection(view: ViewEntity): string {
    const tag = view.type === "component" ? "Component" : "View";
    const lines = [`## ${tag} ${view.name} (${view.file}:${view.line})`];
    lines.push(`- format: ${view.viewFormat} (${view.format})`);
    if (view.controller && view.action) {
      lines.push(`- serves \`${view.controller}#${view.action}\``);
    }
    if (view.referencedPartials.length) {
      lines.push(`- partials: ${view.referencedPartials.join(", ")}`);
    }
    if (view.referencedComponents.length) {
      lines.push(`- components: ${view.referencedComponents.join(", ")}`);
    }
    if (view.referencedModels.length) {
      lines.push(`- models: ${view.referencedModels.join(", ")}`);
    }
    if (view.componentClass) {
      lines.push(`- class: ${view.componentClass}`);
    }
    return lines.join("\n");
  }

  private genericSection(entity: RsiEntity, details: string[]): string {
    const lines = [`## ${capitalize(entity.type)} ${entity.name} (${entity.file}:${entity.line})`, ...details];
    const routes = entity.type === "controller" ? this.query.routesFor(entity.name) : [];
    if (routes.length) {
      lines.push(`- routes: ${routes.map((r) => `${r.verb} ${r.path} → ${r.action}`).join("; ")}`);
    }
    const specs = this.query.findSpecs(entity.name);
    if (specs.length) lines.push(`- specs: ${specs.map((s) => s.file).join(", ")}`);
    return lines.join("\n");
  }
}

function controllerDetails(entity: RsiEntity): string[] {
  const controller = entity as ControllerEntity;
  const details: string[] = [];
  if (controller.actions?.length) details.push(`- actions: ${controller.actions.map((a) => a.name).join(", ")}`);
  if (controller.beforeActions?.length) {
    details.push(
      `- before_actions: ${controller.beforeActions
        .map((b) => `${b.handler}${b.only ? ` only=[${b.only.join(",")}]` : ""}${b.except ? ` except=[${b.except.join(",")}]` : ""}`)
        .join("; ")}`,
    );
  }
  return details;
}

interface Candidates {
  names: string[];
  paths: string[];
}

/** Pull likely entity names and route paths out of a task description. */
export function extractCandidates(request: string): Candidates {
  const names = new Set<string>();
  const paths = new Set<string>();

  for (const m of request.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*(?:::[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*)*)\b/g)) {
    names.add(m[1]);
  }
  for (const m of request.matchAll(/[`"']([A-Za-z_/:.-]+)[`"']/g)) {
    if (m[1].startsWith("/")) paths.add(m[1]);
    else names.add(m[1]);
  }
  for (const m of request.matchAll(/(?:^|\s)(\/[a-z0-9_/:-]+)/g)) {
    paths.add(m[1]);
  }
  for (const m of request.matchAll(/\b([a-z]+(?:_[a-z0-9]+)+)\b/g)) {
    names.add(m[1]);
  }
  // Plain words too ("fix the user model" → User); graph misses are free.
  for (const m of request.matchAll(/\b([a-z]{3,})\b/g)) {
    names.add(m[1]);
  }

  return { names: [...names].slice(0, 24), paths: [...paths].slice(0, 4) };
}

function capitalize(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}
