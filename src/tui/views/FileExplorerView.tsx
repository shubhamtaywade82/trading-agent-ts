import React from "react";
import { Box, Text } from "ink";
import { ViewProps } from "./ConversationView.js";

const MOCK_TREE = [
  { name: "src/", depth: 0, type: "dir" },
  { name: "tui/", depth: 1, type: "dir" },
  { name: "App.tsx", depth: 2, type: "file" },
  { name: "components/", depth: 1, type: "dir" },
  { name: "runtime/", depth: 1, type: "dir" },
  { name: "types.ts", depth: 2, type: "file" },
  { name: "store.ts", depth: 2, type: "file" },
  { name: "tests/", depth: 0, type: "dir" },
  { name: "package.json", depth: 0, type: "file" },
  { name: "tsconfig.json", depth: 0, type: "file" },
];

export function FileExplorerView({ width, rows }: ViewProps): JSX.Element {
  return (
    <Box flexDirection="column" height={rows}>
      <Box height={1} marginBottom={1}>
        <Text bold>Project Files</Text>
        <Text color="gray">  (Ctrl+F to search)</Text>
      </Box>
      {MOCK_TREE.slice(0, rows - 1).map((item, i) => (
        <Box key={i} height={1} marginLeft={item.depth * 2}>
          <Text color={item.type === "dir" ? "blue" : "white"}>
            {item.type === "dir" ? "▸ " : "  "}{item.name}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
