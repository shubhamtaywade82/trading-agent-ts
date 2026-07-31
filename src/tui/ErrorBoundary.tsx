import { Box, Text } from "ink";
import React from "react";

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <Box borderStyle="double" borderColor="red" flexDirection="column">
          <Text bold color="red">
            TradingAgent TUI crashed
          </Text>
          <Text color="red">{this.state.error.message}</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
