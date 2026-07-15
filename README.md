# DevAgent TS

A TypeScript developer agent runtime built on Ollama (local + cloud), with capability-based model routing, LSP-backed code intelligence, a Rails semantic index, a checkpoint/resume-able orchestrator, and a tool-first architecture (35+ tools).

## Architecture

```
src/
├── provider/       Ollama REST client (local + cloud), model catalog, capability router
├── benchmark/      Model scoring harness (JSON validity, tool-calling, latency, tok/s)
├── orchestrator/   Plan steps, parallel dependency-aware execution, checkpoint/resume
├── runtime/        Checkpoint store, config constants, event bus, state store, task machine
├── tools/          35+ tools: filesystem, git, docker, github, sqlite, shell, rspec, rubocop...
├── lsp/            Language server pool/manager — 14 languages configured
├── intelligence/   LSP-backed code intelligence router + Rails semantic index (12 scanners)
├── memory/         SQLite-backed conversation memory + summarizer
├── learning/       Episode recording, grading, reflection, skill synthesis
├── skills/         Skill loader/registry/resolver (Markdown skill packages)
├── mcp/            MCP client + tool adapter (external MCP servers as tools)
├── cli/            Agent orchestration glue (Agent class, conversation, config)
└── tui/            Ink terminal UI (see docs/SPEC.md — frozen product spec)
```

## Key Features

