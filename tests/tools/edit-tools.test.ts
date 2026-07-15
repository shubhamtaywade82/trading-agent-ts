import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PatchTool, AppendTool } from "../../src/tools/edit-tools.js";

describe("PatchTool", () => {
  it("replaces the first occurrence of a find block", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "hello world");
    const tool = new PatchTool(dir);

    await tool.call({ path: "a.txt", find: "world", replace: "there" });

    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("hello there");
  });

  it("throws ToolError when find block is not present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "hello world");
    const tool = new PatchTool(dir);

    await expect(tool.call({ path: "a.txt", find: "missing", replace: "x" })).rejects.toThrow(/not found/);
  });
});

describe("AppendTool", () => {
  it("appends content and creates parent directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new AppendTool(dir);

    await tool.call({ path: "out/log.txt", content: "line1\n" });
    await tool.call({ path: "out/log.txt", content: "line2\n" });

    expect(await readFile(join(dir, "out/log.txt"), "utf-8")).toBe("line1\nline2\n");
  });
});
