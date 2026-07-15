import React from "react";
import { CommandEffect, SlashCommandRegistry } from "../../interaction/slash-commands.js";
import { VIEW_ORDER } from "../../runtime/types.js";
import { UniversalPicker } from "./UniversalPicker.js";

export interface PaletteAction {
  id: string;
  label: string;
  detail: string;
  effect: CommandEffect;
}

export function paletteActions(registry: SlashCommandRegistry): PaletteAction[] {
  const viewActions: PaletteAction[] = VIEW_ORDER.map((view, i) => ({
    id: `view:${view}`,
    label: `Focus: ${view}`,
    detail: `Key ${i + 1}`,
    effect: { kind: "focus-view", view },
  }));
  const commandActions: PaletteAction[] = registry.all().map((c) => ({
    id: `cmd:${c.name}`,
    label: `/${c.name}`,
    detail: c.description,
    effect: c.execute(""),
  }));
  return [...viewActions, ...commandActions];
}

export interface CommandPaletteProps {
  registry: SlashCommandRegistry;
  width: number;
  rows: number;
  active: boolean;
  onAction(effect: CommandEffect): void;
}

/** Ctrl+P — global searchable action palette (actions, not commands). */
export function CommandPalette({ registry, width, rows, active, onAction }: CommandPaletteProps): JSX.Element {
  const actions = paletteActions(registry);
  return (
    <UniversalPicker
      title="Command Palette"
      items={actions}
      width={width}
      rows={rows}
      active={active}
      placeholder="Type an action…"
      emptyText="No matching actions."
      onSubmit={(ids) => {
        const action = actions.find((a) => a.id === ids[0]);
        if (action) onAction(action.effect);
      }}
    />
  );
}
