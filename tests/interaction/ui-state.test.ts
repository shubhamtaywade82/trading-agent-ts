import { initialUiState, uiReduce } from "../../src/interaction/ui-state.js";

describe("uiReduce", () => {
  it("starts on the conversation view with no overlay", () => {
    expect(initialUiState()).toEqual({ activeView: "conversation", overlay: null, zoom: false });
  });

  it("cycles views forward and backward with wrap-around", () => {
    let s = initialUiState();
    s = uiReduce(s, { type: "next-view" });
    expect(s.activeView).toBe("execution");
    s = uiReduce(s, { type: "prev-view" });
    s = uiReduce(s, { type: "prev-view" });
    expect(s.activeView).toBe("timeline");
    s = uiReduce(s, { type: "next-view" });
    expect(s.activeView).toBe("conversation");
  });

  it("opens and closes overlays without touching the active view", () => {
    let s = uiReduce(initialUiState(), { type: "focus-view", view: "git" });
    s = uiReduce(s, { type: "open-overlay", overlay: "palette" });
    expect(s).toMatchObject({ activeView: "git", overlay: "palette" });
    s = uiReduce(s, { type: "close-overlay" });
    expect(s.overlay).toBeNull();
    expect(s.activeView).toBe("git");
  });

  it("toggles zoom", () => {
    let s = uiReduce(initialUiState(), { type: "toggle-zoom" });
    expect(s.zoom).toBe(true);
    s = uiReduce(s, { type: "toggle-zoom" });
    expect(s.zoom).toBe(false);
  });

  it("view-diff opens the diff overlay", () => {
    expect(uiReduce(initialUiState(), { type: "view-diff" }).overlay).toBe("diff");
  });

  it("open-overlay accepts skills and close-overlay clears it", () => {
    let s = uiReduce(initialUiState(), { type: "open-overlay", overlay: "skills" });
    expect(s.overlay).toBe("skills");
    s = uiReduce(s, { type: "close-overlay" });
    expect(s.overlay).toBeNull();
  });
});
