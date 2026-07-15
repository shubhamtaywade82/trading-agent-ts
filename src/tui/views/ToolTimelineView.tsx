import React from "react";
import { Box, Text } from "ink";
import { ViewProps } from "./ConversationView.js";

export function ToolTimelineView({ state, width, rows }: ViewProps): JSX.Element {
  const { toolCalls } = state;
  const maxRows = Math.max(1, rows - 2);
  const visible = toolCalls.slice(-maxRows);

  if (visible.length === 0) {
    return (
      <Box flexDirection="column" height={rows}>
        <Text color="gray">No tool calls yet.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={rows}>
      <Box height={1} marginBottom={1}>
        <Text bold color="magenta">Tool Execution Timeline</Text>
      </Box>
      {visible.map((call, idx) => {
        const time = new Date(call.startedAt);
        const timeStr = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}:${String(time.getSeconds()).padStart(2, "0")}`;
        const isLast = idx === visible.length - 1;
        const connector = isLast ? "└─" : "├─";

        let statusText = "";
        let statusColor = "gray";
        if (call.status === "running") {
          statusText = " ⏳ running";
          statusColor = "yellow";
        } else if (call.status === "failed") {
          statusText = " ✗ failed";
          statusColor = "red";
        } else {
          const duration = call.endedAt ? `${((call.endedAt - call.startedAt) / 1000).toFixed(1)}s` : "";
          statusText = duration ? ` (${duration})` : "";
        }

        return (
          <Box key={call.id} height={1}>
            <Text>
              <Text color="gray">[{timeStr}] </Text>
              <Text color="cyan">{connector} </Text>
              <Text bold color={call.status === "failed" ? "red" : call.status === "running" ? "yellow" : "green"}>
                {call.name}
              </Text>
              <Text color={statusColor}>{statusText}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
