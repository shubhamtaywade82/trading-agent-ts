import * as fs from "node:fs";
import * as path from "node:path";
import { AslSemanticPlugin } from "../../src/intelligence/asl-plugin.js";

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));

describe("AslSemanticPlugin", () => {
  const tempWorkspace = path.join(__dirname, "../fixtures/asl-semantic-temp");
  const devagentTasksDir = path.join(tempWorkspace, ".devagent/tasks");

  beforeEach(() => {
    fs.mkdirSync(devagentTasksDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempWorkspace, { recursive: true, force: true });
  });

  it("should discover and query target entities in ASL tasks", async () => {
    // 1. Create a task with a target entity
    fs.writeFileSync(
      path.join(devagentTasksDir, "TASK-001.md"),
      `---
id: task.auth
title: Implement authentication
kind: implementation
status: pending
goal: add token auth
targets:
  - entity: TokenAuthService
---
`,
      "utf8"
    );

    const plugin = new AslSemanticPlugin(tempWorkspace);
    expect(plugin.detect()).toBe(true);

    const entities = await plugin.discover();
    expect(entities).toHaveLength(1);
    expect(entities[0].name).toBe("TokenAuthService");
    expect(entities[0].type).toBe("AslTaskTarget");

    // Test semantic query
    const results = await plugin.query({ kind: "symbol", term: "TokenAuth" });
    expect(results).toHaveLength(1);
    expect(results[0].entity.name).toBe("TokenAuthService");
    expect(results[0].score).toBe(0.8);
  });
});
