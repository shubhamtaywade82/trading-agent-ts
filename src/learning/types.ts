/**
 * Self-improvement domain types.
 *
 * Pipeline: EpisodeRecorder → Grader → Reflector → LessonStore → SkillSynthesizer.
 * Learned knowledge is materialized as normal workspace skills under
 * .devagent/skills/learned-<topic>/SKILL.md so the existing SkillsRegistry,
 * resolver, and skill_usage stats close the loop without a separate prompt path.
 */

export interface ToolEvent {
  name: string;
  args: Record<string, unknown>;
  /** Compact outcome — never the full result payload. */
  ok: boolean;
  errorLabel?: string;
  durationMs: number;
  at: number;
}

export interface Episode {
  id: string;
  goal: string;
  startedAt: number;
  endedAt: number;
  toolEvents: ToolEvent[];
  /** Skills that were injected for this episode (their ids). */
  activatedSkillIds: string[];
  /** Terminal condition reported by the agent loop. */
  terminal: "answered" | "loop_abort" | "turn_budget" | "error" | "user_cancel";
  finalAssistantText: string;
  /** Populated by the grader, not the recorder. */
  grade?: Grade;
}

export interface Grade {
  /** 0..1 composite. */
  score: number;
  signals: {
    testsRan: boolean;
    testsPassed: boolean | null;
    toolErrorRate: number;
    pathEscapes: number;
    patchFailures: number;
    loopAborted: boolean;
    turnCount: number;
    retriedSameToolMax: number;
  };
  verdict: "success" | "partial" | "failure";
}

export interface Lesson {
  /** Stable content hash — dedupe key. */
  id: string;
  /** One imperative sentence, e.g. "Run `bundle exec rspec` from the app root, not spec/". */
  text: string;
  /** Topic tags used for skill grouping and resolver matching. */
  tags: string[];
  /** Optional language scoping (matches SkillMeta.language). */
  language?: string;
  kind: "pitfall" | "procedure" | "preference" | "project_fact";
  confidence: number;
  evidenceCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Episode ids supporting this lesson — provenance for audit/pruning. */
  episodeIds: string[];
  promotedSkillId: string | null;
}

export interface ReflectionResult {
  lessons: Array<Pick<Lesson, "text" | "tags" | "kind"> & { language?: string }>;
}
