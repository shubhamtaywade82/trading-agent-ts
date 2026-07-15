/**
 * Completion engine: ghost text and autocomplete candidates.
 *
 * Ghost text is the gray continuation shown after the caret — Tab accepts
 * all of it, Right Arrow accepts one word, Esc dismisses.
 */

import { SlashCommandRegistry } from "./slash-commands.js";
import { BUILTIN_TEMPLATES, PromptTemplate, templateCompletions } from "./templates.js";

/**
 * Ghost suffix for the current input, from the newest history entry that
 * starts with it. Returns "" when there is nothing to suggest.
 */
export function ghostSuffix(input: string, history: string[]): string {
  if (!input) return "";
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.length > input.length && entry.startsWith(input)) {
      return entry.slice(input.length);
    }
  }
  return "";
}

/** Accept a single word (plus leading space) from a ghost suffix. */
export function acceptWord(suffix: string): { accepted: string; rest: string } {
  const match = suffix.match(/^\s*\S+/);
  if (!match) return { accepted: suffix, rest: "" };
  return { accepted: match[0], rest: suffix.slice(match[0].length) };
}

export interface CompletionItem {
  label: string;
  detail: string;
  insert: string;
}

/**
 * Autocomplete candidates for the prompt: slash commands when the input
 * starts with "/", prompt templates when it starts with "@".
 */
export function completions(
  input: string,
  registry: SlashCommandRegistry,
  templates: PromptTemplate[] = BUILTIN_TEMPLATES,
): CompletionItem[] {
  if (input.startsWith("@")) return templateCompletions(input, templates);
  if (!input.startsWith("/") || input.includes(" ")) return [];
  const prefix = input.slice(1);
  return registry.complete(prefix).map((c) => ({
    label: `/${c.name}`,
    detail: c.description,
    insert: `/${c.name} `,
  }));
}
