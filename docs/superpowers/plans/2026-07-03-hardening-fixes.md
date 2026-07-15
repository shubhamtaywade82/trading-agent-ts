# DevAgent Hardening Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the production-readiness gaps found in code review — thin test coverage, no CI, duplicated path-escape logic, cloud auth failing late/ugly, no Docker preflight, and error text that can leak provider response bodies.

**Architecture:** No new subsystems. Dedupe `resolveWorkspacePath` to one module, add fail-fast validation at construction/first-use time instead of deep in request paths, add missing unit tests for previously-untested modules (`agent.ts`, `provider.ts`, `router.ts`, `edit-tools.ts`, `directory-tools.ts`, `backup-tools.ts`), and wire a GitHub Actions CI workflow that runs `tsc --noEmit`, `jest`, and lint.

**Tech Stack:** TypeScript 5.5, Jest + ts-jest, Node 20, GitHub Actions.

## Global Constraints

- Node >=20 (per `package.json` engines).
- No new runtime dependencies except `eslint`/`prettier` as devDependencies for Task 7.
- Every existing test must keep passing (`npx jest`) after each task.
- `npx tsc -p tsconfig.json --noEmit` must stay clean after each task.
- Follow existing code style: no semicolon-free style, tools extend `Tool` from `src/tools/tool.ts`, path safety always goes through `resolveWorkspacePath` from `src/tools/path-utils.ts`.

---

### Task 1: Dedupe path-escape logic

**Files:**
- Modify: `src/tools/filesystem.ts:1-15` (remove local `resolveWorkspacePath` + unused imports, import from `path-utils`)
- Test: `tests/tools/filesystem.test.ts` (already covers `PathEscapeError` — no new test needed, just must keep passing)

**Interfaces:**
- Consumes: `resolveWorkspacePath(root: string, relativePath: string): string` from `src/tools/path-utils.ts` (already exported, already throws `ToolError` subclass on escape).
- Produces: `filesystem.ts` still exports `PathEscapeError` (re-exported/aliased) so existing imports (`import { PathEscapeError } from "../tools/filesystem"`) keep working.

- [ ] **Step 1: Read current duplication**

`src/tools/filesystem.ts` currently defines its own `resolveWorkspacePath` (lines 7-15) and its own `PathEscapeError extends ToolError` (line 5), duplicating `src/tools/path-utils.ts`. The duplicate in `path-utils.ts` throws a plain `ToolError`, not `PathEscapeError`, so a straight import swap changes the thrown type. Fix `path-utils.ts` first so both files share one error type.

- [ ] **Step 2: Move `PathEscapeError` into `path-utils.ts` and throw it there**

Edit `src/tools/path-utils.ts` to:

```typescript
import { resolve, join, relative } from "node:path";
import { ToolError } from "./tool";

export class PathEscapeError extends ToolError {}

export function resolveWorkspacePath(root: string, relativePath: string): string {
  const absoluteRoot = resolve(root);
  const full = resolve(join(absoluteRoot, relativePath));
  const rel = relative(absoluteRoot, full);
  if (rel.startsWith("..")) {
    throw new PathEscapeError(`${relativePath} escapes workspace root`);
  }
  return full;
}
```

- [ ] **Step 3: Update `filesystem.ts` to import instead of redefine**

Edit `src/tools/filesystem.ts` lines 1-15 to:

```typescript
import { readFile, writeFile, rename, unlink, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Tool } from "./tool";
import { resolveWorkspacePath, PathEscapeError } from "./path-utils";

export { PathEscapeError };
```

Remove the now-unused `resolve, join, relative` import and the inline `resolveWorkspacePath`/`PathEscapeError` definitions that followed.

- [ ] **Step 4: Run full test suite to confirm no regression**

Run: `npx jest tests/tools/filesystem.test.ts -v`
Expected: PASS, both `PathEscapeError` assertions still hold (they import `PathEscapeError` from `../../src/tools/filesystem`, which now re-exports the shared class).

- [ ] **Step 5: Typecheck and full suite**