- **Capability-based model routing** — `ModelCatalog` discovers installed local + Ollama Cloud models and tags them (`coding`/`vision`/`reasoning`/`quick`/`tools`) by name heuristic; `Router` picks a local-first candidate per capability and falls back through the rest on rate-limit/timeout/network errors. Non-critical turns (low/medium priority, doc/test/lint keywords) delegate to a `quick` model; screenshot/image mentions route to `vision`; architecture/trade-off questions route to `reasoning` — all gracefully no-op back to the primary model when no matching model is installed.
- **Checkpoint/resume** — the orchestrator persists plan state (`CheckpointStore`, atomic JSON) after every step transition; `Agent.resumePlannedTask()` picks a crashed run back up, resetting only non-terminal step statuses so completed work is never re-run. Separately, `SessionStore` persists the full LLM conversation transcript after every turn; `Agent.resumeSession()` / the `/resume` slash command restore it in a fresh process, verified to correctly re-send prior context to the model.
- **Browser tool** — `src/browser/manager.ts` wraps a lazily-launched headless Chromium (Playwright) with one reused page; `browser_navigate`/`click`/`fill`/`get_text`/`screenshot`/`evaluate`/`close` tools expose it to the agent.
- **Parallel step execution** — independent plan steps (no dependency between them) run concurrently via `Promise.all` each round; dependents still wait for their dependency's batch to finish.
- **Tool-first architecture** — the LLM never searches files, greps, or runs git/docker/gh by itself; every such action is a deterministic `Tool` with a JSON-schema signature. `DynamicToolSelector` prunes which tool schemas are exposed per turn instead of dumping the full registry.
- **LSP intelligence** — 14 languages configured (TypeScript, Ruby, Python, Go, Rust, Java, C#, C/C++, PHP, Swift, Kotlin, Dart, YAML, Docker), with definition/references/hover/diagnostics/rename/completion/etc. exposed as tools.
- **Rails semantic index** — 12 scanners (controller, model, job, mailer, policy, concern, migration, schema, view, rspec, routes, gem) feeding a graph store and query engine, exposed as `find_model`/`find_route`/`find_controller`/etc. tools.
- **Benchmark harness** — `npm run benchmark` runs built-in cases (JSON validity, tool-calling correctness) against every discovered local + cloud model, reporting pass rate, latency, and tokens/sec.
- **Learning + memory** — episode recording, grading, reflection, and skill synthesis (`src/learning/`) backed by a SQLite conversation store (`src/memory/`).
- **Docker-sandboxed shell** — `--network=none`, `--pids-limit=128`, memory/CPU capped; buffer-overflow SIGKILL, hard timeout with kill escalation.
- **Path-contained filesystem tools** — every path resolved and checked against workspace root before I/O; atomic writes via temp+rename.
- **Loop detection** — flags repeated (tool, args, error) signatures to prevent infinite retry cycles.

## Tools

Filesystem/edit: `read_file`, `write_file`, `patch`, `append`, `list_directory`, `delete_file`, `make_directory`, `copy_file`, `move_file`, `snapshot_backup`, `watch`, `search_code`.
VCS/infra: `git`, `docker` (build/run/stop/logs/exec/compose; `--privileged` blocked), `github` (`gh` pr/issue/release/repo/run/api; merge/delete/close blocked), `sqlite_query` (read-only: SELECT/PRAGMA/EXPLAIN only).
Market data: `binance_public_api` (GET-only, no API key — spot/USD-M/COIN-M public endpoints incl. `/futures/data/*` OI history & long-short ratio), `binance_technical_indicators` (SMA/EMA/RSI/MACD/Bollinger from klines), `binance_order_book` (bid/ask imbalance), `binance_futures_stats` (funding rate + open interest), `binance_screener` (multi-symbol RSI scan), `binance_watch_price`/`binance_unwatch_price` (live WebSocket ticker), `binance_price_alert` (WS-backed price threshold alerts), `binance_liquidations` (live futures liquidation feed).
Quant research: `binance_backtest` (rule-based strategy vs real history — win rate/expectancy/profit factor/drawdown), `binance_walk_forward` (edge stability across time windows), `binance_monte_carlo` (bootstrap resampling of the trade sequence), `binance_param_sweep` (grid search over parameters, ranked by expectancy), `binance_paper_trade` (simulated positions marked-to-market against live prices — no real exchange, no keys).
Project: `run_tests`, `run_lint`, `run_format`, `run_build`, `rubocop`, `rspec`, `shell` (Docker-sandboxed).
Code intelligence (LSP-backed): `get_definition`, `find_references`, `rename_symbol`, `workspace_symbols`, `document_symbols`, `hover`, `diagnostics`, `code_actions`, `format_document`, `signature_help`, `completion`, `semantic_tokens`.
Rails semantic: `find_model`, `find_route`, `find_controller`, `find_service`, `find_spec`, `find_association`, `find_callback`, `rails_context`, and more.
Plus anything registered via MCP servers (`agent.registerMcpServer(command, args)`).

## Usage

```typescript
import { Provider } from "./src/provider/provider";
import { ModelCatalog } from "./src/provider/catalog";
import { Router } from "./src/provider/router";

const local = new Provider({ tier: "local", model: "qwen3.5:4b" });
const cloud = new Provider({ tier: "cloud", model: "qwen3.5:4b", apiKey: process.env.OLLAMA_API_KEY });

const catalog = new ModelCatalog(local, cloud);
await catalog.refresh(); // discovers installed models on both tiers

const router = new Router({ local, cloud, catalog });
const response = await router.route("reasoning", [{ role: "user", content: "..." }]);
```

Or use the `Agent` class directly — it wires provider/catalog/router, tools, LSP, Rails index, memory, learning, and checkpointing together:

```typescript
import { Agent } from "./src/cli/agent";

const agent = new Agent({ config: { workspaceRoot: "/path/to/project" } });
const reply = await agent.runUserMessage("Add a null check to the parser");
```

## Requirements

- Node.js >= 20
- Ollama running locally, or `OLLAMA_API_KEY` set for cloud tier
- Docker (for the sandboxed `shell` tool and the `docker` tool)
- `gh` CLI on PATH (for the `github` tool)
- Language servers on PATH for any LSP-backed tools you want (`typescript-language-server`, `ruby-lsp`, `pyright`, `gopls`, `rust-analyzer`, etc.) — missing servers degrade gracefully to a text fallback, not a crash

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL (local tier) |
| `OLLAMA_API_KEY` | — | Primary API key for cloud tier — first in the key pool |
| `OLLAMA_API_KEYS` | — | Comma-separated extra Ollama Cloud keys (e.g. separate accounts). On a 429 `Provider` rotates to the next key and retries before giving up — this is for availability across your own accounts, not multi-vendor routing to other providers |
| `DEVAGENT_MODEL` | `qwen3.5:4b` | Default model tag |
| `DEVAGENT_TIER` | `local` | `local` or `cloud` |
| `DEVAGENT_WORKSPACE` | auto-detected | Workspace root override. Auto-detection walks up from `cwd` to the nearest `.git` (matching how most editor/CLI tooling resolves a project root), then falls back to the nearest existing `.devagent/`, then `cwd` itself. All workspace-scoped state (`.devagent/history.json`, `memory.db`, `checkpoint.json`, workspace `config.json`) lives under whatever this resolves to — set it explicitly if you run devagent from outside the project tree |
| `DEVAGENT_TIMEOUT_MS` | — | Request timeout in milliseconds (cloud tier only — local never times out mid-generation) |
| `DEVAGENT_SYSTEM_PROMPT` | *(built-in)* | Custom system prompt |
| `DEVAGENT_SHELL_IMAGE` | `devagent-sandbox:latest` | Docker image for sandbox |
| `DEVAGENT_SHELL_TIMEOUT_SEC` | `30` | Shell command timeout in seconds |
| `DEVAGENT_TOOL_SELECTION_MODE` | `heuristic` | `heuristic` \| `llm` \| `hybrid` — how `DynamicToolSelector` prunes exposed tools |
| `DEVAGENT_MAX_ACTIVE_TOOLS` | — | Cap on tools exposed per turn |
| `DEVAGENT_MAX_LOGS` / `DEVAGENT_MAX_CONVERSATION` / `DEVAGENT_MAX_TOOL_CALLS` / `DEVAGENT_MAX_NOTIFICATIONS` | 500/500/200/20 | Bounded buffer sizes (`src/runtime/config.ts`) |

## Development

```bash
npm install
npm test          # jest — 664 tests across 92 suites
npm run build     # TypeScript → dist/
npm run benchmark # score installed models on JSON validity + tool-calling
```

## Docker Sandbox

```bash
docker build -t devagent-sandbox:latest docker/devagent-sandbox/
```
