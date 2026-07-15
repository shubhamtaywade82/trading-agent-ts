/**
 * Derived views for the two permanent bottom strips.
 *
 * Activity Strip: live health of all actors, always visible, never navigation.
 * Context Strip: dynamic status for the current runtime mode.
 */

import { ACTOR_IDS, ActorHealth, ActorId, AGENT_MODE_LABELS, RuntimeState, StatusToken, ViewId } from "../runtime/types.js";
import { semanticColor } from "./theme-map.js";

const ACTOR_LABELS: Record<ActorId, string> = {
  conversation: "Chat",
  planner: "Plan",
  executor: "Exec",
  tasks: "Tasks",
  git: "Git",
  logs: "Logs",
  memory: "Mem",
  models: "Mdl",
  mcp: "MCP",
  skills: "Skl",
  lsp: "LSP",
};

/** Priority order for actor tokens when width shrinks. */
const ACTOR_PRIORITY: Record<ActorId, number> = {
  conversation: 1,
  executor: 2,
  tasks: 3,
  git: 4,
  planner: 5,
  models: 6,
  logs: 7,
  memory: 8,
  mcp: 9,
  skills: 10,
  lsp: 11,
};

export function activityStripTokens(state: RuntimeState): StatusToken[] {
  const tokens: StatusToken[] = ACTOR_IDS.map((id) => {
    const actor = state.actors[id];
    return {
      text: `${ACTOR_LABELS[id]}${actor.detail || "·"}`,
      priority: actor.health === "error" ? 0 : ACTOR_PRIORITY[id],
      color: semanticColor(actor.health),
    };
  });
  if (state.model.contextLimit > 0) {
    tokens.push({
      text: `Tok${formatK(state.model.contextUsed)}/${formatK(state.model.contextLimit)}`,
      priority: 10,
      color: semanticColor("muted"),
    });
  }
  return tokens;
}

function formatK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

function contextPercent(state: RuntimeState): string | null {
  if (state.model.contextLimit <= 0) return null;
  return `ctx${Math.round((state.model.contextUsed / state.model.contextLimit) * 100)}%`;
}

export function contextStripTokens(state: RuntimeState, activeView?: ViewId): StatusToken[] {
  const tokens: StatusToken[] = [];
  const push = (text: string, priority: number, health?: ActorHealth) =>
    tokens.push({ text, priority, color: health ? semanticColor(health) : undefined });

  // View-specific strips take over while idle: the strip always shows the
  // most relevant live state for what the user is looking at.
  if (state.mode === "idle" && activeView === "git") {
    push(`Branch:${state.git.branch || "-"}`, 1, "active");
    push(`Modified:${state.git.files.length}`, 2);
    push(`Ahead:${state.git.ahead}`, 3);
    push(`Behind:${state.git.behind}`, 4);
    return tokens;
  }
  if (state.mode === "idle" && activeView === "logs") {
    const count = (level: string) => state.logs.filter((l) => l.level === level).length;
    push(`INFO:${count("info")}`, 1, "active");
    push(`WARN:${count("warn")}`, 2, "waiting");
    push(`ERROR:${count("error")}`, 3, count("error") > 0 ? "error" : "healthy");
    push("End Follow", 4, "muted");
    return tokens;
  }
  if (state.mode === "idle" && activeView === "memory") {
    push(`Memories:${state.memory.length}`, 1, "active");
    if (state.memorySummary) push("Summary ready", 2, "healthy");
    return tokens;
  }

  switch (state.mode) {
    case "idle": {
      const am = AGENT_MODE_LABELS[state.agentMode];
      push(`Mode:${am.label}`, 1, "active");
      push(`Model:${state.model.name || "-"}`, 2, "active");
      if (state.session.workspace) push(`Workspace:${state.session.workspace}`, 3);
      push("Ctrl+P Palette", 4, "muted");
      break;
    }
    case "planning": {
      push("Planning", 1, "thinking");
      const total = state.execution.steps.length;
      const idx = state.execution.steps.findIndex((s) => s.id === state.execution.currentStepId);
      if (total > 0) push(`Step ${idx >= 0 ? idx + 1 : 1}/${total}`, 2);
      if (state.status) push(state.status, 3);
      const ctx = contextPercent(state);
      if (ctx) push(ctx, 4);
      push("Esc Cancel", 5, "muted");
      break;
    }
    case "editing": {
      push(`Tool:${state.execution.activeTool ?? "edit"}`, 1, "active");
      if (state.status) push(state.status, 2);
      push("Ctrl+Z Undo", 5, "muted");
      break;
    }
    case "testing": {
      push(`Tool:${state.execution.activeTool ?? "tests"}`, 1, "active");
      if (state.status) push(state.status, 2);
      if (state.execution.etaSeconds != null) push(`ETA ${formatEta(state.execution.etaSeconds)}`, 3);
      push("Ctrl+C Stop", 4, "muted");
      break;
    }
    case "approval": {
      push("Waiting for approval", 1, "waiting");
      if (state.approval) {
        push(`${state.approval.filesChanged} files +${state.approval.additions} -${state.approval.deletions}`, 2);
      }
      push("Enter Approve", 3, "muted");
      push("N Reject", 4, "muted");
      push("D View Diff", 5, "muted");
      break;
    }
    case "streaming": {
      push("Generating...", 1, "thinking");
      if (state.model.tokensPerSecond > 0) push(`${Math.round(state.model.tokensPerSecond)} tok/s`, 2);
      if (state.model.contextUsed > 0) push(`${formatK(state.model.contextUsed)} tokens`, 3);
      push("Ctrl+C Stop Generation", 4, "muted");
      break;
    }
  }
  return tokens;
}

