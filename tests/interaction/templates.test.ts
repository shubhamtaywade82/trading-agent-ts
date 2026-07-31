import { completions } from "../../src/interaction/completion.js";
import { builtinCommands } from "../../src/interaction/slash-commands.js";
import { templateCompletions } from "../../src/interaction/templates.js";

describe("templateCompletions", () => {
  it("offers all templates for a bare @", () => {
    const labels = templateCompletions("@").map((t) => t.label);
    expect(labels).toStrictEqual(["@review", "@tests", "@refactor", "@docs", "@security"]);
  });

  it("filters by prefix", () => {
    const items = templateCompletions("@re");
    expect(items.map((t) => t.label)).toStrictEqual(["@review", "@refactor"]);
    expect(items[0].insert).toContain("Review");
  });

  it("offers nothing after a space or without @", () => {
    expect(templateCompletions("@review the code")).toStrictEqual([]);
    expect(templateCompletions("review")).toStrictEqual([]);
  });
});

describe("completions with templates", () => {
  it("routes @ input to templates and / input to commands", () => {
    const registry = builtinCommands();
    expect(completions("@te", registry).map((i) => i.label)).toStrictEqual(["@tests"]);
    expect(completions("/he", registry).map((i) => i.label)).toStrictEqual(["/help"]);
  });
});
