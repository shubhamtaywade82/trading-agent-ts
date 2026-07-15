import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillsRegistry } from "../../src/skills/registry.js";

function writeSkill(root: string, id: string, frontmatter: string, body = "Body text"): void {
  const dir = join(root, ".devagent", "skills", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`);
}

describe("SkillsRegistry", () => {
  let workspaceRoot: string;
  let homeDir: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "devagent-ws-"));
    homeDir = mkdtempSync(join(tmpdir(), "devagent-home-"));
    writeSkill(workspaceRoot, "rails-api", "name: Rails API\ndescription: REST APIs\ntags: [rails, api]", "Rails body");
    writeSkill(workspaceRoot, "docker", "name: Docker\ndescription: containers\ntags: [docker]", "Docker body");
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("discover() wraps the loader and list() returns metadata", () => {
    const registry = SkillsRegistry.discover({ workspaceRoot, homeDir });
    expect(
      registry
        .list()
        .map((s) => s.id)
        .sort(),
    ).toEqual(["docker", "rails-api"]);
  });

  it("get() finds a known skill and returns undefined for an unknown one", () => {
    const registry = SkillsRegistry.discover({ workspaceRoot, homeDir });
    expect(registry.get("rails-api")?.name).toBe("Rails API");
    expect(registry.get("nope")).toBeUndefined();
  });

  it("resolveForPrompt lazily loads full content for the winning skills", () => {
    const registry = SkillsRegistry.discover({ workspaceRoot, homeDir });
    const resolved = registry.resolveForPrompt("help me with rails api design");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ id: "rails-api", body: "Rails body" });
  });

  it("resolveForPrompt returns nothing when no skill matches", () => {
    const registry = SkillsRegistry.discover({ workspaceRoot, homeDir });
    expect(registry.resolveForPrompt("completely unrelated text")).toEqual([]);
  });

  it("activate(id) bypasses scoring and returns full content", () => {
    const registry = SkillsRegistry.discover({ workspaceRoot, homeDir });
    expect(registry.activate("docker")).toMatchObject({ id: "docker", body: "Docker body" });
    expect(registry.activate("unknown-id")).toBeUndefined();
  });
});
