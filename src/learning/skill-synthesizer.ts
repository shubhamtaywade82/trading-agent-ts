import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SkillUsageStats } from "../skills/types.js";
import { LessonStore } from "./lesson-store.js";
import { Lesson } from "./types.js";

/**
 * Materializes promoted lessons as ordinary workspace skills and demotes
 * learned skills whose recorded skill_usage success rate is poor.
 */
const LEARNED_PREFIX = "learned-";
const MIN_USES_BEFORE_JUDGING = 5;
const DEMOTE_BELOW_SUCCESS_RATE = 0.4;
const MAX_LESSONS_PER_SKILL = 8;

export interface SynthesisReport {
  createdOrUpdated: string[];
  demoted: string[];
}

export class SkillSynthesizer {
  constructor(
    private readonly workspaceRoot: string,
    private readonly lessons: LessonStore,
    private readonly logger: Pick<Console, "info" | "warn"> = console,
  ) {}

  synthesize(): string[] {
    const promotable = this.lessons.promotable();
    if (!promotable.length) return [];

    const byTopic = new Map<string, Lesson[]>();
    for (const lesson of promotable) {
      const topic = lesson.tags[0] ?? "general";
      const group = byTopic.get(topic) ?? [];
      group.push(lesson);
      byTopic.set(topic, group);
    }

    const written: string[] = [];
    for (const [topic, group] of byTopic) {
      const skillId = `${LEARNED_PREFIX}${topic.replace(/[^a-z0-9]+/g, "-")}`;
      const existing = this.lessons.promotedLessons(skillId);
      const merged = [...existing, ...group]
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, MAX_LESSONS_PER_SKILL);

      this.writeSkill(skillId, topic, merged);
      this.lessons.markPromoted(
        group.map((lesson) => lesson.id),
        skillId,
      );
      written.push(skillId);
      this.logger.info(`[Learning] promoted ${group.length} lesson(s) into skill ${skillId}`);
    }
    return written;
  }

  prune(usage: SkillUsageStats[]): string[] {
    const demoted: string[] = [];
    for (const stat of usage) {
      if (!stat.skillId.startsWith(LEARNED_PREFIX)) continue;
      if (stat.useCount < MIN_USES_BEFORE_JUDGING) continue;
      const successRate = stat.successCount / stat.useCount;
      if (successRate >= DEMOTE_BELOW_SUCCESS_RATE) continue;

      const dir = join(this.workspaceRoot, ".devagent", "skills", stat.skillId);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      this.lessons.demote(stat.skillId);
      demoted.push(stat.skillId);
      this.logger.warn(
        `[Learning] demoted ${stat.skillId} — success rate ${successRate.toFixed(2)} over ${stat.useCount} uses`,
      );
    }
    return demoted;
  }

  run(usage: SkillUsageStats[]): SynthesisReport {
    return { demoted: this.prune(usage), createdOrUpdated: this.synthesize() };
  }

  private writeSkill(skillId: string, topic: string, lessons: Lesson[]): void {
    const dir = join(this.workspaceRoot, ".devagent", "skills", skillId);
    mkdirSync(dir, { recursive: true });

    const tags = [...new Set(lessons.flatMap((lesson) => lesson.tags))].slice(0, 10);
    const languages = [...new Set(lessons.map((lesson) => lesson.language).filter(Boolean))] as string[];
    const frontmatter = [
      "---",
      `name: Learned — ${topic}`,
      `description: Auto-synthesized lessons about ${topic} from past tasks in this workspace.`,
      `tags: [${tags.join(", ")}]`,
      `version: "1.${lessons.length}.0"`,
      ...(languages.length === 1 ? [`language: ${languages[0]}`] : []),
      "---",
    ].join("\n");

    const body = lessons
      .map((lesson) => {
        const meta = `<!-- lesson:${lesson.id} confidence:${lesson.confidence.toFixed(2)} evidence:${lesson.evidenceCount} episodes:${lesson.episodeIds.slice(-3).join(",")} -->`;
        return `- **[${lesson.kind}]** ${lesson.text}\n  ${meta}`;
      })
      .join("\n");

    const content = [
      frontmatter,
      "",
      `# Learned lessons: ${topic}`,
      "",
      "Apply these when relevant. Each entry carries provenance in an HTML comment;",
      "delete any entry that is wrong — this file is the source of truth.",
      "",
      body,
      "",
    ].join("\n");

    writeFileSync(join(dir, "SKILL.md"), content, "utf8");
  }
}
