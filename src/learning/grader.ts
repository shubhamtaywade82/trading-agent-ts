import { Episode, Grade } from "./types.js";

/**
 * Grades an episode from hard signals only: exit codes, error labels, and
 * terminal conditions. No LLM self-assessment feeds the reward signal.
 */
const TEST_TOOLS = new Set(["run_tests", "run_rspec"]);
const PATCH_TOOLS = new Set(["patch_file", "write_file", "append_file"]);

export function gradeEpisode(episode: Episode): Grade {
  const events = episode.toolEvents;
  const total = events.length || 1;
  const errors = events.filter((event) => !event.ok);
  const testEvents = events.filter((event) => TEST_TOOLS.has(event.name));
  const lastTest = testEvents[testEvents.length - 1];
  const testsRan = testEvents.length > 0;
  const testsPassed = testsRan ? (lastTest?.ok ?? false) : null;
  const pathEscapes = errors.filter((event) => event.errorLabel === "PathEscapeError").length;
  const patchFailures = errors.filter((event) => PATCH_TOOLS.has(event.name)).length;

  let retriedSameToolMax = 0;
  let run = 0;
  for (let i = 1; i < events.length; i++) {
    const previous = events[i - 1];
    const current = events[i];
    const same =
      current.name === previous.name && current.errorLabel !== undefined && current.errorLabel === previous.errorLabel;
    run = same ? run + 1 : 0;
    retriedSameToolMax = Math.max(retriedSameToolMax, run);
  }

  const signals: Grade["signals"] = {
    testsRan,
    testsPassed,
    toolErrorRate: errors.length / total,
    pathEscapes,
    patchFailures,
    loopAborted: episode.terminal === "loop_abort",
    turnCount: events.length,
    retriedSameToolMax,
  };

  let score = 1.0;
  if (episode.terminal === "loop_abort" || episode.terminal === "error") score -= 0.6;
  if (episode.terminal === "turn_budget") score -= 0.4;
  score -= Math.min(0.3, signals.toolErrorRate * 0.6);
  score -= Math.min(0.2, pathEscapes * 0.1);
  score -= Math.min(0.2, retriedSameToolMax * 0.05);
  if (testsRan && testsPassed === false) score -= 0.3;
  if (testsRan && testsPassed === true) score += 0.1;
  score = Math.max(0, Math.min(1, score));

  const verdict: Grade["verdict"] = score >= 0.75 ? "success" : score >= 0.4 ? "partial" : "failure";
  return { score, signals, verdict };
}
