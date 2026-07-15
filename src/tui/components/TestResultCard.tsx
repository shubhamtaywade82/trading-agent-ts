import React from "react";
import { Box, Text } from "ink";
import { CollapsibleSection } from "./CollapsibleSection.js";
import { ChatEntry } from "../../runtime/types.js";

interface TestResultCardProps {
  entry: ChatEntry;
  collapsed: boolean;
  onToggle: () => void;
  width: number;
}

const statusForResult = (failed: number): string => (failed > 0 ? "failed" : "completed");

export function TestResultCard({ entry, collapsed, onToggle, width }: TestResultCardProps): JSX.Element | null {
  if (entry.kind !== "test_result") return null;
  const { command, passed, failed, failures, durationMs } = entry;

  return (
    <CollapsibleSection
      title={`Tests: ${passed} passed, ${failed} failed`}
      status={statusForResult(failed)}
      collapsed={collapsed}
      onToggle={onToggle}
      width={width}
    >
      <Box flexDirection="column" marginLeft={2}>
        <Box height={1}>
          <Text color="gray" wrap="truncate">
            {command}
          </Text>
        </Box>
        <Box height={1}>
          <Text>
            <Text color="green">✓ {passed} passed</Text>
            {failed > 0 && <Text color="red">  ✗ {failed} failed</Text>}
            <Text color="gray">  ({durationMs}ms)</Text>
          </Text>
        </Box>
        {failures.map((f, i) => (
          <Box key={i} flexDirection="column">
            <Box height={1}>
              <Text color="red">
                {f.file}:{f.line}
              </Text>
            </Box>
            <Box height={1}>
              <Text color="gray" wrap="truncate">
                {"  "}{f.message}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
    </CollapsibleSection>
  );
}
