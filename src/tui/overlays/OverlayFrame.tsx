import React from "react";
import { Box, Text } from "ink";

export interface OverlayFrameProps {
  title: string;
  width: number;
  rows: number;
  children: React.ReactNode;
}

/**
 * Overlays are ephemeral: they render inside the Active View zone, never
 * replace runtime state, and always close with Esc.
 */
export function OverlayFrame({ title, width, rows, children }: OverlayFrameProps): JSX.Element {
  const innerWidth = Math.max(20, Math.min(width - 4, 100));
  return (
    <Box flexDirection="column" height={rows} alignItems="center" justifyContent="center">
      <Box flexDirection="column" width={innerWidth} borderStyle="single" borderColor="blue" paddingX={1}>
        <Box justifyContent="space-between">
          <Text color="blue" bold>
            {title}
          </Text>
          <Text color="gray">Esc Close</Text>
        </Box>
        {children}
      </Box>
    </Box>
  );
}
