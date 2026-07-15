import { Provider, ChatMessage } from "../provider/provider.js";
import { Episode, ReflectionResult } from "./types.js";

/**
 * Distills a graded episode into 0–3 candidate lessons. Malformed provider
 * output returns an empty result rather than throwing into the agent loop.
 */
const MAX_LESSONS = 3;
const VALID_KINDS = new Set(["pitfall", "procedure", "preference", "project_fact"]);

function buildPrompt(episode: Episode): string {
  const grade = episode.grade;
  const trace = episode.toolEvents
    .map((event) => `${event.ok ? "ok " : "ERR"} ${event.name}${event.errorLabel ? ` — ${event.errorLabel}` : ""}`)
    .join("\n");

  return [
    "You review one completed dev-agent task and extract durable lessons for future tasks in THIS repository.",
    "",
    `GOAL: ${episode.goal}`,
    `OUTCOME: ${grade?.verdict ?? "unknown"} (score ${grade?.score.toFixed(2) ?? "?"}, terminal ${episode.terminal})`,
    "TOOL TRACE:",
    trace || "(no tool calls)",
    "",
    "Extract at most 3 lessons. Only include a lesson if the trace contains direct evidence for it.",
    "A lesson must be one imperative sentence, actionable on a future task, and not restate the goal.",
    "Prefer pitfalls (what failed and how it was fixed) and procedures (command/order that worked).",
    "Respond with ONLY this JSON, no markdown fences, no preamble:",
    '{"lessons":[{"text":"...","tags":["..."],"kind":"pitfall|procedure|preference|project_fact","language":"ruby"}]}',
    'Omit "language" unless the lesson is language-specific. Respond {"lessons":[]} if nothing generalizes.',
  ].join("\n");
}

export async function reflect(provider: Provider, episode: Episode): Promise<ReflectionResult> {
  const messages: ChatMessage[] = [{ role: "user", content: buildPrompt(episode) }];

  try {
    const response = await provider.chat(messages, { stream: false });
    return parseReflection((response.message?.content ?? "").trim());
  } catch {
    return { lessons: [] };
  }
}

export function parseReflection(raw: string): ReflectionResult {
  const cleaned = raw
    .replace(/^```(?:json)?/m, "")
    .replace(/```$/m, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { lessons: [] };
  }

  const lessons = (parsed as { lessons?: unknown }).lessons;
  if (!Array.isArray(lessons)) return { lessons: [] };

  const valid: ReflectionResult["lessons"] = [];
  for (const item of lessons.slice(0, MAX_LESSONS)) {
    if (typeof item !== "object" || item === null) continue;
    const lesson = item as Record<string, unknown>;
    if (typeof lesson.text !== "string" || lesson.text.trim().length < 10 || lesson.text.length > 300) continue;
    if (typeof lesson.kind !== "string" || !VALID_KINDS.has(lesson.kind)) continue;
    const tags = Array.isArray(lesson.tags)
      ? lesson.tags.filter((tag): tag is string => typeof tag === "string" && tag.length <= 40).slice(0, 5)
      : [];
    if (!tags.length) continue;

    const candidate: ReflectionResult["lessons"][number] = {
      text: lesson.text.trim(),
      tags: tags.map((tag) => tag.toLowerCase()),
      kind: lesson.kind as "pitfall" | "procedure" | "preference" | "project_fact",
    };
    if (typeof lesson.language === "string" && lesson.language) candidate.language = lesson.language.toLowerCase();
    valid.push(candidate);
  }
  return { lessons: valid };
}
