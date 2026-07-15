/**
 * Routes scanner — static parser for config/routes.rb. Expands
 * resources/resource into RESTful routes (honoring only:/except:),
 * tracks namespace/scope nesting, member/collection blocks, explicit
 * verb routes, and root. Never requires a live Rails app.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { RelationshipIntent, RouteEntity, Scanner, ScannerResult, SourceFile } from "../types.js";
import { camelize, logicalLines, parseMacroArgs, parseSymbolList, singularize, unquote } from "./ruby-source.js";

interface Frame {
  kind: "namespace" | "scope" | "resources" | "resource" | "member" | "collection" | "other";
  pathPrefix: string;
  modulePrefix: string;
  /** For resources frames: the resource path segment + controller. */
  resource?: { segment: string; controller: string; singular: boolean; param: string };
}

const RESOURCES_ACTIONS: Record<string, { verb: string; suffix: string }> = {
  index: { verb: "GET", suffix: "" },
  create: { verb: "POST", suffix: "" },
  new: { verb: "GET", suffix: "/new" },
  edit: { verb: "GET", suffix: "/:id/edit" },
  show: { verb: "GET", suffix: "/:id" },
  update: { verb: "PATCH", suffix: "/:id" },
  destroy: { verb: "DELETE", suffix: "/:id" },
};

const RESOURCE_ACTIONS: Record<string, { verb: string; suffix: string }> = {
  create: { verb: "POST", suffix: "" },
  new: { verb: "GET", suffix: "/new" },
  edit: { verb: "GET", suffix: "/edit" },
  show: { verb: "GET", suffix: "" },
  update: { verb: "PATCH", suffix: "" },
  destroy: { verb: "DELETE", suffix: "" },
};

const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete"]);

export class RoutesScanner implements Scanner {
  readonly name = "routes";

  appliesTo(relPath: string): boolean {
    return relPath === "config/routes.rb";
  }

  async exec(root: string): Promise<ScannerResult | null> {
    const rows = await runRailsRoutes(root);
    if (!rows) return null;

    const entities: RouteEntity[] = [];
    const intents: RelationshipIntent[] = [];

    for (const row of rows) {
      // Strip (.:format) suffix for a canonical path key
      const cleanPath = row.path.replace(/\(\.:format\)/g, "").replace(/\/+$/, "") || "/";
      const id = `route:${row.verb} ${cleanPath}`;

      entities.push({
        id,
        type: "route",
        name: `${row.verb} ${cleanPath}`,
        file: "config/routes.rb",
        line: 0,
        verb: row.verb,
        path: cleanPath,
        controller: row.controller,
        action: row.action,
        routeName: row.prefix || undefined,
      });

      intents.push({
        fromId: id,
        relationship: "routes_to",
        toType: "controller",
        toName: `${camelize(row.controller)}Controller`,
        meta: { action: row.action },
      });
    }

    return { entities, intents };
  }

