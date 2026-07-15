/**
 * Schema scanner — parses db/schema.rb: create_table blocks with typed
 * columns, references, and indexes.
 */

import { Column, Scanner, ScannerResult, SourceFile, TableEntity, TableIndex } from "../types.js";
import { logicalLines, parseMacroArgs, parseSymbolList, splitTopLevel, unquote } from "./ruby-source.js";

const COLUMN_TYPES = new Set([
  "string", "text", "integer", "bigint", "float", "decimal", "numeric",
  "datetime", "timestamp", "time", "date", "binary", "boolean", "json",
  "jsonb", "uuid", "citext", "inet", "virtual",
]);

export class SchemaScanner implements Scanner {
  readonly name = "schema";

  appliesTo(relPath: string): boolean {
    return relPath === "db/schema.rb";
  }

  scan(files: SourceFile[]): ScannerResult {
    const entities: TableEntity[] = [];

    for (const file of files) {
      let current: TableEntity | null = null;

      for (const line of logicalLines(file.content)) {
        const createTable = /^create_table\s+["']([^"']+)["'](.*)$/.exec(line.text);
        if (createTable) {
          current = {
            id: `table:${createTable[1]}`,
            type: "table",
            name: createTable[1],
            file: file.relPath,
            line: line.line,
            columns: [],
            indexes: [],
          };
          const idOff = /id:\s*false/.test(createTable[2]);
          if (!idOff) current.columns.push({ name: "id", columnType: "bigint", nullable: false });
          entities.push(current);
          continue;
        }

        if (!current) {
          const addIndex = /^add_index\s+["']([^"']+)["'],\s*(.+)$/.exec(line.text);
          if (addIndex) {
            const table = entities.find((t) => t.name === addIndex[1]);
            if (table) table.indexes.push(parseIndex(addIndex[2]));
          }
          continue;
        }

        if (/^end\b/.test(line.text)) {
          current = null;
          continue;
        }

        const col = /^t\.([a-z_]+)(?:\s+(.+))?$/.exec(line.text);
        if (!col) continue;
        const method = col[1];
        const call = parseMacroArgs(col[2] ?? "");

        if (COLUMN_TYPES.has(method)) {
          for (const name of call.args) {
            current.columns.push(makeColumn(name, method, call.opts));
          }
        } else if (method === "references" || method === "belongs_to") {
          for (const name of call.args) {
            current.columns.push(makeColumn(`${name}_id`, "bigint", call.opts));
            if (call.opts.polymorphic === "true") {
              current.columns.push(makeColumn(`${name}_type`, "string", call.opts));
            }
          }
        } else if (method === "timestamps") {
          current.columns.push(makeColumn("created_at", "datetime", { null: "false" }));
          current.columns.push(makeColumn("updated_at", "datetime", { null: "false" }));
        } else if (method === "index") {
          current.indexes.push(parseIndex(col[2]));
        }
      }
    }

    return { entities, intents: [] };
  }
}

function makeColumn(name: string, columnType: string, opts: Record<string, string>): Column {
  const column: Column = {
    name,
    columnType,
    nullable: opts.null !== "false",
  };
  if (opts.default !== undefined) column.default = unquote(opts.default);
  return column;
}

function parseIndex(argText: string): TableIndex {
  const parts = splitTopLevel(argText);
  const columns = parts.length ? parseSymbolList(parts[0]) : [];
  const call = parseMacroArgs(argText);
  return { columns: columns.length ? columns : call.args, unique: call.opts.unique === "true" };
}
