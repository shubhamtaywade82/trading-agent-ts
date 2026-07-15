import React from "react";
import { Box, Text } from "ink";

export interface PromptBarProps {
  text: string;
  ghost: string;
  width: number;
  busy: boolean;
}

function isPastedPlaceholder(lines: string[]): boolean {
  return lines.length > 0 && lines[0]!.startsWith("[Pasted text");
}

/**
 * How many terminal rows PromptBar will render for this text: 1 normally,
 * 2 when the "N more lines" / "N lines" indicator row shows. Callers that
 * budget fixed-chrome rows (see density.ts's activeViewRows) must account
 * for this so the Active View / overlays never overflow the terminal.
 */
export function promptBarRows(text: string): 1 | 2 {
  const lines = text.split("\n");
  const isPasted = isPastedPlaceholder(lines);
  const showMultiline = isPasted ? lines.length - 1 > 0 : lines.length > 1;
  return showMultiline ? 2 : 1;
}

/** Prompt input with multiline support. Shift+Enter inserts a newline. */
export function PromptBar({ text, ghost, width, busy }: PromptBarProps): JSX.Element {
  const promptGlyph = busy ? "◌" : ">";
  const lines = text.split("\n");
  const isPasted = isPastedPlaceholder(lines);
  const hiddenCount = isPasted ? lines.length - 1 : 0;
  const lastLine = isPasted ? lines[0]! : (lines[lines.length - 1] ?? "");
  const available = Math.max(1, width - 2);
  const visibleLine = lastLine.length > available ? lastLine.slice(lastLine.length - available) : lastLine;
  const ghostRoom = available - visibleLine.length - 1;
  const visibleGhost = ghostRoom > 0 && !text.endsWith("\n") ? ghost.slice(0, ghostRoom) : "";
  const showMultiline = isPasted ? hiddenCount > 0 : lines.length > 1;
  return (
    <Box flexDirection="column">
      {showMultiline && (
        <Box height={1}>
          <Text color="gray" dimColor>
            {isPasted
              ? `⏎ ${hiddenCount} line${hiddenCount !== 1 ? "s" : ""}`
              : `⏎ ${lines.length - 1} more line${lines.length > 2 ? "s" : ""}`}
          </Text>
        </Box>
      )}
      <Box height={1}>
        <Text color={busy ? "magenta" : "green"} bold>
          {promptGlyph}{" "}
        </Text>
        <Text key={visibleLine}>
          {visibleLine}
          <Text inverse> </Text>
          <Text color="gray">{visibleGhost}</Text>
        </Text>
      </Box>
    </Box>
  );
}
