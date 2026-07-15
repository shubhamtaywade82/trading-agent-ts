# Multi-Pane TUI Design

## Context

DevAgent's current terminal interface (`src/cli/tui.ts`) is a linear scroll built on `readline` + `chalk`/`boxen`/`ora`/`marked-terminal` — one continuous output stream, no cursor addressing, no split panes. The user shared a mockup of a full-screen multi-pane coding-agent TUI (file tree sidebar, chat/plan pane, syntax-highlighted code+diff viewer, terminal, tools log, memory panel, status bar — similar in spirit to lazygit/k9s-style layouts) and asked whether something like it is buildable for this codebase, then asked for a build (not an exact copy — most useful/doable things, rest to backlog).

This spec covers a new, additive multi-pane TUI. The existing `src/cli/tui.ts` REPL is untouched and remains available.

## Goal

Build a full-screen, multi-pane terminal UI for DevAgent that surfaces: a file tree, a chat/plan conversation view, a syntax-highlighted code/diff viewer, a live-streaming terminal, a tool-call log, an LLM-generated memory summary panel, and a status bar — wired to the real `Agent`, `Orchestrator`, `MemoryStore`, `Registry`, and tool implementations already in this codebase. No mocked data.

## Non-Goals (Backlog)

Explicitly deferred, not built in this spec:

