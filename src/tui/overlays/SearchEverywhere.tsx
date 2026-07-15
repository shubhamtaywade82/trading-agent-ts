import React from "react";
import { RuntimeState, ViewId } from "../../runtime/types.js";
import { SlashCommandRegistry } from "../../interaction/slash-commands.js";
import { searchItems } from "../../interaction/search.js";
import { UniversalPicker } from "./UniversalPicker.js";

export interface SearchEverywhereProps {
  state: RuntimeState;
  registry: SlashCommandRegistry;
  width: number;
  rows: number;
  active: boolean;
  onSelect(view: ViewId): void;
}

/** Ctrl+F — one search over chat, logs, memory, tasks, tools, git, commands. */
export function SearchEverywhere({
  state,
  registry,
  width,
  rows,
  active,
  onSelect,
}: SearchEverywhereProps): JSX.Element {
  const items = searchItems(state, registry);
  return (
    <UniversalPicker
      title="Search Everywhere"
      items={items}
      width={width}
      rows={rows}
      active={active}
      placeholder="files, logs, memory, tasks, commands…"
      emptyText="Nothing matches."
      onSubmit={(ids) => {
        const item = items.find((i) => i.id === ids[0]);
        if (item) onSelect(item.view);
      }}
    />
  );
}
