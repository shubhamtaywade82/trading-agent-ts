/**
 * Universal picker model: one filter/select behavior reused by every list
 * (palette, model switcher, search). Pure logic lives here; the rendering
 * lives in src/tui/overlays/UniversalPicker.tsx.
 */

export interface PickerItem {
  id: string;
  label: string;
  detail?: string;
}

/** Case-insensitive all-terms filter over label + detail. */
export function filterPickerItems<T extends PickerItem>(items: T[], query: string): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return items;
  return items.filter((item) => {
    const haystack = `${item.label} ${item.detail ?? ""}`.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

/** Window of items to show around the highlighted index. */
export function visibleWindow<T>(items: T[], index: number, size: number): { start: number; items: T[] } {
  if (size <= 0 || items.length === 0) return { start: 0, items: [] };
  const clamped = Math.max(0, Math.min(index, items.length - 1));
  const start = Math.max(0, Math.min(clamped - size + 1, items.length - size));
  return { start, items: items.slice(start, start + size) };
}
