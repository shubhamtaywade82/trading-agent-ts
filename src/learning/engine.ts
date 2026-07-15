import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { MemoryStore } from "../memory/store.js";
import { Provider } from "../provider/provider.js";
import { EpisodeRecorder } from "./episode-recorder.js";
import { gradeEpisode } from "./grader.js";
import { LessonStore } from "./lesson-store.js";
import { reflect } from "./reflector.js";
import { SkillSynthesizer } from "./skill-synthesizer.js";
import { Episode } from "./types.js";

export interface LearningEngineOptions {
  workspaceRoot: string;
  provider: Provider;
  memory: MemoryStore;
  /** Reflect on at most every Nth episode when the episode was a clean success. */
  reflectSuccessEveryN?: number;
  logger?: Pick<Console, "info" | "warn">;
}

/**
 * Owns the full loop: record → grade → reflect → absorb → synthesize/prune.
 * Background work is serialized and swallowed so learning never adds latency
 * to, or throws into, the user-facing turn.
 */
export class LearningEngine {
  readonly recorder = new EpisodeRecorder();
  private readonly lessons: LessonStore;
  private readonly synthesizer: SkillSynthesizer;
  private readonly reflectSuccessEveryN: number;
  private readonly logger: Pick<Console, "info" | "warn">;
  private successCounter = 0;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(private readonly opts: LearningEngineOptions) {
    const dbPath = join(opts.workspaceRoot, ".devagent", "lessons.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.lessons = new LessonStore(dbPath);
    this.synthesizer = new SkillSynthesizer(opts.workspaceRoot, this.lessons, opts.logger);
    this.reflectSuccessEveryN = opts.reflectSuccessEveryN ?? 4;
    this.logger = opts.logger ?? console;
  }

  onEpisodeEnd(terminal: Episode["terminal"], finalText: string): void {
    const episode = this.recorder.end(terminal, finalText);
    if (!episode) return;
    this.inFlight = this.inFlight
      .then(() => this.process(episode))
      .catch((error) => {
        this.logger.warn(`[Learning] pipeline error: ${error instanceof Error ? error.message : error}`);
      });
  }

  flush(): Promise<void> {
    return this.inFlight;
  }

  getLessonStore(): LessonStore {
    return this.lessons;
  }

  close(): void {
    this.lessons.close();
  }

  private async process(episode: Episode): Promise<void> {
    episode.grade = gradeEpisode(episode);
    this.lessons.recordEpisode({
      id: episode.id,
      goal: episode.goal,
      verdict: episode.grade.verdict,
      score: episode.grade.score,
      terminal: episode.terminal,
      startedAt: episode.startedAt,
      endedAt: episode.endedAt,
      toolEventCount: episode.toolEvents.length,
      payload: JSON.stringify(episode),
    });

    const shouldReflect =
      episode.grade.verdict !== "success" || ++this.successCounter % this.reflectSuccessEveryN === 0;
    if (!shouldReflect || episode.toolEvents.length === 0) return;

    const reflection = await reflect(this.opts.provider, episode);
    if (!reflection.lessons.length) return;

    const weight = episode.grade.verdict === "success" ? 0.4 : 0.25;
    const touched = this.lessons.absorb(reflection, episode.id, weight);
    this.logger.info(`[Learning] absorbed ${touched.length} lesson(s) from ${episode.grade.verdict} episode`);

    const report = this.synthesizer.run(this.opts.memory.allSkillUsage());
    if (report.createdOrUpdated.length || report.demoted.length) this.lessons.sweep();
  }
}
