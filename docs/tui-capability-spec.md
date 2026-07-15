# TUI/CLI Capability Spec

The current zone skeleton (Header, ContextStrip, ActivityStrip, PromptBar, TokenLine, and routed views) is the right base. The gap with Claude Code-style workflows is a capability set, not more panels.

## Priority capabilities

1. **Permission modes**
   - Header shows one global mode: `read-only`, `auto-edit`, or `full-auto`.
   - Keybind cycles the mode.
   - Per-tool policy:
     - Read-only tools are always allowed.
     - Write, patch, delete, move, and copy tools require approval in `read-only`.
     - Shell execution and `git push` require approval except in `full-auto`.
   - `ApprovalOverlay` is the single gate for tools not auto-allowed by the current mode.

2. **Diff-first review queue**
   - Use the existing edit tracker to surface every mutating tool result in a pending-diff lane.
   - Shortcuts:
     - `y` applies/accepts the diff.
     - `n` rejects/reverts the diff.
     - `e` opens the diff in `$EDITOR`.
   - In `auto-edit`, diffs apply immediately but remain in the lane for post-hoc review and revert.

3. **Checkpoint and rewind**
   - Automatically create a snapshot before the first mutating tool in each user turn.
   - Add `/rewind` to list checkpoints and restore one.
   - Header shows the current checkpoint id.

4. **Headless mode**
   - Add `devagent -p "task" --output-format json|stream`.
   - Reuse the existing `Agent` event surface; emit JSONL rather than Ink UI.
   - This enables CI, cron, shell pipelines, and integration with other agents.

5. **Session persistence**
   - Store `Agent` messages and edit-tracker state under `.devagent/sessions/<session-id>/`.
   - Add `devagent --resume <session-id>` and `devagent --continue`.
   - Keep `resetContext()` as an explicit lifecycle action.

6. **Header/status additions**
   - Permission mode.
   - Context usage: tokens used / model context window.
   - Auto-compact indicator around 80% context usage.
   - Current checkpoint id.
   - Learning indicator, e.g. `Λ 3` for lessons absorbed this session.

7. **Learning view**
   - Lessons table: text, confidence, evidence count, and promoted skill id.
   - Episode history: goal, terminal, score, verdict, and tool-event count.
   - Demotion log: learned skill id, usage count, success rate, and demotion time.
