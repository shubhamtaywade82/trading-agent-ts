import * as fs from "node:fs";
import * as path from "node:path";
import { validateAsl, generateAslGraph } from "../../src/asl/commands.js";

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));

describe("ASL Commands", () => {
  const tempWorkspace = path.join(__dirname, "../fixtures/asl-workspace-temp");
  const devagentDir = path.join(tempWorkspace, ".devagent");

  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    fs.mkdirSync(devagentDir, { recursive: true });
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tempWorkspace, { recursive: true, force: true });
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("should return false when .devagent directory does not exist", async () => {
    const nonExistentPath = path.join(__dirname, "non-existent-folder");
    const ok = await validateAsl(nonExistentPath);
    expect(ok).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("directory does not exist"));
  });

  it("should validate a valid ASL setup correctly", async () => {
    // 1. Setup workspace spec
    fs.mkdirSync(path.join(devagentDir, "workspace"), { recursive: true });
    fs.writeFileSync(
      path.join(devagentDir, "workspace/workspace.md"),
      `---
language: typescript
frameworks:
  - nextjs
---
# Workspace info
`,
      "utf8"
    );

    // 2. Setup task specs
    fs.mkdirSync(path.join(devagentDir, "tasks"), { recursive: true });
    fs.writeFileSync(
      path.join(devagentDir, "tasks/TASK-001.md"),
      `---
id: task.001
title: Setup project
kind: implementation
status: completed
goal: initial scaffold
---
`,
      "utf8"
    );

    fs.writeFileSync(
      path.join(devagentDir, "tasks/TASK-002.md"),
      `---
id: task.002
title: Implement feature
kind: implementation
status: pending
goal: add feature
depends_on:
  - task.001
---
`,
      "utf8"
    );

    const ok = await validateAsl(tempWorkspace);
    expect(ok).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("should detect unknown dependencies", async () => {
    fs.mkdirSync(path.join(devagentDir, "tasks"), { recursive: true });
    fs.writeFileSync(
      path.join(devagentDir, "tasks/TASK-001.md"),
      `---
id: task.001
title: Setup project
kind: implementation
status: completed
goal: initial scaffold
depends_on:
  - task.999
---
`,
      "utf8"
    );

    const ok = await validateAsl(tempWorkspace);
    expect(ok).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("depends on unknown task 'task.999'"));
  });

  it("should detect dependency cycles", async () => {
    fs.mkdirSync(path.join(devagentDir, "tasks"), { recursive: true });
    fs.writeFileSync(
      path.join(devagentDir, "tasks/TASK-001.md"),
      `---
id: task.001
title: Setup project
kind: implementation
status: completed
goal: initial scaffold
depends_on:
  - task.002
---
`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(devagentDir, "tasks/TASK-002.md"),
      `---
id: task.002
title: Implement feature
kind: implementation
status: pending
goal: add feature
depends_on:
  - task.001
---
`,
      "utf8"
    );

    const ok = await validateAsl(tempWorkspace);
    expect(ok).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Dependency cycle detected"));
  });

  it("should print a DAG graph of task execution correctly", async () => {
    fs.mkdirSync(path.join(devagentDir, "tasks"), { recursive: true });
    fs.writeFileSync(
      path.join(devagentDir, "tasks/TASK-001.md"),
      `---
id: task.001
title: Setup project
kind: implementation
status: completed
goal: initial scaffold
---
`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(devagentDir, "tasks/TASK-002.md"),
      `---
id: task.002
title: Implement feature
kind: implementation
status: pending
goal: add feature
depends_on:
  - task.001
---
`,
      "utf8"
    );

    await generateAslGraph(tempWorkspace);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("ASL Task Execution DAG"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("task.001"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("task.002"));
  });
});
