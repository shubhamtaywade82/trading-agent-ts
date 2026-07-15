import React from "react";
import { Box, Text } from "ink";
import { MemoryItem } from "../../runtime/types.js";
import { tail, truncate, wrapText } from "../../layout/truncate.js";
import { ViewProps } from "./ConversationView.js";

const KIND_LABEL: Record<MemoryItem["kind"], string> = {
  repo: "repo",
  style: "style",
  preference: "pref",
  architecture: "arch",
};

/** Memory: repo knowledge, coding style, preferences, architecture notes. */
export function MemoryView({ state, width, rows }: ViewProps): JSX.Element {
  const summaryLines = state.memorySummary ? wrapText(state.memorySummary, Math.max(10, width)) : [];
  const summaryRows = Math.min(summaryLines.length, Math.max(1, Math.floor(rows / 2)));
  const itemRows = Math.max(0, rows - summaryRows);
  const items = tail(state.memory, itemRows);
  if (summaryLines.length === 0 && items.length === 0) {
    return (
      <Box height={rows}>
        <Text color="gray">No memory yet — knowledge accumulates as the agent works.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" height={rows}>
      {summaryLines.slice(0, summaryRows).map((line, i) => (
        <Text key={`s${i}`} wrap="truncate" color="magenta">
          {line}
        </Text>
      ))}
      {items.map((item) => (
        <Text key={item.key} wrap="truncate">
          <Text color="yellow">{`[${KIND_LABEL[item.kind]}] `}</Text>
          <Text color="blue">{item.key}</Text>
          <Text color="gray">{" — "}</Text>
          <Text>{truncate(item.value.replace(/\n/g, " "), Math.max(10, width - item.key.length - 12))}</Text>
        </Text>
      ))}
    </Box>
  );
}
