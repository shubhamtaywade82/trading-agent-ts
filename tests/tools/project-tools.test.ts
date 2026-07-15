import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunTestsTool, RunLintTool, RunFormatTool, RunBuildTool } from "../../src/tools/project-tools.js";

async function initProject(scripts: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "ws-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", scripts }));
  await writeFile(join(dir, "package-lock.json"), "{}");
  return dir;
}

describe("RunTestsTool", () => {
  jest.setTimeout(10000);

  it("runs the test script and reports exit code", async () => {
    const dir = await initProject({ test: "node -e \"process.exit(0)\"" });
    const tool = new RunTestsTool(dir);

    const result = await tool.call({});

    expect(result.exitCode).toBe(0);
    expect(result.command).toContain("npm run test");
  });

  it("returns ScriptNotFoundError when no test script is defined", async () => {
    const dir = await initProject({});
    const tool = new RunTestsTool(dir);

    const result = await tool.call({});

    expect(result.error).toBe("ScriptNotFoundError");
  });
});

describe("RunLintTool / RunFormatTool / RunBuildTool", () => {
  it("each map to their respective package.json script", async () => {
    const dir = await initProject({
      lint: "node -e \"process.exit(0)\"",
      format: "node -e \"process.exit(0)\"",
      build: "node -e \"process.exit(0)\"",
    });

    expect((await new RunLintTool(dir).call({})).exitCode).toBe(0);
    expect((await new RunFormatTool(dir).call({})).exitCode).toBe(0);
    expect((await new RunBuildTool(dir).call({})).exitCode).toBe(0);
  });
});
