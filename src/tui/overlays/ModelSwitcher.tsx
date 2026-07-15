import React from "react";
import { Box, Text } from "ink";
import { UniversalPicker } from "./UniversalPicker.js";
import { OverlayFrame } from "./OverlayFrame.js";

export interface ModelSwitcherProps {
  current: string;
  models: string[] | null; // null = still loading
  width: number;
  rows: number;
  active: boolean;
  onSelect(model: string): void;
}

/** Ctrl+M — switch model via the universal picker. */
export function ModelSwitcher({ current, models, width, rows, active, onSelect }: ModelSwitcherProps): JSX.Element {
  if (models === null) {
    return (
      <OverlayFrame title="Switch Model" width={width} rows={rows}>
        <Box>
          <Text color="magenta">Loading models…</Text>
        </Box>
      </OverlayFrame>
    );
  }
  const all = models.includes(current) || !current ? models : [current, ...models];
  return (
    <UniversalPicker
      title="Switch Model"
      items={all.map((m) => ({ id: m, label: m, detail: m === current ? "current" : undefined }))}
      width={width}
      rows={rows}
      active={active}
      placeholder="Type to filter models…"
      emptyText="No models available — is the provider reachable?"
      initialSelected={current ? [current] : []}
      onSubmit={(ids) => {
        if (ids[0]) onSelect(ids[0]);
      }}
    />
  );
}
