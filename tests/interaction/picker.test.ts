import { filterPickerItems, visibleWindow } from "../../src/interaction/picker.js";

const items = [
  { id: "1", label: "Filesystem", detail: "MCP server" },
  { id: "2", label: "Docker", detail: "MCP server" },
  { id: "3", label: "Docker Compose", detail: "tool" },
  { id: "4", label: "Git", detail: "vcs" },
];

describe("filterPickerItems", () => {
  it("returns everything for an empty query", () => {
    expect(filterPickerItems(items, "")).toHaveLength(4);
  });

  it("matches case-insensitively on label and detail", () => {
    expect(filterPickerItems(items, "docker").map((i) => i.id)).toEqual(["2", "3"]);
    expect(filterPickerItems(items, "MCP").map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("requires every term to match", () => {
    expect(filterPickerItems(items, "docker tool").map((i) => i.id)).toEqual(["3"]);
    expect(filterPickerItems(items, "docker zzz")).toEqual([]);
  });
});

describe("visibleWindow", () => {
  const list = ["a", "b", "c", "d", "e"];

  it("shows from the start when the index fits", () => {
    expect(visibleWindow(list, 0, 3)).toEqual({ start: 0, items: ["a", "b", "c"] });
    expect(visibleWindow(list, 2, 3)).toEqual({ start: 0, items: ["a", "b", "c"] });
  });

  it("scrolls to keep the highlighted item visible", () => {
    expect(visibleWindow(list, 4, 3)).toEqual({ start: 2, items: ["c", "d", "e"] });
    expect(visibleWindow(list, 3, 3)).toEqual({ start: 1, items: ["b", "c", "d"] });
  });

  it("handles empty lists and zero sizes", () => {
    expect(visibleWindow([], 0, 3)).toEqual({ start: 0, items: [] });
    expect(visibleWindow(list, 1, 0)).toEqual({ start: 0, items: [] });
  });
});
