/**
 * The single frozen theme. Colors are semantic only:
 * green = healthy/done, blue = active/focused, yellow = waiting/warning,
 * red = error/blocked, purple = thinking/model activity, gray = muted.
 */

import { ActorHealth } from "../runtime/types.js";

export type SemanticColor = "green" | "blue" | "yellow" | "red" | "magenta" | "gray";

export function semanticColor(health: ActorHealth): SemanticColor {
  switch (health) {
    case "healthy":
      return "green";
    case "active":
      return "blue";
    case "waiting":
      return "yellow";
    case "error":
      return "red";
    case "thinking":
      return "magenta";
    case "muted":
      return "gray";
  }
}

export const theme = {
  healthy: "green",
  active: "blue",
  waiting: "yellow",
  error: "red",
  thinking: "magenta",
  muted: "gray",
  border: "gray",
  focusBorder: "blue",
} as const;
