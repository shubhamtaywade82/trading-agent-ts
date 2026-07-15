import React from "react";
import { Box, Text } from "ink";
import { ExecutionStep } from "../../runtime/types.js";
import { tail, truncate } from "../../layout/truncate.js";
import { ViewProps } from "./ConversationView.js";

const STEP_GLYPH: Record<ExecutionStep["status"], { glyph: string; color: string }> = {
  pending: { glyph: "○", color: "gray" },
  running: { glyph: "▶", color: "blue" },
  completed: { glyph: "✓", color: "green" },
  failed: { glyph: "✗", color: "red" },
  skipped: { glyph: "↷", color: "yellow" },
};

/** Execution: goal, steps, active tool, queue, ETA, reasoning summary. */
export function ExecutionView({ state, width, rows, detail }: ViewProps): JSX.Element {
  const { execution } = state;
  const headerRows = execution.goal ? 1 : 0;
  const toolRow = execution.activeTool || execution.queue.length > 0 ? 1 : 0;
  const reasoningRow = detail !== "compact" && execution.reasoning ? 1 : 0;
  const stepRows = Math.max(0, rows - headerRows - toolRow - reasoningRow);
  const steps = tail(execution.steps, stepRows);
  return (
    <Box flexDirection="column" height={rows}>
      {execution.goal ? (
        <Text wrap="truncate">
          <Text color="blue" bold>
            Goal{" "}
          </Text>
          {truncate(execution.goal, width - 5)}
        </Text>
      ) : (
        <Text color="gray">No execution in progress.</Text>
      )}
      {steps.map((step) => {
        const s = STEP_GLYPH[step.status];
        return (
          <Text key={step.id} wrap="truncate">
            <Text color={s.color}>{` ${s.glyph} `}</Text>
            <Text color={step.status === "running" ? "blue" : undefined}>{truncate(step.description, width - 4)}</Text>
          </Text>
        );
      })}
      {toolRow > 0 && (
        <Text wrap="truncate">
          {execution.activeTool && (
            <>
              <Text color="yellow">Tool:</Text>
              <Text>{execution.activeTool}</Text>
            </>
          )}
          {execution.queue.length > 0 && <Text color="gray">{`  Queue: ${execution.queue.join(" → ")}`}</Text>}
          {execution.etaSeconds != null && <Text color="gray">{`  ETA ${execution.etaSeconds}s`}</Text>}
        </Text>
      )}
      {reasoningRow > 0 && (
        <Text wrap="truncate" color="gray" italic>
          {truncate(execution.reasoning.replace(/\n/g, " "), width)}
        </Text>
      )}
    </Box>
  );
}
