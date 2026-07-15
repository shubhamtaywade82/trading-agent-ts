import React from "react";
import { Box, Text } from "ink";

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <Box borderStyle="double" borderColor="red" flexDirection="column">
          <Text bold color="red">
            DevAgent TUI crashed
          </Text>
          <Text color="red">{this.state.error.message}</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
