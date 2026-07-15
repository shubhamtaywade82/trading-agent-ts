import { SchemaScanner } from "../../../../src/intelligence/rails/scanners/schema-scanner.js";
import { TableEntity } from "../../../../src/intelligence/rails/types.js";

const SCHEMA = [
  'ActiveRecord::Schema[7.1].define(version: 2024_01_02_000000) do',
  '  create_table "users", force: :cascade do |t|',
  '    t.string "email", null: false',
  '    t.string "name"',
  '    t.boolean "active", default: "true"',
  '    t.index ["email"], name: "index_users_on_email", unique: true',
  "  end",
  "",
  '  create_table "orders", force: :cascade do |t|',
  '    t.references "user", null: false',
  '    t.decimal "total", precision: 10, scale: 2',
  "    t.timestamps",
  "  end",
  "",
  '  add_index "orders", ["user_id"], name: "idx"',
  "end",
].join("\n");

describe("SchemaScanner", () => {
  it("extracts tables, columns, references, timestamps, and indexes", () => {
    const result = new SchemaScanner().scan([{ relPath: "db/schema.rb", content: SCHEMA }]);
    const tables = result.entities as TableEntity[];
    const users = tables.find((t) => t.name === "users")!;
    const orders = tables.find((t) => t.name === "orders")!;

    expect(users.columns.map((c) => c.name)).toEqual(["id", "email", "name", "active"]);
    expect(users.columns.find((c) => c.name === "email")?.nullable).toBe(false);
    expect(users.columns.find((c) => c.name === "name")?.nullable).toBe(true);
    expect(users.indexes).toEqual([{ columns: ["email"], unique: true }]);

    expect(orders.columns.map((c) => c.name)).toEqual(["id", "user_id", "total", "created_at", "updated_at"]);
    expect(orders.indexes).toEqual([{ columns: ["user_id"], unique: false }]);
  });
});
