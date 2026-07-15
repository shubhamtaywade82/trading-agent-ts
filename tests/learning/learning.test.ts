import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gradeEpisode } from "../../src/learning/grader.js";
import { LessonStore, lessonId } from "../../src/learning/lesson-store.js";
import { parseReflection } from "../../src/learning/reflector.js";
import { SkillSynthesizer } from "../../src/learning/skill-synthesizer.js";
import { Episode, ToolEvent } from "../../src/learning/types.js";

function ev(name: string, ok: boolean, errorLabel?: string): ToolEvent {
  const event: ToolEvent = { name, args: {}, ok, durationMs: 10, at: Date.now() };
  if (errorLabel) event.errorLabel = errorLabel;
  return event;
}

function episode(events: ToolEvent[], terminal: Episode["terminal"] = "answered"): Episode {
  return {
    id: "ep-1",
    goal: "fix the spec",
    startedAt: 0,
    endedAt: 100,
    toolEvents: events,
    activatedSkillIds: [],
    terminal,
    finalAssistantText: "done",
  };
}

describe("gradeEpisode", () => {
  it("scores a clean run with passing tests as success", () => {
    const grade = gradeEpisode(episode([ev("read_file", true), ev("patch_file", true), ev("run_rspec", true)]));

    expect(grade.verdict).toBe("success");
    expect(grade.signals.testsPassed).toBe(true);
  });

  it("uses the LAST test result, so red→green still grades success", () => {
    const grade = gradeEpisode(
      episode([ev("run_rspec", false, "exit 1"), ev("patch_file", true), ev("run_rspec", true)]),
    );

    expect(grade.signals.testsPassed).toBe(true);
    expect(grade.verdict).toBe("success");
  });

  it("fails a loop-aborted episode and detects thrash", () => {
    const grade = gradeEpisode(
      episode(
        [ev("read_file", false, "ENOENT"), ev("read_file", false, "ENOENT"), ev("read_file", false, "ENOENT")],
        "loop_abort",
      ),
    );

    expect(grade.verdict).toBe("failure");
    expect(grade.signals.retriedSameToolMax).toBe(2);
    expect(grade.signals.loopAborted).toBe(true);
  });

  it("penalizes ending on failing tests", () => {
    const grade = gradeEpisode(episode([ev("patch_file", true), ev("run_tests", false, "exit 1")]));

    expect(grade.signals.testsPassed).toBe(false);
    expect(grade.verdict).not.toBe("success");
  });
});

describe("LessonStore", () => {
  let dir: string;
  let store: LessonStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lessons-"));
    store = new LessonStore(join(dir, "lessons.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("dedupes lessons by normalized text and accumulates evidence", () => {
    const first = { lessons: [{ text: "Run rspec from the app root", tags: ["rspec"], kind: "procedure" as const }] };
    const second = {
      lessons: [{ text: "run RSpec, from the app root!", tags: ["rspec"], kind: "procedure" as const }],
    };

    store.absorb(first, "ep-1", 0.4);
    const [lesson] = store.absorb(second, "ep-2", 0.4);

    expect(lesson.evidenceCount).toBe(2);
    expect(lesson.episodeIds).toEqual(["ep-1", "ep-2"]);
    expect(store.all()).toHaveLength(1);
  });

  it("only promotes after evidence and confidence thresholds", () => {
    const result = {
      lessons: [{ text: "Use bundle exec for all ruby commands", tags: ["ruby"], kind: "procedure" as const }],
    };

    store.absorb(result, "ep-1", 0.4);
    store.absorb(result, "ep-2", 0.4);
    expect(store.promotable()).toHaveLength(0);

    store.absorb(result, "ep-3", 0.4);
    const promotable = store.promotable();

    expect(promotable).toHaveLength(1);
    expect(promotable[0].confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("decays stale unpromoted lessons and deletes the noise floor", () => {
    store.absorb(
      { lessons: [{ text: "Some weak one-off observation here", tags: ["misc"], kind: "pitfall" as const }] },
      "ep-1",
      0.1,
    );

    const future = Date.now() + 8 * 24 * 60 * 60 * 1000;
    const { decayed, deleted } = store.sweep(future);

    expect(decayed + deleted).toBeGreaterThanOrEqual(1);
    expect(store.all()).toHaveLength(0);
  });
});

describe("SkillSynthesizer", () => {
  let dir: string;
  let store: LessonStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ws-"));
    store = new LessonStore(join(dir, "lessons.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const silent = { info: () => {}, warn: () => {} };

  it("writes promoted lessons as a discoverable SKILL.md with provenance", () => {
    const result = {
      lessons: [{ text: "Run migrations before rspec in this repo", tags: ["rspec"], kind: "procedure" as const }],
    };
    store.absorb(result, "ep-1", 0.4);
    store.absorb(result, "ep-2", 0.4);
    store.absorb(result, "ep-3", 0.4);

    const synth = new SkillSynthesizer(dir, store, silent);
    const written = synth.synthesize();

    expect(written).toEqual(["learned-rspec"]);
    const path = join(dir, ".devagent", "skills", "learned-rspec", "SKILL.md");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("tags: [rspec]");
    expect(content).toContain("Run migrations before rspec");
    expect(content).toContain(`lesson:${lessonId(result.lessons[0].text)}`);
    expect(store.promotable()).toHaveLength(0);
  });

  it("demotes a learned skill whose measured success rate is poor", () => {
    const result = {
      lessons: [{ text: "Always delete node_modules before building", tags: ["build"], kind: "procedure" as const }],
    };
    store.absorb(result, "ep-1", 0.4);
    store.absorb(result, "ep-2", 0.4);
    store.absorb(result, "ep-3", 0.4);
    const synth = new SkillSynthesizer(dir, store, silent);
    synth.synthesize();

    const demoted = synth.prune([{ skillId: "learned-build", useCount: 6, successCount: 1, lastUsedAt: Date.now() }]);

    expect(demoted).toEqual(["learned-build"]);
    expect(existsSync(join(dir, ".devagent", "skills", "learned-build"))).toBe(false);
    expect(store.all()[0].promotedSkillId).toBeNull();
  });
});

describe("parseReflection", () => {
  it("accepts valid JSON and strips markdown fences", () => {
    const raw =
      '```json\n{"lessons":[{"text":"Use pnpm not npm in this repo","tags":["node"],"kind":"preference"}]}\n```';

    expect(parseReflection(raw).lessons).toHaveLength(1);
  });

  it("rejects malformed items without throwing", () => {
    expect(parseReflection("not json").lessons).toHaveLength(0);
    expect(parseReflection('{"lessons":[{"text":"short","tags":[],"kind":"pitfall"}]}').lessons).toHaveLength(0);
    expect(
      parseReflection('{"lessons":[{"text":"long enough text here","tags":["x"],"kind":"invalid"}]}').lessons,
    ).toHaveLength(0);
  });
});
