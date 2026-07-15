import { packTokens, renderTokenLine, TOKEN_SEPARATOR } from "../../src/layout/status-tokens.js";
import { StatusToken } from "../../src/runtime/types.js";

const tokens: StatusToken[] = [
  { text: "Now: Running tests", priority: 1 },
  { text: "Tool:pnpm test", priority: 2 },
  { text: "ETA:00:18", priority: 3 },
  { text: "Queue: read → grep → edit", priority: 4 },
  { text: "Ctrl+C Stop", priority: 5 },
];

describe("packTokens", () => {
  it("keeps every token when there is room", () => {
    expect(packTokens(tokens, 500)).toHaveLength(5);
  });

  it("drops lowest-priority tokens first as width shrinks", () => {
    const width = "Now: Running tests".length + TOKEN_SEPARATOR.length + "Tool:pnpm test".length;
    const packed = packTokens(tokens, width);
    expect(packed.map((t) => t.text)).toEqual(["Now: Running tests", "Tool:pnpm test"]);
  });

  it("preserves original ordering among survivors", () => {
    const shuffled: StatusToken[] = [
      { text: "ccc", priority: 3 },
      { text: "aaa", priority: 1 },
      { text: "bbb", priority: 2 },
    ];
    const packed = packTokens(shuffled, 500);
    expect(packed.map((t) => t.text)).toEqual(["ccc", "aaa", "bbb"]);
  });

  it("can skip a large token but keep a smaller lower-priority one", () => {
    const mixed: StatusToken[] = [
      { text: "aaaa", priority: 1 },
      { text: "b".repeat(50), priority: 2 },
      { text: "cc", priority: 3 },
    ];
    const packed = packTokens(mixed, 12);
    expect(packed.map((t) => t.text)).toEqual(["aaaa", "cc"]);
  });

  it("always shows the top token truncated when nothing fits", () => {
    const packed = packTokens(tokens, 6);
    expect(packed).toHaveLength(1);
    expect(packed[0].text).toBe("Now: …");
  });

  it("renderTokenLine joins with the separator and never overflows", () => {
    for (const width of [10, 20, 40, 80, 200]) {
      expect(renderTokenLine(tokens, width).length).toBeLessThanOrEqual(width);
    }
    expect(renderTokenLine(tokens, 200)).toBe(tokens.map((t) => t.text).join(TOKEN_SEPARATOR));
  });
});
