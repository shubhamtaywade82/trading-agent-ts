import { Box, Text } from "ink";
import React from "react";

import { packTokens, TOKEN_SEPARATOR } from "../../layout/status-tokens.js";
import type { StatusToken } from "../../runtime/types.js";

export interface TokenLineProps {
  tokens: StatusToken[];
  width: number;
}

/** Renders a strip of status tokens packed to width, colors preserved. */
export function TokenLine({ tokens, width }: TokenLineProps): JSX.Element {
  const packed = packTokens(tokens, width);
  return (
    <Box height={1} minHeight={1}>
      <Text>
        {packed.length > 0 ? (
          packed.map((token, i) => (
            <React.Fragment key={`${token.text}-${i}`}>
              {i > 0 && <Text color="gray">{TOKEN_SEPARATOR}</Text>}
              <Text {...(token.color !== undefined && { color: token.color })}>{token.text}</Text>
            </React.Fragment>
          ))
        ) : (
          <Text> </Text>
        )}
      </Text>
    </Box>
  );
}
