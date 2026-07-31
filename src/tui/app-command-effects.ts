/**
 * Effect execution for the TUI shell.
 *
 * applyEffect() interprets slash-command effects (model switching, session
 * resume, workspace init, ...) against the live shell: bus, store and agent.
 * Side-effect-only — it never renders, keeping the component tree
 * snapshot-stable. runAgentTask() wraps a user-message run in the streaming
 * lifecycle (busy flag + streaming/idle mode events).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Dispatch, SetStateAction } from "react";

import type { UiCommand } from "../interaction/keybindings.js";
import type { CommandEffect } from "../interaction/slash-commands.js";
import type { EventBus } from "../runtime/events.js";
import type { Store } from "../runtime/store.js";
import { AGENT_MODES } from "../runtime/types.js";
import type { AgentMode, ChatRole } from "../runtime/types.js";
import type { SkillsRegistry } from "../skills/registry.js";

export interface ShellAgent {
  runUserMessage: (message: string) => Promise<unknown>;
  setModel?: (model: string) => void;
  setTier?: (tier: string) => void;
  resetContext?: () => void;
  resumeSession?: () => Array<{ role: string; content: string }> | null;
  hasResumableSession?: () => boolean;
  listModels?: () => Promise<string[]>;
  /** Round-trips a real request through the new model; true, or an error string. */
  validateModel?: () => Promise<true | string>;
  getSkillsRegistry?: () => SkillsRegistry;
  pinSkill?: (id: string | null) => void;
  addLearning?: (category: string, context: string, lesson: string) => void;
}

export interface EffectDeps {
  bus: EventBus;
  store: Store;
  agent?: ShellAgent | undefined;
  workspaceRoot?: string | undefined;
  uiDispatch: Dispatch<UiCommand>;
  setModels: Dispatch<SetStateAction<string[] | null>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  exit: () => void;
}

export interface TaskDeps {
  bus: EventBus;
  setBusy: Dispatch<SetStateAction<boolean>>;
}

export function notify(bus: EventBus, kind: "info" | "success" | "warning" | "error", text: string): void {
  bus.publish({ type: "notification", kind, text });
}

function isAgentMode(mode: string): mode is AgentMode {
  return (AGENT_MODES as readonly string[]).includes(mode);
}

function publishConversationMessage(bus: EventBus, role: ChatRole, text: string): void {
  bus.publish({ type: "conversation.message", role, text });
}

function publishConversationClear(bus: EventBus): void {
  bus.publish({ type: "conversation.clear" });
}

function publishModelChanged(bus: EventBus, name: string, provider?: string): void {
  bus.publish({ type: "model.changed", name, ...(provider === undefined ? {} : { provider }) });
}

function publishAgentMode(bus: EventBus, mode: AgentMode): void {
  bus.publish({ type: "mode.agent", mode });
}

/** Runs a user message to the agent with the streaming-mode lifecycle. */
export async function runAgentTask(
  run: () => Promise<unknown>,
  deps: TaskDeps,
  onError?: (error: unknown) => void,
): Promise<void> {
  deps.setBusy(true);
  deps.bus.publish({ type: "mode.changed", mode: "streaming" });
  try {
    await run();
  } catch (error) {
    onError?.(error);
  } finally {
    deps.setBusy(false);
    deps.bus.publish({ type: "model.streaming", streaming: false });
    deps.bus.publish({ type: "mode.changed", mode: "idle" });
  }
}

export function cycleNextMode(store: Store, bus: EventBus): void {
  const current = store.getState().agentMode;
  const index = AGENT_MODES.indexOf(current);
  const next = AGENT_MODES[(index + 1) % AGENT_MODES.length] ?? AGENT_MODES[0] ?? "ask";
  publishAgentMode(bus, next);
  notify(bus, "info", `Mode: ${next}`);
}

const handleMessage: EffectHandlerMap["message"] = (effect, deps) => {
  publishConversationMessage(deps.bus, "system", effect.text);
};

const handleOpenOverlay: EffectHandlerMap["open-overlay"] = (effect, deps) => {
  deps.uiDispatch({ type: "open-overlay", overlay: effect.overlay });
};

