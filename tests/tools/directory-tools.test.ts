import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ListDirectoryTool,
  DeleteFileTool,
  MakeDirectoryTool,
  CopyFileTool,
  MoveFileTool,
} from "../../src/tools/directory-tools.js";

describe("ListDirectoryTool", () => {
  it("lists files and directories with type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "x");
    await mkdir(join(dir, "sub"));
    const tool = new ListDirectoryTool(dir);

    const result = await tool.call({ path: "." });

    const entries = result.entries as { name: string; type: string }[];
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "a.txt", type: "file" }),
        expect.objectContaining({ name: "sub", type: "directory" }),
      ]),
    );
  });

  it("defaults to root when path is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "x");
    const tool = new ListDirectoryTool(dir);

    const result = await tool.call({});

    expect(result.path).toBe(".");
    const entries = result.entries as { name: string; type: string }[];
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "a.txt", type: "file" }),
      ]),
    );
  });
});

describe("DeleteFileTool", () => {
  it("removes a file recursively", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "x");
    const tool = new DeleteFileTool(dir);

    const result = await tool.call({ path: "a.txt" });

    expect(result.removed).toBe(true);
  });
});

describe("MakeDirectoryTool", () => {
  it("creates nested directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new MakeDirectoryTool(dir);

    const result = await tool.call({ path: "a/b/c" });

    expect(result.created).toBe(true);
  });
});

describe("CopyFileTool", () => {
  it("copies a file within the workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "x");
    const tool = new CopyFileTool(dir);

    const result = await tool.call({ source: "a.txt", destination: "b.txt" });

    expect(result.copied).toBe(true);
  });

  it("returns ArgumentError when destination is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new CopyFileTool(dir);

    const result = await tool.call({ source: "a.txt" });

    expect(result.error).toBe("ArgumentError");
  });
});

describe("MoveFileTool", () => {
  it("renames a file within the workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "x");
    const tool = new MoveFileTool(dir);

    const result = await tool.call({ source: "a.txt", destination: "b.txt" });

    expect(result.moved).toBe(true);
  });
});
