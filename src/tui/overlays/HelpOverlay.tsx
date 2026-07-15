import React from "react";
import { Box, Text } from "ink";
import { OverlayFrame } from "./OverlayFrame.js";

const KEYS: [string, string][] = [
  ["1-8", "Focus a view (Conversation, Execution, Tasks, Git, Logs, Memory, Models, MCP)"],
  ["Tab / Shift+Tab", "Next / previous view"],
  ["Ctrl+P", "Command palette"],
  ["Ctrl+B", "Actors overlay"],
  ["Ctrl+M", "Switch model"],
  ["Ctrl+F", "Search everywhere"],
  ["z", "Zoom active view"],
  ["/", "Slash commands (with autocomplete)"],
  ["@", "Prompt templates"],
  ["↑ / ↓", "Prompt history"],
  ["Tab (in prompt)", "Accept ghost text"],
  ["Esc", "Close overlay / cancel"],
  ["?", "This help"],
  ["q", "Quit"],
];

export function HelpOverlay({ width, rows }: { width: number; rows: number }): JSX.Element {
  return (
    <OverlayFrame title="Help — Keys" width={width} rows={rows}>
      {KEYS.slice(0, Math.max(3, rows - 4)).map(([key, description]) => (
        <Box key={key}>
          <Box width={18}>
            <Text color="yellow">{key}</Text>
          </Box>
          <Text wrap="truncate">{description}</Text>
        </Box>
      ))}
      <Text color="gray" italic>
        Changing focus never stops background actors.
      </Text>
    </OverlayFrame>
  );
}
