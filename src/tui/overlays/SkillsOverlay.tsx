import { Box, Text } from "ink";
import React from "react";

import type { SkillMeta, SkillUsageStats } from "../../skills/types.js";

import { OverlayFrame } from "./OverlayFrame.js";
import { UniversalPicker } from "./UniversalPicker.js";

export interface SkillsOverlayProps {
  skills: SkillMeta[];
  usage?: Record<string, SkillUsageStats>;
  width: number;
  rows: number;
  active: boolean;
  onSelect: (id: string) => void;
}

/** Browse installed skills and pin one — reached via /skills or the command palette. */
export function SkillsOverlay({ skills, usage, width, rows, active, onSelect }: SkillsOverlayProps): JSX.Element {
  if (skills.length === 0) {
    return (
      <OverlayFrame title="Skills" width={width} rows={rows}>
        <Box>
          <Text color="magenta">No skills found in .trading-agent/skills or ~/.trading-agent/skills</Text>
        </Box>
      </OverlayFrame>
    );
  }
  return (
    <UniversalPicker
      title="Skills"
      items={skills.map((s) => {
        const used = usage?.[s.id];
        return {
          id: s.id,
          label: s.name,
          detail: used ? `used ${used.useCount}×` : s.tags.join(", "),
        };
      })}
      width={width}
      rows={rows}
      active={active}
      placeholder="Type to filter skills…"
      emptyText="No matching skills"
      onSubmit={(ids) => {
        if (ids[0]) onSelect(ids[0]);
      }}
    />
  );
}
