import React from "react";
import { Box, Text } from "ink";

export const Panel: React.FC<{
  title: string;
  borderColor?: string;
  empty?: string;
  right?: string;
  children?: React.ReactNode;
}> = ({ title, borderColor = "cyan", empty, right, children }) => {
  const isEmpty = !children || (Array.isArray(children) && children.length === 0);
  if (isEmpty && empty) {
    return (
      <Box marginBottom={1}>
        <Text color="gray">· {title}: {empty}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} marginBottom={1}>
      <Box marginTop={-1} justifyContent="space-between">
        <Text bold color={borderColor}>
          {title}
        </Text>
        {right && <Text color="gray">{right}</Text>}
      </Box>
      {children}
    </Box>
  );
};
