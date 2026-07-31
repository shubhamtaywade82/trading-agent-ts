import React from "react";

import { activityStripTokens } from "../../layout/strips.js";
import { semanticColor } from "../../layout/theme-map.js";
import type { RuntimeState } from "../../runtime/types.js";

import { TokenLine } from "./TokenLine.js";

export interface ActivityStripProps {
  state: RuntimeState;
  width: number;
  now?: number;
}

const NOTIFICATION_TTL_MS = 5000;

const NOTIFICATION_HEALTH = {
  info: "active",
  success: "healthy",
  warning: "waiting",
  error: "error",
} as const;

/** Live health of every actor; recent notifications surface as a toast token. */
export function ActivityStrip({ state, width, now = Date.now() }: ActivityStripProps): JSX.Element {
  const tokens = activityStripTokens(state);
  const latest = state.notifications.at(-1);
  if (latest && now - latest.at < NOTIFICATION_TTL_MS) {
    tokens.push({
      text: `${latest.kind === "success" ? "✓ " : (latest.kind === "error" ? "✗ " : "")}${latest.text}`,
      priority: 0,
      color: semanticColor(NOTIFICATION_HEALTH[latest.kind]),
    });
  }
  return <TokenLine tokens={tokens} width={width} />;
}
