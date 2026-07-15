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
    process.env.TRADINGAGENT_WORKSPACE = workspaceRoot;
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
    mkdirSync(join(workspaceRoot, ".trading-agent"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, ".trading-agent", "config.json"),
      JSON.stringify({ apiKeys: ["primary_key", "file_key"] }),
    );

    expect(loadConfig().apiKeys).toEqual(["primary_key", "file_key"]);
  });
});

describe("workspace root resolution (git-root, like most editor tooling)", () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();

  beforeEach(() => {
    delete process.env.TRADINGAGENT_WORKSPACE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    process.chdir(originalCwd);
  });

  it("finds the project root via .git even with no .trading-agent yet (first run in a new project)", async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "gitroot-test-")));
    mkdirSync(join(projectRoot, ".git"));
    const nested = join(projectRoot, "src", "deep", "nested");
    mkdirSync(nested, { recursive: true });

    process.chdir(nested);
    expect(loadConfig().workspaceRoot).toBe(projectRoot);
  });

  it("finds the project root when launched from a subdirectory with no .trading-agent yet", async () => {
    // Regression: a prior session created .trading-agent at the git root; a new
    // session launched from a different, still-.trading-agent-less subdirectory
    // must resolve to the same root, not fork off a fresh one.
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "gitroot-test-")));
    mkdirSync(join(projectRoot, ".git"));
    mkdirSync(join(projectRoot, ".trading-agent"));
    const otherSubdir = join(projectRoot, "packages", "other");
    mkdirSync(otherSubdir, { recursive: true });

    process.chdir(otherSubdir);
    expect(loadConfig().workspaceRoot).toBe(projectRoot);
  });

  it("falls back to nearest .trading-agent when there is no .git", async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "devagent-only-test-")));
    mkdirSync(join(projectRoot, ".trading-agent"));
    const nested = join(projectRoot, "sub");
    mkdirSync(nested);

    process.chdir(nested);
    expect(loadConfig().workspaceRoot).toBe(projectRoot);
  });

  it("prefers .git over a farther-out .trading-agent when both exist at different levels", async () => {
    const outer = await realpath(await mkdtemp(join(tmpdir(), "outer-devagent-")));
    mkdirSync(join(outer, ".trading-agent"));
    const inner = join(outer, "project");
    mkdirSync(inner);
    mkdirSync(join(inner, ".git"));

    process.chdir(inner);
    expect(loadConfig().workspaceRoot).toBe(inner);
  });

  it("TRADINGAGENT_WORKSPACE still overrides everything", async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "gitroot-test-")));
    mkdirSync(join(projectRoot, ".git"));
    const override = await realpath(await mkdtemp(join(tmpdir(), "override-test-")));

    process.env.TRADINGAGENT_WORKSPACE = override;
    process.chdir(projectRoot);
    expect(loadConfig().workspaceRoot).toBe(override);
  });
});
