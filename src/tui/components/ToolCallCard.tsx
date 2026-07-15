import React from "react";
import { Box, Text } from "ink";
import { CollapsibleSection } from "./CollapsibleSection.js";
import { ChatEntry } from "../../runtime/types.js";
import { truncate } from "../../layout/truncate.js";

interface ToolCallCardProps {
  entry: ChatEntry;
  collapsed: boolean;
  onToggle: () => void;
  width: number;
}

export function ToolCallCard({ entry, collapsed, onToggle, width }: ToolCallCardProps): JSX.Element | null {
  if (entry.kind !== "tool_call") return null;
  const { name, status, result, error } = entry;

  return (
    <CollapsibleSection title={`Tool: ${name}`} status={status} collapsed={collapsed} onToggle={onToggle} width={width}>
      <Box flexDirection="column" marginLeft={2}>
        {error && (
          <Box height={1}>
            <Text color="red" wrap="truncate">
              Error: {truncate(error, width - 10)}
            </Text>
          </Box>
        )}
        {result && (
          <Box height={1}>
            <Text color="gray" wrap="truncate">
              Result: {truncate(result, width - 10)}
            </Text>
          </Box>
        )}
      </Box>
    </CollapsibleSection>
  );
}
