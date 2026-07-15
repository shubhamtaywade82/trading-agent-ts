import React from "react";
import { Box, Text } from "ink";
import { CollapsibleSection } from "./CollapsibleSection.js";
import { ChatEntry } from "../../runtime/types.js";

interface DecisionCardProps {
  entry: ChatEntry;
  collapsed: boolean;
  onToggle: () => void;
  width: number;
}

export function DecisionCard({ entry, collapsed, onToggle, width }: DecisionCardProps): JSX.Element | null {
  if (entry.kind !== "decision") return null;
  const { options, selected, reason, confidence } = entry;

  return (
    <CollapsibleSection title="Strategy" status="completed" collapsed={collapsed} onToggle={onToggle} width={width}>
      <Box flexDirection="column" marginLeft={2}>
        <Box height={1}>
          <Text>
            <Text bold>Selected: </Text>
            <Text color="green">{selected}</Text>
          </Text>
        </Box>
        {options.length > 0 && (
          <Box height={1}>
            <Text color="gray">
              Options: {options.join(", ")}
            </Text>
          </Box>
        )}
        {reason && (
          <Box height={1}>
            <Text wrap="truncate">
              <Text bold>Reason: </Text>
              {reason}
            </Text>
          </Box>
        )}
        <Box height={1}>
          <Text>
            <Text bold>Confidence: </Text>
            <Text color={confidence > 0.7 ? "green" : confidence > 0.4 ? "yellow" : "red"}>
              {Math.round(confidence * 100)}%
            </Text>
          </Text>
        </Box>
      </Box>
    </CollapsibleSection>
  );
}
