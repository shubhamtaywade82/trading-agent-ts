# AGENTS.md – DevAgent‑TS Project Overview

## 1. Project Purpose

**DevAgent‑TS** is a TypeScript‑based developer‑agent runtime that enables LLM‑driven coding assistants. It provides:
- A **capability-based model router** (`src/provider/`) — a `ModelCatalog` discovers installed local + Ollama Cloud models, tags them by capability (coding/vision/reasoning/quick/tools), and a `Router` picks a local-first candidate per request, falling back through the rest on rate-limit/timeout/network errors.
- **Checkpoint/resume** (`src/runtime/checkpoint.ts`) — the orchestrator persists plan state after every step transition; a crashed multi-step task resumes instead of restarting, without re-running completed steps. Separately, `src/runtime/session.ts`'s `SessionStore` persists the LLM conversation transcript after every turn; `Agent.resumeSession()` / the `/resume` slash command restore it in a new process.
- **Browser automation** (`src/browser/manager.ts`) — a lazily-launched headless Chromium (Playwright), one reused page, exposed as `browser_navigate`/`click`/`fill`/`get_text`/`screenshot`/`evaluate`/`close` tools.
- **Parallel step execution** — independent plan steps run concurrently (`Promise.all` per round); dependents still wait for their dependency's batch.
- **Docker‑sandboxed shell execution** – every `shell` tool call runs inside an isolated container with no network, bounded memory/CPU and hard time‑outs.
- **LSP‑backed code intelligence** (`src/lsp/`, `src/intelligence/`) — 14 languages configured, degrading to a text fallback when a server isn't installed instead of failing.
- **Rails semantic index** (`src/intelligence/rails/`) — 12 scanners (controller/model/job/mailer/policy/concern/migration/schema/view/rspec/routes/gem) feeding a graph store and query engine.
- A **benchmark harness** (`src/benchmark/`) — scores installed models on JSON validity and tool-calling correctness, with latency/tokens-per-sec.
- A **centralised, immutable state store** (`src/runtime/store.ts`) that receives events from all actors, reduces them, and feeds the TUI renderer.
- An **orchestrator** (`src/orchestrator/`) that models plan steps, detects loops, performs topological dependency ordering with parallel execution, retries, checkpoints, and roll‑backs.
- A **plugin‑style tool registry** (`src/tools/`, 35+ tools) for safely exposing filesystem, git, docker, github, sqlite, shell, LSP, and Rails capabilities to the LLM, with `DynamicToolSelector` (`src/tools/discovery.ts`) pruning which tools are exposed per turn.
- **Learning + memory** (`src/learning/`, `src/memory/`) — episode recording, grading, reflection, skill synthesis, and a SQLite conversation store.
- An **MCP client** (`src/mcp/`) for registering external MCP servers' tools into the same registry.

The repository contains the full runtime, CLI, TUI, provider, and a large suite of unit tests that validate core behaviour.

---

## 2. Tech Stack

| Layer | Technology |
|------|--------------|
| **Language** | TypeScript (target ES2022) |
| **Runtime** | Node.js ≥ 20 |
| **Package manager** | npm (lockfile `package-lock.json`) |
| **Testing** | Jest with `ts-jest` preset |
| **Linting** | ESLint (`.eslintrc.cjs`) with `@typescript-eslint` plugin |
| **Formatting** | Prettier (`.prettierrc.json`) |
| **CLI / UI** | Ink (React‑style terminal UI) |
| **Docker sandbox** | Custom Docker image `devagent-sandbox:latest` used by `ShellTool` |
| **LLM provider** | Ollama REST API – local (`http://localhost:11434`) or cloud (`OLLAMA_API_KEY`); both speak the same native `/api/chat` shape |
| **Local database** | `better-sqlite3` — agent memory (`.devagent/memory.db`) and the `sqlite_query` tool |
| **Build** | TypeScript compiler (`tsc`) producing `dist/` |
| **Version control** | Git (runtime tracks branch, ahead/behind, file list) |

---

## 3. Testing Framework & How to Run Tests

The project uses **Jest** with the `ts-jest` preset.
- Configuration lives in `jest.config.js` (roots: `<rootDir>/tests`).
- Tests are located under the `tests/` directory mirroring the source layout (e.g. `tests/tools`, `tests/orchestrator`, `tests/provider`, `tests/benchmark`).

### Run the test suite

```bash
npm test          # runs jest — 580 tests across 84 suites
```

You can also watch tests during development with the standard Jest `--watch` flag (e.g. `npx jest --watch`).

---

## 4. Linting & Formatting Conventions

- **ESLint** (`npm run lint`) linting covers `src` and `tests` and respects the TypeScript project `tsconfig.eslint.json`.  Notable rule overrides:
  - `@typescript-eslint/no-explicit-any` is turned **off** (allowed).
  - Unused‑variable warnings ignore identifiers starting with `_`.
- **Prettier** (`npm run format:check`) enforces a 120‑character line width, trailing commas, and semicolons.  The formatter runs on the same source files as ESLint.
- CI (if any) should enforce both lint and format checks before merging.

