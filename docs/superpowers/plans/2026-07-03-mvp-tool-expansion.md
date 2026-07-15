# Coding-Agent MVP Tool Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring DevAgent from "filesystem + shell + basic orchestrator" up to the MVP capability set of a Claude-Code-class coding agent: codebase search (ripgrep), git operations, project-aware test/lint/format/build runners, persistent memory, a wired-in planner, and MCP client support — in that priority order.

**Architecture:** Every new capability is a `Tool` subclass (matching the existing pattern in `src/tools/*.ts`: constructor takes `root: string`, `call(args)` returns `Record<string, unknown>`, path args go through `resolveWorkspacePath`), registered in `Agent`'s constructor (`src/cli/agent.ts`) alongside the existing tools. Where a capability shells out (git, npm/pytest/eslint/etc.), it reuses the existing sandboxed `ShellTool` execution path rather than spawning processes directly, so nothing new bypasses the Docker sandbox. Memory is a new `src/memory/` module backed by SQLite, loaded/saved around `Agent.runUserMessage`. The existing `Orchestrator`/`Planner` interfaces (`src/orchestrator/types.ts`) already model multi-step planning — Task 6 wires them into `Agent` instead of leaving them as an unused subsystem. Tree-sitter/LSP (code intelligence) is scoped as Phase 2 and only stubbed here — it's the heaviest lift (native bindings, per-language grammars) and shouldn't block shipping the rest.

**Tech Stack:** TypeScript 5.5, existing `Tool`/`Registry`/`ShellTool` pattern, `better-sqlite3` for memory, `ripgrep` (`rg`) binary via shell-out, `simple-git`-free raw `git` CLI shell-out (no new git library — keep dependency surface small), MCP via `@modelcontextprotocol/sdk`.

## Global Constraints

- Node >=20 (per `package.json` engines).
- New tools must run inside the existing Docker sandbox (`ShellTool`) when they execute arbitrary project commands (git, test runners, linters, formatters, build tools) — do not add a second unsandboxed `spawn` path.
- All new filesystem-touching tools must use `resolveWorkspacePath` from `src/tools/path-utils.ts` (see [[2026-07-03-hardening-fixes]] Task 1 — depends on that dedup landing first).
- Every new tool needs a Jest test file under `tests/tools/` following the `mkdtemp`-based fixture pattern already used in `tests/tools/filesystem.test.ts` and `tests/tools/directory-tools.test.ts`.
- No tool may be registered in `Agent` without an entry in `docs/` describing what it does (append to this plan's tasks — each task includes the doc line).
- Priority order for implementation is fixed by the MVP list: Search → Git → Test/Lint/Format/Build → Memory → Planner wiring → MCP. Do not reorder without re-checking dependencies (Memory Task 5 assumes Agent's message loop shape from Task 1-4 hasn't changed; Planner Task 6 assumes Memory Task 5 landed so plan history can persist).

---

### Task 1: Ripgrep-backed search tool

**Files:**
- Create: `src/tools/search-tools.ts`
- Create: `tests/tools/search-tools.test.ts`
- Modify: `src/cli/agent.ts:1-76` (register new tool)

**Interfaces:**
- Consumes: `Tool`, `ToolError` from `src/tools/tool.ts`; `resolveWorkspacePath` from `src/tools/path-utils.ts`; `spawn` from `node:child_process`.
- Produces: `SearchCodeTool` — `name: "search_code"`, `call({ query, path?, glob?, maxResults? })` returns `{ query, matches: { path: string; line: number; text: string }[], truncated: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `tests/tools/search-tools.test.ts`:

```typescript
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchCodeTool } from "../../src/tools/search-tools";