  scan(files: SourceFile[]): ScannerResult {
    const entities: RouteEntity[] = [];
    const intents: RelationshipIntent[] = [];

    for (const file of files) {
      const stack: Frame[] = [];

      const currentPrefix = () => stack.map((f) => f.pathPrefix).filter(Boolean).join("");
      const currentModule = () =>
        stack
          .map((f) => f.modulePrefix)
          .filter(Boolean)
          .join("/");

      const addRoute = (verb: string, path: string, controller: string, action: string, line: number, routeName?: string) => {
        const fullController = currentModule() ? `${currentModule()}/${controller}` : controller;
        const normalizedPath = path.replace(/\/+/g, "/") || "/";
        const route: RouteEntity = {
          id: `route:${verb} ${normalizedPath}`,
          type: "route",
          name: `${verb} ${normalizedPath}`,
          file: file.relPath,
          line,
          verb,
          path: normalizedPath,
          controller: fullController,
          action,
          routeName,
        };
        entities.push(route);
        intents.push({
          fromId: route.id,
          relationship: "routes_to",
          toType: "controller",
          toName: `${camelize(fullController)}Controller`,
          meta: { action },
        });
      };

      for (const line of logicalLines(file.content)) {
        const text = line.text;

        if (/^end\b/.test(text)) {
          stack.pop();
          continue;
        }

        const namespaceMatch = /^namespace\s+:([a-z_0-9]+)/.exec(text);
        if (namespaceMatch) {
          stack.push({ kind: "namespace", pathPrefix: `/${namespaceMatch[1]}`, modulePrefix: namespaceMatch[1] });
          continue;
        }

        const scopeMatch = /^scope\s+(.+?)\s+do\s*$/.exec(text) ?? /^scope\s+(.+)$/.exec(text);
        if (scopeMatch && /\bdo\s*$/.test(text)) {
          const call = parseMacroArgs(scopeMatch[1].replace(/\s+do\s*$/, ""));
          const pathPart = call.args[0] ?? (call.opts.path ? unquote(call.opts.path) : "");
          stack.push({
            kind: "scope",
            pathPrefix: pathPart ? `/${unquote(pathPart).replace(/^\//, "")}` : "",
            modulePrefix: call.opts.module ? unquote(call.opts.module) : "",
          });
          continue;
        }

        const memberMatch = /^(member|collection)\s+do\s*$/.exec(text);
        if (memberMatch) {
          const parent = [...stack].reverse().find((f) => f.resource);
          const onMember = memberMatch[1] === "member" && parent?.resource && !parent.resource.singular;
          stack.push({
            kind: memberMatch[1] as Frame["kind"],
            pathPrefix: onMember ? `/:${parent!.resource!.param}` : "",
            modulePrefix: "",
          });
          continue;
        }

        const resourcesMatch = /^(resources|resource)\s+(.+)$/.exec(text);
        if (resourcesMatch) {
          const singular = resourcesMatch[1] === "resource";
          const opensBlock = /\bdo\s*$/.test(text);
          const call = parseMacroArgs(resourcesMatch[2].replace(/\s+do\s*$/, ""));
          const actionTable = singular ? RESOURCE_ACTIONS : RESOURCES_ACTIONS;
          let actions = Object.keys(actionTable);
          if (call.opts.only) actions = parseSymbolList(call.opts.only).filter((a) => actionTable[a]);
          if (call.opts.except) {
            const excluded = new Set(parseSymbolList(call.opts.except));
            actions = actions.filter((a) => !excluded.has(a));
          }
          const controllerOverride = call.opts.controller ? unquote(call.opts.controller) : undefined;
          const param = call.opts.param ? unquote(call.opts.param) : "id";

          // Nested inside a plural `resources` block → parent id param segment.
          const parentFrame = stack.length ? stack[stack.length - 1] : undefined;
          const nestedParam =
            parentFrame?.kind === "resources" && parentFrame.resource && !parentFrame.resource.singular
              ? `/:${singularize(parentFrame.resource.segment)}_${parentFrame.resource.param}`
              : "";

          let lastFrame: Frame | null = null;
          for (const segment of call.args) {
            const controller = controllerOverride ?? (singular ? pluralizeSegment(segment) : segment);
            const basePath = `${currentPrefix()}${nestedParam}/${call.opts.path ? unquote(call.opts.path) : segment}`;
            for (const action of actions) {
              const { verb, suffix } = actionTable[action];
              addRoute(verb, basePath + suffix.replace("/:id", `/:${param}`), controller, action, line.line);
            }
            lastFrame = {
              kind: singular ? "resource" : "resources",
              pathPrefix: `${nestedParam}/${segment}`,
              modulePrefix: "",
              resource: { segment, controller, singular, param },
            };
          }
          // A `resources ... do` block owns exactly one `end`, so push one frame.
          if (opensBlock && lastFrame) stack.push(lastFrame);
          continue;
        }

        const rootMatch = /^root\s+(?:to:\s*)?["']([^"'#]+)#([^"']+)["']/.exec(text);
        if (rootMatch) {
          addRoute("GET", currentPrefix() || "/", rootMatch[1], rootMatch[2], line.line, "root");
          continue;
        }

        const verbMatch = /^(get|post|put|patch|delete)\s+(.+)$/.exec(text);
        if (verbMatch && HTTP_VERBS.has(verbMatch[1])) {
          const call = parseMacroArgs(verbMatch[2]);
          let pathArg = call.args[0];
          let target = call.opts.to ? unquote(call.opts.to) : undefined;
          const hashRocket = /^["']([^"']+)["']\s*=>\s*["']([^"']+)["']/.exec(verbMatch[2]);
          if (hashRocket) {
            pathArg = hashRocket[1];
            target = hashRocket[2];
          }
          if (!pathArg) continue;
          const routeName = call.opts.as ? unquote(call.opts.as) : undefined;
          const verb = verbMatch[1].toUpperCase();

          const memberFrame = [...stack].reverse().find((f) => f.kind === "member" || f.kind === "collection");
          const resourceFrame = [...stack].reverse().find((f) => f.resource);

          if (target && target.includes("#")) {
            const [controller, action] = target.split("#");
            addRoute(verb, `${currentPrefix()}/${pathArg.replace(/^\//, "")}`, controller, action, line.line, routeName);
          } else if (memberFrame && resourceFrame?.resource) {
            addRoute(verb, `${currentPrefix()}/${pathArg}`, resourceFrame.resource.controller, pathArg, line.line, routeName);
          } else {
            // `get "pages/about"` — controller#action inferred from path.
            const segments = pathArg.replace(/^\//, "").split("/");
            if (segments.length >= 2) {
              const action = segments.pop() as string;
              addRoute(verb, `${currentPrefix()}/${pathArg.replace(/^\//, "")}`, segments.join("/"), action, line.line, routeName);
            }
          }
          continue;
        }

        // Any other `... do` block (routes.draw itself, `constraints do`,
        // `concern :x do`) must push a frame so the matching `end` pops it.
        if (/\bdo\s*(?:\|[^|]*\|)?\s*$/.test(text)) {
          stack.push({ kind: "other", pathPrefix: "", modulePrefix: "" });
        }
      }
    }

    return { entities, intents };
  }
}

function pluralizeSegment(segment: string): string {
  const singular = singularize(segment);
  if (singular !== segment) return segment; // already plural
  if (/(?:x|ch|sh|ss|s|z)$/.test(segment)) return `${segment}es`;
  if (/[^aeiou]y$/.test(segment)) return `${segment.slice(0, -1)}ies`;
  return `${segment}s`;
}

interface RailsRouteRow {
  prefix: string;
  verb: string;
  path: string;
  controller: string;
  action: string;
}

// Matches bin/rails routes output lines:
//   [prefix_spaces](prefix)?[spaces]VERB[spaces]URI_PATTERN[spaces]CONTROLLER#ACTION
const ROUTE_LINE_RE = /^\s*(?:(\S+)\s+)?(GET|POST|PATCH|PUT|DELETE)\s+(\S+)\s+(.+)$/;

async function runRailsRoutes(root: string): Promise<RailsRouteRow[] | null> {
  return new Promise((resolvePromise) => {
    const child = spawn("bundle", ["exec", "bin/rails", "routes"], {
      cwd: root,
      timeout: 30_000,
      env: { ...process.env, RAILS_ENV: "production" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        resolvePromise(null);
        return;
      }
      const rows: RailsRouteRow[] = [];
      for (const line of stdout.split("\n")) {
        if (line.trim().length === 0) continue;
        const m = ROUTE_LINE_RE.exec(line);
        if (!m) continue;
        const [, prefix, verb, path, caPart] = m;
        const caMatch = /^([^#]+)#(.+)$/.exec(caPart);
        if (!caMatch) continue;
        rows.push({ prefix: prefix ?? "", verb, path, controller: caMatch[1], action: caMatch[2] });
      }
      resolvePromise(rows.length > 0 ? rows : null);
    });
    child.on("error", () => resolvePromise(null));
  });
}
