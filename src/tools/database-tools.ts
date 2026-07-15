import Database from "better-sqlite3";
import { Tool } from "./tool.js";
import { resolveWorkspacePath } from "./path-utils.js";

// ponytail: read-only by design (SELECT/PRAGMA/EXPLAIN only) — a DB tool that
// lets an LLM silently DROP/DELETE a project's database is a real destructive-
// action risk. Add an explicit write mode later if a task genuinely needs it.
const READ_ONLY_PATTERN = /^\s*(select|pragma|explain)\b/i;

export class SqliteQueryTool extends Tool {
  constructor(private readonly root: string) {
    super();
  }

  get name(): string {
    return "sqlite_query";
  }

  get description(): string {
    return "Inspect a SQLite database file: list tables, show a table's schema, or run a read-only query (SELECT/PRAGMA/EXPLAIN only).";
  }

  get tags(): string[] {
    return ["database", "sqlite", "sql"];
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        dbPath: { type: "string", description: "Path to the .sqlite3/.db file, relative to the workspace root" },
        operation: { type: "string", enum: ["tables", "schema", "query"] },
        table: { type: "string", description: "Required for operation=schema" },
        sql: { type: "string", description: "Required for operation=query — must start with SELECT, PRAGMA, or EXPLAIN" },
      },
      required: ["dbPath", "operation"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const dbPath = args.dbPath as string;
    const operation = args.operation as string;
    if (!dbPath || !operation) {
      return { error: "ArgumentError", message: "dbPath and operation are required" };
    }

    let fullPath: string;
    try {
      fullPath = resolveWorkspacePath(this.root, dbPath);
    } catch (e) {
      return { error: "PathEscapeError", message: (e as Error).message };
    }

    let db: Database.Database;
    try {
      db = new Database(fullPath, { readonly: true, fileMustExist: true });
    } catch (e) {
      return { error: "DatabaseOpenError", message: (e as Error).message };
    }

    try {
      if (operation === "tables") {
        const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
        return { tables: rows.map((r: any) => r.name) };
      }

      if (operation === "schema") {
        const table = args.table as string;
        if (!table) return { error: "ArgumentError", message: "table is required for operation=schema" };
        const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
        return { table, columns: rows };
      }

      if (operation === "query") {
        const sql = args.sql as string;
        if (!sql) return { error: "ArgumentError", message: "sql is required for operation=query" };
        if (!READ_ONLY_PATTERN.test(sql)) {
          return { error: "WriteQueryBlockedError", message: "only SELECT, PRAGMA, and EXPLAIN queries are allowed" };
        }
        const rows = db.prepare(sql).all();
        return { rows };
      }

      return { error: "ArgumentError", message: `unknown operation: ${operation}` };
    } catch (e) {
      return { error: "QueryError", message: (e as Error).message };
    } finally {
      db.close();
    }
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
