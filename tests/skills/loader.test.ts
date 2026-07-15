import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, loadSkillContent, loadSkillMeta } from "../../src/skills/loader.js";

function writeSkill(root: string, id: string, frontmatter: string, body = "# Body\n\ncontent"): string {
  const dir = join(root, ".devagent", "skills", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`);
  return dir;
}

describe("loadSkillMeta / discoverSkills", () => {
  let workspaceRoot: string;
  let homeDir: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "devagent-ws-"));
    homeDir = mkdtempSync(join(tmpdir(), "devagent-home-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("parses frontmatter and uses the directory name as id", () => {
    const dir = writeSkill(
      workspaceRoot,
      "rails-api",
      "name: Rails API\ndescription: REST APIs\ntags: [rails, api]\nversion: 1.2.0",
    );
    const meta = loadSkillMeta(dir, "workspace");
    expect(meta).toMatchObject({
      id: "rails-api",
      name: "Rails API",
      description: "REST APIs",
      tags: ["rails", "api"],
      version: "1.2.0",
      scope: "workspace",
    });
  });

  it("falls back to defaults for missing frontmatter fields", () => {
    const dir = writeSkill(workspaceRoot, "bare", "name: Bare");
    const meta = loadSkillMeta(dir, "workspace");
    expect(meta).toMatchObject({ id: "bare", description: "", tags: [], version: "0.0.0" });
  });

  it("returns null for a missing SKILL.md", () => {
    const dir = join(workspaceRoot, ".devagent", "skills", "ghost");
    mkdirSync(dir, { recursive: true });
    expect(loadSkillMeta(dir, "workspace")).toBeNull();
  });

  it("discoverSkills finds workspace and global skills, workspace wins on id collision", () => {
    writeSkill(homeDir, "shared", "name: Global Version\ndescription: from global");
    writeSkill(homeDir, "global-only", "name: Global Only");
    writeSkill(workspaceRoot, "shared", "name: Workspace Version\ndescription: from workspace");

    const found = discoverSkills({ workspaceRoot, homeDir });
    const byId = new Map(found.map((s) => [s.id, s]));

    expect(byId.get("shared")).toMatchObject({ name: "Workspace Version", scope: "workspace" });
    expect(byId.get("global-only")).toMatchObject({ name: "Global Only", scope: "global" });
    expect(found).toHaveLength(2);
  });

  it("skips a directory with no SKILL.md rather than throwing", () => {
    mkdirSync(join(workspaceRoot, ".devagent", "skills", "empty-dir"), { recursive: true });
    writeSkill(workspaceRoot, "valid", "name: Valid");
    expect(() => discoverSkills({ workspaceRoot, homeDir })).not.toThrow();
    expect(discoverSkills({ workspaceRoot, homeDir }).map((s) => s.id)).toEqual(["valid"]);
  });

  it("returns an empty list when no skills directories exist", () => {
    expect(discoverSkills({ workspaceRoot, homeDir })).toEqual([]);
  });
});

describe("loadSkillContent", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "devagent-ws-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("strips frontmatter from the body and lists resource files", () => {
    const dir = writeSkill(workspaceRoot, "with-resources", "name: With Resources", "# Heading\n\nSome body text.");
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(join(dir, "references", "notes.md"), "notes");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "run.sh"), "#!/bin/sh");

    const meta = loadSkillMeta(dir, "workspace")!;
    const content = loadSkillContent(meta);

    expect(content.body).toBe("# Heading\n\nSome body text.");
    expect(content.references).toEqual(["notes.md"]);
    expect(content.scripts).toEqual(["run.sh"]);
    expect(content.templates).toEqual([]);
  });
});
