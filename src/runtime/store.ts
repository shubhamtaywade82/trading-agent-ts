/**
 * Central state store. The single source of truth the renderer reads.
 *
 * Events flow: actors -> EventBus -> Store.apply -> subscribers (renderer).
 * No business logic lives in rendering; it all terminates here.
 */

import { EventBus, RuntimeEvent } from "./events.js";
import { applyTaskTransition } from "./task-machine.js";
import { ACTOR_IDS, ActorId, ActorState, ChatEntry, RuntimeState, Task, ToolCall } from "./types.js";

/** Bounded buffer sizes so long sessions can't grow state without limit. */
// NOTE: Buffer limits are now configurable via `src/runtime/config.ts`. This file
// reads the values from environment variables (or falls back to sensible defaults).
// Moving the constants out of this file keeps the reducer pure and makes it easy
// for CI or callers to adjust limits without recompiling.
import { MAX_LOGS, MAX_CONVERSATION, MAX_TOOL_CALLS, MAX_NOTIFICATIONS } from "./config.js";

// Strips ANSI/C0/C1 control sequences from text before it lands in state,
// so tool or shell output emitting screen-clear/cursor-addressing/title-set
// (or hostile) escape sequences can't corrupt the fixed layout. Preserves
// printable characters, newlines, and tabs; \r is stripped since Ink has no
// concept of "rewind the line".
/* eslint-disable no-control-regex -- intentionally matching C0/C1 control chars to strip them */
export function sanitizeText(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
/* eslint-enable no-control-regex */

export interface InitialStateOptions {
  workspace?: string;
  branch?: string;
  model?: string;
  provider?: string;
  contextLimit?: number;
}

export function initialRuntimeState(opts: InitialStateOptions = {}): RuntimeState {
  const actors = {} as Record<ActorId, ActorState>;
  for (const id of ACTOR_IDS) {
    actors[id] = { id, health: "muted", detail: "" };
  }
  actors.conversation.health = "healthy";
  return {
    session: {
      workspace: opts.workspace ?? "",
      branch: opts.branch ?? "",
      startedAt: Date.now(),
    },
    mode: "idle",
    agentMode: "code",
    status: "",
    actors,
    conversation: [],
    execution: {
      goal: "",
      steps: [],
      currentStepId: null,
      activeTool: null,
      queue: [],
      etaSeconds: null,
      reasoning: "",
    },
    tasks: [],
    toolCalls: [],
    logs: [],
    memory: [],
    memorySummary: "",
    git: { branch: opts.branch ?? "", ahead: 0, behind: 0, files: [] },
    model: {
      provider: opts.provider ?? "local",
      name: opts.model ?? "",
      streaming: false,
      tokensPerSecond: 0,
      latencyMs: 0,
      contextUsed: 0,
      contextLimit: opts.contextLimit ?? 0,
    },
    mcpServers: [],
    lspServers: [],
    skills: [],
    approval: null,
    notifications: [],
    lastError: null,
  };
}

function bounded<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(items.length - max) : items;
}

function withActor(state: RuntimeState, id: ActorId, patch: Partial<Omit<ActorState, "id">>): RuntimeState {
  return { ...state, actors: { ...state.actors, [id]: { ...state.actors[id], ...patch } } };
}

function appendChunk(conversation: ChatEntry[], role: "assistant" | "thinking", chunk: string): ChatEntry[] {
  const last = conversation[conversation.length - 1];
  if (last && last.kind === "text" && last.role === role) {
    return conversation.slice(0, -1).concat({ ...last, text: last.text + chunk });
  }
  return bounded([...conversation, { kind: "text", role, text: chunk, at: Date.now() }], MAX_CONVERSATION);
}

function taskDetail(tasks: Task[]): string {
  const active = tasks.filter((t) => t.status === "running" || t.status === "queued" || t.status === "blocked");
  return active.length > 0 ? String(active.length) : "✓";
}

