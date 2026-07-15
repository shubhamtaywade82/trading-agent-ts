/**
 * Core domain model for the DevAgent runtime.
 *
 * The UI is a pure reflection of this state: actors are always alive,
 * views only change what is observed, never what is running.
 */

/** The always-alive actors. Every subsystem is one of these. */
export type ActorId =
  "conversation" | "planner" | "executor" | "tasks" | "git" | "logs" | "memory" | "models" | "mcp" | "skills" | "lsp";

export const ACTOR_IDS: readonly ActorId[] = [
  "conversation",
  "planner",
  "executor",
  "tasks",
  "git",
  "logs",
  "memory",
  "models",
  "mcp",
  "skills",
  "lsp",
];

/** Semantic health of an actor, mapped 1:1 to theme colors. */
export type ActorHealth = "healthy" | "active" | "waiting" | "error" | "thinking" | "muted";

export interface ActorState {
  id: ActorId;
  health: ActorHealth;
  /** Short live detail, e.g. a count ("3") or a glyph-worthy summary. */
  detail: string;
}

/** The focusable views of the Active View zone. Focus never stops actors. */
export type ViewId = "conversation" | "execution" | "tasks" | "git" | "logs" | "memory" | "models" | "mcp" | "lsp" | "files" | "settings" | "context" | "rails" | "timeline";

export const VIEW_ORDER: readonly ViewId[] = [
  "conversation",
  "execution",
  "tasks",
  "git",
  "logs",
  "memory",
  "models",
  "mcp",
  "lsp",
  "files",
  "settings",
  "context",
  "rails",
  "timeline",
];

/** Runtime mode drives the Context Strip contents. */
export type RuntimeMode = "idle" | "planning" | "editing" | "testing" | "approval" | "streaming";

/** Agent operational modes — controls what the agent is allowed to do. */
export type AgentMode = "ask" | "code" | "architect" | "review" | "debug" | "autonomous";

export const AGENT_MODES: readonly AgentMode[] = ["ask", "code", "architect", "review", "debug", "autonomous"];

export const AGENT_MODE_LABELS: Record<AgentMode, { label: string; description: string }> = {
  ask: { label: "Ask", description: "Q&A only, no file changes" },
  code: { label: "Code", description: "Generate and apply code changes" },
  architect: { label: "Architect", description: "Design, UML, and implementation plans" },
  review: { label: "Review", description: "Analyze code quality, security, and performance" },
  debug: { label: "Debug", description: "Investigate failures using logs and tests" },
  autonomous: { label: "Autonomous", description: "Plan, edit, test, iterate until complete" },
};

export type TaskStatus = "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  dependencies: string[];
  /** 0..1 progress for running tasks; undefined when not measurable. */
  progress?: number;
  worker?: string;
}

export type ToolCallStatus = "running" | "completed" | "failed";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolCallStatus;
  startedAt: number;
  endedAt?: number;
  result?: Record<string, unknown>;
  error?: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  at: number;
  level: LogLevel;
  source: string;
  message: string;
}

export interface MemoryItem {
  key: string;
  value: string;
  kind: "repo" | "style" | "preference" | "architecture";
}

export interface GitFileChange {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed";
  staged: boolean;
  additions?: number;
  deletions?: number;
}

export interface GitState {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileChange[];
}

export interface ModelState {
  provider: string;
  name: string;
  streaming: boolean;
  tokensPerSecond: number;
  latencyMs: number;
  contextUsed: number;
  contextLimit: number;
}

export interface McpServerState {
  name: string;
  connected: boolean;
  latencyMs: number;
  tools: string[];
  errors: number;
}

export interface SkillState {
  id: string;
  name: string;
  tags: string[];
  active: boolean;
}

export interface LspServerState {
  language: string;
  status: "starting" | "running" | "idle" | "stopped" | "error";
  documentsCount: number;
  errorCount: number;
}

export interface ApprovalRequest {
  id: string;
  title: string;
  summary: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  diff?: string;
}

export type ChatRole = "user" | "assistant" | "thinking" | "tool" | "system";

export interface TestFailure {
  file: string;
  line: number;
  message: string;
}

export interface CardItem {
  label: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  detail?: string;
}

export type ChatEntry =
  | { kind: "text"; role: ChatRole; text: string; at: number }
  | { kind: "plan"; role: "assistant"; steps: ExecutionStep[]; status: "pending" | "running" | "completed"; at: number }
  | { kind: "decision"; role: "assistant"; options: string[]; selected: string; reason: string; confidence: number; at: number }
  | { kind: "tool_call"; role: "assistant"; id: string; name: string; args: Record<string, unknown>; status: ToolCallStatus; result?: string; error?: string; at: number }
  | { kind: "diff_preview"; role: "assistant"; filePath: string; diff: string; status: "pending_review" | "approved" | "rejected"; at: number }
  | { kind: "test_result"; role: "assistant"; command: string; passed: number; failed: number; failures: TestFailure[]; durationMs: number; at: number }
  | { kind: "card"; role: "assistant"; title: string; status: "running" | "completed" | "failed"; items: CardItem[]; at: number };

export interface ExecutionStep {
  id: string;
  description: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
}

export interface ExecutionState {
  goal: string;
  steps: ExecutionStep[];
  currentStepId: string | null;
  activeTool: string | null;
  /** Names of queued tools, in order. */
  queue: string[];
  etaSeconds: number | null;
  reasoning: string;
}

export interface SessionState {
  workspace: string;
  branch: string;
  startedAt: number;
}

/**
 * A single unit of the status system. Lower `priority` numbers are more
 * important and survive longer as width shrinks.
 */
export interface StatusToken {
  text: string;
  priority: number;
  color?: string;
}

export interface Notification {
  id: string;
  text: string;
  kind: "info" | "success" | "warning" | "error";
  at: number;
}

/** The complete runtime state. Rendering maps this to terminal output. */
export interface RailsIndexState {
  status: "building" | "ready" | "updated" | "disabled" | "error";
  entityCount: number;
  edgeCount: number;
  scannerErrors: string[];
  railsVersion?: string;
  rubyVersion?: string;
  testFramework?: string;
  byType?: Record<string, number>;
}

export interface RuntimeState {
  session: SessionState;
  mode: RuntimeMode;
  agentMode: AgentMode;
  status: string;
  actors: Record<ActorId, ActorState>;
  conversation: ChatEntry[];
  execution: ExecutionState;
  tasks: Task[];
  toolCalls: ToolCall[];
  logs: LogEvent[];
  memory: MemoryItem[];
  memorySummary: string;
  git: GitState;
  model: ModelState;
  mcpServers: McpServerState[];
  lspServers: LspServerState[];
  rails?: RailsIndexState;
  skills: SkillState[];
  approval: ApprovalRequest | null;
  notifications: Notification[];
  lastError: string | null;
}