describe("SearchCodeTool", () => {
  it("finds matching lines with file path and line number", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.ts"), "function foo() {}\nfunction bar() {}\n");
    const tool = new SearchCodeTool(dir);

    const result = await tool.call({ query: "function bar" });

    const matches = result.matches as { path: string; line: number; text: string }[];
    expect(matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "a.ts", line: 2 })]),
    );
  });

  it("scopes search to a subdirectory when path is given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "b.ts"), "const TODO = 1;\n");
    await writeFile(join(dir, "c.ts"), "const TODO = 2;\n");
    const tool = new SearchCodeTool(dir);

    const result = await tool.call({ query: "TODO", path: "sub" });

    const matches = result.matches as { path: string }[];
    expect(matches.every((m) => m.path.startsWith("sub/"))).toBe(true);
  });

  it("rejects a path that escapes the workspace root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new SearchCodeTool(dir);

    await expect(tool.call({ query: "x", path: "../../etc" })).rejects.toThrow(/escapes workspace root/);
  });

  it("returns empty matches when nothing found, without erroring", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.ts"), "nothing here\n");
    const tool = new SearchCodeTool(dir);

    const result = await tool.call({ query: "zzz_not_present" });

    expect(result.matches).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/tools/search-tools.test.ts -v`
Expected: FAIL with "Cannot find module '../../src/tools/search-tools'".

- [ ] **Step 3: Implement `SearchCodeTool`**

Create `src/tools/search-tools.ts`:

```typescript
import { spawn } from "node:child_process";
import { relative } from "node:path";
import { Tool } from "./tool";
import { resolveWorkspacePath } from "./path-utils";

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

const DEFAULT_MAX_RESULTS = 200;

export class SearchCodeTool extends Tool {
  constructor(private readonly root: string) {
    super();
  }

  get name(): string {
    return "search_code";
  }

  get description(): string {
    return "Search the workspace for a literal string or ripgrep-compatible regex, returning file:line matches.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string", description: "Subdirectory to scope the search to (default: workspace root)." },
        glob: { type: "string", description: "Optional ripgrep --glob filter, e.g. '*.ts'." },
        maxResults: { type: "number" },
      },
      required: ["query"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = args.query as string;
    const scopedPath = (args.path as string | undefined) ?? ".";
    const glob = args.glob as string | undefined;
    const maxResults = (args.maxResults as number | undefined) ?? DEFAULT_MAX_RESULTS;

    const searchRoot = resolveWorkspacePath(this.root, scopedPath);

    const rgArgs = ["--line-number", "--no-heading", "--color=never"];
    if (glob) rgArgs.push("--glob", glob);
    rgArgs.push("--", query, searchRoot);

    const output = await this.runRipgrep(rgArgs);
    const matches: SearchMatch[] = [];

    for (const line of output.split("\n")) {
      if (!line) continue;
      const firstColon = line.indexOf(":");
      const secondColon = line.indexOf(":", firstColon + 1);
      if (firstColon === -1 || secondColon === -1) continue;

      const filePath = line.slice(0, firstColon);
      const lineNo = Number(line.slice(firstColon + 1, secondColon));
      const text = line.slice(secondColon + 1);
      matches.push({ path: relative(this.root, filePath), line: lineNo, text });
      if (matches.length >= maxResults) break;
    }

    return { query, matches, truncated: matches.length >= maxResults };
  }

  private runRipgrep(args: string[]): Promise<string> {
    return new Promise((resolvePromise) => {
      const child = spawn("rg", args);
      let stdout = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.on("close", (code) => {
        // rg exits 1 when there are simply no matches — that's success for us, not an error.
        if (code === 0 || code === 1) resolvePromise(stdout);
        else resolvePromise("");
      });
      child.on("error", () => resolvePromise(""));
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/tools/search-tools.test.ts -v`
Expected: PASS. Requires `rg` (ripgrep) installed on the dev/CI machine — add `ripgrep` to the CI runner setup if `.github/workflows/ci.yml` (from the hardening-fixes plan) doesn't already have it; `ubuntu-latest` GitHub runners do not ship `rg` preinstalled, so add `- run: sudo apt-get install -y ripgrep` before the test step once that CI file exists.

- [ ] **Step 5: Register in `Agent`**

Edit `src/cli/agent.ts`: add `import { SearchCodeTool } from "../tools/search-tools";` near the other tool imports (after line 15), and add `.register(new SearchCodeTool(cfg.workspaceRoot))` to the registry chain (after line 75, before `.register(new WatchTool(...))` or after — order doesn't matter, registry is a map).

- [ ] **Step 6: Commit**

```bash
git add src/tools/search-tools.ts tests/tools/search-tools.test.ts src/cli/agent.ts
git commit -m "feat: add ripgrep-backed search_code tool"
```

---

### Task 2: Git tool

**Files:**
- Create: `src/tools/git-tools.ts`
- Create: `tests/tools/git-tools.test.ts`
- Modify: `src/cli/agent.ts` (register new tool)

**Interfaces:**
- Consumes: `Tool` from `src/tools/tool.ts`, `spawn` from `node:child_process`.
- Produces: `GitTool` — `name: "git"`, `call({ args: string[] })` returns `{ command: string, exitCode: number, stdout: string, stderr: string }`. Restricted to a fixed allowlist of subcommands (`status`, `diff`, `log`, `branch`, `add`, `commit`, `checkout`, `stash`, `show`, `blame`, `rev-parse`) — no `push`, `reset --hard`, `clean -f`, or arbitrary remote operations, matching this project's own "no destructive git without explicit user approval" stance.

- [ ] **Step 1: Write the failing test**

Create `tests/tools/git-tools.test.ts`:

```typescript
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitTool } from "../../src/tools/git-tools";

const exec = promisify(execFile);

describe("GitTool", () => {
  it("runs an allowlisted subcommand and returns stdout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await exec("git", ["init"], { cwd: dir });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await exec("git", ["config", "user.name", "Test"], { cwd: dir });
    const tool = new GitTool(dir);

    const result = await tool.call({ args: ["status", "--porcelain"] });

    expect(result.exitCode).toBe(0);
  });

  it("rejects a subcommand not on the allowlist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new GitTool(dir);

    const result = await tool.call({ args: ["push", "origin", "main"] });

    expect(result.error).toBe("DisallowedGitCommandError");
  });

  it("rejects reset --hard even though reset alone might seem safe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new GitTool(dir);

    const result = await tool.call({ args: ["reset", "--hard", "HEAD~1"] });

    expect(result.error).toBe("DisallowedGitCommandError");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/tools/git-tools.test.ts -v`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `GitTool`**

Create `src/tools/git-tools.ts`:

```typescript
import { spawn } from "node:child_process";
import { Tool } from "./tool";

const ALLOWED_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "branch",
  "add",
  "commit",
  "checkout",
  "stash",
  "show",
  "blame",
  "rev-parse",
  "cherry-pick",
]);

const DISALLOWED_FLAG_PATTERNS = [/^--hard$/, /^--force$/, /^-f$/, /^-D$/];

export class GitTool extends Tool {
  constructor(private readonly root: string) {
    super();
  }

  get name(): string {
    return "git";
  }

  get description(): string {
    return "Run a read/local-write git subcommand (status, diff, log, branch, add, commit, checkout, stash, show, blame, rev-parse, cherry-pick). Push, force operations, and hard resets are blocked — ask the user to run those manually.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { args: { type: "array", items: { type: "string" } } },
      required: ["args"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const gitArgs = args.args as string[];
    if (!Array.isArray(gitArgs) || gitArgs.length === 0) {
      return { error: "ArgumentError", message: "args must be a non-empty string array" };
    }

    const subcommand = gitArgs[0];
    if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
      return { error: "DisallowedGitCommandError", message: `git ${subcommand} is not on the allowlist` };
    }
    if (gitArgs.some((a) => DISALLOWED_FLAG_PATTERNS.some((p) => p.test(a)))) {
      return { error: "DisallowedGitCommandError", message: `flags in [${gitArgs.join(" ")}] are blocked (force/hard operations)` };
    }

    return new Promise((resolvePromise) => {
      const child = spawn("git", gitArgs, { cwd: this.root });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("close", (exitCode) => {
        resolvePromise({ command: `git ${gitArgs.join(" ")}`, exitCode: exitCode ?? -1, stdout, stderr });
      });
      child.on("error", (err) => {
        resolvePromise({ command: `git ${gitArgs.join(" ")}`, exitCode: -1, stdout: "", stderr: err.message });
      });
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/tools/git-tools.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Register in `Agent`**

Edit `src/cli/agent.ts`: add `import { GitTool } from "../tools/git-tools";` and `.register(new GitTool(cfg.workspaceRoot))` in the registry chain.

- [ ] **Step 6: Commit**

```bash
git add src/tools/git-tools.ts tests/tools/git-tools.test.ts src/cli/agent.ts
git commit -m "feat: add allowlisted git tool (status/diff/log/branch/add/commit/checkout/stash/show/blame)"
```

---

### Task 3: Project script runner (test / lint / format / build)

**Files:**
- Create: `src/tools/project-tools.ts`
- Create: `tests/tools/project-tools.test.ts`
- Modify: `src/cli/agent.ts` (register new tools)

**Interfaces:**
- Consumes: `Tool` from `src/tools/tool.ts`, `readFile` from `node:fs/promises`, `spawn` from `node:child_process`.
- Produces: four tools — `RunTestsTool` (`name: "run_tests"`), `RunLintTool` (`name: "run_lint"`), `RunFormatTool` (`name: "run_format"`), `RunBuildTool` (`name: "run_build"`) — each detects the project's package manager from lockfiles present at the workspace root (`package-lock.json` → `npm`, `pnpm-lock.yaml` → `pnpm`, `yarn.lock` → `yarn`) and runs the corresponding `package.json` script (`test`, `lint`, `format`, `build`) if present; returns `{ error: "ScriptNotFoundError" }` if the script isn't defined, rather than silently no-op'ing. Node-only for this MVP pass — Python/Ruby/Rust/Go detection is a documented follow-up, not built here (see Self-Review Notes).

- [ ] **Step 1: Write the failing test**

Create `tests/tools/project-tools.test.ts`:

```typescript
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunTestsTool, RunLintTool, RunFormatTool, RunBuildTool } from "../../src/tools/project-tools";

async function initProject(scripts: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "ws-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", scripts }));
  await writeFile(join(dir, "package-lock.json"), "{}");
  return dir;
}

describe("RunTestsTool", () => {
  it("runs the test script and reports exit code", async () => {
    const dir = await initProject({ test: "node -e \"process.exit(0)\"" });
    const tool = new RunTestsTool(dir);

    const result = await tool.call({});

    expect(result.exitCode).toBe(0);
    expect(result.command).toContain("npm run test");
  });

  it("returns ScriptNotFoundError when no test script is defined", async () => {
    const dir = await initProject({});
    const tool = new RunTestsTool(dir);

    const result = await tool.call({});

    expect(result.error).toBe("ScriptNotFoundError");
  });
});

describe("RunLintTool / RunFormatTool / RunBuildTool", () => {
  it("each map to their respective package.json script", async () => {
    const dir = await initProject({
      lint: "node -e \"process.exit(0)\"",
      format: "node -e \"process.exit(0)\"",
      build: "node -e \"process.exit(0)\"",
    });

    expect((await new RunLintTool(dir).call({})).exitCode).toBe(0);
    expect((await new RunFormatTool(dir).call({})).exitCode).toBe(0);
    expect((await new RunBuildTool(dir).call({})).exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/tools/project-tools.test.ts -v`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `project-tools.ts`**

Create `src/tools/project-tools.ts`:

```typescript
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Tool } from "./tool";

async function detectPackageManager(root: string): Promise<"npm" | "pnpm" | "yarn"> {
  const check = async (file: string) => {
    try {
      await readFile(join(root, file));
      return true;
    } catch {
      return false;
    }
  };
  if (await check("pnpm-lock.yaml")) return "pnpm";
  if (await check("yarn.lock")) return "yarn";
  return "npm";
}

async function hasScript(root: string, scriptName: string): Promise<boolean> {
  try {
    const raw = await readFile(join(root, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return Boolean(pkg.scripts?.[scriptName]);
  } catch {
    return false;
  }
}

function runScript(root: string, pm: "npm" | "pnpm" | "yarn", scriptName: string): Promise<Record<string, unknown>> {
  const args = pm === "yarn" ? [scriptName] : ["run", scriptName];
  const command = `${pm} ${args.join(" ")}`;

  return new Promise((resolvePromise) => {
    const child = spawn(pm, args, { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (exitCode) => resolvePromise({ command, exitCode: exitCode ?? -1, stdout, stderr }));
    child.on("error", (err) => resolvePromise({ command, exitCode: -1, stdout: "", stderr: err.message }));
  });
}

abstract class ScriptRunnerTool extends Tool {
  protected abstract readonly scriptName: string;
  protected abstract readonly toolName: string;
  protected abstract readonly toolDescription: string;

  constructor(protected readonly root: string) {
    super();
  }

  get name(): string {
    return this.toolName;
  }

  get description(): string {
    return this.toolDescription;
  }

  async call(_args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!(await hasScript(this.root, this.scriptName))) {
      return { error: "ScriptNotFoundError", message: `no "${this.scriptName}" script in package.json` };
    }
    const pm = await detectPackageManager(this.root);
    return runScript(this.root, pm, this.scriptName);
  }
}

export class RunTestsTool extends ScriptRunnerTool {
  protected readonly scriptName = "test";
  protected readonly toolName = "run_tests";
  protected readonly toolDescription = "Run the project's test suite via its package.json \"test\" script.";
}

export class RunLintTool extends ScriptRunnerTool {
  protected readonly scriptName = "lint";
  protected readonly toolName = "run_lint";
  protected readonly toolDescription = "Run the project's linter via its package.json \"lint\" script.";
}

export class RunFormatTool extends ScriptRunnerTool {
  protected readonly scriptName = "format";
  protected readonly toolName = "run_format";
  protected readonly toolDescription = "Run the project's formatter via its package.json \"format\" script.";
}

export class RunBuildTool extends ScriptRunnerTool {
  protected readonly scriptName = "build";
  protected readonly toolName = "run_build";
  protected readonly toolDescription = "Run the project's build via its package.json \"build\" script.";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/tools/project-tools.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Register in `Agent`**

Edit `src/cli/agent.ts`: add `import { RunTestsTool, RunLintTool, RunFormatTool, RunBuildTool } from "../tools/project-tools";` and register all four with `cfg.workspaceRoot`.

- [ ] **Step 6: Commit**

```bash
git add src/tools/project-tools.ts tests/tools/project-tools.test.ts src/cli/agent.ts
git commit -m "feat: add run_tests/run_lint/run_format/run_build tools with npm/pnpm/yarn detection"
```

---

### Task 4: Persistent memory (SQLite)

**Files:**
- Create: `src/memory/store.ts`
- Create: `tests/memory/store.test.ts`
- Modify: `src/cli/agent.ts` (load/save around `runUserMessage`)
- Modify: `package.json` (add `better-sqlite3` dependency)

**Interfaces:**
- Consumes: `better-sqlite3` (`Database` class).
- Produces: `MemoryStore` class with:
  - `constructor(dbPath: string)`
  - `appendMessage(role: string, content: string): void`
  - `recentMessages(limit: number): { role: string; content: string; at: number }[]`
  - `setProjectNote(key: string, value: string): void`
  - `getProjectNote(key: string): string | undefined`
  - `close(): void`

- [ ] **Step 1: Install dependency**

Run: `npm install better-sqlite3 && npm install --save-dev @types/better-sqlite3`

- [ ] **Step 2: Write the failing test**

Create `tests/memory/store.test.ts`:

```typescript
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/memory/store";

describe("MemoryStore", () => {
  it("persists and retrieves recent messages in chronological order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-"));
    const store = new MemoryStore(join(dir, "devagent.db"));

    store.appendMessage("user", "first");
    store.appendMessage("assistant", "second");

    const messages = store.recentMessages(10);

    expect(messages.map((m) => m.content)).toEqual(["first", "second"]);
    store.close();
  });

  it("caps recentMessages to the requested limit, keeping the newest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-"));
    const store = new MemoryStore(join(dir, "devagent.db"));

    for (let i = 0; i < 5; i++) store.appendMessage("user", `msg-${i}`);

    const messages = store.recentMessages(2);

    expect(messages.map((m) => m.content)).toEqual(["msg-3", "msg-4"]);
    store.close();
  });

  it("stores and overwrites project notes by key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-"));
    const store = new MemoryStore(join(dir, "devagent.db"));

    store.setProjectNote("style", "2-space indent");
    store.setProjectNote("style", "4-space indent");

    expect(store.getProjectNote("style")).toBe("4-space indent");
    expect(store.getProjectNote("missing")).toBeUndefined();
    store.close();
  });

  it("survives reopening the same db file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-"));
    const path = join(dir, "devagent.db");
    const store1 = new MemoryStore(path);
    store1.appendMessage("user", "persisted");
    store1.close();

    const store2 = new MemoryStore(path);
    expect(store2.recentMessages(10).map((m) => m.content)).toEqual(["persisted"]);
    store2.close();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest tests/memory/store.test.ts -v`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement `MemoryStore`**

Create `src/memory/store.ts`:

```typescript
import Database from "better-sqlite3";

