import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchCodeTool } from "../../src/tools/search-tools.js";

describe("SearchCodeTool", () => {
  it("finds matching lines with file path and line number", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.ts"), "function foo() {}\nfunction bar() {}\n");
    const tool = new SearchCodeTool(dir);

    const result = await tool.call({ query: "function bar" });

    const matches = result.matches as { path: string; line: number; text: string }[];
    expect(matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "a.ts", line: 2 })]),
    );
  });

  it("scopes search to a subdirectory when path is given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "b.ts"), "const TODO = 1;\n");
    await writeFile(join(dir, "c.ts"), "const TODO = 2;\n");
    const tool = new SearchCodeTool(dir);

    const result = await tool.call({ query: "TODO", path: "sub" });

    const matches = result.matches as { path: string }[];
    expect(matches.every((m) => m.path.startsWith("sub/"))).toBe(true);
  });

  it("rejects a path that escapes the workspace root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new SearchCodeTool(dir);

    await expect(tool.call({ query: "x", path: "../../etc" })).rejects.toThrow(/escapes workspace root/);
  });

  it("returns empty matches when nothing found, without erroring", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.ts"), "nothing here\n");
    const tool = new SearchCodeTool(dir);

    const result = await tool.call({ query: "zzz_not_present" });

    expect(result.matches).toEqual([]);
  });
});
