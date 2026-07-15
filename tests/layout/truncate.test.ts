import { elidePath, tail, truncate, truncateStart, wrapText } from "../../src/layout/truncate.js";

describe("truncate", () => {
  it("passes short text through", () => {
    expect(truncate("abc", 5)).toBe("abc");
  });
  it("cuts with an ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abcdef", 1)).toBe("…");
    expect(truncate("abcdef", 0)).toBe("");
  });
});

describe("truncateStart", () => {
  it("keeps the tail", () => {
    expect(truncateStart("abcdef", 4)).toBe("…def");
  });
});

describe("elidePath", () => {
  it("keeps whole paths that fit", () => {
    expect(elidePath("src/tools/fs.ts", 20)).toBe("src/tools/fs.ts");
  });
  it("elides the middle preserving head and tail", () => {
    expect(elidePath("src/very/deep/nested/tools/fs.ts", 20)).toBe("src/…/tools/fs.ts");
  });
  it("falls back to tail truncation for hopeless widths", () => {
    expect(elidePath("src/deep/averylongfilename.ts", 8)).toBe("…name.ts");
  });
});

describe("tail", () => {
  it("returns the last N items", () => {
    expect(tail([1, 2, 3, 4], 2)).toEqual([3, 4]);
    expect(tail([1, 2], 5)).toEqual([1, 2]);
    expect(tail([1, 2], 0)).toEqual([]);
  });
});

describe("wrapText", () => {
  it("hard-wraps long lines and preserves newlines", () => {
    expect(wrapText("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
    expect(wrapText("ab\ncd", 10)).toEqual(["ab", "cd"]);
    expect(wrapText("x", 0)).toEqual([]);
  });
});
