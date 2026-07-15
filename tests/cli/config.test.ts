import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { loadConfig } from "../../src/cli/config.js";

describe("loadConfig apiKeys pool", () => {
  const originalEnv = { ...process.env };
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "config-test-"));
    process.env.DEVAGENT_WORKSPACE = workspaceRoot;
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_KEYS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("is undefined when no keys are configured anywhere", () => {
    expect(loadConfig().apiKeys).toBeUndefined();
  });

  it("puts OLLAMA_API_KEY first in the pool", () => {
    process.env.OLLAMA_API_KEY = "primary_key";
    expect(loadConfig().apiKeys).toEqual(["primary_key"]);
  });

  it("appends comma-separated OLLAMA_API_KEYS after the primary key", () => {
    process.env.OLLAMA_API_KEY = "primary_key";
    process.env.OLLAMA_API_KEYS = "second_key, third_key";
    expect(loadConfig().apiKeys).toEqual(["primary_key", "second_key", "third_key"]);
  });

  it("merges in keys from the workspace config file and dedupes", () => {
    process.env.OLLAMA_API_KEY = "primary_key";
    mkdirSync(join(workspaceRoot, ".devagent"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, ".devagent", "config.json"),
      JSON.stringify({ apiKeys: ["primary_key", "file_key"] }),
    );

    expect(loadConfig().apiKeys).toEqual(["primary_key", "file_key"]);
  });
});

describe("workspace root resolution (git-root, like most editor tooling)", () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();

  beforeEach(() => {
    delete process.env.DEVAGENT_WORKSPACE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    process.chdir(originalCwd);
  });

  it("finds the project root via .git even with no .devagent yet (first run in a new project)", async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "gitroot-test-")));
    mkdirSync(join(projectRoot, ".git"));
    const nested = join(projectRoot, "src", "deep", "nested");
    mkdirSync(nested, { recursive: true });

    process.chdir(nested);
    expect(loadConfig().workspaceRoot).toBe(projectRoot);
  });

  it("finds the project root when launched from a subdirectory with no .devagent yet", async () => {
    // Regression: a prior session created .devagent at the git root; a new
    // session launched from a different, still-.devagent-less subdirectory
    // must resolve to the same root, not fork off a fresh one.
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "gitroot-test-")));
    mkdirSync(join(projectRoot, ".git"));
    mkdirSync(join(projectRoot, ".devagent"));
    const otherSubdir = join(projectRoot, "packages", "other");
    mkdirSync(otherSubdir, { recursive: true });

    process.chdir(otherSubdir);
    expect(loadConfig().workspaceRoot).toBe(projectRoot);
  });

  it("falls back to nearest .devagent when there is no .git", async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "devagent-only-test-")));
    mkdirSync(join(projectRoot, ".devagent"));
    const nested = join(projectRoot, "sub");
    mkdirSync(nested);

    process.chdir(nested);
    expect(loadConfig().workspaceRoot).toBe(projectRoot);
  });

  it("prefers .git over a farther-out .devagent when both exist at different levels", async () => {
    const outer = await realpath(await mkdtemp(join(tmpdir(), "outer-devagent-")));
    mkdirSync(join(outer, ".devagent"));
    const inner = join(outer, "project");
    mkdirSync(inner);
    mkdirSync(join(inner, ".git"));

    process.chdir(inner);
    expect(loadConfig().workspaceRoot).toBe(inner);
  });

  it("DEVAGENT_WORKSPACE still overrides everything", async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "gitroot-test-")));
    mkdirSync(join(projectRoot, ".git"));
    const override = await realpath(await mkdtemp(join(tmpdir(), "override-test-")));

    process.env.DEVAGENT_WORKSPACE = override;
    process.chdir(projectRoot);
    expect(loadConfig().workspaceRoot).toBe(override);
  });
});
