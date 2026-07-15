/**
 * View scanner — indexes ERB/HAML/Slim templates in app/views/ and
 * ViewComponent/Phlex classes in app/components/.
 *
 * ERB scanning extracts: render calls (→ partials + components), model
 * references via @instance variables and constant receivers, helper usage.
 * Component scanning detects ViewComponent (:class < ViewComponent::Base)
 * and Phlex (:class < Phlex::HTML/View) definitions.
 *
 * Convention mapping: app/views/users/index.html.erb → UsersController#index.
 */

import { RelationshipIntent, Scanner, ScannerResult, SourceFile, ViewEntity } from "../types.js";
import { logicalLines, singularize } from "./ruby-source.js";

const VIEW_EXT = /\.(erb|haml|slim|builder)$/;

/** Match `<%= ... %>` or `<% ... %>` (not `<%# ... %>` comments). */
const ERB_TAG = /<%(?:=|==)?\s*([\s\S]*?)\s*-?%>/g;

const RENDER_CALL = /\brender\s*(?:\(|\s+)?(?:partial:\s*)?/;
const QUOTED_PATH = /["']([a-z0-9_./-]+)["']/;
const COMPONENT_NEW = /\b([A-Z][A-Za-z0-9]*(?:::[A-Z][A-Za-z0-9]*)*)\.new\s*\(/;
const INSTANCE_VAR = /@([a-z][a-z0-9_]*)/g;
const MODEL_RECEIVER = /\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)*)\.(?:all|find|find_by|where|create|new|update|destroy|delete|exists\?|count|order|limit|joins|includes|select|pluck|first|last|take|find_each)\b/g;
const HELPERS = /\b(?:link_to|form_with|form_for|button_to|mail_to|image_tag|asset_path|content_tag|tag\.|javascript_tag|stylesheet_link_tag|render|redirect_to)\b/g;

const COMPONENT_CLASS = /^class\s+([A-Z][A-Za-z0-9_:]*)\s*<\s*(ViewComponent::Base|ApplicationComponent|Phlex::HTML|Phlex::View|Phlex::Component)\b/;

export class ViewScanner implements Scanner {
  readonly name = "view";

  appliesTo(relPath: string): boolean {
    return !!(
      VIEW_EXT.test(relPath) && /(?:^|\/)app\/views\//.test(relPath) ||
      /(?:^|\/)app\/components\/.*\.rb$/.test(relPath)
    );
  }

  scan(files: SourceFile[]): ScannerResult {
    const entities: ViewEntity[] = [];
    const intents: RelationshipIntent[] = [];

    for (const file of files) {
      if (VIEW_EXT.test(file.relPath)) {
        this.scanTemplate(file, entities, intents);
      } else if (file.relPath.endsWith(".rb")) {
        this.scanComponentFile(file, entities, intents);
      }
    }

    return { entities, intents };
  }

  // ─── template scanning (ERB / HAML / Slim) ─────────────────────────

  private scanTemplate(
    file: SourceFile,
    entities: ViewEntity[],
    intents: RelationshipIntent[],
  ): void {
    const { relPath, content } = file;
    const isPartial = /\/_/.test(relPath);
    const [controller, action] = isPartial ? [undefined, undefined] : this.conventionFromPath(relPath);
    const viewFormat = this.detectViewFormat(relPath);
    const format = this.responseFormat(relPath);

    const entityName = relPath.replace(/^app\/views\//, "").replace(/\.\w+\.(erb|haml|slim|builder)$/, ".$1").replace(VIEW_EXT, "");

    const entity: ViewEntity = {
      id: `view:${relPath}`,
      type: "view",
      name: entityName,
      file: relPath,
      line: 1,
      viewFormat,
      format,
      controller,
      action,
      referencedPartials: [],
      referencedComponents: [],
      referencedModels: [],
      referencedHelpers: [],
    };

    if (controller && action) {
      intents.push({
        fromId: entity.id,
        relationship: "renders_view",
        toType: "controller",
        toName: `${controller}Controller`,
        meta: { action },
      });
    }

    // Extract Ruby expressions from ERB tags
    const erbExprs = this.extractErbExpressions(content);
    const seenPartials = new Set<string>();
    const seenComps = new Set<string>();
    const seenModels = new Set<string>();

    for (const expr of erbExprs) {
      this.extractRenderPartial(expr, relPath, controller, entity, intents, seenPartials);
      this.extractComponent(expr, entity, intents, seenComps);
      this.extractModelRefs(expr, entity, intents, seenModels);
      this.extractHelpers(expr, entity);
    }

    entities.push(entity);
  }

  /** Pull <code> from ERB tags, skipping `<%#` comments. */
  private extractErbExpressions(content: string): string[] {
    const out: string[] = [];
    let m: RegExpExecArray | null;
    const re = new RegExp(ERB_TAG.source, "g");
    while ((m = re.exec(content)) !== null) {
      const code = m[1].trim();
      if (code && !code.startsWith("#")) out.push(code);
    }
    return out;
  }

  /** `render partial: "form"` or `render "shared/header"` or `render(@user)`. */
  private extractRenderPartial(
    expr: string,
    relPath: string,
    controller: string | undefined,
    entity: ViewEntity,
    intents: RelationshipIntent[],
    seen: Set<string>,
  ): void {
    if (!RENDER_CALL.test(expr)) return;

    const qm = expr.match(QUOTED_PATH);
    if (qm) {
      const raw = qm[1];
      // Resolve relative partial names: "form" → "users/form" when in app/views/users/...
      const resolved = raw.includes("/") ? raw : controller ? `${this.controllerViewDir(controller)}/${raw}` : raw;
      const partialName = `${resolved.startsWith("/") ? resolved.slice(1) : resolved}`;
      if (seen.has(partialName)) return;
      seen.add(partialName);
      entity.referencedPartials.push(partialName);
      intents.push({
        fromId: entity.id,
        relationship: "renders_partial",
        toType: "view",
        toName: partialName,
      });
    }
  }

  /** `render UserComponent.new(...)` or `render(Admin::MyComponent.new(...))`. */
  private extractComponent(
    expr: string,
    entity: ViewEntity,
    intents: RelationshipIntent[],
    seen: Set<string>,
  ): void {
    const cm = expr.match(COMPONENT_NEW);
    if (!cm) return;
    const name = cm[1];
    if (seen.has(name)) return;
    seen.add(name);
    entity.referencedComponents.push(name);
    intents.push({
      fromId: entity.id,
      relationship: "renders_component",
      toType: "component",
      toName: name,
    });
  }

  /** `@user` → User, `@users` → User, `User.all` → User. */
  private extractModelRefs(
    expr: string,
    entity: ViewEntity,
    intents: RelationshipIntent[],
    seen: Set<string>,
  ): void {
    for (const m of expr.matchAll(INSTANCE_VAR)) {
      const modelName = this.instanceToModel(m[1]);
      if (!modelName) continue;
      const key = `model:${modelName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entity.referencedModels.push(modelName);
      intents.push({
        fromId: entity.id,
        relationship: "references_model",
        toType: "model",
        toName: modelName,
      });
    }

    for (const m of expr.matchAll(MODEL_RECEIVER)) {
      const modelName = m[1];
      const key = `model:${modelName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entity.referencedModels.push(modelName);
      intents.push({
        fromId: entity.id,
        relationship: "references_model",
        toType: "model",
        toName: modelName,
      });
    }
  }

  /** Track helper method usage. */
  private extractHelpers(expr: string, entity: ViewEntity): void {
    for (const m of expr.matchAll(HELPERS)) {
      const h = m[0];
      if (!entity.referencedHelpers.includes(h)) {
        entity.referencedHelpers.push(h);
      }
    }
  }

  // ─── component scanning (ViewComponent / Phlex .rb files) ──────────

  private scanComponentFile(
    file: SourceFile,
    entities: ViewEntity[],
    intents: RelationshipIntent[],
  ): void {
    const { relPath, content } = file;

    for (const line of logicalLines(content)) {
      const cm = COMPONENT_CLASS.exec(line.text);
      if (!cm) continue;

      const bareName = cm[1];
      const superclass = cm[2];
      const viewFormat = superclass.startsWith("Phlex") ? "phlex" : "view_component" as "view_component" | "phlex";

      // Prepend namespace from enclosing class/module nesting
      const qualifiedName = line.namespace.length && !bareName.includes("::")
        ? `${line.namespace.join("::")}::${bareName}`
        : bareName;

      const modelName = this.componentToModel(qualifiedName);

      const entity: ViewEntity = {
        id: `component:${qualifiedName}`,
        type: "component",
        name: qualifiedName,
        file: relPath,
        line: line.line,
        viewFormat,
        format: "html",
        controller: undefined,
        action: undefined,
        referencedPartials: [],
        referencedComponents: [],
        referencedModels: modelName ? [modelName] : [],
        referencedHelpers: [],
        componentClass: qualifiedName,
        template: this.conventionalTemplate(relPath),
      };

      entities.push(entity);

      if (modelName) {
        intents.push({
          fromId: entity.id,
          relationship: "references_model",
          toType: "model",
          toName: modelName,
        });
      }
    }
  }

  // ─── helpers ───────────────────────────────────────────────────────

  /** `app/views/users/index.html.erb` → `["Users", "index"]`. */
  private conventionFromPath(relPath: string): [string | undefined, string | undefined] {
    // Strip template extension(s) — handles both .erb and .html.erb
    const stripped = relPath.replace(/^app\/views\//, "").replace(/\.\w+\.(erb|haml|slim|builder)$/, "").replace(VIEW_EXT, "");
    // stripped is now e.g. "users/index", "admin/users/index", "layouts/application"
    const segs = stripped.split("/");
    if (segs.length < 2) return [undefined, undefined];
    if (segs[segs.length - 1].startsWith("_")) return [undefined, undefined];
    const action = segs.pop() as string;
    const controllerPath = segs.join("/");
    if (controllerPath === "layouts") return [undefined, undefined];
    const controller = controllerPath
      .split("/")
      .map((seg) => seg.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(""))
      .join("::");
    return [controller, action];
  }

  /** `Users` → `users` (view dir). */
  private controllerViewDir(controller: string): string {
    return controller
      .replace(/Controller$/, "")
      .split("::")
      .map((seg) => seg.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase())
      .join("/");
  }

  private instanceToModel(name: string): string | null {
    if (!name || name === "_") return null;
    const singular = singularize(name);
    return singular
      .split("_")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join("");
  }

  /** UserComponent → User, Admin::UserRowComponent → Admin::UserRow. */
  private componentToModel(className: string): string | null {
    // Check if the last segment ends with "Component"
    const parts = className.split("::");
    const last = parts[parts.length - 1];
    const suffix = "Component";
    if (last.endsWith(suffix)) {
      const modelBase = last.slice(0, -suffix.length);
      // If there's a namespace prefix, prepend it
      if (parts.length > 1) {
        return `${parts.slice(0, -1).join("::")}::${modelBase}`;
      }
      return modelBase;
    }
    return null;
  }

  private detectViewFormat(relPath: string): "erb" | "haml" | "slim" | "builder" | "view_component" | "phlex" {
    if (relPath.endsWith(".erb")) return "erb";
    if (relPath.endsWith(".haml")) return "haml";
    if (relPath.endsWith(".slim")) return "slim";
    if (relPath.endsWith(".builder")) return "builder";
    return "erb";
  }

  private responseFormat(relPath: string): string {
    const m = /\.(\w+)\.(erb|haml|slim|builder)$/.exec(relPath);
    return m ? m[1] : "html";
  }

  private conventionalTemplate(relPath: string): string | undefined {
    return relPath.replace(/\.rb$/, ".html.erb");
  }
}