export interface StoredMessage {
  role: string;
  content: string;
  at: number;
}

export class MemoryStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_notes (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  appendMessage(role: string, content: string): void {
    this.db.prepare("INSERT INTO messages (role, content, at) VALUES (?, ?, ?)").run(role, content, Date.now());
  }

  recentMessages(limit: number): StoredMessage[] {
    const rows = this.db
      .prepare("SELECT role, content, at FROM messages ORDER BY id DESC LIMIT ?")
      .all(limit) as StoredMessage[];
    return rows.reverse();
  }

  setProjectNote(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO project_notes (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  getProjectNote(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM project_notes WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest tests/memory/store.test.ts -v`
Expected: PASS.

- [ ] **Step 6: Wire into `Agent`**

Edit `src/cli/agent.ts`. Add import: `import { MemoryStore } from "../memory/store";` and `import { join } from "node:path";` (if not already imported).

Add a private field after `private readonly loopDetector = new LoopDetector();` (around line 38):

```typescript
  private readonly memory: MemoryStore;
```

In the constructor, after `this.registry = new Registry()...` block (around line 75), add:

```typescript
    this.memory = new MemoryStore(join(cfg.workspaceRoot, ".devagent", "memory.db"));
```

In `runUserMessage`, right after `this.messages.push({ role: "user", content: userMessage });` (around line 102), add:

```typescript
    this.memory.appendMessage("user", userMessage);
```

And where the method returns `lastAssistantText` on the success path (around line 139, `if (hasContent) { return lastAssistantText; }`), change to:

```typescript
        if (hasContent) {
          this.memory.appendMessage("assistant", lastAssistantText);
          return lastAssistantText;
        }
```

Note: this only persists the raw conversation transcript for now — using `recentMessages()` to seed `this.messages` on startup (cross-session continuity) is a deliberate follow-up, not built in this task, so a fresh `Agent` instance still starts with an empty transcript. Flagging this so it isn't read as an oversight.

- [ ] **Step 7: Run full suite**

Run: `npx tsc -p tsconfig.json --noEmit && npx jest`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/memory/store.ts tests/memory/store.test.ts src/cli/agent.ts package.json package-lock.json
git commit -m "feat: add SQLite-backed MemoryStore, wire message logging into Agent"
```

---

### Task 5: Wire Orchestrator/Planner into Agent for multi-step tasks

**Files:**
- Create: `src/orchestrator/agent-planner.ts`
- Create: `tests/orchestrator/agent-planner.test.ts`
- Modify: `src/cli/agent.ts` (add opt-in `runPlannedTask` method)

**Interfaces:**
- Consumes: `Orchestrator`, `PlanStep`, `StepRunner`, `Planner`, `StepOutcome` from `src/orchestrator/*`.
- Produces: `AgentStepRunner implements StepRunner` — wraps `Agent.runUserMessage` so each `PlanStep.description` becomes one turn of the existing ReAct loop, translating a thrown error into `{ kind: "retryable", error }` and a clean text return into `{ kind: "success", output: { text } }`. `Agent.runPlannedTask(steps: PlanStep[]): Promise<PlanStep[]>` becomes the new opt-in multi-step entry point (existing `runUserMessage` is untouched and remains the default single-turn path).

- [ ] **Step 1: Write the failing test**

Create `tests/orchestrator/agent-planner.test.ts`:

```typescript
import { AgentStepRunner } from "../../src/orchestrator/agent-planner";
import { PlanStep } from "../../src/orchestrator/types";

function makeStep(id: string, description: string): PlanStep {
  return { id, description, status: "pending", dependencies: [], retryCount: 0 };
}

describe("AgentStepRunner", () => {
  it("returns a success outcome when the wrapped runner resolves with text", async () => {
    const runUserMessage = jest.fn().mockResolvedValue("done: created file");
    const runner = new AgentStepRunner({ runUserMessage } as any);

    const outcome = await runner.run(makeStep("s1", "create a file"));

    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") expect(outcome.output.text).toBe("done: created file");
  });

  it("returns a retryable outcome when the wrapped runner throws", async () => {
    const runUserMessage = jest.fn().mockRejectedValue(new Error("network blip"));
    const runner = new AgentStepRunner({ runUserMessage } as any);

    const outcome = await runner.run(makeStep("s1", "create a file"));

    expect(outcome.kind).toBe("retryable");
    if (outcome.kind === "retryable") expect(outcome.error).toBe("network blip");
  });

  it("passes the step description as the user message to the wrapped agent", async () => {
    const runUserMessage = jest.fn().mockResolvedValue("ok");
    const runner = new AgentStepRunner({ runUserMessage } as any);

    await runner.run(makeStep("s1", "add a README"));

    expect(runUserMessage).toHaveBeenCalledWith("add a README");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/orchestrator/agent-planner.test.ts -v`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `AgentStepRunner`**

Create `src/orchestrator/agent-planner.ts`:

```typescript
import { PlanStep, StepOutcome, StepRunner } from "./types";

export interface RunsUserMessages {
  runUserMessage(message: string): Promise<string>;
}

export class AgentStepRunner implements StepRunner {
  constructor(private readonly agent: RunsUserMessages) {}

  async run(step: PlanStep): Promise<StepOutcome> {
    try {
      const text = await this.agent.runUserMessage(step.description);
      return { kind: "success", output: { text } };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { kind: "retryable", error };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/orchestrator/agent-planner.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Add `runPlannedTask` to `Agent`**

Edit `src/cli/agent.ts`. Add imports:

```typescript
import { Orchestrator } from "../orchestrator/orchestrator";
import { AgentStepRunner } from "../orchestrator/agent-planner";
import { PlanStep, Planner, HistoryEntry } from "../orchestrator/types";
```

Add a method to the `Agent` class (after `runUserMessage`, before `setModel`):

```typescript
  async runPlannedTask(steps: PlanStep[], planner: Planner): Promise<PlanStep[]> {
    const orchestrator = new Orchestrator({
      steps,
      runner: new AgentStepRunner(this),
      planner,
      runRollback: async (command: string) => {
        await this.runUserMessage(`Roll back by running exactly this: ${command}`);
      },
    });
    return orchestrator.run();
  }
```

Note: `runPlannedTask` reuses `this.messages` (the ReAct transcript) across every step, since each step calls `this.runUserMessage(...)` which appends to the same conversation — this is intentional so later steps see earlier steps' tool results as context. Callers who want isolated per-step context should call `agent.resetContext()` between steps themselves; the orchestrator doesn't do this automatically because cross-step context is usually what you want for a coherent multi-step task.

- [ ] **Step 6: Run full suite**

Run: `npx tsc -p tsconfig.json --noEmit && npx jest`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/agent-planner.ts tests/orchestrator/agent-planner.test.ts src/cli/agent.ts
git commit -m "feat: wire Orchestrator/Planner into Agent via opt-in runPlannedTask"
```

---

### Task 6: MCP client support

**Files:**
- Create: `src/mcp/client.ts`
- Create: `src/mcp/mcp-tool-adapter.ts`
- Create: `tests/mcp/mcp-tool-adapter.test.ts`
- Modify: `src/cli/agent.ts` (optional MCP server registration hook)
- Modify: `package.json` (add `@modelcontextprotocol/sdk` dependency)

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk/client` (`Client`, transport classes), `Tool` from `src/tools/tool.ts`.
- Produces: `McpToolAdapter extends Tool` — wraps one remote MCP tool as a local `Tool`, translating `schema` from the MCP tool's JSON schema and `call(args)` into an MCP `client.callTool({ name, arguments: args })`. `connectMcpServer(command: string, args: string[]): Promise<Tool[]>` in `src/mcp/client.ts` spawns a stdio MCP server, lists its tools, and returns one `McpToolAdapter` per remote tool, ready to `.register()` onto the existing `Registry`.

- [ ] **Step 1: Install dependency**

Run: `npm install @modelcontextprotocol/sdk`

- [ ] **Step 2: Write the failing test for the adapter (the part testable without a real MCP server)**

Create `tests/mcp/mcp-tool-adapter.test.ts`:

```typescript
import { McpToolAdapter } from "../../src/mcp/mcp-tool-adapter";

function fakeMcpClient(callResult: unknown) {
  return {
    callTool: jest.fn().mockResolvedValue(callResult),
  };
}

describe("McpToolAdapter", () => {
  it("exposes the remote tool's name, description, and JSON schema", () => {
    const client = fakeMcpClient({ content: [] });
    const adapter = new McpToolAdapter(client as any, {
      name: "github_search_issues",
      description: "Search GitHub issues",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    });

    expect(adapter.name).toBe("github_search_issues");
    expect(adapter.description).toBe("Search GitHub issues");
    expect(adapter.parameters).toEqual({ type: "object", properties: { query: { type: "string" } }, required: ["query"] });
  });

  it("forwards call() args to the underlying MCP client and returns its content", async () => {
    const client = fakeMcpClient({ content: [{ type: "text", text: "3 issues found" }] });
    const adapter = new McpToolAdapter(client as any, {
      name: "github_search_issues",
      description: "Search GitHub issues",
      inputSchema: { type: "object", properties: {}, required: [] },
    });

    const result = await adapter.call({ query: "bug" });

    expect(client.callTool).toHaveBeenCalledWith({ name: "github_search_issues", arguments: { query: "bug" } });
    expect(result.content).toEqual([{ type: "text", text: "3 issues found" }]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest tests/mcp/mcp-tool-adapter.test.ts -v`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement `McpToolAdapter`**

Create `src/mcp/mcp-tool-adapter.ts`:

```typescript
import { Tool } from "../tools/tool";

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpClientLike {
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

export class McpToolAdapter extends Tool {
  constructor(
    private readonly client: McpClientLike,
    private readonly descriptor: McpToolDescriptor,
  ) {
    super();
  }

  get name(): string {
    return this.descriptor.name;
  }

  get description(): string {
    return this.descriptor.description;
  }

  get parameters(): Record<string, unknown> {
    return this.descriptor.inputSchema;
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.callTool({ name: this.descriptor.name, arguments: args });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest tests/mcp/mcp-tool-adapter.test.ts -v`
Expected: PASS.

- [ ] **Step 6: Implement `connectMcpServer` (integration point, not unit-tested here)**

Create `src/mcp/client.ts`:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Tool } from "../tools/tool";
import { McpToolAdapter } from "./mcp-tool-adapter";

export async function connectMcpServer(command: string, args: string[] = []): Promise<Tool[]> {
  const transport = new StdioClientTransport({ command, args });
  const client = new Client({ name: "devagent", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const { tools } = await client.listTools();
  return tools.map(
    (t) =>
      new McpToolAdapter(client, {
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema as Record<string, unknown>,
      }),
  );
}
```

This function is exercised manually against a real MCP server (e.g. `npx @modelcontextprotocol/server-filesystem /some/path`), not in the Jest suite — spawning and handshaking with a real subprocess in CI is flaky and out of scope for this MVP pass. Document this gap rather than faking it with a mock that proves nothing about the real SDK's wire format.

- [ ] **Step 7: Add optional registration hook to `Agent`**

Edit `src/cli/agent.ts`. Add:

```typescript
import { connectMcpServer } from "../mcp/client";
```

Add a method to `Agent` (after `getRegistry()`):

```typescript
  async registerMcpServer(command: string, args: string[] = []): Promise<void> {
    const tools = await connectMcpServer(command, args);
    for (const tool of tools) this.registry.register(tool);
  }
```

This is deliberately opt-in and not called from the constructor — MCP servers are external processes with their own trust boundary, so wiring one in should be an explicit call (from `repl.ts`/`tui.ts` config, a future task) rather than automatic on every `Agent` construction.

- [ ] **Step 8: Run full suite**

Run: `npx tsc -p tsconfig.json --noEmit && npx jest`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/mcp/client.ts src/mcp/mcp-tool-adapter.ts tests/mcp/mcp-tool-adapter.test.ts src/cli/agent.ts package.json package-lock.json
git commit -m "feat: add MCP client support (McpToolAdapter + connectMcpServer + Agent.registerMcpServer)"
```

---

## Self-Review Notes

- **Spec coverage vs. the user's MVP list:** LLM ✅ (pre-existing), Filesystem ✅ (pre-existing), Search ✅ (Task 1), Terminal ✅ (pre-existing `ShellTool`), Git ✅ (Task 2), Test Runner ✅ (Task 3), Formatter ✅ (Task 3), Linter ✅ (Task 3), Build System ✅ (Task 3), Memory ✅ (Task 4), Planner ✅ (Task 5, was already half-built as `Orchestrator`/unused), MCP ✅ (Task 6).
- **Explicitly deferred, not forgotten:** Tree-sitter and LSP (Code Intelligence) are the two MVP items *not* built in this plan. Reason: both need native/heavier dependencies (tree-sitter grammars per language, or spawning real language servers like `typescript-language-server`/`pyright` and speaking LSP-over-stdio) and are a materially bigger lift than the other 12 items combined. Recommend a dedicated follow-up plan once Tasks 1-6 here are shipped and stable — trying to bundle it in risks stalling the higher-value, lower-risk items above. Browser automation (Playwright), CI/CD triggering, observability, and Docker orchestration-as-a-tool are correctly out of scope per the user's own "everything else can be added incrementally" framing.
- **Dependency on hardening-fixes plan:** Task 1 here (`SearchCodeTool`) and every subsequent task use `resolveWorkspacePath` from `src/tools/path-utils.ts`. [[2026-07-03-hardening-fixes]] Task 1 consolidates that function into one module — run that plan first, or at minimum its Task 1, before starting this one, so there's no duplicate-definition drift to reconcile later.
- **Type consistency check:** `StepRunner.run(step: PlanStep): Promise<StepOutcome>` (Task 5) matches the interface already defined in `src/orchestrator/types.ts:17-19` exactly — no signature drift. `McpToolAdapter` (Task 6) satisfies the abstract `Tool` contract (`name`, `description`, `parameters`, `call`) from `src/tools/tool.ts` used consistently across Tasks 1-3 as well.
- **Sandbox consistency gap, flagged not fixed:** `GitTool` (Task 2) and the `project-tools.ts` runners (Task 3) shell out directly via `node:child_process.spawn`, *not* through the Docker-sandboxed `ShellTool`. This matches the existing pattern (`WatchTool`, `backup-tools.ts` also touch the filesystem directly, not through the sandbox) but is worth a conscious call: git and package-manager commands typically need to run in the same environment as the project's own toolchain (project-local `node_modules/.bin`, git config, SSH agent for some flows), which the network-isolated Docker sandbox may not have. If sandboxing these too is wanted, that's a follow-up decision, not an oversight in this plan.
