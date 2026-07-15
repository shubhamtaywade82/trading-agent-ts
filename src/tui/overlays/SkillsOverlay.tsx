import React from "react";
import { Box, Text } from "ink";
import { SkillMeta, SkillUsageStats } from "../../skills/types.js";
import { UniversalPicker } from "./UniversalPicker.js";
import { OverlayFrame } from "./OverlayFrame.js";

export interface SkillsOverlayProps {
  skills: SkillMeta[];
  usage?: Record<string, SkillUsageStats>;
  width: number;
  rows: number;
  active: boolean;
  onSelect(id: string): void;
}

/** Browse installed skills and pin one — reached via /skills or the command palette. */
export function SkillsOverlay({ skills, usage, width, rows, active, onSelect }: SkillsOverlayProps): JSX.Element {
  if (skills.length === 0) {
    return (
      <OverlayFrame title="Skills" width={width} rows={rows}>
        <Box>
          <Text color="magenta">No skills found in .devagent/skills or ~/.devagent/skills</Text>
        </Box>
      </OverlayFrame>
    );
  }
  return (
    <UniversalPicker
      title="Skills"
      items={skills.map((s) => ({
        id: s.id,
        label: s.name,
        detail: usage?.[s.id] ? `used ${usage[s.id].useCount}×` : s.tags.join(", "),
      }))}
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
