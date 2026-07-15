import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { filterPickerItems, PickerItem, visibleWindow } from "../../interaction/picker.js";
import { OverlayFrame } from "./OverlayFrame.js";

export interface UniversalPickerProps {
  title: string;
  items: PickerItem[];
  width: number;
  rows: number;
  active: boolean;
  /** Multi-select: Space toggles, Enter confirms the checked set. */
  multi?: boolean;
  placeholder?: string;
  emptyText?: string;
  /** Item ids checked initially (multi) or the current value (single). */
  initialSelected?: string[];
  onSubmit(ids: string[]): void;
}

/**
 * The one searchable picker every list reuses (VS Code Quick Pick style):
 * type to filter, ↑/↓ to navigate, Enter to select. In multi mode Space
 * toggles and Enter confirms.
 */
export function UniversalPicker({
  title,
  items,
  width,
  rows,
  active,
  multi = false,
  placeholder = "",
  emptyText = "No matches.",
  initialSelected = [],
  onSubmit,
}: UniversalPickerProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(initialSelected));

  const filtered = filterPickerItems(items, query);
  const clampedIndex = Math.min(index, Math.max(0, filtered.length - 1));
  const listRows = Math.max(3, rows - 5);
  const { start, items: visible } = visibleWindow(filtered, clampedIndex, listRows);

  useInput(
    (input, key) => {
      if (key.upArrow) {
        setIndex(Math.max(0, clampedIndex - 1));
      } else if (key.downArrow) {
        setIndex(Math.min(filtered.length - 1, clampedIndex + 1));
      } else if (key.return) {
        if (multi) {
          onSubmit([...checked]);
        } else if (filtered[clampedIndex]) {
          onSubmit([filtered[clampedIndex].id]);
        }
      } else if (multi && input === " ") {
        const item = filtered[clampedIndex];
        if (item) {
          setChecked((prev) => {
            const next = new Set(prev);
            if (next.has(item.id)) next.delete(item.id);
            else next.add(item.id);
            return next;
          });
        }
      } else if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        setIndex(0);
      } else if (input && !key.ctrl && !key.meta && !key.tab && !key.escape) {
        setQuery((q) => q + input);
        setIndex(0);
      }
    },
    { isActive: active },
  );

  return (
    <OverlayFrame title={title} width={width} rows={rows}>
      <Text>
        <Text color="green">{"> "}</Text>
        {query}
        <Text inverse> </Text>
        {!query && placeholder && <Text color="gray">{placeholder}</Text>}
      </Text>
      {visible.map((item, i) => {
        const absolute = start + i;
        const highlighted = absolute === clampedIndex;
        const glyph = multi
          ? checked.has(item.id)
            ? "[x] "
            : "[ ] "
          : initialSelected.includes(item.id)
            ? "(•) "
            : "";
        return (
          <Box key={item.id}>
            <Text color={highlighted ? "blue" : undefined} inverse={highlighted} wrap="truncate">
              {glyph}
              {item.label}
            </Text>
            {item.detail ? (
              <Text color="gray" wrap="truncate">
                {"  "}
                {item.detail}
              </Text>
            ) : null}
          </Box>
        );
      })}
      {filtered.length === 0 && <Text color="gray">{emptyText}</Text>}
      <Text color="gray">{multi ? "Space Toggle  Enter Confirm" : "↑/↓ Navigate  Enter Select"}</Text>
    </OverlayFrame>
  );
}
