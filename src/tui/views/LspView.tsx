import React from "react";
import { Box, Text } from "ink";
import { tail } from "../../layout/truncate.js";
import { ViewProps } from "./ConversationView.js";

const STATUS_COLORS: Record<string, string> = {
  running: "green",
  idle: "yellow",
  starting: "blue",
  stopped: "gray",
  error: "red",
};

const STATUS_GLYPH: Record<string, string> = {
  running: " ● ",
  idle: " ◷ ",
  starting: " ○ ",
  stopped: " ○ ",
  error: " ● ",
};

export function LspView({ state, rows }: ViewProps): JSX.Element {
  const servers = tail(state.lspServers ?? [], rows);
  if (servers.length === 0) {
    return (
      <Box height={rows}>
        <Text color="gray">No LSP servers running.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" height={rows}>
      {servers.map((server) => (
        <Text key={server.language} wrap="truncate">
          <Text color={STATUS_COLORS[server.status] ?? "gray"}>
            {STATUS_GLYPH[server.status] ?? " ○ "}
          </Text>
          <Text bold>{server.language}</Text>
          <Text color="gray">{`  ${server.status}`}</Text>
          {server.documentsCount > 0 && (
            <Text color="gray">{`  ${server.documentsCount} doc${server.documentsCount !== 1 ? "s" : ""}`}</Text>
          )}
          {server.errorCount > 0 && (
            <Text color="red">{`  ${server.errorCount} error${server.errorCount !== 1 ? "s" : ""}`}</Text>
          )}
        </Text>
      ))}
    </Box>
  );
}
