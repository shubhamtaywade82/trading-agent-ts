/**
 * Prompt templates. Typing "@" in the prompt offers reusable templates;
 * selecting one replaces the "@name" token with the template body so the
 * user keeps typing naturally.
 */

export interface PromptTemplate {
  name: string;
  description: string;
  insert: string;
}

export const BUILTIN_TEMPLATES: PromptTemplate[] = [
  {
    name: "review",
    description: "Code review of files or a diff",
    insert: "Review the following for correctness, style, and maintainability: ",
  },
  {
    name: "tests",
    description: "Write tests for code or behavior",
    insert: "Write thorough tests (happy path and edge cases) for: ",
  },
  {
    name: "refactor",
    description: "Refactor without changing behavior",
    insert: "Refactor the following without changing behavior, and explain each change: ",
  },
  {
    name: "docs",
    description: "Write or update documentation",
    insert: "Write clear documentation (with examples) for: ",
  },
  {
    name: "security",
    description: "Security-focused review",
    insert: "Do a security review (injection, path traversal, secrets, unsafe deps) of: ",
  },
];

export function templateCompletions(input: string, templates: PromptTemplate[] = BUILTIN_TEMPLATES) {
  if (!input.startsWith("@") || input.includes(" ")) return [];
  const prefix = input.slice(1);
  return templates
    .filter((t) => t.name.startsWith(prefix))
    .map((t) => ({ label: `@${t.name}`, detail: t.description, insert: t.insert }));
}