- Multi-terminal / multiple concurrent live output streams (v1 = one active stream, most recent command)
- Vim-modal NORMAL/INSERT input (mockup shows a "NORMAL" status indicator — not built; input is always-typeable like the existing REPL)
- Mouse support
- Settings gear icon / config UI
- Multi-session picker (mockup's "Session ID" panel — v1 is single session per launch)

## Framework Choice

**Ink** (React for CLI), over blessed/neo-blessed. Rationale: `Agent` already exposes a clean event-emitter surface (`onAssistantText`, `onThinking`, `onToolCall`, `onToolResult`, `onError`, `onStatus`) — Ink's component/state model maps directly onto this (events → reducer actions → re-render), whereas blessed's callback-heavy widget API fights that model. Ink is TS-first and actively maintained. Trade-off: no built-in split-pane primitive — panes are hand-built with Ink's flexbox (`<Box flexDirection>`).

## Architecture

New `src/tui/` directory, parallel to (not replacing) `src/cli/tui.ts`:

```
src/tui/
  App.tsx              — root layout, composes all panes via flexbox
  state.ts             — reducer + action types (single source of TUI state)
  agent-bridge.ts       — subscribes to Agent events, dispatches reducer actions
  plan-generator.ts     — new: decomposes a user request into PlanStep[] via one LLM call
  edit-tracker.ts       — snapshots pre-edit file content for diff rendering
  panes/
    FileTree.tsx
    ChatPlan.tsx
    CodeDiff.tsx
    Terminal.tsx
    ToolsLog.tsx
    Memory.tsx
    StatusBar.tsx
  index.ts             — entry point (new bin target, does not replace existing `dev`/`start` scripts)
```

New runtime dependencies: `ink`, `ink-testing-library` (dev), `diff` (unified diff generation), `cli-highlight` (syntax highlighting for code + diff lines).

### State management

Single `useReducer` in `App.tsx` (or a small custom store if reducer complexity grows — decided at implementation time, not architecturally significant). Action types cover: `ASSISTANT_TEXT_CHUNK`, `THINKING_CHUNK`, `TOOL_CALLED`, `TOOL_RESULT`, `STATUS_CHANGED`, `ERROR`, `SHELL_OUTPUT_CHUNK`, `PLAN_STEP_CHANGED`, `FILE_SELECTED`, `MEMORY_SUMMARY_UPDATED`. `agent-bridge.ts` is the only module that calls `agent.on(...)` and translates events into these actions — panes never talk to `Agent` directly, only read reducer state and dispatch UI-only actions (e.g. `FILE_SELECTED` from user navigating the file tree).

### Layout

Three-column flexbox grid, matching the mockup's structure:

- **Left sidebar** (fixed width): file tree (top, scrollable) + context stats (token usage, model, temperature) + session stats (duration, message count, tool-call count, files-changed count) — all derived from real reducer state, no placeholders.
- **Center column**: `ChatPlan` pane (top, flexible height) + `Terminal` pane (bottom, fixed height).
- **Right column**: `CodeDiff` pane (top, flexible height, shows selected/most-recently-edited file) + tabbed lower region (`ToolsLog` / `Memory` — tab-switched, or side-by-side if terminal width allows; decided at implementation time based on available columns).
- **Status bar**: pinned to the last terminal row — current focused pane, git branch (via `GitTool status`), files-changed count, model name, time.

### Data flow

`agent-bridge.ts` wires:

```typescript
agent.on("onAssistantText", (chunk) => dispatch({ type: "ASSISTANT_TEXT_CHUNK", chunk }));
agent.on("onThinking", (chunk) => dispatch({ type: "THINKING_CHUNK", chunk }));
agent.on("onToolCall", (name, args) => dispatch({ type: "TOOL_CALLED", name, args }));
agent.on("onToolResult", (name, result) => dispatch({ type: "TOOL_RESULT", name, result }));
agent.on("onStatus", (status) => dispatch({ type: "STATUS_CHANGED", status }));
agent.on("onError", (error) => dispatch({ type: "ERROR", error }));
agent.on("onShellOutput", (stream, chunk) => dispatch({ type: "SHELL_OUTPUT_CHUNK", stream, chunk }));
```

No new events are needed beyond `onShellOutput` (see Terminal Pane below) and plan-step transitions (see Plan Mode below).

### Plan mode

`Orchestrator` (`src/orchestrator/orchestrator.ts`) already exists and is wired into `Agent.runPlannedTask(steps, planner)`, but nothing today turns a free-form user request into an initial `PlanStep[]` — `Planner.replan()` only handles re-planning after a failure, not initial decomposition.

New `src/tui/plan-generator.ts`:

```typescript
export async function generatePlan(userRequest: string, provider: Provider): Promise<PlanStep[]>
```

Sends one non-streaming prompt asking the model to decompose `userRequest` into a JSON array of `{ id, description, dependencies }`. Parses and validates the response (rejects and surfaces an error to the user if the model returns malformed JSON — no silent fallback to a single-step plan, since that would misrepresent what's about to run). Successfully parsed steps are given `status: "pending"`, `retryCount: 0` and passed to `agent.runPlannedTask(steps, planner)`.

`Orchestrator` needs one small addition to support live plan-progress rendering: an optional `onStepChange?: (step: PlanStep) => void` field on `OrchestratorOptions`, invoked from `runStep()` whenever a step's `status` changes (running/completed/retryable-pending/failed/skipped). `agent-bridge.ts` (or a plan-specific bridge) wires this to `dispatch({ type: "PLAN_STEP_CHANGED", step })`. `ChatPlan` pane renders a numbered checklist (mirroring the mockup) when plan steps are present, falling back to normal chat transcript rendering otherwise.

### File tree & code/diff viewer

File tree: built from `ListDirectoryTool` (already exists, no new tool needed), lazy-expanded per directory on user selection (arrow keys + enter, not full recursive scan upfront — avoids slow startup on large repos). Selecting a file dispatches `FILE_SELECTED`, which triggers a `read_file` call and renders the content in `CodeDiff` with `cli-highlight` syntax coloring, no diff markers, until that file has been edited this session.

**Diff tracking** (`edit-tracker.ts`): before any `write_file` or `patch_file` tool call is dispatched by `Agent`, `agent-bridge.ts` snapshots the file's current content via `read_file` (best-effort — if the file doesn't exist yet, treat prior content as empty) and stores it keyed by path. After the tool result comes back, the tracker computes a unified diff (`diff` package's `diffLines` or similar) between the snapshot and the new content, feeding `CodeDiff`'s diff-render mode (red/green +/- lines, syntax-highlighted per line, `+N -M` header matching the mockup). This tracker is in-memory, per-session — no persistence needed (matches `Agent`'s existing in-memory `messages` transcript).

### Terminal pane — live streaming

`ShellTool` (`src/tools/shell.ts`) currently buffers all stdout/stderr and resolves once at process close — no intermediate access to output as it streams. Add an optional constructor field to `ShellToolOptions`:

```typescript
onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
```

Invoked from the existing `child.stdout.on("data", ...)` / `child.stderr.on("data", ...)` handlers in `ShellTool.call()`, alongside the existing buffering logic (pure addition — `call()`'s return shape and buffering/truncation behavior are unchanged). `Agent` passes this callback when constructing `ShellTool`, forwarding to a new `AgentEvents.onShellOutput` event. `Terminal` pane subscribes and appends chunks live as `run_shell` executes — true character-by-character streaming, not resolved-on-close.

v1 shows a single active stream (most recently started `run_shell` call). If a second `run_shell` call starts while a previous one's output is still being read by the model in the tool-call loop, the pane simply switches to showing the new one — concurrent multi-terminal display is backlog.

### Memory pane — LLM-generated summary

`MemoryStore` (`src/memory/store.ts`) already persists messages and project notes but has no summarization logic (correctly — it's a pure storage layer, no `Provider` dependency).

New `src/memory/summarizer.ts`:

```typescript
export async function generateSummary(store: MemoryStore, provider: Provider): Promise<string>
```

Pulls `store.recentMessages(20)`, sends one non-streaming prompt asking for a 3-5 bullet-point summary of the conversation so far, writes the result via `store.setProjectNote("summary", text)`, and returns it.

Trigger: `Agent` calls this fire-and-forget after each successful `runUserMessage()` resolution (does not block the returned response). Guarded by an `isSummarizing` boolean field on `Agent` — if a summarization is already in flight when a turn completes, that turn's trigger is skipped (the next completed turn will catch it; no queueing, no stacking calls). `Memory` pane renders the stored summary plus a files-touched list (derived from the same tool-call log used for diff tracking — any path that appeared in a `write_file`/`patch_file`/`delete_file`/`move_file` tool call this session) and a live message count from `MemoryStore.recentMessages(...).length`-style tracking (or a running counter in reducer state — implementation detail).

### Keybindings

- `Tab` / `Shift+Tab` — cycle pane focus
- `Ctrl+Enter` — send chat input
- `F1` — help overlay (static keybinding reference, no external docs lookup)
- `F2` — focus file tree
- `F3` — focus search (opens a prompt using `SearchCodeTool`, results rendered in a transient overlay or the tools log — implementation detail)
- `F4` — focus a minimal git status view (`GitTool status`/`diff`, read-only render, not a full git UI)
- `F5` — focus terminal
- `F6` — focus chat
- No modal (vim NORMAL/INSERT) input — the input box is always typeable, matching the existing REPL's model.

### Testing

- `ink-testing-library` for pane component rendering (assertion-based on rendered output, not snapshot-only, matching this repo's existing test style).
- `state.ts` reducer tested in isolation — pure functions, straightforward table-driven tests per action type.
- `agent-bridge.ts` tested with a fake event-emitting `Agent`-shaped object (mirrors the pattern already used in `tests/orchestrator/agent-planner.test.ts`, which stubs `runUserMessage`).
- `plan-generator.ts` tested against a fake `Provider` returning both valid and malformed JSON, asserting the malformed case surfaces an error rather than silently degrading.
- `edit-tracker.ts` and `summarizer.ts` tested with fixture before/after content and fixture message lists respectively — no real LLM calls in tests.
- `ShellTool`'s new `onOutput` callback tested the same way the existing `shell.test.ts` mocks `child_process.spawn` — assert chunks are forwarded as they arrive, and that existing buffered-result behavior is unchanged.

## Open Questions / Risks

- **Terminal width constraints**: the mockup assumes a wide terminal (~150+ cols). Exact fallback behavior for narrow terminals (stack panes vertically? hide some?) is an implementation-time decision, not specified here — flag if it becomes a blocker during implementation.
- **Right-column tab vs side-by-side for ToolsLog/Memory**: deferred to implementation, decided based on how much horizontal space is actually available once the layout is built and tested against a real terminal.
- **Plan-generator JSON reliability**: local/small models may not reliably return valid JSON for step decomposition. The design's answer (surface an error, no silent single-step fallback) is deliberate but should be revisited if it proves too brittle in practice with the project's default local models.
