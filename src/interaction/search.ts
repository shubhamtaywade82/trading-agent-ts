/**
 * Search everywhere (Ctrl+F): one index over conversation, logs, memory,
 * tasks, tool calls, git files, and commands. Selecting a result focuses
 * the view that owns it.
 */

import { RuntimeState, ViewId } from "../runtime/types.js";
import { SlashCommandRegistry } from "./slash-commands.js";
import { PickerItem } from "./picker.js";

export interface SearchItem extends PickerItem {
  view: ViewId;
}

const MAX_PER_SOURCE = 50;

function firstLine(text: string, max = 80): string {
  const line = text.split("\n")[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function searchItems(state: RuntimeState, registry: SlashCommandRegistry): SearchItem[] {
  const items: SearchItem[] = [];

  for (const [i, entry] of state.conversation.slice(-MAX_PER_SOURCE).entries()) {
    const label =
      entry.kind === "text" ? firstLine(entry.text) :
      entry.kind === "plan" ? `Plan: ${entry.steps.length} steps` :
      entry.kind === "decision" ? `Strategy: ${entry.selected}` :
      entry.kind === "tool_call" ? `Tool: ${entry.name}` :
      entry.kind === "diff_preview" ? `Diff: ${entry.filePath}` :
      entry.kind === "test_result" ? `Tests: ${entry.passed}/${entry.passed + entry.failed}` :
      entry.kind === "card" ? `Card: ${entry.title}` : "(unknown)";
    items.push({ id: `chat:${i}`, label, detail: `chat · ${entry.role}`, view: "conversation" });
  }
  for (const [i, log] of state.logs.slice(-MAX_PER_SOURCE).entries()) {
    items.push({
      id: `log:${i}`,
      label: firstLine(log.message),
      detail: `log · ${log.level} · ${log.source}`,
      view: "logs",
    });
  }
  for (const item of state.memory.slice(-MAX_PER_SOURCE)) {
    items.push({
      id: `mem:${item.key}`,
      label: `${item.key} — ${firstLine(item.value)}`,
      detail: `memory · ${item.kind}`,
      view: "memory",
    });
  }
  for (const task of state.tasks.slice(-MAX_PER_SOURCE)) {
    items.push({ id: `task:${task.id}`, label: task.title, detail: `task · ${task.status}`, view: "tasks" });
  }
  for (const call of state.toolCalls.slice(-MAX_PER_SOURCE)) {
    items.push({ id: `tool:${call.id}`, label: call.name, detail: `tool · ${call.status}`, view: "execution" });
  }
  for (const file of state.git.files.slice(0, MAX_PER_SOURCE)) {
    items.push({ id: `git:${file.path}`, label: file.path, detail: `git · ${file.status}`, view: "git" });
  }
  for (const command of registry.all()) {
    items.push({
      id: `cmd:${command.name}`,
      label: `/${command.name}`,
      detail: `command · ${command.description}`,
      view: "conversation",
    });
  }
  return items;
}
