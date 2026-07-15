import { acceptWord, completions, ghostSuffix } from "../../src/interaction/completion.js";
import { builtinCommands } from "../../src/interaction/slash-commands.js";

describe("ghostSuffix", () => {
  const history = ["create filesystem tool", "create tests", "fix docker"];

  it("suggests the newest matching continuation", () => {
    expect(ghostSuffix("create", history)).toBe(" tests");
    expect(ghostSuffix("create f", history)).toBe("ilesystem tool");
    expect(ghostSuffix("zzz", history)).toBe("");
    expect(ghostSuffix("", history)).toBe("");
  });

  it("never suggests the input itself", () => {
    expect(ghostSuffix("fix docker", history)).toBe("");
  });
});

describe("acceptWord", () => {
  it("accepts one word including leading whitespace", () => {
    expect(acceptWord(" filesystem tool")).toEqual({ accepted: " filesystem", rest: " tool" });
    expect(acceptWord("tool")).toEqual({ accepted: "tool", rest: "" });
  });
});

describe("completions", () => {
  const registry = builtinCommands();

  it("offers slash commands for a / prefix", () => {
    const items = completions("/mo", registry);
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(["/model", "/models"]));
    expect(items[0].insert.startsWith("/")).toBe(true);
  });

  it("offers nothing for plain text or after a space", () => {
    expect(completions("model", registry)).toEqual([]);
    expect(completions("/model qwen", registry)).toEqual([]);
  });
});
