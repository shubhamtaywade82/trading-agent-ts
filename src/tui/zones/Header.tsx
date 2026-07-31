import React from "react";

import { headerTokens } from "../../layout/strips.js";
import type { RuntimeState } from "../../runtime/types.js";

import { TokenLine } from "./TokenLine.js";

export interface HeaderProps {
  state: RuntimeState;
  width: number;
  now?: number;
}

export function Header({ state, width, now }: HeaderProps): JSX.Element {
  return <TokenLine tokens={headerTokens(state, now)} width={width} />;
}