function formatEta(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const MODE_LABELS: Record<RuntimeState["mode"], string> = {
  idle: "IDLE",
  planning: "PLANNING",
  editing: "EDITING",
  testing: "TESTING",
  approval: "APPROVAL",
  streaming: "STREAMING",
};

/** Header zone: product, workspace, model, branch, context usage, mode, state, clock. */
export function headerTokens(state: RuntimeState, now: number = Date.now()): StatusToken[] {
  const tokens: StatusToken[] = [{ text: "DevAgent", priority: 1, color: semanticColor("thinking") }];
  if (state.session.workspace) tokens.push({ text: state.session.workspace, priority: 3 });
  if (state.model.name) tokens.push({ text: state.model.name, priority: 2, color: semanticColor("active") });
  if (state.model.provider === "cloud") {
    tokens.push({ text: "☁ cloud", priority: 2, color: semanticColor("thinking") });
  }
  const branch = state.git.branch || state.session.branch;
  if (branch) tokens.push({ text: `⎇ ${branch}`, priority: 4 });
  const ctx = contextPercent(state);
  if (ctx) tokens.push({ text: ctx, priority: 5 });
  const am = AGENT_MODE_LABELS[state.agentMode];
  tokens.push({ text: am.label, priority: 2, color: semanticColor("active") });
  tokens.push({
    text: MODE_LABELS[state.mode],
    priority: 3,
    color: semanticColor(state.mode === "idle" ? "healthy" : state.mode === "approval" ? "waiting" : "thinking"),
  });
  // Git status
  if (state.git.files.length > 0) {
    tokens.push({ text: `Git:${state.git.files.length}m`, priority: 6, color: semanticColor("waiting") });
  }
  // Memory status
  if (state.memory.length > 0) {
    tokens.push({ text: `Mem:${state.memory.length}`, priority: 8, color: semanticColor("healthy") });
  }
  // LSP status
  const runningLsp = state.lspServers.filter((s) => s.status === "running");
  if (runningLsp.length > 0) {
    tokens.push({
      text: `LSP:${runningLsp.map((s) => s.language.slice(0, 2)).join(",")}`,
      priority: 9,
      color: semanticColor("healthy"),
    });
  }
  // Rails status
  if (state.rails && state.rails.status !== "disabled") {
    tokens.push({ text: `Rails:${state.rails.status}`, priority: 10, color: semanticColor(state.rails.status === "ready" ? "healthy" : "thinking") });
  }
  // Skills
  const activeSkills = state.skills.filter((s) => s.active).length;
  if (activeSkills > 0) {
    tokens.push({ text: `Skills:${activeSkills}`, priority: 10, color: semanticColor("active") });
  }
  const clock = new Date(now);
  const hh = String(clock.getHours()).padStart(2, "0");
  const mm = String(clock.getMinutes()).padStart(2, "0");
  tokens.push({ text: `${hh}:${mm}`, priority: 11, color: semanticColor("muted") });
  return tokens;
}
