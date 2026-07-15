import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitTool } from "../../src/tools/git-tools.js";

const exec = promisify(execFile);

describe("GitTool", () => {
  it("runs an allowlisted subcommand and returns stdout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await exec("git", ["init"], { cwd: dir });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await exec("git", ["config", "user.name", "Test"], { cwd: dir });
    const tool = new GitTool(dir);

    const result = await tool.call({ args: ["status", "--porcelain"] });

    expect(result.exitCode).toBe(0);
  });

  it("rejects a subcommand not on the allowlist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new GitTool(dir);

    const result = await tool.call({ args: ["push", "origin", "main"] });

    expect(result.error).toBe("DisallowedGitCommandError");
  });

  it("rejects reset --hard even though reset alone might seem safe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new GitTool(dir);

    const result = await tool.call({ args: ["reset", "--hard", "HEAD~1"] });

    expect(result.error).toBe("DisallowedGitCommandError");
  });
});
