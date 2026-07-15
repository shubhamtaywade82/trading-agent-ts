import React from "react";
import { Box, Text } from "ink";
import { ViewProps } from "./ConversationView.js";

function row(label: string, value: React.ReactNode): JSX.Element {
  return (
    <Text key={label} wrap="truncate">
      <Text color="gray">{label.padEnd(14)}</Text>
      {value}
    </Text>
  );
}

/** Models: provider, model, latency, throughput, context, stream state. */
export function ModelsView({ state, rows }: ViewProps): JSX.Element {
  const { model } = state;
  const ctxPct = model.contextLimit > 0 ? Math.round((model.contextUsed / model.contextLimit) * 100) : null;
  return (
    <Box flexDirection="column" height={rows}>
      {row("Provider", <Text>{model.provider}</Text>)}
      {row("Model", <Text color="blue">{model.name || "-"}</Text>)}
      {row("Stream", model.streaming ? <Text color="magenta">streaming ▶</Text> : <Text color="green">idle</Text>)}
      {row("Tokens/sec", <Text>{model.tokensPerSecond > 0 ? Math.round(model.tokensPerSecond) : "-"}</Text>)}
      {row("Latency", <Text>{model.latencyMs > 0 ? `${model.latencyMs}ms` : "-"}</Text>)}
      {row(
        "Context",
        ctxPct == null ? (
          <Text>-</Text>
        ) : (
          <Text color={ctxPct > 85 ? "red" : ctxPct > 65 ? "yellow" : "green"}>
            {`${model.contextUsed}/${model.contextLimit} (${ctxPct}%)`}
          </Text>
        ),
      )}
    </Box>
  );
}
