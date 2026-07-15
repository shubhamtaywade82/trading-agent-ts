import { cp, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/cli/agent.js";

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURE = join(__dirname, "..", "fixtures", "rails-app");

describe("Agent Rails semantic index wiring", () => {
  it("registers rails tools that self-disable in a non-Rails workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-plain-"));
    const agent = new Agent({ config: { workspaceRoot: dir, tier: "local", model: "test-model" } });

    expect(agent.railsIndex.enabled).toBe(false);

    const registry = agent.getRegistry();
    const names = registry.schemas().map((s) => s.function.name);
    expect(names).toEqual(expect.arrayContaining(["find_model", "find_route", "rails_context", "rails_index_status"]));

    const result = await registry.invoke("find_model", { name: "User" });
    expect(result).toEqual({ enabled: false, reason: "not a Rails workspace" });

    // Disabled index never writes a cache db.
    expect(existsSync(join(dir, ".devagent", "rails-index.db"))).toBe(false);
  });

  it("builds the index for a Rails workspace and answers queries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-rails-"));
    await cp(FIXTURE, dir, { recursive: true });
    const agent = new Agent({ config: { workspaceRoot: dir, tier: "local", model: "test-model" } });

    expect(agent.railsIndex.enabled).toBe(true);
    await agent.railsIndex.build();

    const result = (await agent.getRegistry().invoke("find_model", { name: "User" })) as {
      found: boolean;
      specs: string[];
    };
    expect(result.found).toBe(true);
    expect(result.specs).toContain("spec/models/user_spec.rb");

    // Build persisted the cache under .devagent/.
    expect(existsSync(join(dir, ".devagent", "rails-index.db"))).toBe(true);
  });
});
