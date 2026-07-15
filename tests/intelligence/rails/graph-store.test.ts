import { cp, mkdtemp, utimes } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeGraph } from "../../../src/intelligence/rails/graph/graph.js";
import { GraphStore } from "../../../src/intelligence/rails/graph/graph-store.js";
import { SemanticIndex } from "../../../src/intelligence/rails/indexer.js";
import { ModelEntity, RelationshipIntent } from "../../../src/intelligence/rails/types.js";

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURE = join(__dirname, "..", "..", "fixtures", "rails-app");

function sampleGraph(): { graph: KnowledgeGraph; intents: RelationshipIntent[] } {
  const graph = new KnowledgeGraph();
  const user: ModelEntity = {
    id: "model:User",
    type: "model",
    name: "User",
    file: "app/models/user.rb",
    line: 1,
    associations: [{ kind: "has_many", name: "orders", className: "Order", line: 2 }],
    validations: [],
    callbacks: [],
    scopes: [],
    concerns: [],
  };
  graph.addEntity(user);
  graph.addEntity({ id: "model:Order", type: "model", name: "Order", file: "app/models/order.rb", line: 1 });
  graph.addEdge({ from: "model:User", to: "model:Order", type: "has_many", meta: { association: "orders" } });
  const intents: RelationshipIntent[] = [
    { fromId: "model:User", relationship: "has_many", toType: "model", toName: "Order", meta: { association: "orders" } },
  ];
  return { graph, intents };
}

describe("GraphStore", () => {
  it("round-trips graph, edges, intents, and freshness", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rsi-store-"));
    const path = join(dir, "rails-index.db");
    const { graph, intents } = sampleGraph();

    const store = new GraphStore(path);
    store.save(graph, intents, "hash-1");
    store.close();

    const reopened = new GraphStore(path);
    expect(reopened.isFresh("hash-1")).toBe(true);
    expect(reopened.isFresh("hash-2")).toBe(false);

    const loaded = new KnowledgeGraph();
    const loadedIntents = reopened.load(loaded);
    expect(loadedIntents).toEqual(intents);
    expect((loaded.getEntity("model:User") as ModelEntity).associations[0].className).toBe("Order");
    expect(loaded.edgesFrom("model:User", "has_many")[0]).toMatchObject({ to: "model:Order", meta: { association: "orders" } });
    expect(reopened.savedAt()).toBeGreaterThan(0);
    reopened.close();
  });

  it("returns null when empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rsi-store-"));
    const store = new GraphStore(join(dir, "rails-index.db"));
    expect(store.load(new KnowledgeGraph())).toBeNull();
    store.close();
  });
});

describe("SemanticIndex persistence", () => {
  it("loads from cache when manifest is unchanged, rebuilds when stale", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rsi-cache-"));
    await cp(FIXTURE, dir, { recursive: true });
    const cachePath = join(dir, ".devagent-rails.db");

    const first = SemanticIndex.create(dir, { cachePath });
    await first.build();
    expect(first.status().loadedFromCache).toBe(false);
    const entityCount = first.status().entityCount;
    first.dispose();

    const second = SemanticIndex.create(dir, { cachePath });
    await second.build();
    expect(second.status().loadedFromCache).toBe(true);
    expect(second.status().entityCount).toBe(entityCount);
    // Query engine works off the cached graph.
    expect(second.query.findModel("User")?.associations.length).toBeGreaterThan(0);
    expect(second.query.findRoute("/users", "GET")?.action).toBe("index");
    second.dispose();

    // Touch a file → manifest hash changes → full rebuild.
    const now = new Date();
    await utimes(join(dir, "app", "models", "user.rb"), now, now);
    const third = SemanticIndex.create(dir, { cachePath });
    await third.build();
    expect(third.status().loadedFromCache).toBe(false);
    expect(third.status().entityCount).toBe(entityCount);
    third.dispose();
  });

  it("supports incremental update after a cache-warm start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rsi-cache-upd-"));
    await cp(FIXTURE, dir, { recursive: true });
    const cachePath = join(dir, ".devagent-rails.db");

    const first = SemanticIndex.create(dir, { cachePath });
    await first.build();
    first.dispose();

    const warm = SemanticIndex.create(dir, { cachePath });
    await warm.build();
    expect(warm.status().loadedFromCache).toBe(true);

    writeFileSync(
      join(dir, "app", "models", "user.rb"),
      ["class User < ApplicationRecord", "  has_many :orders", "end"].join("\n"),
    );
    await warm.update(["app/models/user.rb"]);

    const user = warm.query.findModel("User");
    expect(user?.callbacks).toHaveLength(0);
    expect(warm.graph.edgesFrom(user!.id, "has_many").map((e) => e.to)).toContain("model:Order");
    warm.dispose();
  });
});