Run: `npx tsc -p tsconfig.json --noEmit && npx jest`
Expected: clean typecheck, all 25+ tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/tools/path-utils.ts src/tools/filesystem.ts
git commit -m "fix: dedupe path-escape logic into path-utils"
```

---

### Task 2: Fail-fast cloud auth check

**Files:**
- Modify: `src/provider/provider.ts:75-96` (`chat` method)
- Test: `tests/provider/provider.test.ts` (new file)

**Interfaces:**
- Consumes: existing `Provider` class, `ProviderOptions`, `ProviderError`.
- Produces: `Provider.chat()` throws `ProviderError` synchronously (before any `fetch`) when `tier === "cloud"` and `apiKey` is falsy. Message: `"missing apiKey for cloud chat"`.

- [ ] **Step 1: Write the failing test**

Create `tests/provider/provider.test.ts`:

```typescript
import { Provider, ProviderError } from "../../src/provider/provider";

describe("Provider cloud auth", () => {
  it("throws ProviderError before making a request when apiKey is missing", async () => {
    const provider = new Provider({ tier: "cloud", model: "test-model", host: "https://example.invalid" });

    await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(ProviderError);
    await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/missing apiKey/);
  });

  it("does not throw the apiKey error for local tier", async () => {
    const provider = new Provider({ tier: "local", model: "test-model", host: "http://127.0.0.1:1" });

    await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.not.toThrow(/missing apiKey/);
  });
});
```

Note: the second test still rejects (connection refused on port 1), it just must not reject with the apiKey message — this proves the guard is tier-scoped.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/provider/provider.test.ts -v`
Expected: FAIL on the first test — today `chat()` sends `Authorization: Bearer undefined` and fails with a fetch/DNS error, not `ProviderError` with "missing apiKey".

- [ ] **Step 3: Add the guard**

Edit `src/provider/provider.ts`, inside `async chat(...)` right after the `body` construction (before the `headers` block, around line 84):

```typescript
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResponse> {
    if (this.tier === "cloud" && !this.apiKey) {
      throw new ProviderError("missing apiKey for cloud chat");
    }

    const body: Record<string, unknown> = { model: this.model, messages, stream: opts.stream ?? false };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/provider/provider.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/provider/provider.ts tests/provider/provider.test.ts
git commit -m "fix: fail fast on missing cloud apiKey instead of sending Bearer undefined"
```

---

### Task 3: Redact response bodies from ProviderError messages

**Files:**
- Modify: `src/provider/provider.ts:117-122`
- Test: `tests/provider/provider.test.ts` (append)

**Interfaces:**
- Consumes: existing `resp.text()` error path.
- Produces: `ProviderError` message caps the upstream body at 500 chars and strips any `Bearer <token>` / `sk-...`-shaped substrings before inclusion, so a leaking upstream (e.g. an echo proxy) can't smuggle the caller's own key back into logs.

- [ ] **Step 1: Write the failing test**

Append to `tests/provider/provider.test.ts`:

```typescript
describe("Provider error redaction", () => {
  it("redacts bearer tokens from upstream error bodies", async () => {
    const fakeFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "upstream failed, saw header Authorization: Bearer sk-secret-abc123",
    });
    (globalThis as any).fetch = fakeFetch;

    const provider = new Provider({ tier: "cloud", model: "m", apiKey: "sk-secret-abc123", host: "https://x" });

    await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/\[REDACTED\]/);
    await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.not.toThrow(/sk-secret-abc123/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/provider/provider.test.ts -v`
Expected: FAIL — current code interpolates `await resp.text()` raw into the `ProviderError` message.

- [ ] **Step 3: Add a redaction helper and use it**

Edit `src/provider/provider.ts`. Add near the top (after imports, module scope):

```typescript
const MAX_ERROR_BODY_CHARS = 500;

function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9]{6,}/g, "[REDACTED]")
    .slice(0, MAX_ERROR_BODY_CHARS);
}
```

Change the error-throwing line (around line 120-122):

```typescript
    if (!resp.ok) {
      throw new ProviderError(`Ollama ${this.tier} ${resp.status}: ${redactSecrets(await resp.text())}`);
    }
```

