import { Provider } from "../../src/provider/provider.js";
import { ModelCatalog, inferCapabilities } from "../../src/provider/catalog.js";

describe("inferCapabilities", () => {
  it("tags vision models", () => {
    expect(inferCapabilities("qwen3-vl:4b")).toEqual(expect.arrayContaining(["vision", "tools"]));
  });

  it("tags reasoning models", () => {
    expect(inferCapabilities("deepseek-r1:8b")).toEqual(expect.arrayContaining(["reasoning", "tools"]));
  });

  it("tags small models as quick", () => {
    expect(inferCapabilities("nemotron-3-nano:4b")).toEqual(expect.arrayContaining(["quick", "tools"]));
  });

  it("defaults to coding for plain instruct models", () => {
    expect(inferCapabilities("qwen3:8b")).toEqual(expect.arrayContaining(["coding", "tools"]));
  });
});

describe("ModelCatalog.refresh", () => {
  it("merges local and cloud model lists, tagged by tier", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    const cloud = new Provider({ tier: "cloud", model: "x", apiKey: "k" });

    jest.spyOn(local, "availableModels").mockResolvedValue({ models: [{ name: "qwen3:8b" }] });
    jest.spyOn(cloud, "availableModels").mockResolvedValue({ data: [{ id: "qwen3-vl:4b" }] });

    const catalog = new ModelCatalog(local, cloud);
    const models = await catalog.refresh();

    expect(models).toEqual([
      { name: "qwen3:8b", tier: "local", capabilities: expect.arrayContaining(["coding"]) },
      { name: "qwen3-vl:4b", tier: "cloud", capabilities: expect.arrayContaining(["vision"]) },
    ]);
  });

  it("tolerates an unreachable local Ollama and keeps cloud models", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    const cloud = new Provider({ tier: "cloud", model: "x", apiKey: "k" });

    jest.spyOn(local, "availableModels").mockRejectedValue(new Error("ECONNREFUSED"));
    jest.spyOn(cloud, "availableModels").mockResolvedValue({ data: [{ id: "qwen3:8b" }] });

    const catalog = new ModelCatalog(local, cloud);
    const models = await catalog.refresh();

    expect(models).toHaveLength(1);
    expect(models[0].tier).toBe("cloud");
  });

  it("modelsFor sorts local candidates before cloud", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    const cloud = new Provider({ tier: "cloud", model: "x", apiKey: "k" });

    jest.spyOn(local, "availableModels").mockResolvedValue({ models: [{ name: "qwen3:8b" }] });
    jest.spyOn(cloud, "availableModels").mockResolvedValue({ data: [{ id: "qwen3.5:8b" }] });

    const catalog = new ModelCatalog(local, cloud);
    await catalog.refresh();

    const candidates = catalog.modelsFor("coding");
    expect(candidates[0].tier).toBe("local");
  });

  it("uses local Ollama's real capabilities array instead of guessing from the name", async () => {
    // Real /api/tags shape — a model named without any vision/reasoning hints
    // in its name, but genuinely capable per the server's own metadata.
    const local = new Provider({ tier: "local", model: "x" });
    jest.spyOn(local, "availableModels").mockResolvedValue({
      models: [
        {
          name: "trading-core:latest",
          model: "trading-core:latest",
          details: { parameter_size: "4.7B" },
          capabilities: ["vision", "completion", "tools", "thinking"],
        },
      ],
    });

    const catalog = new ModelCatalog(local);
    const models = await catalog.refresh();

    // Name-heuristic alone would never guess vision/reasoning for this name.
    // 4.7B is above the 4B "quick" threshold, so it's correctly excluded.
    expect(models[0].capabilities).toEqual(expect.arrayContaining(["tools", "vision", "reasoning"]));
    expect(models[0].capabilities).not.toContain("quick");
    expect(models[0].capabilities).not.toContain("coding"); // has vision/reasoning, so no coding fallback
  });

  it("does not tag quick for a real capabilities model over the size threshold", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    jest.spyOn(local, "availableModels").mockResolvedValue({
      models: [
        {
          name: "big-model:latest",
          details: { parameter_size: "70B" },
          capabilities: ["tools", "completion"],
        },
      ],
    });

    const catalog = new ModelCatalog(local);
    const models = await catalog.refresh();

    expect(models[0].capabilities).not.toContain("quick");
    expect(models[0].capabilities).toEqual(expect.arrayContaining(["tools", "coding"]));
  });

  it("parses M-suffixed parameter sizes as quick too", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    jest.spyOn(local, "availableModels").mockResolvedValue({
      models: [{ name: "tiny:latest", details: { parameter_size: "494.03M" }, capabilities: ["tools"] }],
    });

    const catalog = new ModelCatalog(local);
    const models = await catalog.refresh();

    expect(models[0].capabilities).toContain("quick");
  });

  it("falls back to the name heuristic for local models with no capabilities field (older Ollama)", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    jest.spyOn(local, "availableModels").mockResolvedValue({
      models: [{ name: "deepseek-r1:8b" }], // no `capabilities` key at all
    });

    const catalog = new ModelCatalog(local);
    const models = await catalog.refresh();

    expect(models[0].capabilities).toEqual(expect.arrayContaining(["reasoning"]));
  });

  it("does not tag an embedding-only model as coding — it can't generate text at all", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    jest.spyOn(local, "availableModels").mockResolvedValue({
      models: [{ name: "nomic-embed-text:latest", details: { parameter_size: "137M" }, capabilities: ["embedding"] }],
    });

    const catalog = new ModelCatalog(local);
    const models = await catalog.refresh();

    expect(models[0].capabilities).not.toContain("coding");
    expect(models[0].capabilities).not.toContain("tools");
    expect(models[0].capabilities).toContain("quick"); // size-based tagging still applies
  });

  it("cloud models (no capabilities field in /v1/models) still use the name heuristic", async () => {
    const cloud = new Provider({ tier: "cloud", model: "x", apiKey: "k" });
    jest.spyOn(cloud, "availableModels").mockResolvedValue({ data: [{ id: "qwen3-vl:4b" }] });

    const catalog = new ModelCatalog(undefined, cloud);
    const models = await catalog.refresh();

    expect(models[0].capabilities).toEqual(expect.arrayContaining(["vision"]));
  });
});
