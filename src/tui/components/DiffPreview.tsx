import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { CollapsibleSection } from "./CollapsibleSection.js";
import { ChatEntry } from "../../runtime/types.js";

interface DiffPreviewProps {
  entry: ChatEntry;
  collapsed: boolean;
  onToggle: () => void;
  width: number;
}

export function DiffPreview({ entry, collapsed, onToggle, width }: DiffPreviewProps): JSX.Element | null {
  if (entry.kind !== "diff_preview") return null;
  const { filePath, diff, status } = entry;

  const diffLines = useMemo(() => diff.split("\n").filter(Boolean), [diff]);

  return (
    <CollapsibleSection title={filePath} status={status} collapsed={collapsed} onToggle={onToggle} width={width}>
      <Box flexDirection="column" marginLeft={2}>
        {diffLines.slice(0, 30).map((line, i) => {
          let color = "white";
          if (line.startsWith("+")) color = "green";
          else if (line.startsWith("-")) color = "red";
          else if (line.startsWith("@")) color = "cyan";
          return (
            <Box key={i} height={1}>
              <Text color={color as any}>{line}</Text>
            </Box>
          );
        })}
        {diffLines.length > 30 && (
          <Box height={1}>
            <Text color="gray">... {diffLines.length - 30} more lines</Text>
          </Box>
        )}
      </Box>
    </CollapsibleSection>
  );
}
