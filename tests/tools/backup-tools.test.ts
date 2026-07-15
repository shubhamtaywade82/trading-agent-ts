import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotBackupTool } from "../../src/tools/backup-tools.js";

describe("SnapshotBackupTool", () => {
  it("copies the target file into .devagent/backups with a timestamp suffix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "content-v1");
    const tool = new SnapshotBackupTool(dir);

    const result = await tool.call({ path: "a.txt" });

    const backupFiles = await readdir(join(dir, ".devagent/backups"));
    expect(backupFiles.length).toBe(1);
    expect(await readFile(join(dir, result.backupPath as string), "utf-8")).toBe("content-v1");
  });

  it("returns an ArgumentError when path is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new SnapshotBackupTool(dir);

    const result = await tool.call({});

    expect(result.error).toBe("ArgumentError");
  });
});
