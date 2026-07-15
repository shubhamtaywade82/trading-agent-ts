import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubTool } from "../../src/tools/github-tools.js";

describe("GitHubTool", () => {
  it("runs an allowlisted subcommand and returns a real exit code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new GitHubTool(dir);

    const result = await tool.call({ args: ["repo", "view", "--json", "name"] });

    expect(typeof result.exitCode).toBe("number");
    expect(result.command).toBe("gh repo view --json name");
  });

  it("rejects a subcommand not on the allowlist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new GitHubTool(dir);

    const result = await tool.call({ args: ["auth", "logout"] });

    expect(result.error).toBe("DisallowedGitHubCommandError");
  });

  it("rejects merge even though pr is allowlisted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new GitHubTool(dir);

    const result = await tool.call({ args: ["pr", "merge", "1"] });

    expect(result.error).toBe("DisallowedGitHubCommandError");
  });

  it("rejects delete and close verbs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new GitHubTool(dir);

    await expect(tool.call({ args: ["issue", "delete", "1"] })).resolves.toMatchObject({
      error: "DisallowedGitHubCommandError",
    });
    await expect(tool.call({ args: ["pr", "close", "1"] })).resolves.toMatchObject({
      error: "DisallowedGitHubCommandError",
    });
  });

  it("rejects empty args", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new GitHubTool(dir);

    const result = await tool.call({ args: [] });

    expect(result.error).toBe("ArgumentError");
  });
});
