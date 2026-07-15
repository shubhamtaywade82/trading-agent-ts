import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../../src/tools/registry.js";
import { ReadFileTool } from "../../src/tools/filesystem.js";

describe("Registry", () => {
  it("returns a tool's result on successful invoke", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "x");
    const registry = new Registry().register(new ReadFileTool(dir));

    const result = await registry.invoke("read_file", { path: "a.txt" });

    expect(result.content).toBe("x");
  });

  it("converts a tool exception into an error payload instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const registry = new Registry().register(new ReadFileTool(dir));

    const result = await registry.invoke("read_file", { path: "missing.txt" });

    expect(result.error).toBeDefined();
    expect(result.message as string).toMatch(/ENOENT/);
  });

  it("converts an unknown tool name into an error payload instead of throwing", async () => {
    const registry = new Registry();

    const result = await registry.invoke("nope", {});

    expect(result.error).toBe("ToolError");
  });

  it("exposes registered tools as Ollama tool-calling schemas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const registry = new Registry().register(new ReadFileTool(dir));

    expect(registry.schemas()[0].function.name).toBe("read_file");
  });
});
