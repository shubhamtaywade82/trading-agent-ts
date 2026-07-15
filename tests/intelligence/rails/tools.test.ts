import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemanticIndex } from "../../../src/intelligence/rails/indexer.js";
import { createRailsTools } from "../../../src/intelligence/rails/tools/semantic-tools.js";
import { Tool } from "../../../src/tools/tool.js";

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURE = join(__dirname, "..", "..", "fixtures", "rails-app");

function toolByName(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("rails semantic tools", () => {
  it("exposes stable schemas", () => {
    const tools = createRailsTools(SemanticIndex.create("/nonexistent"));
    expect(tools.map((t) => t.name).sort()).toEqual([
      "find_association",
      "find_callback",
      "find_controller",
      "find_model",
      "find_route",
      "find_service",
      "find_spec",
      "rails_context",
      "rails_index_status",
    ]);
    for (const tool of tools) {
      expect(tool.schema.function.name).toBe(tool.name);
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it("short-circuits on a non-Rails workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rsi-tools-empty-"));
    const tools = createRailsTools(SemanticIndex.create(dir));

    const result = await toolByName(tools, "find_model").call({ name: "User" });
    expect(result).toEqual({ enabled: false, reason: "not a Rails workspace" });

    const status = await toolByName(tools, "rails_index_status").call({});
    expect(status.enabled).toBe(false);
  });

  describe("on the fixture app", () => {
    let tools: Tool[];

    beforeAll(async () => {
      const dir = await mkdtemp(join(tmpdir(), "rsi-tools-"));
      await cp(FIXTURE, dir, { recursive: true });
      const index = SemanticIndex.create(dir);
      await index.build();
      tools = createRailsTools(index);
    });

    it("find_model returns model, table, and specs", async () => {
      const result = (await toolByName(tools, "find_model").call({ name: "User" })) as Record<string, unknown> & {
        model: { associations: unknown[] };
        table: { columns: unknown[] };
        specs: string[];
      };
      expect(result.found).toBe(true);
      expect(result.model.associations.length).toBeGreaterThan(0);
      expect(result.table.columns.length).toBeGreaterThan(0);
      expect(result.specs).toContain("spec/models/user_spec.rb");
    });

    it("find_route resolves controller", async () => {
      const result = (await toolByName(tools, "find_route").call({ path: "/users", verb: "GET" })) as {
        found: boolean;
        route: { action: string };
        controller?: { name: string };
      };
      expect(result.found).toBe(true);
      expect(result.route.action).toBe("index");
      expect(result.controller?.name).toBe("UsersController");
    });

    it("find_controller lists actions and routes", async () => {
      const result = (await toolByName(tools, "find_controller").call({ name: "UsersController" })) as {
        found: boolean;
        controller: { actions: { name: string }[] };
        routes: string[];
      };
      expect(result.found).toBe(true);
      expect(result.controller.actions.map((a) => a.name)).toEqual(expect.arrayContaining(["index", "show", "create"]));
      expect(result.routes.some((r) => r.includes("GET /users"))).toBe(true);
    });

    it("find_association and find_callback answer model questions", async () => {
      const assoc = (await toolByName(tools, "find_association").call({ name: "User" })) as { associations: { name: string }[] };
      expect(assoc.associations.map((a) => a.name)).toContain("orders");

      const callbacks = (await toolByName(tools, "find_callback").call({ name: "User" })) as { callbacks: { handler: string }[] };
      expect(callbacks.callbacks.map((c) => c.handler)).toContain("normalize_email");
    });

    it("rails_context builds task context", async () => {
      const result = (await toolByName(tools, "rails_context").call({ request: "Fix User creation" })) as {
        context: string;
        tokenEstimate: number;
      };
      expect(result.context).toContain("Model User");
      expect(result.tokenEstimate).toBeGreaterThan(0);
    });

    it("rails_index_status reports counts", async () => {
      const result = (await toolByName(tools, "rails_index_status").call({})) as {
        enabled: boolean;
        state: string;
        entityCount: number;
      };
      expect(result.enabled).toBe(true);
      expect(result.state).toBe("ready");
      expect(result.entityCount).toBeGreaterThan(10);
    });

    it("reports found=false for unknown entities", async () => {
      const result = await toolByName(tools, "find_model").call({ name: "Ghost" });
      expect(result.found).toBe(false);
    });
  });
});