Apply the same `redactSecrets(...)` wrap to the matching line in `availableModels()` (around line 145).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/provider/provider.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/provider/provider.ts tests/provider/provider.test.ts
git commit -m "fix: redact bearer tokens and cap length in provider error messages"
```

---

### Task 4: Docker preflight check for ShellTool

**Files:**
- Modify: `src/tools/shell.ts` (add `checkDockerAvailable`, call once lazily)
- Test: `tests/tools/shell.test.ts` (append)

**Interfaces:**
- Consumes: existing `spawn` from `node:child_process`.
- Produces: `ShellTool.call()` returns `{ exitCode: -1, stdout: "", stderr: "docker is not available: <reason>", truncated: false, error: "DockerUnavailableError" }` instead of a raw ENOENT-shaped spawn error, and only runs the check once per process (cached) so it doesn't add latency to every call after the first.

- [ ] **Step 1: Write the failing test**

Append to `tests/tools/shell.test.ts` (mirror existing test setup style in that file — check how it constructs `ShellTool` and mocks `spawn` before writing; use the same mocking approach already present in the file):

```typescript
it("returns a DockerUnavailableError instead of a raw spawn error when docker is missing", async () => {
  const tool = new ShellTool({ workspaceRoot: "/tmp", logger: { info: jest.fn(), warn: jest.fn() } });
  // Force the internal availability check to fail without touching the real docker binary.
  (tool as any).dockerAvailable = false;
  (tool as any).dockerChecked = true;

  const result = await tool.call({ command: "echo hi" });

  expect(result.error).toBe("DockerUnavailableError");
  expect(result.exitCode).toBe(-1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/tools/shell.test.ts -v`
Expected: FAIL — `dockerAvailable`/`dockerChecked` fields don't exist yet, and `call()` doesn't short-circuit on them.

- [ ] **Step 3: Add the preflight fields and check**

Edit `src/tools/shell.ts`. Add two private fields near the other private fields (around line 22-27):

```typescript
  private dockerChecked = false;
  private dockerAvailable = true;
```

Add a private method after `constructor` (around line 38):

```typescript
  private async ensureDockerAvailable(): Promise<boolean> {
    if (this.dockerChecked) return this.dockerAvailable;
    this.dockerChecked = true;
    this.dockerAvailable = await new Promise((resolveCheck) => {
      const probe = spawn("docker", ["info"]);
      probe.on("close", (code) => resolveCheck(code === 0));
      probe.on("error", () => resolveCheck(false));
    });
    if (!this.dockerAvailable) {
      this.logger.warn("[ShellTool] docker is not available — run_shell will fail until it is");
    }
    return this.dockerAvailable;
  }
```

At the top of `async call(...)` (right after the empty-command check, around line 60), add:

```typescript
    if (!(await this.ensureDockerAvailable())) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: "docker is not available: dockerd is not reachable (is Docker running?)",
        truncated: false,
        error: "DockerUnavailableError",
      };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/tools/shell.test.ts -v`
Expected: PASS. Also confirm existing shell tests still pass (they exercise real docker calls or mocks — check the file's existing setup; the new field defaults (`dockerChecked = false`) mean untouched tests still hit the real `ensureDockerAvailable()` probe path, which spawns `docker info` once — acceptable since existing tests already require a working `docker` binary given they invoke `docker run`).

- [ ] **Step 5: Commit**

```bash
git add src/tools/shell.ts tests/tools/shell.test.ts
git commit -m "fix: preflight docker availability check with clear error instead of raw spawn failure"
```

---

### Task 5: Tests for `directory-tools.ts`

**Files:**
- Create: `tests/tools/directory-tools.test.ts`

**Interfaces:**
- Consumes: `ListDirectoryTool`, `DeleteFileTool`, `MakeDirectoryTool`, `CopyFileTool`, `MoveFileTool` from `src/tools/directory-tools.ts` (all take `root: string` in constructor, `call(args)` returns `Record<string, unknown>`).

- [ ] **Step 1: Write the tests**

Create `tests/tools/directory-tools.test.ts`:

```typescript
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ListDirectoryTool,
  DeleteFileTool,
  MakeDirectoryTool,
  CopyFileTool,
  MoveFileTool,
} from "../../src/tools/directory-tools";

describe("ListDirectoryTool", () => {
  it("lists files and directories with type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "x");
    await mkdir(join(dir, "sub"));
    const tool = new ListDirectoryTool(dir);

    const result = await tool.call({ path: "." });

    const entries = result.entries as { name: string; type: string }[];
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "a.txt", type: "file" }),
        expect.objectContaining({ name: "sub", type: "directory" }),
      ]),
    );
  });

  it("returns an ArgumentError when path is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new ListDirectoryTool(dir);

    const result = await tool.call({});

    expect(result.error).toBe("ArgumentError");
  });
});

