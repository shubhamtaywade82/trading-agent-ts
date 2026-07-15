import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteQueryTool } from "../../src/tools/database-tools.js";

describe("SqliteQueryTool", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sqlite-tool-test-"));
    dbPath = join(dir, "app.sqlite3");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO users (name) VALUES ('ada'), ('grace');
    `);
    db.close();
  });

  it("lists tables", async () => {
    const tool = new SqliteQueryTool(dir);
    const result = await tool.call({ dbPath: "app.sqlite3", operation: "tables" });
    expect(result.tables).toEqual(["users"]);
  });

  it("shows a table's schema", async () => {
    const tool = new SqliteQueryTool(dir);
    const result = await tool.call({ dbPath: "app.sqlite3", operation: "schema", table: "users" });
    const columns = result.columns as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toEqual(["id", "name"]);
  });

  it("runs a SELECT query", async () => {
    const tool = new SqliteQueryTool(dir);
    const result = await tool.call({ dbPath: "app.sqlite3", operation: "query", sql: "SELECT name FROM users ORDER BY name" });
    expect(result.rows).toEqual([{ name: "ada" }, { name: "grace" }]);
  });

  it("blocks a write query", async () => {
    const tool = new SqliteQueryTool(dir);
    const result = await tool.call({ dbPath: "app.sqlite3", operation: "query", sql: "DELETE FROM users" });
    expect(result.error).toBe("WriteQueryBlockedError");
  });

  it("blocks DROP TABLE", async () => {
    const tool = new SqliteQueryTool(dir);
    const result = await tool.call({ dbPath: "app.sqlite3", operation: "query", sql: "DROP TABLE users" });
    expect(result.error).toBe("WriteQueryBlockedError");
  });

  it("rejects a dbPath that escapes the workspace root", async () => {
    const tool = new SqliteQueryTool(dir);
    const result = await tool.call({ dbPath: "../../etc/passwd", operation: "tables" });
    expect(result.error).toBe("PathEscapeError");
  });

  it("errors cleanly on a missing database file", async () => {
    const tool = new SqliteQueryTool(dir);
    const result = await tool.call({ dbPath: "does-not-exist.sqlite3", operation: "tables" });
    expect(result.error).toBe("DatabaseOpenError");
  });
});
