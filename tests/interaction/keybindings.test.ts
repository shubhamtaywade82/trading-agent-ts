import { KeyContext, resolveKey } from "../../src/interaction/keybindings.js";

const base: KeyContext = { overlay: null, promptHasText: false, mode: "idle" };

describe("resolveKey", () => {
  it("digits 1-9 focus views when the prompt is empty", () => {
    expect(resolveKey("1", {}, base)).toEqual({ type: "focus-view", view: "conversation" });
    expect(resolveKey("2", {}, base)).toEqual({ type: "focus-view", view: "execution" });
    expect(resolveKey("8", {}, base)).toEqual({ type: "focus-view", view: "mcp" });
    expect(resolveKey("9", {}, base)).toEqual({ type: "focus-view", view: "lsp" });
  });

  it("digits type into a non-empty prompt instead", () => {
    expect(resolveKey("1", {}, { ...base, promptHasText: true })).toBeNull();
  });

  it("Tab cycles views only when the prompt is empty", () => {
    expect(resolveKey("", { tab: true }, base)).toEqual({ type: "next-view" });
    expect(resolveKey("", { tab: true, shift: true }, base)).toEqual({ type: "prev-view" });
    expect(resolveKey("", { tab: true }, { ...base, promptHasText: true })).toBeNull();
  });

  it("Ctrl+P and Ctrl+B open overlays even while typing", () => {
    expect(resolveKey("p", { ctrl: true }, { ...base, promptHasText: true })).toEqual({
      type: "open-overlay",
      overlay: "palette",
    });
    expect(resolveKey("b", { ctrl: true }, base)).toEqual({ type: "open-overlay", overlay: "actors" });
  });

  it("Ctrl+M opens the model switcher, Ctrl+F opens search", () => {
    expect(resolveKey("m", { ctrl: true }, base)).toEqual({ type: "open-overlay", overlay: "model" });
    expect(resolveKey("f", { ctrl: true }, { ...base, promptHasText: true })).toEqual({
      type: "open-overlay",
      overlay: "search",
    });
  });

  it("Esc closes an open overlay, otherwise cancels", () => {
    expect(resolveKey("", { escape: true }, { ...base, overlay: "help" })).toEqual({ type: "close-overlay" });
    expect(resolveKey("", { escape: true }, base)).toEqual({ type: "cancel" });
  });

  it("z zooms, ? opens help, q quits — prompt empty only", () => {
    expect(resolveKey("z", {}, base)).toEqual({ type: "toggle-zoom" });
    expect(resolveKey("?", {}, base)).toEqual({ type: "open-overlay", overlay: "help" });
    expect(resolveKey("q", {}, base)).toEqual({ type: "quit" });
    expect(resolveKey("q", {}, { ...base, promptHasText: true })).toBeNull();
  });

  it("keys stay with the overlay while one is open", () => {
    expect(resolveKey("q", {}, { ...base, overlay: "palette" })).toBeNull();
    expect(resolveKey("1", {}, { ...base, overlay: "palette" })).toBeNull();
  });

  it("approval mode maps Enter/a/n/d", () => {
    const ctx: KeyContext = { ...base, mode: "approval" };
    expect(resolveKey("", { return: true }, ctx)).toEqual({ type: "approve" });
    expect(resolveKey("a", {}, ctx)).toEqual({ type: "approve" });
    expect(resolveKey("n", {}, ctx)).toEqual({ type: "reject" });
    expect(resolveKey("d", {}, ctx)).toEqual({ type: "view-diff" });
  });
});
