import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerTool } from "../../src/tools/docker-tools.js";

describe("DockerTool", () => {
  it("runs an allowlisted subcommand and returns a real exit code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new DockerTool(dir);

    const result = await tool.call({ args: ["ps"] });

    expect(typeof result.exitCode).toBe("number");
    expect(result.command).toBe("docker ps");
  });

  it("rejects a subcommand not on the allowlist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new DockerTool(dir);

    const result = await tool.call({ args: ["rmi", "-f", "some-image"] });

    expect(result.error).toBe("DisallowedDockerCommandError");
  });

  it("rejects --privileged even on an otherwise-allowed subcommand", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new DockerTool(dir);

    const result = await tool.call({ args: ["run", "--privileged", "alpine"] });

    expect(result.error).toBe("DisallowedDockerCommandError");
  });

  it("rejects empty args", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new DockerTool(dir);

    const result = await tool.call({ args: [] });

    expect(result.error).toBe("ArgumentError");
  });
});