---

## 5. Build System & Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compiles TypeScript (`src/ → dist/`) using `tsc` and the `tsconfig.json` configuration. |
| `npm start` | Starts the production TUI (`node dist/tui/index.js`). |
| `npm run dev` | Runs the TUI directly from source via `tsx` (no build step). |
| `npm run dev:legacy` | Runs the older CLI entry point (`src/cli/tui.ts`). |
| `npm run benchmark` | Scores installed local + cloud models on JSON validity + tool-calling (`src/benchmark/cli.ts`). |
| `npm run lint` | Executes ESLint over source and test files. |
| `npm run format:check` | Runs Prettier in check mode. |
| `docker build -t devagent-sandbox:latest docker/devagent-sandbox/` | Builds the sandbox image used by `ShellTool`. |

---

## 6. Key Directory Structure

```
.
├── .agents/                # internal DevAgent metadata (runtime, history)
├── .devagent/               # DevAgent runtime files (memory.db, checkpoint.json, config.json)
├── bin/                     # CLI entry point (compiled JavaScript)
├── docker/                  # Dockerfile for sandbox image
├── docs/                    # Project documentation
│   └── SPEC.md              # Frozen TUI product spec — breaking changes need deliberate review
├── src/                     # Core library
│   ├── benchmark/           # Model scoring harness (cases, runner, score, report, cli)
│   ├── cli/                 # Agent class, conversation, config, agent-tools wiring
│   ├── intelligence/        # LSP intelligence router + Rails semantic index/scanners
│   ├── interaction/         # Interaction layer — keybindings, slash commands, history, search
│   ├── layout/               # Ink layout components (header, activity strip, density, etc.)
│   ├── learning/             # Episode recording, grading, reflection, skill synthesis
│   ├── lsp/                  # Language server pool/manager/registry — 14 languages configured
│   ├── mcp/                  # MCP client + tool adapter
│   ├── memory/                # SQLite-backed conversation memory + summarizer
│   ├── orchestrator/          # Plan steps, parallel execution, checkpointing, loop detector
│   ├── provider/               # Ollama provider, model catalog, capability router
│   ├── runtime/                 # Checkpoint store, EventBus, store, reducers, task machine
│   ├── skills/                   # Skill loader/registry/resolver
│   ├── tools/                     # Tool base class + 35+ concrete tools + dynamic selector
│   └── tui/                        # Ink TUI components (main UI, status bar, etc.)
├── tests/                   # Jest test suite mirroring src layout — 580 tests / 84 suites
├── package.json             # npm scripts, dependencies, runtime config
├── tsconfig*.json           # Typescript compiler config (main + eslint)
├── .eslintrc.cjs            # ESLint configuration
├── .prettierrc.json         # Prettier configuration
└── README.md                # High‑level project description
```

---

## 7. Notable Architecture Decisions & Conventions

1. **Single Source of Truth – the Store**
   - All UI components read from `src/runtime/store.ts`.  Events flow from actors → `EventBus` → `reduce` → new immutable state.  This guarantees deterministic rendering and makes time‑travel debugging possible.
2. **Bounded Buffers**
   - Conversation, logs, tool‑calls, and notifications have hard caps (`MAX_CONVERSATION = 500`, etc., `src/runtime/config.ts`, overridable via `DEVAGENT_MAX_*` env vars) to keep long sessions bounded in memory.
3. **Sanitisation of Text**
   - `sanitizeText` strips ANSI escape sequences and control characters before they enter the store, protecting the TUI from malicious output.
4. **Docker‑Sandboxed Shell Tool**
   - `ShellTool` ensures every command runs with no network, limited resources, and an output ceiling (2 MiB).  It also escalates kills if the container is stubborn.
5. **Loop Detection**
   - `src/orchestrator/loop-detector.ts` tracks repeated tool‑call signatures to avoid infinite retries, a common failure mode for LLM‑driven agents.
6. **Capability-Based Model Router**
   - `src/provider/catalog.ts` discovers installed local + cloud models and tags each by name heuristic (coding/vision/reasoning/quick/tools — deliberately a heuristic, not real metadata; upgrade path is local `/api/show` capability flags). `src/provider/router.ts` picks a local-first candidate per capability and falls back through the rest on `RateLimitError`/`TimeoutError`/network `TypeError`. `Agent.classifyCapability` (`src/cli/agent.ts`) routes non-critical turns to `quick`, screenshot/image mentions to `vision`, and architecture/trade-off questions to `reasoning` — silently falling back to the primary model when no matching model is installed, never breaking the turn.
7. **Checkpoint/Resume**
   - `src/runtime/checkpoint.ts`'s `CheckpointStore` does an atomic (`tmp` + `rename`) JSON save after every orchestrator step transition and replan; `Orchestrator.run()` clears it on full completion. `sanitizeResumedSteps` resets any non-terminal step status to `pending` on resume — a crashed process's in-flight step outcome is unknown, so it's safely retried rather than trusted.
