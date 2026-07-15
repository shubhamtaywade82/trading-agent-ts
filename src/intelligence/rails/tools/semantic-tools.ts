/**
 * Phase 11 — LLM-callable tools over the Rails Semantic Index. Tools are
 * always registered so the tool schema set stays stable; on a non-Rails
 * workspace each call short-circuits with `{ enabled: false }`.
 */

import { Tool } from "../../../tools/tool.js";
import { SemanticIndex } from "../indexer.js";
import { RsiEntity } from "../types.js";

abstract class RailsTool extends Tool {
  constructor(protected readonly index: SemanticIndex) {
    super();
  }

  protected disabledResult(): Record<string, unknown> | null {
    if (!this.index.enabled) {
      return { enabled: false, reason: "not a Rails workspace" };
    }
    if (this.index.status().state !== "ready") {
      return { enabled: true, ready: false, state: this.index.status().state };
    }
    return null;
  }

  protected nameParam(description: string): Record<string, unknown> {
    return {
      type: "object",
      properties: { name: { type: "string", description } },
      required: ["name"],
    };
  }
}

function summarize(entity: RsiEntity): Record<string, unknown> {
  return { ...entity };
}

export class FindModelTool extends RailsTool {
  get name(): string {
    return "find_model";
  }
  get description(): string {
    return "Look up a Rails model in the semantic index: file, table, columns, associations, validations, callbacks, scopes.";
  }
  get parameters(): Record<string, unknown> {
    return this.nameParam("Model class name, e.g. User or Billing::Invoice");
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const gate = this.disabledResult();
    if (gate) return gate;
    const model = this.index.query.findModel(String(args.name ?? ""));
    if (!model) return { found: false, name: args.name };
    const table = this.index.graph.edgesFrom(model.id, "backed_by_table")[0];
    return {
      found: true,
      model: summarize(model),
      table: table ? summarize(this.index.graph.getEntity(table.to)!) : undefined,
      specs: this.index.query.findSpecs(model.name).map((s) => s.file),
    };
  }
}

export class FindRouteTool extends RailsTool {
  get name(): string {
    return "find_route";
  }
  get description(): string {
    return "Resolve a route path (and optional HTTP verb) to its controller#action via the Rails semantic index.";
  }
  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "Route path, e.g. /users or /users/:id" },
        verb: { type: "string", description: "Optional HTTP verb (GET, POST, ...)" },
      },
      required: ["path"],
    };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const gate = this.disabledResult();
    if (gate) return gate;
    const route = this.index.query.findRoute(String(args.path ?? ""), args.verb ? String(args.verb) : undefined);
    if (!route) return { found: false, path: args.path };
    const target = this.index.graph.edgesFrom(route.id, "routes_to")[0];
    return {
      found: true,
      route: summarize(route),
      controller: target ? summarize(this.index.graph.getEntity(target.to)!) : undefined,
    };
  }
}

export class FindControllerTool extends RailsTool {
  get name(): string {
    return "find_controller";
  }
  get description(): string {
    return "Look up a Rails controller: actions, before_actions, rescue handlers, concerns, and the routes that reach it.";
  }
  get parameters(): Record<string, unknown> {
    return this.nameParam("Controller name, e.g. UsersController or users");
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const gate = this.disabledResult();
    if (gate) return gate;
    const controller = this.index.query.findController(String(args.name ?? ""));
    if (!controller) return { found: false, name: args.name };
    return {
      found: true,
      controller: summarize(controller),
      routes: this.index.query.routesFor(controller.name).map((r) => `${r.verb} ${r.path} → ${r.action}`),
      specs: this.index.query.findSpecs(controller.name).map((s) => s.file),
    };
  }
}

export class FindServiceTool extends RailsTool {
  get name(): string {
    return "find_service";
  }
  get description(): string {
    return "Look up a Rails service object: file, public methods, and what it calls (models, jobs, mailers).";
  }
  get parameters(): Record<string, unknown> {
    return this.nameParam("Service class name, e.g. UserCreator");
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const gate = this.disabledResult();
    if (gate) return gate;
    const service = this.index.query.findService(String(args.name ?? ""));
    if (!service) return { found: false, name: args.name };
    const calls = this.index.graph.edgesFrom(service.id).map((e) => `${e.type} → ${e.to}`);
    return { found: true, service: summarize(service), relationships: calls };
  }
}

export class FindSpecTool extends RailsTool {
  get name(): string {
    return "find_spec";
  }
  get description(): string {
    return "Find RSpec files covering a model, controller, service, or other entity.";
  }
  get parameters(): Record<string, unknown> {
    return this.nameParam("Entity name the spec should cover, e.g. User or UsersController");
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const gate = this.disabledResult();
    if (gate) return gate;
    const specs = this.index.query.findSpecs(String(args.name ?? ""));
    return { found: specs.length > 0, specs: specs.map((s) => ({ file: s.file, type: s.specType, examples: s.exampleCount })) };
  }
}

export class FindAssociationTool extends RailsTool {
  get name(): string {
    return "find_association";
  }
  get description(): string {
    return "List a Rails model's Active Record associations (belongs_to/has_many/has_one) with resolved target classes.";
  }
  get parameters(): Record<string, unknown> {
    return this.nameParam("Model class name");
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const gate = this.disabledResult();
    if (gate) return gate;
    const name = String(args.name ?? "");
    const model = this.index.query.findModel(name);
    if (!model) return { found: false, name };
    return { found: true, model: model.name, associations: model.associations };
  }
}

export class FindCallbackTool extends RailsTool {
  get name(): string {
    return "find_callback";
  }
  get description(): string {
    return "List a Rails model's Active Record callbacks (before_save, after_commit, ...) — the side effects of saving it.";
  }
  get parameters(): Record<string, unknown> {
    return this.nameParam("Model class name");
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const gate = this.disabledResult();
    if (gate) return gate;
    const name = String(args.name ?? "");
    const model = this.index.query.findModel(name);
    if (!model) return { found: false, name };
    return { found: true, model: model.name, callbacks: model.callbacks };
  }
}

export class RailsContextTool extends RailsTool {
  get name(): string {
    return "rails_context";
  }
  get description(): string {
    return "Build a compact Rails context block for a task: matching routes, controllers, models (columns, associations, callbacks), and specs — use before planning Rails changes.";
  }
  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { request: { type: "string", description: "The task or question to build context for" } },
      required: ["request"],
    };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const gate = this.disabledResult();
    if (gate) return gate;
    const context = this.index.contextBuilder.buildContext(String(args.request ?? ""));
    return { context: context.text, tokenEstimate: context.tokenEstimate, entities: context.entities };
  }
}

export class RailsIndexStatusTool extends RailsTool {
  get name(): string {
    return "rails_index_status";
  }
  get description(): string {
    return "Report Rails semantic index status: entity/edge counts, scanner errors, freshness.";
  }
  async call(): Promise<Record<string, unknown>> {
    const status = this.index.status();
    return { ...status, stats: this.index.graph.stats() };
  }
}

export function createRailsTools(index: SemanticIndex): Tool[] {
  return [
    new FindModelTool(index),
    new FindRouteTool(index),
    new FindControllerTool(index),
    new FindServiceTool(index),
    new FindSpecTool(index),
    new FindAssociationTool(index),
    new FindCallbackTool(index),
    new RailsContextTool(index),
    new RailsIndexStatusTool(index),
  ];
}
