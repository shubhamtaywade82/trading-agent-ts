import React from "react";
import { Box, Text } from "ink";
import { RuntimeState, ViewId } from "../../runtime/types.js";
import { contextStripTokens } from "../../layout/strips.js";
import { CompletionItem } from "../../interaction/completion.js";
import { TokenLine } from "./TokenLine.js";

export interface ContextStripProps {
  state: RuntimeState;
  width: number;
  activeView: ViewId;
  /** When the prompt is completing a slash command, hints replace the strip. */
  completionItems?: CompletionItem[];
  completionIndex?: number;
}

export function ContextStrip({
  state,
  width,
  activeView,
  completionItems,
  completionIndex,
}: ContextStripProps): JSX.Element {
  if (completionItems && completionItems.length > 0) {
    return (
      <Box height={1}>
        <Text wrap="truncate">
          {completionItems.map((item, i) => (
            <React.Fragment key={item.label}>
              {i > 0 && <Text color="gray">{"  "}</Text>}
              <Text color={i === completionIndex ? "blue" : "gray"} inverse={i === completionIndex}>
                {item.label}
              </Text>
            </React.Fragment>
          ))}
        </Text>
      </Box>
    );
  }
  return <TokenLine tokens={contextStripTokens(state, activeView)} width={width} />;
}