8. **Parallel-Ready Orchestrator**
   - `Orchestrator.run()` fans out every currently-ready step (dependencies satisfied) via `Promise.all` each round, instead of one at a time — independent coder/reviewer/tester-style steps overlap in-flight.
9. **Planner with Dependency Graph**
   - Steps (`PlanStep`) declare `dependencies` and optional `rollbackCommand`.  The orchestrator resolves a topological order, marks blocked/skipped steps on cascade failure, and can re‑plan on failures.
10. **Extensible Tool Registry**
    - `src/tools/registry.ts` registers tools with name, description and JSON‑schema parameters, enabling the LLM to discover capabilities programmatically. `src/tools/discovery.ts`'s `DynamicToolSelector` prunes which tool schemas are actually sent to the model each turn (heuristic/llm/hybrid modes) instead of exposing the full registry every time.
11. **Destructive-Action Guardrails on Infra Tools**
    - `DockerTool` blocks `--privileged`; `GitHubTool` blocks `merge`/`delete`/`close`; `SqliteQueryTool` is read-only (SELECT/PRAGMA/EXPLAIN only); `GitTool` blocks force/hard operations. None of these tools can be used to silently take an irreversible action.
12. **Environment‑Driven Configuration**
    - Runtime values such as `DEVAGENT_MODEL`, `DEVAGENT_TIMEOUT_MS`, `DEVAGENT_SHELL_IMAGE`, `DEVAGENT_TOOL_SELECTION_MODE` are read from `process.env` (via `dotenv`), see `src/cli/config.ts` and the README's environment variable table.
13. **Multiple API Keys — Ollama Cloud Key Pool, Not Multi-Vendor Routing**
    - `CliConfig.apiKeys: string[]` (`src/cli/config.ts`, from `OLLAMA_API_KEY` + comma-separated `OLLAMA_API_KEYS` + config-file `apiKeys`, deduped) is a pool of Ollama Cloud keys for one provider — e.g. separate accounts for availability. `Provider` (`src/provider/provider.ts`) tracks a rotation index; on a cloud-tier 429 it rotates to the next key and retries before throwing `RateLimitError`. It does not route by model vendor and does not reach non-Ollama endpoints — `Provider.chat` always POSTs to Ollama's native `/api/chat` shape.
14. **Workspace Root Resolution — Git Root First, Like Most Editor Tooling**
    - `findWorkspaceRoot` (`src/cli/config.ts`) walks up from `cwd` to the nearest `.git` (dir or file — worktrees work), then falls back to the nearest existing `.devagent/`, then `cwd`. Git-first avoids the old chicken-and-egg bug where a first-ever run in a project, or a run from a subdirectory that hadn't had `.devagent` created yet, silently fell back to `cwd` and started a disconnected `.devagent/` (fragmented history/memory/config per launch directory). All workspace-scoped state hangs off this resolution — `DEVAGENT_WORKSPACE` overrides it outright.
15. **Testing Philosophy**
    - Unit tests mock Docker `/run_shell` calls and provider responses (`fetch`); tools that wrap real CLIs (`git`, `docker`, `gh`) are tested against the real binaries for allowlist/rejection behavior, not mocked. Browser tools (`src/browser/`) are tested against a real headless Chromium (`data:` URLs, offline/deterministic), not a Playwright mock. Tests assert state transitions and tool outputs rather than UI output, making them fast and deterministic.
16. **ESM Migration — Jest Runs in Real ESM Mode, Pinned to Jest 30**
    - The project is `"type": "module"`; `package.json`'s `test` script runs `node --experimental-vm-modules .../jest`, and `jest.config.js` uses `ts-jest/presets/default-esm`. `tests/jest.setup.js` restores `jest.fn()`/`spyOn()`/`mock()` as a global (not auto-injected in real ESM mode). `jest.mock()` doesn't auto-hoist under ESM — the 5 files that need it use `jest.unstable_mockModule()` + dynamic `await import()` instead (see `tests/tools/shell.test.ts` for the pattern). Jest was bumped from 29 to 30 specifically to fix a real, recurring `signal-exit` dual-package-hazard crash (`Export '__signal_exit_emitter__' is not defined`) that only showed up under `--experimental-vm-modules` — confirmed via multiple full-suite reruns before and after the bump. Don't downgrade Jest without re-verifying that issue doesn't come back.

---

## 8. Getting Started (quick checklist)

1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Build the sandbox image** (required for any `shell`/`docker` tool usage)
   ```bash
   docker build -t devagent-sandbox:latest docker/devagent-sandbox/
   ```
3. **Run the test suite** to ensure everything works
   ```bash
   npm test
   ```
4. **Start the development UI**
   ```bash
   npm run dev
   ```
5. **Score installed models** (optional — needs a reachable local Ollama and/or `OLLAMA_API_KEY`)
   ```bash
   npm run benchmark
   ```
6. **Build for production**
   ```bash
   npm run build && npm start
   ```

---

*This file is intended for future DevAgent sessions to quickly understand the repository layout, tooling, and architectural conventions.*