export function reduce(state: RuntimeState, event: RuntimeEvent): RuntimeState {
  switch (event.type) {
    case "conversation.message": {
      const entry: ChatEntry = { kind: "text", role: event.role, text: sanitizeText(event.text), at: Date.now() };
      return withActor(
        { ...state, conversation: bounded([...state.conversation, entry], MAX_CONVERSATION) },
        "conversation",
        { health: "healthy" },
      );
    }
    case "conversation.chunk": {
      const next = { ...state, conversation: appendChunk(state.conversation, event.role, sanitizeText(event.chunk)) };
      return withActor(next, "conversation", { health: event.role === "thinking" ? "thinking" : "active" });
    }
    case "conversation.clear":
      return { ...state, conversation: [] };
    case "conversation.plan": {
      const entry: ChatEntry = {
        kind: "plan",
        role: "assistant",
        steps: event.steps,
        status: event.status,
        at: Date.now(),
      };
      return withActor(
        { ...state, execution: { ...state.execution, goal: event.goal, steps: event.steps }, conversation: bounded([...state.conversation, entry], MAX_CONVERSATION) },
        "planner",
        { health: event.status === "running" ? "thinking" : "healthy", detail: event.status === "running" ? "▶" : "✓" },
      );
    }
    case "conversation.decision": {
      const entry: ChatEntry = {
        kind: "decision",
        role: "assistant",
        options: event.options,
        selected: event.selected,
        reason: event.reason,
        confidence: event.confidence,
        at: Date.now(),
      };
      return withActor(
        { ...state, conversation: bounded([...state.conversation, entry], MAX_CONVERSATION) },
        "planner",
        { health: "healthy", detail: "✓" },
      );
    }
    case "conversation.tool_call": {
      const entry: ChatEntry = {
        kind: "tool_call",
        role: "assistant",
        id: event.id,
        name: event.name,
        args: event.args,
        status: event.status,
        result: event.result,
        error: event.error,
        at: Date.now(),
      };
      const existingIdx = state.conversation.findIndex(
        (e) => e.kind === "tool_call" && e.id === event.id,
      );
      const updatedConversation =
        existingIdx >= 0
          ? [...state.conversation.slice(0, existingIdx), entry, ...state.conversation.slice(existingIdx + 1)]
          : [...state.conversation, entry];
      const actorHealth = event.status === "failed" ? "error" : event.status === "running" ? "active" : "healthy";
      return withActor(
        {
          ...state,
          conversation: bounded(updatedConversation, MAX_CONVERSATION),
          execution: { ...state.execution, activeTool: event.status === "running" ? event.name : state.execution.activeTool },
        },
        "executor",
        { health: actorHealth, detail: event.status === "running" ? "▶" : event.status === "failed" ? "✗" : "✓" },
      );
    }
    case "conversation.diff": {
      const entry: ChatEntry = {
        kind: "diff_preview",
        role: "assistant",
        filePath: event.filePath,
        diff: event.diff,
        status: event.status,
        at: Date.now(),
      };
      return withActor(
        { ...state, conversation: bounded([...state.conversation, entry], MAX_CONVERSATION) },
        "executor",
        { health: "healthy", detail: "✓" },
      );
    }
    case "conversation.test_result": {
      const entry: ChatEntry = {
        kind: "test_result",
        role: "assistant",
        command: event.command,
        passed: event.passed,
        failed: event.failed,
        failures: event.failures,
        durationMs: event.durationMs,
        at: Date.now(),
      };
      const actorHealth = event.failed > 0 ? "error" : "healthy";
      return withActor(
        { ...state, conversation: bounded([...state.conversation, entry], MAX_CONVERSATION) },
        "executor",
        { health: actorHealth, detail: event.failed > 0 ? `✗${event.failed}` : "✓" },
      );
    }
    case "conversation.card": {
      const entry: ChatEntry = {
        kind: "card",
        role: "assistant",
        title: event.title,
        status: event.status,
        items: event.items,
        at: Date.now(),
      };
      return withActor(
        { ...state, conversation: bounded([...state.conversation, entry], MAX_CONVERSATION) },
        "tasks",
        { health: event.status === "running" ? "active" : "healthy", detail: event.status === "running" ? "▶" : "✓" },
      );
    }
    case "conversation.card_item": {
      const last = state.conversation[state.conversation.length - 1];
      if (last && last.kind === "card" && last.title === event.title) {
        const updatedItems = last.items.map((item) =>
          item.label === event.label ? { ...item, status: event.status, detail: event.detail ?? item.detail } : item,
        );
        const updatedEntry: ChatEntry = { ...last, items: updatedItems };
        return withActor(
          { ...state, conversation: bounded([...state.conversation.slice(0, -1), updatedEntry], MAX_CONVERSATION) },
          "tasks",
          { health: event.status === "running" ? "active" : "healthy", detail: event.status as string },
        );
      }
      return state;
    }
    case "task.created": {
      const tasks = [...state.tasks.filter((t) => t.id !== event.task.id), event.task];
      return withActor({ ...state, tasks }, "tasks", { health: "active", detail: taskDetail(tasks) });
    }
    case "task.progress": {
      const tasks = applyTaskTransition(state.tasks, event.taskId, event.status, event.progress);
      const anyFailed = tasks.some((t) => t.status === "failed");
      return withActor({ ...state, tasks }, "tasks", {
        health: anyFailed ? "error" : tasks.some((t) => t.status === "running") ? "active" : "healthy",
        detail: taskDetail(tasks),
      });
    }
    case "tool.started": {
      const call: ToolCall = {
        id: event.id,
        name: event.name,
        args: event.args,
        status: "running",
        startedAt: Date.now(),
      };
      const next = {
        ...state,
        toolCalls: bounded([...state.toolCalls, call], MAX_TOOL_CALLS),
        execution: { ...state.execution, activeTool: event.name },
      };
      return withActor(next, "executor", { health: "active", detail: "▶" });
    }
    case "tool.completed":
    case "tool.failed": {
      const failed = event.type === "tool.failed";
      const toolCalls = state.toolCalls.map((c) =>
        c.id === event.id
          ? {
              ...c,
              status: failed ? ("failed" as const) : ("completed" as const),
              endedAt: Date.now(),
              result: failed ? c.result : (event as { result: Record<string, unknown> }).result,
              error: failed ? (event as { error: string }).error : c.error,
            }
          : c,
      );
      const stillRunning = toolCalls.some((c) => c.status === "running");
      const next = {
        ...state,
        toolCalls,
        execution: { ...state.execution, activeTool: stillRunning ? state.execution.activeTool : null },
      };
      return withActor(next, "executor", {
        health: failed ? "error" : stillRunning ? "active" : "healthy",
        detail: stillRunning ? "▶" : failed ? "✗" : "✓",
      });
    }
    case "model.streaming": {
      const model = {
        ...state.model,
        streaming: event.streaming,
        tokensPerSecond: event.tokensPerSecond ?? (event.streaming ? state.model.tokensPerSecond : 0),
      };
      return withActor({ ...state, model }, "models", {
        health: event.streaming ? "thinking" : "healthy",
        detail: event.streaming ? "▶" : "✓",
      });
    }
    case "model.changed": {
      const model = { ...state.model, name: event.name, provider: event.provider ?? state.model.provider };
      return withActor({ ...state, model }, "models", { health: "healthy" });
    }
    case "context.changed":
      return { ...state, model: { ...state.model, contextUsed: event.used, contextLimit: event.limit } };
    case "git.changed":
      return withActor({ ...state, git: event.git }, "git", {
        health: event.git.files.length > 0 ? "waiting" : "healthy",
        detail: event.git.files.length > 0 ? String(event.git.files.length) : "✓",
      });
    case "logs.appended": {
      const entry = {
        at: Date.now(),
        level: event.level,
        source: event.source,
        message: sanitizeText(event.message),
      };
      const logs = bounded([...state.logs, entry], MAX_LOGS);
      return withActor({ ...state, logs }, "logs", {
        health: event.level === "error" ? "error" : state.actors.logs.health === "error" ? "error" : "healthy",
        detail: String(logs.length),
      });
    }
    case "memory.updated": {
      const next = {
        ...state,
        memory: event.items ?? state.memory,
        memorySummary: event.summary ?? state.memorySummary,
      };
      return withActor(next, "memory", { health: "healthy", detail: "✓" });
    }
    case "mcp.changed": {
      const anyDown = event.servers.some((s) => !s.connected);
      return withActor({ ...state, mcpServers: event.servers }, "mcp", {
        health: event.servers.length === 0 ? "muted" : anyDown ? "error" : "healthy",
        detail: anyDown ? "✗" : "✓",
      });
    }
    case "lsp.changed": {
      const servers = event.servers;
      const anyError = servers.some((s) => s.status === "error");
      const anyRunning = servers.some((s) => s.status === "running");
      const detail = servers
        .filter((s) => s.status === "running")
        .map((s) => s.language.slice(0, 2))
        .join(" ");
      return withActor({ ...state, lspServers: servers }, "lsp", {
        health: servers.length === 0 ? "muted" : anyError ? "error" : anyRunning ? "healthy" : "waiting",
        detail: detail || "—",
      });
    }
    case "lsp.diagnostics": {
      return withActor({ ...state }, "lsp", {
        health: event.count > 0 ? "waiting" : "healthy",
        detail: event.count > 0 ? `${event.count}✗` : state.actors.lsp.detail,
      });
    }
    case "rails.index": {
      return {
        ...state,
        rails: {
          status: event.status,
          entityCount: event.entityCount ?? 0,
          edgeCount: event.edgeCount ?? 0,
          scannerErrors: event.scannerErrors ?? [],
          railsVersion: event.railsVersion,
          rubyVersion: event.rubyVersion,
          testFramework: event.testFramework,
          byType: event.byType,
        },
      };
    }
    case "skills.changed": {
      const anyActive = event.skills.some((s) => s.active);
      return withActor({ ...state, skills: event.skills }, "skills", {
        health: event.skills.length === 0 ? "muted" : anyActive ? "active" : "healthy",
        detail: anyActive ? String(event.skills.filter((s) => s.active).length) : "✓",
      });
    }
    case "approval.requested":
      return withActor({ ...state, approval: event.request, mode: "approval" }, "executor", {
        health: "waiting",
        detail: "?",
      });
    case "approval.resolved": {
      if (!state.approval || state.approval.id !== event.id) return state;
      return { ...state, approval: null, mode: "idle" };
    }
    case "execution.goal":
      return withActor(
        {
          ...state,
          execution: { ...state.execution, goal: event.goal, steps: event.steps, currentStepId: null },
          mode: "planning",
        },
        "planner",
        { health: "thinking", detail: "▶" },
      );
    case "execution.step": {
      const known = state.execution.steps.some((s) => s.id === event.step.id);
      const steps = known
        ? state.execution.steps.map((s) => (s.id === event.step.id ? event.step : s))
        : [...state.execution.steps, event.step];
      const currentStepId = event.step.status === "running" ? event.step.id : state.execution.currentStepId;
      const done = steps.every((s) => s.status !== "pending" && s.status !== "running");
      return withActor({ ...state, execution: { ...state.execution, steps, currentStepId } }, "planner", {
        health: done ? "healthy" : "thinking",
        detail: done ? "✓" : "▶",
      });
    }
    case "execution.queue":
      return {
        ...state,
        execution: { ...state.execution, queue: event.queue, etaSeconds: event.etaSeconds ?? null },
      };
    case "execution.reasoning":
      return { ...state, execution: { ...state.execution, reasoning: sanitizeText(event.text) } };
    case "mode.changed":
      return { ...state, mode: event.mode };
    case "mode.agent":
      return { ...state, agentMode: event.mode };
    case "status.changed":
      return { ...state, status: event.status };
    case "notification": {
      const note = {
        id: `n${Date.now()}-${state.notifications.length}`,
        text: event.text,
        kind: event.kind,
        at: Date.now(),
      };
      return { ...state, notifications: bounded([...state.notifications, note], MAX_NOTIFICATIONS) };
    }
    case "error": {
      // Executor health flips to "✗" on any error, but that glyph alone gives
      // the user zero detail — surface the actual message as a notification
      // too, the same path a visible toast already uses elsewhere.
      const note = { id: `n${Date.now()}-${state.notifications.length}`, text: event.message, kind: "error" as const, at: Date.now() };
      return withActor(
        { ...state, lastError: event.message, notifications: bounded([...state.notifications, note], MAX_NOTIFICATIONS) },
        "executor",
        { health: "error", detail: "✗" },
      );
    }
    default:
      return state;
  }
}

export type StoreListener = (state: RuntimeState) => void;

export class Store {
  private state: RuntimeState;
  private listeners = new Set<StoreListener>();

  constructor(initial?: RuntimeState) {
    this.state = initial ?? initialRuntimeState();
  }

  getState(): RuntimeState {
    return this.state;
  }

  apply(event: RuntimeEvent): void {
    const next = reduce(this.state, event);
    if (next === this.state) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener(next);
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Wire this store as the primary subscriber of a bus. */
  attach(bus: EventBus): () => void {
    return bus.subscribe((event) => this.apply(event));
  }
}
