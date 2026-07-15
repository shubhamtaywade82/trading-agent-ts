import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkspace } from "../../../src/intelligence/rails/workspace-discovery.js";

async function makeRailsApp(overrides?: { application?: string; lockfile?: string }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsi-app-"));
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "Gemfile"), 'source "https://rubygems.org"\ngem "rails", "~> 7.1.0"\nruby "3.3.0"\n');
  await writeFile(
    join(root, "Gemfile.lock"),
    overrides?.lockfile ??
      ["GEM", "  remote: https://rubygems.org/", "  specs:", "    rails (7.1.3)", "", "BUNDLED WITH", "   2.5.6", ""].join("\n"),
  );
  await writeFile(
    join(root, "config", "application.rb"),
    overrides?.application ??
      ["module Demo", "  class Application < Rails::Application", "    config.load_defaults 7.1", "  end", "end"].join("\n"),
  );
  return root;
}

describe("discoverWorkspace", () => {
  it("detects a Rails workspace with versions", async () => {
    const root = await makeRailsApp();
    await mkdir(join(root, "spec"), { recursive: true });

    const info = discoverWorkspace(root);

    expect(info.isRails).toBe(true);
    expect(info.isRuby).toBe(true);
    expect(info.railsVersion).toBe("7.1.3");
    expect(info.rubyVersion).toBe("3.3.0");
    expect(info.bundlerVersion).toBe("2.5.6");
    expect(info.usesZeitwerk).toBe(true);
    expect(info.testFramework).toBe("rspec");
  });

  it("detects api_only mode", async () => {
    const root = await makeRailsApp({
      application: [
        "module Demo",
        "  class Application < Rails::Application",
        "    config.api_only = true",
        "  end",
        "end",
      ].join("\n"),
    });

    expect(discoverWorkspace(root).apiOnly).toBe(true);
  });

  it("classifies a plain Ruby workspace as non-Rails", async () => {
    const root = await mkdtemp(join(tmpdir(), "rsi-ruby-"));
    await writeFile(join(root, "Gemfile"), 'source "https://rubygems.org"\n');

    const info = discoverWorkspace(root);

    expect(info.isRuby).toBe(true);
    expect(info.isRails).toBe(false);
  });

  it("classifies a non-Ruby workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "rsi-none-"));

    const info = discoverWorkspace(root);

    expect(info.isRuby).toBe(false);
    expect(info.isRails).toBe(false);
  });

  it("detects engines", async () => {
    const root = await makeRailsApp();
    await mkdir(join(root, "engines", "billing", "lib"), { recursive: true });

    const info = discoverWorkspace(root);

    expect(info.engines).toEqual([{ name: "billing", path: "engines/billing" }]);
  });
});