const handleFocusView: EffectHandlerMap["focus-view"] = (effect, deps) => {
  deps.uiDispatch({ type: "focus-view", view: effect.view });
};

const handleClearConversation: EffectHandlerMap["clear-conversation"] = (_effect, deps) => {
  publishConversationClear(deps.bus);
};

const handleSetModel: EffectHandlerMap["set-model"] = (effect, deps) => {
  const agent = deps.agent;
  const previous = deps.store.getState().model.name;
  if (effect.model === previous) return;
  agent?.setModel?.(effect.model);
  publishModelChanged(deps.bus, effect.model);
  if (!agent?.validateModel) {
    notify(deps.bus, "success", `Model: ${effect.model}`);
    return;
  }
  notify(deps.bus, "info", `Validating ${effect.model}…`);
  agent
    .validateModel()
    .then((result): boolean => {
      if (result === true) {
        notify(deps.bus, "success", `Model: ${effect.model}`);
        return true;
      }
      agent.setModel?.(previous);
      publishModelChanged(deps.bus, previous);
      notify(deps.bus, "error", `${effect.model} ${result}`);
      return false;
    })
    .catch(() => {
      // Unreachable: validateModel() resolves true | string, never rejects.
    });
};

const handleSetTier: EffectHandlerMap["set-tier"] = (effect, deps) => {
  const previous = deps.store.getState().model.provider;
  if (effect.tier === previous) return;
  deps.agent?.setTier?.(effect.tier);
  deps.setModels(null); // Invalidate the Ctrl+M cache — it belongs to the old tier
  publishModelChanged(deps.bus, deps.store.getState().model.name, effect.tier);
  notify(deps.bus, "success", `Tier: ${effect.tier}`);
};

const handleActivateSkill: EffectHandlerMap["activate-skill"] = (effect, deps) => {
  const meta = deps.agent?.getSkillsRegistry?.().get(effect.id);
  if (!meta) {
    notify(deps.bus, "error", `Unknown skill: ${effect.id}`);
    return;
  }
  deps.agent?.pinSkill?.(effect.id);
  notify(deps.bus, "success", `Skill pinned: ${meta.name}`);
};

function initWorkspaceDirectory(deps: EffectDeps): void {
  const root = deps.workspaceRoot ?? process.cwd();
  const dir = join(root, ".trading-agent");
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify(
      {
        model: deps.store.getState().model.name,
        tier: deps.store.getState().model.provider,
        host: process.env["OLLAMA_HOST"] ?? null,
      },
      null,
      2,
    ),
  );
  notify(deps.bus, "success", `.trading-agent/ created in ${dir}`);
}

function kickOffAgentsFile(root: string, deps: EffectDeps): void {
  const agentsPath = join(root, "AGENTS.md");
  if (existsSync(agentsPath)) return;
  const agent = deps.agent;
  if (!agent) return;
  const initPrompt = [
    `I just initialized TradingAgent in \`${root}\`. Create \`AGENTS.md\` at the project root — this file tells future TradingAgent sessions how to work with this codebase.`,
    "",
    "First explore the project (read key configs, understand the structure, check the tech stack, testing setup, linting rules, build system, etc).",
    "Then write `AGENTS.md` using the write_file tool. Cover:",
    "- Project purpose (brief)",
    "- Tech stack (language, framework, runtime)",
    "- Testing framework and how to run tests",
    "- Linting/formatting conventions",
    "- Build system and commands",
    "- Key directory structure",
    "- Any notable architecture decisions or conventions you observe",
    "",
    "Only create the file if you can successfully explore the project first. Be thorough.",
  ].join("\n");
  publishConversationMessage(deps.bus, "user", initPrompt);
  runAgentTask(() => agent.runUserMessage(initPrompt), deps).catch(() => {
    // Unreachable: runAgentTask resolves after its own error handling.
  });
}

