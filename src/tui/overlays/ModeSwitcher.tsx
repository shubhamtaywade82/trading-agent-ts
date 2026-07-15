import React, { useState } from "react";
import { Box, Text } from "ink";
import { AGENT_MODES, AGENT_MODE_LABELS, AgentMode } from "../../runtime/types.js";
import { OverlayFrame } from "./OverlayFrame.js";

interface ModeSwitcherProps {
  current: AgentMode;
  width: number;
  rows: number;
  active: boolean;
  onSelect: (mode: AgentMode) => void;
}

export function ModeSwitcher({ current, width, rows, active, onSelect }: ModeSwitcherProps): JSX.Element {
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(AGENT_MODES.indexOf(current));

  const filtered = AGENT_MODES.filter((m) => {
    const label = AGENT_MODE_LABELS[m].label.toLowerCase();
    return !filter || label.includes(filter.toLowerCase());
  });

  const handleKey = (ch: string) => {
    if (active) {
      if (ch.length === 1) {
        setFilter((f) => f + ch);
      }
    }
  };

  return (
    <OverlayFrame title="Agent Mode" width={width} rows={rows}>
      <Box flexDirection="column" height={rows - 2}>
        <Box marginLeft={1} marginBottom={1}>
          <Text wrap="truncate">
            <Text color="gray">Filter: </Text>
            <Text>{filter || "(type to filter)"}</Text>
          </Text>
        </Box>
        {filtered.map((mode, i) => {
          const info = AGENT_MODE_LABELS[mode];
          const isCurrent = mode === current;
          const isSelected = i === selectedIndex;
          return (
            <Box key={mode} height={2}>
              <Box marginLeft={1}>
                <Text
                  color={isSelected ? "blue" : isCurrent ? "green" : "white"}
                  inverse={isSelected}
                  bold={isCurrent}
                >
                  {isCurrent ? "▸ " : "  "}{info.label}
                </Text>
              </Box>
              <Box marginLeft={2}>
                <Text color="gray" wrap="truncate">
                  {info.description}
                </Text>
              </Box>
            </Box>
          );
        })}
        {filtered.length === 0 && (
          <Box marginLeft={1}>
            <Text color="gray">No matching modes</Text>
          </Box>
        )}
      </Box>
    </OverlayFrame>
  );
}
