import React from "react";
import { Box, Text } from "ink";
import { Task, TaskStatus } from "../../runtime/types.js";
import { tail, truncate } from "../../layout/truncate.js";
import { ViewProps } from "./ConversationView.js";

const TASK_GLYPH: Record<TaskStatus, { glyph: string; color: string }> = {
  queued: { glyph: "○", color: "gray" },
  blocked: { glyph: "◌", color: "yellow" },
  running: { glyph: "▶", color: "blue" },
  completed: { glyph: "✓", color: "green" },
  failed: { glyph: "✗", color: "red" },
  cancelled: { glyph: "–", color: "gray" },
};

function progressBar(progress: number, width: number): string {
  const filled = Math.round(progress * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

/** Tasks: the task graph — dependencies, states, workers, progress. */
export function TasksView({ state, width, rows, detail }: ViewProps): JSX.Element {
  const tasks = tail(state.tasks, rows);
  if (tasks.length === 0) {
    return (
      <Box height={rows}>
        <Text color="gray">No tasks.</Text>
      </Box>
    );
  }
  const showDeps = detail === "expanded" || detail === "full";
  return (
    <Box flexDirection="column" height={rows}>
      {tasks.map((task: Task) => {
        const s = TASK_GLYPH[task.status];
        const deps = showDeps && task.dependencies.length > 0 ? ` ⇠ ${task.dependencies.join(",")}` : "";
        const worker = detail === "full" && task.worker ? ` @${task.worker}` : "";
        const bar =
          task.status === "running" && task.progress != null && detail !== "compact"
            ? ` ${progressBar(task.progress, 10)}`
            : "";
        return (
          <Text key={task.id} wrap="truncate">
            <Text color={s.color}>{` ${s.glyph} `}</Text>
            <Text>{truncate(`${task.title}${deps}${worker}`, Math.max(8, width - 16))}</Text>
            <Text color="blue">{bar}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
