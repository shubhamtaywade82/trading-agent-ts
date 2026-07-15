/**
 * Priority-based status token packing. Both bottom strips are built from
 * StatusTokens; when width shrinks, lower-priority tokens disappear first
 * and the strip never wraps or overflows.
 */

import { StatusToken } from "../runtime/types.js";
import { truncate } from "./truncate.js";

export const TOKEN_SEPARATOR = " │ ";

/**
 * Select the highest-priority tokens that fit in `width` when joined with
 * the separator. Original ordering is preserved among survivors; ties in
 * priority keep earlier tokens.
 */
export function packTokens(tokens: StatusToken[], width: number): StatusToken[] {
  if (width <= 0 || tokens.length === 0) return [];
  const indexed = tokens.map((token, index) => ({ token, index }));
  const byPriority = [...indexed].sort((a, b) => a.token.priority - b.token.priority || a.index - b.index);

  const chosen = new Set<number>();
  let used = 0;
  for (const { token, index } of byPriority) {
    const cost = token.text.length + (chosen.size > 0 ? TOKEN_SEPARATOR.length : 0);
    if (used + cost <= width) {
      chosen.add(index);
      used += cost;
    }
  }

  // Always show at least the single most important token, truncated.
  if (chosen.size === 0) {
    const top = byPriority[0];
    return [{ ...top.token, text: truncate(top.token.text, width) }];
  }
  return indexed.filter(({ index }) => chosen.has(index)).map(({ token }) => token);
}

/** Render packed tokens to a single plain-text line (for tests/logs). */
export function renderTokenLine(tokens: StatusToken[], width: number): string {
  return truncate(
    packTokens(tokens, width)
      .map((t) => t.text)
      .join(TOKEN_SEPARATOR),
    width,
  );
}
