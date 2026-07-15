import React from "react";
import { Text } from "ink";

const STATUS_GLYPH: Record<string, { glyph: string; color: string }> = {
  pending: { glyph: "○", color: "gray" },
  running: { glyph: "▶", color: "blue" },
  completed: { glyph: "✓", color: "green" },
  failed: { glyph: "✗", color: "red" },
  skipped: { glyph: "↷", color: "yellow" },
  waiting: { glyph: "○", color: "yellow" },
  approved: { glyph: "✓", color: "green" },
  rejected: { glyph: "✗", color: "red" },
  pending_review: { glyph: "○", color: "yellow" },
  healthy: { glyph: "✓", color: "green" },
  active: { glyph: "▶", color: "blue" },
  error: { glyph: "✗", color: "red" },
  thinking: { glyph: "○", color: "magenta" },
  muted: { glyph: "—", color: "gray" },
};

interface StatusChipProps {
  status: string;
  label?: string;
}

export function StatusChip({ status, label }: StatusChipProps): JSX.Element {
  const s = STATUS_GLYPH[status] ?? { glyph: "?", color: "gray" };
  return (
    <Text color={s.color}>
      {label ? `${s.glyph} ${label}` : s.glyph}
    </Text>
  );
}
