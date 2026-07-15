/**
 * Model scanner — extracts associations, validations, callbacks, scopes,
 * and concern includes from app/models. Association targets become
 * relationship intents resolved by the indexer.
 */

import {
  Association,
  ModelEntity,
  RelationshipIntent,
  Scanner,
  ScannerResult,
  SourceFile,
} from "../types.js";
import { classify, logicalLines, parseMacroArgs, parseSymbolList, singularize, underscore, unquote } from "./ruby-source.js";

const ASSOCIATION_KINDS = ["belongs_to", "has_many", "has_one", "has_and_belongs_to_many"] as const;

const CALLBACK_KINDS = new Set([
  "before_validation", "after_validation",
  "before_save", "around_save", "after_save",
  "before_create", "around_create", "after_create",
  "before_update", "around_update", "after_update",
  "before_destroy", "around_destroy", "after_destroy",
  "after_commit", "after_create_commit", "after_update_commit", "after_destroy_commit",
  "after_rollback", "after_initialize", "after_find", "after_touch",
]);

export class ModelScanner implements Scanner {
  readonly name = "model";

  appliesTo(relPath: string): boolean {
    return /(?:^|\/)app\/models\/(?!concerns\/).+\.rb$/.test(relPath);
  }

  scan(files: SourceFile[]): ScannerResult {
    const entities: ModelEntity[] = [];
    const intents: RelationshipIntent[] = [];

    for (const file of files) {
      let model: ModelEntity | null = null;

      for (const line of logicalLines(file.content)) {
        const classDef = /^class\s+([A-Z][A-Za-z0-9_:]*)(?:\s*<\s*([A-Za-z0-9_:]+))?/.exec(line.text);
        if (classDef) {
          const name = qualify(classDef[1], line.namespace);
          model = {
            id: `model:${name}`,
            type: "model",
            name,
            file: file.relPath,
            line: line.line,
            superclass: classDef[2],
            associations: [],
            validations: [],
            callbacks: [],
            scopes: [],
            concerns: [],
          };
          model.table = tableNameFor(name);
          entities.push(model);
          intents.push({
            fromId: model.id,
            relationship: "backed_by_table",
            toType: "table",
            toName: model.table,
          });
          continue;
        }
        if (!model || line.namespace[line.namespace.length - 1] !== unqualified(model.name)) continue;

        const macro = /^([a-z_]+)\s+(.+)$/.exec(line.text);
        if (!macro) {
          const tableName = /^self\.table_name\s*=\s*["']([^"']+)["']/.exec(line.text);
          if (tableName) {
            model.table = tableName[1];
            retargetTableIntent(intents, model.id, tableName[1]);
          }
          continue;
        }
        const [, keyword, argText] = macro;

        if ((ASSOCIATION_KINDS as readonly string[]).includes(keyword)) {
          const call = parseMacroArgs(argText);
          for (const assocName of call.args) {
            const kind = keyword as Association["kind"];
            const association: Association = {
              kind,
              name: assocName,
              className: call.opts.class_name ? unquote(call.opts.class_name) : classify(assocName, kind),
              line: line.line,
            };
            if (call.opts.through) association.through = unquote(call.opts.through);
            if (call.opts.polymorphic === "true") association.polymorphic = true;
            if (call.opts.dependent) association.dependent = unquote(call.opts.dependent);
            model.associations.push(association);
            if (!association.polymorphic) {
              intents.push({
                fromId: model.id,
                relationship: kind,
                toType: "model",
                toName: association.className,
                meta: { association: assocName },
              });
            }
          }
        } else if (keyword === "validates" || keyword === "validates_each") {
          const call = parseMacroArgs(argText);
          model.validations.push({
            attributes: call.args,
            rules: Object.keys(call.opts),
            line: line.line,
          });
        } else if (keyword === "validate") {
          const call = parseMacroArgs(argText);
          model.validations.push({ attributes: [], rules: call.args, line: line.line });
        } else if (CALLBACK_KINDS.has(keyword)) {
          const call = parseMacroArgs(argText);
          for (const handler of call.args) {
            model.callbacks.push({ kind: keyword, handler, line: line.line });
          }
          if (!call.args.length) {
            model.callbacks.push({ kind: keyword, handler: "(block)", line: line.line });
          }
        } else if (keyword === "scope") {
          const scopeName = parseSymbolList(argText.split(",")[0]);
          if (scopeName.length) model.scopes.push({ name: scopeName[0], line: line.line });
        } else if (keyword === "include") {
          const constant = /^([A-Z][A-Za-z0-9_:]*)/.exec(argText);
          if (constant) {
            model.concerns.push(constant[1]);
            intents.push({
              fromId: model.id,
              relationship: "includes_concern",
              toType: "concern",
              toName: constant[1],
            });
          }
        }
      }
    }

    return { entities, intents };
  }
}

function qualify(name: string, namespace: string[]): string {
  if (name.includes("::")) return name;
  return namespace.length ? `${namespace.join("::")}::${name}` : name;
}

function unqualified(name: string): string {
  const parts = name.split("::");
  return parts[parts.length - 1];
}

function tableNameFor(modelName: string): string {
  const base = underscore(unqualified(modelName));
  const singular = singularize(base);
  // Pluralize: inverse of the small singularize table for common cases.
  if (/(?:x|ch|sh|ss|s|z)$/.test(singular)) return `${singular}es`;
  if (/[^aeiou]y$/.test(singular)) return `${singular.slice(0, -1)}ies`;
  if (singular === "person") return "people";
  return `${singular}s`;
}

function retargetTableIntent(intents: RelationshipIntent[], modelId: string, table: string): void {
  const intent = intents.find((i) => i.fromId === modelId && i.relationship === "backed_by_table");
  if (intent) intent.toName = table;
}
