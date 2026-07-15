import { KnowledgeGraph } from "../../../src/intelligence/rails/graph/graph.js";
import { RsiEntity } from "../../../src/intelligence/rails/types.js";

function entity(id: string, overrides?: Partial<RsiEntity>): RsiEntity {
  const [type, name] = id.split(":");
  return {
    id,
    type: type as RsiEntity["type"],
    name,
    file: `app/${type}s/${name.toLowerCase()}.rb`,
    line: 1,
    ...overrides,
  };
}

describe("KnowledgeGraph", () => {
  it("indexes entities by type, name (case-insensitive), and file", () => {
    const graph = new KnowledgeGraph();
    graph.addEntity(entity("model:User"));
    graph.addEntity(entity("controller:UsersController"));

    expect(graph.findByType("model")).toHaveLength(1);
    expect(graph.findByName("user")[0].id).toBe("model:User");
    expect(graph.findByName("users_controller", "controller")[0].id).toBe("controller:UsersController");
    expect(graph.findByFile("app/models/user.rb")[0].id).toBe("model:User");
  });

  it("replaces an entity re-added with the same id", () => {
    const graph = new KnowledgeGraph();
    graph.addEntity(entity("model:User"));
    graph.addEntity(entity("model:User", { line: 42 }));

    expect(graph.findByType("model")).toHaveLength(1);
    expect(graph.getEntity("model:User")?.line).toBe(42);
  });

  it("removeByFile drops entities and their edges", () => {
    const graph = new KnowledgeGraph();
    graph.addEntity(entity("model:User"));
    graph.addEntity(entity("model:Order"));
    graph.addEdge({ from: "model:User", to: "model:Order", type: "has_many" });

    graph.removeByFile("app/models/user.rb");

    expect(graph.getEntity("model:User")).toBeUndefined();
    expect(graph.getEntity("model:Order")).toBeDefined();
    expect(graph.allEdges()).toHaveLength(0);
    expect(graph.edgesTo("model:Order")).toHaveLength(0);
  });

  it("traverses BFS with depth and edge-type filters", () => {
    const graph = new KnowledgeGraph();
    graph.addEntity(entity("route:GET /users"));
    graph.addEntity(entity("controller:UsersController"));
    graph.addEntity(entity("model:User"));
    graph.addEntity(entity("model:Order"));
    graph.addEdge({ from: "route:GET /users", to: "controller:UsersController", type: "routes_to" });
    graph.addEdge({ from: "controller:UsersController", to: "model:User", type: "calls" });
    graph.addEdge({ from: "model:User", to: "model:Order", type: "has_many" });

    const all = graph.traverse("route:GET /users", { maxDepth: 3 });
    expect(all.map((n) => n.entity.id)).toEqual([
      "route:GET /users",
      "controller:UsersController",
      "model:User",
      "model:Order",
    ]);

    const shallow = graph.traverse("route:GET /users", { maxDepth: 1 });
    expect(shallow).toHaveLength(2);

    const onlyCalls = graph.traverse("controller:UsersController", { edgeTypes: ["calls"] });
    expect(onlyCalls.map((n) => n.entity.id)).toEqual(["controller:UsersController", "model:User"]);
  });

  it("traverses incoming edges for dependents", () => {
    const graph = new KnowledgeGraph();
    graph.addEntity(entity("model:User"));
    graph.addEntity(entity("service:CreateUser"));
    graph.addEdge({ from: "service:CreateUser", to: "model:User", type: "calls" });

    const dependents = graph.traverse("model:User", { direction: "in" });
    expect(dependents.map((n) => n.entity.id)).toEqual(["model:User", "service:CreateUser"]);
  });

  it("reports stats", () => {
    const graph = new KnowledgeGraph();
    graph.addEntity(entity("model:User"));
    graph.addEntity(entity("model:Order"));
    graph.addEdge({ from: "model:User", to: "model:Order", type: "has_many" });

    const stats = graph.stats();
    expect(stats.nodes).toBe(2);
    expect(stats.edges).toBe(1);
    expect(stats.byType.model).toBe(2);
  });
});
