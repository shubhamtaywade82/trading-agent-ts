import { mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadFileTool, WriteFileTool, PathEscapeError } from "../../src/tools/filesystem.js";

describe("ReadFileTool", () => {
  it("reads a file inside the workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "hello");
    const tool = new ReadFileTool(dir);

    const result = await tool.call({ path: "a.txt" });

    expect(result.content).toBe("hello");
  });

  it("rejects a path that escapes the workspace root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new ReadFileTool(dir);

    await expect(tool.call({ path: "../../etc/passwd" })).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects reads through symlinks that escape the workspace root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(dir, "outside"));
    const tool = new ReadFileTool(dir);

    await expect(tool.call({ path: "outside/secret.txt" })).rejects.toBeInstanceOf(PathEscapeError);
  });
});

describe("WriteFileTool", () => {
  it("writes atomically, creating parent directories as needed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new WriteFileTool(dir);

    await tool.call({ path: "out/b.txt", content: "data" });

    expect(await readFile(join(dir, "out/b.txt"), "utf-8")).toBe("data");
  });

  it("leaves no temp file behind after a successful write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new WriteFileTool(dir);

    await tool.call({ path: "c.txt", content: "data" });

    const files = await readdir(dir);
    expect(files.some((f) => f.includes(".tmp."))).toBe(false);
  });

  it("rejects a path that escapes the workspace root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new WriteFileTool(dir);

    await expect(tool.call({ path: "../outside.txt", content: "x" })).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects writes through symlinked directories that escape the workspace root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    await symlink(outside, join(dir, "outside"));
    const tool = new WriteFileTool(dir);

    await expect(tool.call({ path: "outside/new.txt", content: "x" })).rejects.toBeInstanceOf(PathEscapeError);
  });
});
