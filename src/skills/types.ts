/**
 * Skills domain types. A Skill is reusable expertise (SKILL.md + optional
 * references/scripts/templates), not a callable Tool.
 *
 * SkillMeta is cheap and held in memory for every discovered skill.
 * SkillContent (body + resource listing) is read from disk lazily, only
 * for skills that win resolution for a given prompt — this is the
 * "progressive disclosure" requirement from the Agent Skills spec.
 */

export type SkillScope = "workspace" | "global";

export interface SkillMeta {
  /** Directory name, not the frontmatter `name` — avoids id/directory mismatch. */
  id: string;
  name: string;
  description: string;
  tags: string[];
  version: string;
  scope: SkillScope;
  /** Absolute path to the skill's directory, for lazy loads. */
  dir: string;
  /** Absolute path to SKILL.md itself. */
  path: string;
  /** Optional programming language this skill targets (e.g. "python", "ruby"). */
  language?: string;
}

export interface SkillContent extends SkillMeta {
  /** Markdown body, frontmatter stripped. */
  body: string;
  /** Relative paths under references/. */
  references: string[];
  /** Relative paths under scripts/. */
  scripts: string[];
  /** Relative paths under templates/. */
  templates: string[];
}

export interface SkillScore {
  meta: SkillMeta;
  score: number;
  matchedTags: string[];
}

export interface SkillUsageStats {
  skillId: string;
  useCount: number;
  successCount: number;
  lastUsedAt: number | null;
}