describe("DeleteFileTool", () => {
  it("removes a file recursively", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "x");
    const tool = new DeleteFileTool(dir);

    const result = await tool.call({ path: "a.txt" });

    expect(result.removed).toBe(true);
  });
});

describe("MakeDirectoryTool", () => {
  it("creates nested directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new MakeDirectoryTool(dir);

    const result = await tool.call({ path: "a/b/c" });

    expect(result.created).toBe(true);
  });
});

describe("CopyFileTool", () => {
  it("copies a file within the workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "x");
    const tool = new CopyFileTool(dir);

    const result = await tool.call({ source: "a.txt", destination: "b.txt" });

    expect(result.copied).toBe(true);
  });

  it("returns ArgumentError when destination is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new CopyFileTool(dir);

    const result = await tool.call({ source: "a.txt" });

    expect(result.error).toBe("ArgumentError");
  });
});

describe("MoveFileTool", () => {
  it("renames a file within the workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "x");
    const tool = new MoveFileTool(dir);

    const result = await tool.call({ source: "a.txt", destination: "b.txt" });

    expect(result.moved).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify all pass (no implementation change needed)**

Run: `npx jest tests/tools/directory-tools.test.ts -v`
Expected: PASS — this task is pure test-coverage backfill, `directory-tools.ts` is not modified.

- [ ] **Step 3: Commit**

```bash
git add tests/tools/directory-tools.test.ts
git commit -m "test: add coverage for directory-tools"
```

---

### Task 6: Tests for `edit-tools.ts` and `backup-tools.ts`

**Files:**
- Create: `tests/tools/edit-tools.test.ts`
- Create: `tests/tools/backup-tools.test.ts`

**Interfaces:**
- Consumes: `PatchTool`, `AppendTool` from `src/tools/edit-tools.ts`; `SnapshotBackupTool` from `src/tools/backup-tools.ts`.

- [ ] **Step 1: Write `tests/tools/edit-tools.test.ts`**

```typescript
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PatchTool, AppendTool } from "../../src/tools/edit-tools";

describe("PatchTool", () => {
  it("replaces the first occurrence of a find block", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "hello world");
    const tool = new PatchTool(dir);

    await tool.call({ path: "a.txt", find: "world", replace: "there" });

    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("hello there");
  });

  it("throws ToolError when find block is not present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "hello world");
    const tool = new PatchTool(dir);

    await expect(tool.call({ path: "a.txt", find: "missing", replace: "x" })).rejects.toThrow(/not found/);
  });
});

describe("AppendTool", () => {
  it("appends content and creates parent directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new AppendTool(dir);

    await tool.call({ path: "out/log.txt", content: "line1\n" });
    await tool.call({ path: "out/log.txt", content: "line2\n" });

    expect(await readFile(join(dir, "out/log.txt"), "utf-8")).toBe("line1\nline2\n");
  });
});
```

- [ ] **Step 2: Write `tests/tools/backup-tools.test.ts`**

```typescript
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotBackupTool } from "../../src/tools/backup-tools";

describe("SnapshotBackupTool", () => {
  it("copies the target file into .devagent/backups with a timestamp suffix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "content-v1");
    const tool = new SnapshotBackupTool(dir);

    const result = await tool.call({ path: "a.txt" });

    const backupFiles = await readdir(join(dir, ".devagent/backups"));
    expect(backupFiles.length).toBe(1);
    expect(await readFile(join(dir, result.backupPath as string), "utf-8")).toBe("content-v1");
  });

  it("returns an ArgumentError when path is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new SnapshotBackupTool(dir);

    const result = await tool.call({});

    expect(result.error).toBe("ArgumentError");
  });
});
```

- [ ] **Step 3: Run both files**

Run: `npx jest tests/tools/edit-tools.test.ts tests/tools/backup-tools.test.ts -v`
Expected: PASS — pure test-coverage backfill, no source changes.

- [ ] **Step 4: Commit**

```bash
git add tests/tools/edit-tools.test.ts tests/tools/backup-tools.test.ts
git commit -m "test: add coverage for edit-tools and backup-tools"
```

---

### Task 7: ESLint + Prettier baseline

**Files:**
- Create: `.eslintrc.cjs`
- Create: `.prettierrc.json`
- Modify: `package.json` (devDependencies + scripts)

**Interfaces:**
- Produces: `npm run lint` and `npm run format:check` scripts usable by CI (Task 8).

- [ ] **Step 1: Install devDependencies**

Run:
```bash
npm install --save-dev eslint@^8.57.0 @typescript-eslint/parser@^7.0.0 @typescript-eslint/eslint-plugin@^7.0.0 prettier@^3.3.0
```

- [ ] **Step 2: Create `.eslintrc.cjs`**

```javascript
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 2022, sourceType: "module", project: "./tsconfig.json" },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: { node: true, es2022: true, jest: true },
  ignorePatterns: ["dist/", "node_modules/"],
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
  },
};
```

- [ ] **Step 3: Create `.prettierrc.json`**

```json
{
  "printWidth": 120,
  "trailingComma": "all",
  "semi": true
}
```

- [ ] **Step 4: Add scripts to `package.json`**

Add to the `"scripts"` block (alongside existing `build`, `test`, `start`, `dev`):

```json
    "lint": "eslint src tests --ext .ts",
    "format:check": "prettier --check src tests"
```

- [ ] **Step 5: Run lint, fix reported issues**

Run: `npm run lint`
Expected: some findings against the current codebase (e.g. unused imports). Fix each one it reports — do not add blanket `// eslint-disable` comments.

- [ ] **Step 6: Verify clean**

Run: `npm run lint && npx tsc -p tsconfig.json --noEmit && npx jest`
Expected: all three clean/passing.

- [ ] **Step 7: Commit**

```bash
git add .eslintrc.cjs .prettierrc.json package.json package-lock.json
git commit -m "chore: add eslint and prettier baseline"
```

(If Step 5 required source fixes in other files, stage those too before committing, or commit them as a preceding `fix: lint cleanup` commit — keep the lint-config commit and the lint-fix commit separate if the fix set is non-trivial.)

---

### Task 8: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: a workflow that runs on every push and PR to `main`, running typecheck, lint, and tests.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - run: npm ci
      - run: npm run lint
      - run: npx tsc -p tsconfig.json --noEmit
      - run: npx jest --ci
```

Note: `run_shell`-dependent tests (`tests/tools/shell.test.ts`) require a working `docker` binary. `ubuntu-latest` GitHub-hosted runners ship Docker preinstalled, so this should work as-is — but confirm by watching the first CI run; if the shell tests fail in CI due to sandboxing/permissions, split them into a separate job gated on `docker info` succeeding rather than disabling them.

- [ ] **Step 2: Push and verify the workflow runs**

This step requires pushing to a branch/PR on GitHub — do it as part of normal PR flow, not locally. Confirm the Actions tab shows a green run before merging.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add typecheck, lint, and test workflow"
```

---

## Self-Review Notes

- **Coverage:** all 6 previously-untested-or-thin areas from the review (path dedup, cloud auth fail-fast, secret redaction, docker preflight, directory/edit/backup tool tests, CI+lint) now have tasks.
- **Not covered here, deliberately:** `agent.ts` end-to-end loop tests and `router.ts` fallback tests are meaty enough (need a fake `Provider`/streaming mock harness) that they're better as their own follow-up plan once this hardening lands — flagging so it isn't mistaken for an oversight.
- **Type consistency check:** `PathEscapeError` stays importable from `src/tools/filesystem.ts` (re-export) so no call site outside this plan needs to change; `ProviderError` constructor signature (`message: string`) unchanged in Tasks 2-3.
