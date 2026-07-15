import { cp, mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemanticIndex } from "../../../src/intelligence/rails/indexer.js";
import { ModelEntity } from "../../../src/intelligence/rails/types.js";

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURE = join(__dirname, "..", "..", "fixtures", "rails-app");

async function fixtureCopy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rsi-fixture-"));
  await cp(FIXTURE, dir, { recursive: true });
  return dir;
}

describe("SemanticIndex", () => {
  it("is disabled for non-Rails workspaces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rsi-empty-"));
    const index = SemanticIndex.create(dir);

    expect(index.enabled).toBe(false);
    await index.build();
    expect(index.status().state).toBe("idle");
    expect(index.status().entityCount).toBe(0);
  });

  it("builds a cross-scanner graph from the fixture app", async () => {
    const dir = await fixtureCopy();
    const index = SemanticIndex.create(dir);
    expect(index.enabled).toBe(true);

    await index.build();
    const status = index.status();
    expect(status.state).toBe("ready");
    expect(status.scannerErrors).toEqual([]);

    // model → table edge
    const user = index.graph.findByName("User", "model")[0];
    expect(user).toBeDefined();
    expect(index.graph.edgesFrom(user.id, "backed_by_table")[0]?.to).toBe("table:users");

    // model → model association edge
    expect(index.graph.edgesFrom(user.id, "has_many").map((e) => e.to)).toContain("model:Order");

    // route → controller edge
    const indexRoute = index.graph.findByName("GET /users", "route")[0];
    expect(indexRoute).toBeDefined();
    const routesTo = index.graph.edgesFrom(indexRoute.id, "routes_to")[0];
    expect(routesTo?.to).toBe("controller:UsersController");

    // namespaced controller resolves
    const adminRoute = index.graph.findByName("GET /admin/reports", "route")[0];
    expect(index.graph.edgesFrom(adminRoute.id, "routes_to")[0]?.to).toBe("controller:Admin::ReportsController");

    // gems present
    expect(index.graph.findByName("rails", "gem")).toHaveLength(1);
  });

  it("isolates scanner failures per file without killing the build", async () => {
    const dir = await fixtureCopy();
    // Malformed Ruby should not throw the whole build.
    writeFileSync(join(dir, "app", "models", "broken.rb"), "class Broken < <<<%% not ruby");
    const index = SemanticIndex.create(dir);

    await index.build();

    expect(index.status().state).toBe("ready");
    expect(index.graph.findByName("User", "model")).toHaveLength(1);
  });

  it("updates incrementally when a model changes", async () => {
    const dir = await fixtureCopy();
    const index = SemanticIndex.create(dir);
    await index.build();

    const before = index.graph.findByName("User", "model")[0] as ModelEntity;
    expect(before.callbacks.length).toBeGreaterThan(0);

    writeFileSync(
      join(dir, "app", "models", "user.rb"),
      ["class User < ApplicationRecord", "  has_many :orders", "  belongs_to :organization", "end"].join("\n"),
    );

    await index.update(["app/models/user.rb"]);

    const after = index.graph.findByName("User", "model")[0] as ModelEntity;
    expect(after.callbacks).toHaveLength(0);
    const dangling = index.status().danglingIntents;
    expect(dangling).toBeGreaterThan(0); // Organization model does not exist
    expect(index.graph.edgesFrom(after.id, "has_many").map((e) => e.to)).toContain("model:Order");
  });

  it("removes entities when a file is deleted", async () => {
    const dir = await fixtureCopy();
    const index = SemanticIndex.create(dir);
    await index.build();

    await rm(join(dir, "app", "models", "order.rb"));
    await index.update(["app/models/order.rb"]);

    expect(index.graph.findByName("Order", "model")).toHaveLength(0);
    const user = index.graph.findByName("User", "model")[0];
    expect(index.graph.edgesFrom(user.id, "has_many")).toHaveLength(0);
  });
});
