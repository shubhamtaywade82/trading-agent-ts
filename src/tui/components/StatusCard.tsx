import React from "react";
import { Box, Text } from "ink";
import { CollapsibleSection } from "./CollapsibleSection.js";
import { StatusChip } from "./StatusChip.js";
import { ChatEntry } from "../../runtime/types.js";

interface StatusCardProps {
  entry: ChatEntry;
  collapsed: boolean;
  onToggle: () => void;
  width: number;
}

export function StatusCard({ entry, collapsed, onToggle, width }: StatusCardProps): JSX.Element | null {
  if (entry.kind !== "card") return null;
  const { title, status, items } = entry;

  return (
    <CollapsibleSection title={title} status={status} collapsed={collapsed} onToggle={onToggle} width={width}>
      <Box flexDirection="column" marginLeft={2}>
        {items.map((item, i) => (
          <Box key={i} height={1}>
            <Text>
              <StatusChip status={item.status} />
              {" "}
              <Text
                color={
                  item.status === "completed"
                    ? "green"
                    : item.status === "failed"
                      ? "red"
                      : item.status === "running"
                        ? "blue"
                        : "gray"
                }
              >
                {item.label}
              </Text>
              {item.detail && (
                <Text color="gray" wrap="truncate">
                  {"  "}{item.detail}
                </Text>
              )}
            </Text>
          </Box>
        ))}
      </Box>
    </CollapsibleSection>
  );
}