const handleInitWorkspace: EffectHandlerMap["init-workspace"] = (_effect, deps) => {
  initWorkspaceDirectory(deps);
  const root = deps.workspaceRoot ?? process.cwd();
  if (deps.agent) kickOffAgentsFile(root, deps);
};

const handleResetContext: EffectHandlerMap["reset-context"] = (_effect, deps) => {
  deps.agent?.resetContext?.();
  notify(deps.bus, "info", "Context reset");
};

const handleResumeSession: EffectHandlerMap["resume-session"] = (_effect, deps) => {
  const restored = deps.agent?.resumeSession?.();
  if (!restored || restored.length === 0) {
    notify(deps.bus, "info", "No previous session to resume");
    return;
  }
  publishConversationClear(deps.bus);
  for (const m of restored) {
    if (m.role !== "user" && m.role !== "assistant") continue; // Skip system/tool noise in the log
    if (!m.content) continue;
    publishConversationMessage(deps.bus, m.role, m.content);
  }
  notify(deps.bus, "success", `Resumed session (${String(restored.length)} messages)`);
};

const handleLearn: EffectHandlerMap["learn"] = (effect, deps) => {
  if (!deps.agent?.addLearning) {
    notify(deps.bus, "error", "Learning not supported by agent");
    return;
  }
  deps.agent.addLearning("user_preference", "user explicitly typed /learn", effect.rule);
  notify(deps.bus, "success", `Learned: ${effect.rule.slice(0, 40)}${effect.rule.length > 40 ? "..." : ""}`);
};

const handleSetAgentMode: EffectHandlerMap["set-agent-mode"] = (effect, deps) => {
  if (!isAgentMode(effect.mode)) return;
  publishAgentMode(deps.bus, effect.mode);
  notify(deps.bus, "info", `Mode: ${effect.mode}`);
};

const handleRunShell: EffectHandlerMap["run-shell"] = (effect, deps) => {
  publishConversationMessage(deps.bus, "user", `Run: ${effect.command}`);
  const agent = deps.agent;
  if (!agent) return;
  const run = (): Promise<unknown> =>
    agent.runUserMessage(`Run the following shell command and show me the output:\n\n${effect.command}`);
  runAgentTask(run, deps).catch(() => {
    // Unreachable: runAgentTask resolves after its own error handling.
  });
};

const handleSearch: EffectHandlerMap["search"] = (_effect, deps) => {
  deps.uiDispatch({ type: "open-overlay", overlay: "search" });
};

const handleNextMode: EffectHandlerMap["next-mode"] = (_effect, deps) => {
  cycleNextMode(deps.store, deps.bus);
};

const handleQuit: EffectHandlerMap["quit"] = (_effect, deps) => {
  deps.exit();
};

const handleError: EffectHandlerMap["error"] = (effect, deps) => {
  notify(deps.bus, "error", effect.text);
};

type EffectHandlerMap = {
  [K in CommandEffect["kind"]]: (effect: Extract<CommandEffect, { kind: K }>, deps: EffectDeps) => void;
};

const EFFECT_HANDLERS: EffectHandlerMap = {
  message: handleMessage,
  "open-overlay": handleOpenOverlay,
  "focus-view": handleFocusView,
  "clear-conversation": handleClearConversation,
  "set-model": handleSetModel,
  "set-tier": handleSetTier,
  "activate-skill": handleActivateSkill,
  "init-workspace": handleInitWorkspace,
  "reset-context": handleResetContext,
  "resume-session": handleResumeSession,
  learn: handleLearn,
  "set-agent-mode": handleSetAgentMode,
  "run-shell": handleRunShell,
  search: handleSearch,
  "next-mode": handleNextMode,
  quit: handleQuit,
  error: handleError,
};

/** Interprets a slash-command effect against the live shell. */
export function applyEffect(effect: CommandEffect, deps: EffectDeps): void {
  callHandler(effect.kind, effect, deps);
}

function callHandler<K extends CommandEffect["kind"]>(
  kind: K,
  effect: Extract<CommandEffect, { kind: K }>,
  deps: EffectDeps,
): void {
  EFFECT_HANDLERS[kind](effect, deps);
}
