import React from "react";
import { Box, Text } from "ink";
import { ViewProps } from "./ConversationView.js";

export function ContextInspectorView({ state, width, rows }: ViewProps): JSX.Element {
  const { model, memory, execution } = state;

  const contextPercent = model.contextLimit > 0 ? Math.round((model.contextUsed / model.contextLimit) * 100) : 0;
  const contextColor = contextPercent > 80 ? "red" : contextPercent > 60 ? "yellow" : "green";

  return (
    <Box flexDirection="column" height={rows}>
      <Box height={1} marginBottom={1}>
        <Text bold>Context Inspector</Text>
      </Box>

      <Box height={1}>
        <Text bold>Token Usage</Text>
      </Box>
      <Box height={1} marginLeft={2}>
        <Text>
          <Text>Used: </Text>
          <Text color={contextColor}>{model.contextUsed.toLocaleString()}</Text>
          <Text color="gray"> / {model.contextLimit.toLocaleString()}</Text>
        </Text>
      </Box>
      <Box height={1} marginLeft={2}>
        <Text>
          <Text>Usage: </Text>
          <Text color={contextColor}>{contextPercent}%</Text>
        </Text>
      </Box>
      <Box height={1} marginLeft={2}>
        <Text>
          <Text>Speed: </Text>
          <Text color="gray">{model.tokensPerSecond.toFixed(1)} tok/s</Text>
          {model.latencyMs > 0 && <Text color="gray">  Latency: {model.latencyMs}ms</Text>}
        </Text>
      </Box>

      {memory.length > 0 && (
        <>
          <Box height={1} marginTop={1}>
            <Text bold>Working Memory</Text>
          </Box>
          {memory.slice(0, rows - 8).map((item, i) => (
            <Box key={i} height={1} marginLeft={2}>
              <Text>
                <Text color="cyan">{item.kind}</Text>
                <Text color="gray"> {item.key}: </Text>
                <Text wrap="truncate">{item.value.slice(0, width - 20)}</Text>
              </Text>
            </Box>
          ))}
        </>
      )}

      {execution.steps.length > 0 && (
        <>
          <Box height={1} marginTop={1}>
            <Text bold>Execution Plan ({execution.steps.length} steps)</Text>
          </Box>
          <Box marginLeft={2}>
            <Text color="gray" wrap="truncate">
              {execution.goal.slice(0, width - 10)}
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}
