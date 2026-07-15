import { GemScanner } from "../../../../src/intelligence/rails/scanners/gem-scanner.js";
import { GemEntity } from "../../../../src/intelligence/rails/types.js";

const LOCKFILE = [
  "GEM",
  "  remote: https://rubygems.org/",
  "  specs:",
  "    pg (1.5.6)",
  "    rails (7.1.3)",
  "      actionpack (= 7.1.3)",
  "      activerecord (= 7.1.3)",
  "",
  "PATH",
  "  remote: engines/billing",
  "  specs:",
  "    billing (0.1.0)",
  "      rails (>= 7.0)",
  "",
  "PLATFORMS",
  "  x86_64-linux",
  "",
  "DEPENDENCIES",
  "  pg",
  "  rails (~> 7.1.0)",
  "",
  "BUNDLED WITH",
  "   2.5.6",
].join("\n");

describe("GemScanner", () => {
  it("parses gems, versions, sources, and dependencies", () => {
    const result = new GemScanner().scan([{ relPath: "Gemfile.lock", content: LOCKFILE }]);
    const gems = result.entities as GemEntity[];

    expect(gems.map((g) => g.name)).toEqual(["pg", "rails", "billing"]);
    expect(gems.find((g) => g.name === "rails")?.version).toBe("7.1.3");
    expect(gems.find((g) => g.name === "rails")?.dependencies).toEqual(["actionpack", "activerecord"]);
    expect(gems.find((g) => g.name === "billing")?.source).toBe("path");
    expect(result.intents.filter((i) => i.relationship === "depends_on_gem")).toHaveLength(3);
  });

  it("returns empty results for empty input", () => {
    expect(new GemScanner().scan([]).entities).toEqual([]);
  });
});
