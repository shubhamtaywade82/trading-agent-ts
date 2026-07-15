/**
 * Discovers and loads skills from disk. Never throws for a single bad
 * skill directory — malformed or missing SKILL.md is skipped, not fatal,
 * since skills are an optional enhancement, not a hard dependency.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { SkillContent, SkillMeta, SkillScope } from "./types.js";

export interface DiscoverOptions {
  workspaceRoot: string;
  /** Override for tests; defaults to os.homedir(). */
  homeDir?: string;
}

function skillsDir(root: string): string {
  return join(root, ".devagent", "skills");
}

function listSkillDirs(root: string): string[] {
  const dir = skillsDir(root);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

function listResourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return (readdirSync(dir, { recursive: true }) as string[]).filter((entry) => {
      try {
        return statSync(join(dir, entry)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** Reads and parses one skill's SKILL.md into SkillMeta. Returns null if missing/malformed. */
export function loadSkillMeta(skillDir: string, scope: SkillScope): SkillMeta | null {
  const path = join(skillDir, "SKILL.md");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const { data } = matter(raw);
    const id = skillDir.split(/[/\\]/).filter(Boolean).pop() ?? "";
    if (!id) return null;
    return {
      id,
      name: typeof data.name === "string" && data.name ? data.name : id,
      description: typeof data.description === "string" ? data.description : "",
      tags: Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === "string") : [],
      version: typeof data.version === "string" && data.version ? data.version : "0.0.0",
      language: typeof data.language === "string" && data.language ? data.language : undefined,
      scope,
      dir: skillDir,
      path,
    };
  } catch {
    return null;
  }
}

/**
 * Scans .devagent/skills/ (workspace) and ~/.devagent/skills/ (global) for
 * skill directories, parsing SKILL.md frontmatter only (cheap). Workspace
 * skills override global skills sharing an id.
 */
export function discoverSkills(opts: DiscoverOptions): SkillMeta[] {
  const global = listSkillDirs(opts.homeDir ?? homedir())
    .map((dir) => loadSkillMeta(dir, "global"))
    .filter((s): s is SkillMeta => s != null);
  const workspace = listSkillDirs(opts.workspaceRoot)
    .map((dir) => loadSkillMeta(dir, "workspace"))
    .filter((s): s is SkillMeta => s != null);

  const byId = new Map<string, SkillMeta>();
  for (const skill of global) byId.set(skill.id, skill);
  for (const skill of workspace) byId.set(skill.id, skill); // workspace wins
  return [...byId.values()];
}

/** Lazily loads full content (body + reference/script/template listings) for one skill. */
export function loadSkillContent(meta: SkillMeta): SkillContent {
  const raw = readFileSync(meta.path, "utf8");
  const { content } = matter(raw);
  return {
    ...meta,
    body: content.trim(),
    references: listResourceFiles(join(meta.dir, "references")),
    scripts: listResourceFiles(join(meta.dir, "scripts")),
    templates: listResourceFiles(join(meta.dir, "templates")),
  };
}
