/**
 * Deterministic keyword/tag overlap scoring — no ML/embeddings. Tag hits
 * are weighted higher than description-word hits. Ties are broken by
 * skill id so resolution is reproducible.
 */

import { SkillMeta, SkillScore } from "./types.js";

const TAG_WEIGHT = 3;
const DESCRIPTION_WEIGHT = 1;
const LANGUAGE_MISMATCH_PENALTY = -10;

// Common English function words. Without this filter, a skill with a long,
// prose-heavy description (many stopword hits) scores nonzero against almost
// any prompt regardless of topic and crowds out more relevant skills.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "when", "at", "by", "for",
  "with", "about", "against", "between", "into", "through", "during", "before", "after",
  "above", "below", "to", "from", "up", "down", "in", "out", "on", "off", "over", "under",
  "again", "further", "once", "here", "there", "all", "any", "both", "each", "few", "more",
  "most", "other", "some", "such", "no", "nor", "not", "only", "own", "same", "so", "than",
  "too", "very", "s", "t", "can", "will", "just", "don", "should", "now", "is", "are", "was",
  "were", "be", "been", "being", "have", "has", "had", "having", "do", "does", "did", "doing",
  "this", "that", "these", "those", "i", "you", "he", "she", "it", "we", "they", "what",
  "which", "who", "whom", "of", "as", "until", "while", "use", "uses", "using", "also",
  "your", "our", "their", "its", "get", "gets", "want", "wants", "wanted",
]);

export interface ResolveOptions {
  topN?: number;
  minScore?: number;
  /** When set, skills with a declared `language` that differs are penalised heavily. */
  projectLanguage?: string;
}

/** Lowercase, word-boundary tokenization with de-duplication. */
export function tokenize(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words);
}

function scoreSkill(promptTokens: Set<string>, skill: SkillMeta, projectLanguage?: string): SkillScore {
  let score = 0;
  const matchedTags: string[] = [];

  for (const tag of skill.tags) {
    const tagTokens = tokenize(tag);
    if ([...tagTokens].some((t) => promptTokens.has(t))) {
      score += TAG_WEIGHT;
      matchedTags.push(tag);
    }
  }

  const descriptionTokens = tokenize(`${skill.name} ${skill.description}`);
  for (const token of descriptionTokens) {
    if (STOPWORDS.has(token)) continue;
    if (promptTokens.has(token)) score += DESCRIPTION_WEIGHT;
  }

  // Heavily penalise skills that target a different programming language
  if (skill.language && projectLanguage && skill.language !== projectLanguage) {
    score += LANGUAGE_MISMATCH_PENALTY;
  }

  return { meta: skill, score, matchedTags };
}

export function resolveSkills(prompt: string, catalog: SkillMeta[], opts: ResolveOptions = {}): SkillScore[] {
  const topN = opts.topN ?? 3;
  const minScore = opts.minScore ?? 1;
  const promptTokens = tokenize(prompt);

  return catalog
    .map((skill) => scoreSkill(promptTokens, skill, opts.projectLanguage))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score || a.meta.id.localeCompare(b.meta.id))
    .slice(0, topN);
}
