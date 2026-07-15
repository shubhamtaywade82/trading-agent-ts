/**
 * The runtime event bus. Every actor publishes events here; the state
 * store is the primary subscriber. Rendering never subscribes directly —
 * it reads the store.
 */

import {
  AgentMode,
  ApprovalRequest,
  CardItem,
  ChatRole,
  ExecutionStep,
  GitState,
  LogLevel,
  LspServerState,
  McpServerState,
  MemoryItem,
  RuntimeMode,
  SkillState,
  Task,
  TestFailure,
  ToolCallStatus,
} from "./types.js";

export type RuntimeEvent =
  | { type: "conversation.message"; role: ChatRole; text: string }
  | { type: "conversation.chunk"; role: "assistant" | "thinking"; chunk: string }
  | { type: "conversation.clear" }
  | { type: "conversation.plan"; goal: string; steps: ExecutionStep[]; status: "pending" | "running" | "completed" }
  | { type: "conversation.decision"; options: string[]; selected: string; reason: string; confidence: number }
  | { type: "conversation.tool_call"; id: string; name: string; args: Record<string, unknown>; status: ToolCallStatus; result?: string; error?: string }
  | { type: "conversation.diff"; filePath: string; diff: string; status: "pending_review" | "approved" | "rejected" }
  | { type: "conversation.test_result"; command: string; passed: number; failed: number; failures: TestFailure[]; durationMs: number }
  | { type: "conversation.card"; title: string; status: "running" | "completed" | "failed"; items: CardItem[] }
  | { type: "conversation.card_item"; title: string; label: string; status: CardItem["status"]; detail?: string }
  | { type: "task.created"; task: Task }
  | { type: "task.progress"; taskId: string; status: Task["status"]; progress?: number }
  | { type: "tool.started"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool.completed"; id: string; result: Record<string, unknown> }
  | { type: "tool.failed"; id: string; error: string }
  | { type: "model.streaming"; streaming: boolean; tokensPerSecond?: number }
  | { type: "model.changed"; provider?: string; name: string }
  | { type: "context.changed"; used: number; limit: number }
  | { type: "git.changed"; git: GitState }
  | { type: "logs.appended"; level: LogLevel; source: string; message: string }
  | { type: "memory.updated"; items?: MemoryItem[]; summary?: string }
  | { type: "mcp.changed"; servers: McpServerState[] }
  | { type: "lsp.changed"; servers: LspServerState[] }
  | { type: "lsp.diagnostics"; path: string; count: number }
  | {
      type: "rails.index";
      status: "building" | "ready" | "updated" | "disabled" | "error";
      entityCount?: number;
      edgeCount?: number;
      scannerErrors?: string[];
      durationMs?: number;
      railsVersion?: string;
      rubyVersion?: string;
      testFramework?: string;
      byType?: Record<string, number>;
    }
  | { type: "skills.changed"; skills: SkillState[] }
  | { type: "approval.requested"; request: ApprovalRequest }
  | { type: "approval.resolved"; id: string; approved: boolean }
  | { type: "execution.goal"; goal: string; steps: ExecutionStep[] }
  | { type: "execution.step"; step: ExecutionStep }
  | { type: "execution.queue"; queue: string[]; etaSeconds?: number }
  | { type: "execution.reasoning"; text: string }
  | { type: "mode.changed"; mode: RuntimeMode }
  | { type: "mode.agent"; mode: AgentMode }
  | { type: "status.changed"; status: string }
  | { type: "notification"; text: string; kind: "info" | "success" | "warning" | "error" }
  | { type: "error"; message: string };

export type EventListener = (event: RuntimeEvent) => void;

export class EventBus {
  private listeners = new Set<EventListener>();

  publish(event: RuntimeEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
