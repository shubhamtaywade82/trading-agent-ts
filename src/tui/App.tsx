import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventBus } from "../runtime/events.js";
import { Store } from "../runtime/store.js";
import { RuntimeState, VIEW_ORDER, ViewId } from "../runtime/types.js";
import { activeViewRows, densityForWidth, detailForDensity } from "../layout/density.js";
import { resolveKey, UiCommand } from "../interaction/keybindings.js";
import { initialUiState, uiReduce } from "../interaction/ui-state.js";
import { builtinCommands, CommandEffect, parseSlashInput, SlashCommandRegistry } from "../interaction/slash-commands.js";
import { HistoryManager } from "../interaction/history.js";
import { acceptWord, completions, ghostSuffix } from "../interaction/completion.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { Header } from "./zones/Header.js";
import { ActivityStrip } from "./zones/ActivityStrip.js";
import { ContextStrip } from "./zones/ContextStrip.js";
import { PromptBar, promptBarRows } from "./zones/PromptBar.js";
import { ConversationView, ViewProps } from "./views/ConversationView.js";
import { ExecutionView } from "./views/ExecutionView.js";
import { TasksView } from "./views/TasksView.js";
import { GitView } from "./views/GitView.js";
import { LogsView } from "./views/LogsView.js";
import { MemoryView } from "./views/MemoryView.js";
import { ModelsView } from "./views/ModelsView.js";
import { McpView } from "./views/McpView.js";
import { LspView } from "./views/LspView.js";
import { FileExplorerView } from "./views/FileExplorerView.js";
import { SettingsView } from "./views/SettingsView.js";
import { ContextInspectorView } from "./views/ContextInspectorView.js";
import { RailsView } from "./views/RailsView.js";
import { ToolTimelineView } from "./views/ToolTimelineView.js";
import { CommandPalette } from "./overlays/CommandPalette.js";
import { HelpOverlay } from "./overlays/HelpOverlay.js";
import { ActorsOverlay } from "./overlays/ActorsOverlay.js";
import { ApprovalOverlay } from "./overlays/ApprovalOverlay.js";
import { ModelSwitcher } from "./overlays/ModelSwitcher.js";
import { ModeSwitcher } from "./overlays/ModeSwitcher.js";
import { SearchEverywhere } from "./overlays/SearchEverywhere.js";
import { SkillsOverlay } from "./overlays/SkillsOverlay.js";
import { SkillsRegistry } from "../skills/registry.js";

export interface ShellAgent {
  runUserMessage(message: string): Promise<unknown>;
  setModel?(model: string): void;
  setTier?(tier: string): void;
  resetContext?(): void;
  resumeSession?(): Array<{ role: string; content: string }> | null;
  hasResumableSession?(): boolean;
  listModels?(): Promise<string[]>;
  /** Round-trips a real request through the new model; true, or an error string. */
  validateModel?(): Promise<true | string>;
  getSkillsRegistry?(): SkillsRegistry;
  pinSkill?(id: string | null): void;
  addLearning?(category: string, context: string, lesson: string): void;
}

export interface AppProps {
  bus: EventBus;
  store: Store;
  agent?: ShellAgent;
  registry?: SlashCommandRegistry;
  /** Explicit size for tests; defaults to the live terminal size. */
  columns?: number;
  rows?: number;
  now?: number;
  workspaceRoot?: string;
}

const VIEWS: Record<ViewId, (props: ViewProps) => JSX.Element> = {
  conversation: ConversationView,
  execution: ExecutionView,
  tasks: TasksView,
  git: GitView,
  logs: LogsView,
  memory: MemoryView,
  models: ModelsView,
  mcp: McpView,
  lsp: LspView,
  files: FileExplorerView,
  settings: SettingsView,
  context: ContextInspectorView,
  rails: RailsView,
  timeline: ToolTimelineView,
};

const VIEW_LABELS: Record<ViewId, string> = {
  conversation: "Conversation",
  execution: "Execution",
  tasks: "Tasks",
  git: "Git",
  logs: "Logs",
  memory: "Memory",
  models: "Models",
  mcp: "MCP",
  lsp: "LSP",
  files: "Files",
  settings: "Settings",
  context: "Context",
  rails: "Rails",
  timeline: "Timeline",
};

function useTerminalSize(columns?: number, rows?: number): { width: number; height: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    width: columns ?? stdout?.columns ?? 100,
    height: rows ?? stdout?.rows ?? 30,
  });
  useEffect(() => {
    if (columns != null && rows != null) return;
    if (!stdout) return;
    const onResize = () => setSize({ width: columns ?? stdout.columns ?? 100, height: rows ?? stdout.rows ?? 30 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout, columns, rows]);
  return columns != null && rows != null ? { width: columns, height: rows } : size;
}

// Ink 3 bundles a React 17-era reconciler without useSyncExternalStore,
// so subscribe the classic way. The re-sync inside the effect catches any
// events published between first render and subscription.
//
// Streaming responses publish one bus event per token (see agent-bridge.ts).
// Real tokens arrive on separate event-loop turns (real network/inference
// latency between them), not in a same-tick burst — same-tick coalescing
// (the previous approach here) does nothing for that case, since there's
// only ever one event per turn to coalesce. Calling setState on every single
// token is what causes the flicker: Ink 3's renderer isn't a real diffing
// engine, so every commit is close to a full-screen repaint.
//
// Real fix: a leading+trailing time-window throttle, independent of how the
// events are spaced. The first update in a quiet period renders immediately
// (stays responsive); anything within RENDER_THROTTLE_MS of the last render
// is deferred to a single trailing flush instead of one render each.
const RENDER_THROTTLE_MS = 50; // ~20fps cap — well above flicker threshold, still feels live
function useRuntimeState(store: Store): RuntimeState {
  const [state, setState] = useState<RuntimeState>(() => store.getState());
  useEffect(() => {
    setState(store.getState());
    let lastFlush = 0;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      pendingTimer = null;
      lastFlush = Date.now();
      setState(store.getState());
    };
    const unsubscribe = store.subscribe(() => {
      if (pendingTimer) return; // a trailing flush is already scheduled — it'll pick up this update
      const elapsed = Date.now() - lastFlush;
      if (elapsed >= RENDER_THROTTLE_MS) {
        flush();
      } else {
        pendingTimer = setTimeout(flush, RENDER_THROTTLE_MS - elapsed);
      }
    });
    return () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      unsubscribe();
    };
  }, [store]);
  return state;
}

// SGR mouse reporting (scroll wheel, click) — some terminals send these
// whenever the app is in raw mode, even though DevAgent never requests mouse
// tracking. Format: ESC [ < button ; col ; row (M press or m release). Without
// this filter the raw escape sequence gets typed into the prompt literally.
const MOUSE_SGR_PATTERN = /\x1b?\[<\d+;\d+;\d+[Mm]/;

export function App({ bus, store, agent, registry, columns, rows, now, workspaceRoot }: AppProps): JSX.Element {
  const { exit } = useApp();
  const state = useRuntimeState(store);
  const { width, height } = useTerminalSize(columns, rows);
  const [ui, uiDispatch] = useReducer(uiReduce, undefined, initialUiState);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [history] = useState(() => {
    const root = workspaceRoot ?? process.cwd();
    const historyFile = join(root, ".devagent", "history.json");
    // Also load legacy flat file for backwards compat
    const legacyPath = join(root, ".devagent_history");
    let initialHistory: string[] = [];
    try {
      if (existsSync(legacyPath)) {
        const content = readFileSync(legacyPath, "utf-8");
        initialHistory = content.split("\n").filter(Boolean);
      }
    } catch {
      // ignore
    }
    const mgr = new HistoryManager(initialHistory, 200, historyFile);
    mgr.load();
    return mgr;
  });
  const [models, setModels] = useState<string[] | null>(null);
  const commandRegistry = useMemo(() => registry ?? builtinCommands(), [registry]);
  const pastingRef = useRef(false);
  const pasteBufRef = useRef("");
  const pasteCountRef = useRef(0);

  // Burst detection: some terminals split a multi-line paste into one
  // "data" event PER LINE, each ending in a lone \r that Ink reads as a
  // real Enter keypress — without this, every pasted line gets individually
  // submitted as its own message before the user ever sees the full paste.
  // No human presses Enter faster than FAST_INPUT_MS after the previous
  // keystroke; anything faster is the terminal dumping a paste, so a fast
  // Enter becomes a newline within the prompt instead of a submit.
  const FAST_INPUT_MS = 20;
  const BURST_IDLE_MS = 60;
  const lastInputAtRef = useRef(0);
  const burstActiveRef = useRef(false);
  const burstStartPromptRef = useRef("");
  const burstTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Snapshot of prompt right before the current "typing session" (any run of
  // input with no long idle gap) began. A burst is only detected on its 2nd
  // event (the first fast Enter), by which point the first line's plain
  // characters already landed in `prompt` — anchoring to this instead of the
  // live prompt at burst-detection time reaches back to include that first
  // line in the eventual collapse too.
  const sessionStartPromptRef = useRef("");

  useEffect(
    () => () => {
      if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
    },
    [],
  );

  // Shared by both paste paths (bracketed-paste markers, and the plain
  // useInput fallback below for terminals that don't emit them): collapse
  // multi-line content into a "[Pasted text #N +K lines]" placeholder, but
  // keep the real content right after it so submitPrompt still sends it in
  // full. Single-line "pastes" are just appended — no placeholder needed.
  const appendPasted = useCallback((prev: string, pasted: string): string => {
    const lineCount = pasted.split("\n").length;
    if (lineCount <= 1) return prev + pasted;
    pasteCountRef.current += 1;
    const prefix = prev ? prev + "\n" : "";
    return `${prefix}[Pasted text #${pasteCountRef.current} +${lineCount} lines]\n${pasted}`;
  }, []);

  // Collapses whatever raw text a rapid-Enter burst added to the prompt
  // (see FAST_INPUT_MS above) into the same placeholder as other paste
  // paths, once the burst goes idle.
  const finalizeBurst = useCallback(() => {
    burstActiveRef.current = false;
    burstTimerRef.current = null;
    setPrompt((current) => {
      const start = burstStartPromptRef.current;
      if (!current.startsWith(start)) return current; // state diverged; leave it alone
      const added = current.slice(start.length).replace(/^\n/, "");
      if (added.split("\n").length <= 1) return current;
      return appendPasted(start, added);
    });
  }, [appendPasted]);

  // Detect bracketed paste markers on stdin.
  // Uses prependListener so our handler runs BEFORE Ink's — once pastingRef
  // is true, useInput bails out and lets this handler set the prompt directly.
  useEffect(() => {
    if (!process.stdin.isTTY) return;
    let buf = "";
    const handler = (data: Buffer) => {
      buf += data.toString();

      if (buf.includes("\x1b[200~")) {
        pastingRef.current = true;
        pasteBufRef.current = "";
        buf = buf.replace("\x1b[200~", "");
      }

      if (pastingRef.current) {
        if (buf.includes("\x1b[201~")) {
          const parts = buf.split("\x1b[201~");
          pasteBufRef.current += parts[0] ?? "";
          // Some terminals encode pasted line breaks as bare \r (confirmed
          // via DEVAGENT_DEBUG_STDIN capture) rather than \n. Normalize both
          // \r\n and lone \r to \n so line counting/collapsing sees them —
          // otherwise the raw \r survives into the prompt and, once actually
          // written to a real terminal, repeatedly carriage-returns the
          // cursor, leaving only the last segment visible on screen.
          const pasted = pasteBufRef.current.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          pasteBufRef.current = "";
          setPrompt((p) => appendPasted(p, pasted));
          buf = parts.slice(1).join("\x1b[201~");
          // Defer turning off pastingRef so any useInput callbacks queued
          // from INK's buffer see pastingRef.current = true and bail out.
          setTimeout(() => {
            pastingRef.current = false;
          }, 0);
        } else {
          pasteBufRef.current += buf;
          buf = "";
        }
      }

      if (!pastingRef.current) buf = "";
    };
    process.stdin.prependListener("data", handler);
    return () => {
      process.stdin.off("data", handler);
    };
  }, []);

  // Load the model list lazily when the switcher opens; cache afterwards.
  useEffect(() => {
    if (ui.overlay !== "model" || models !== null) return;
    let cancelled = false;
    if (!agent?.listModels) {
      setModels([]);
      return;
    }
    agent
      .listModels()
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [ui.overlay, models, agent]);

  const density = densityForWidth(width);
  const detail = ui.zoom ? "full" : detailForDensity(density);
  const viewRows = activeViewRows(height, promptBarRows(prompt));
  const contentRows = Math.max(2, viewRows - 1);

  const completionItems = completions(prompt, commandRegistry);
  const activeCompletion = completionItems.length > 0;
  const ghost = activeCompletion ? "" : ghostSuffix(prompt, history.all());

  const applyEffect = useCallback(
    async (effect: CommandEffect): Promise<void> => {
      switch (effect.kind) {
        case "message":
          bus.publish({ type: "conversation.message", role: "system", text: effect.text });
          break;
        case "open-overlay":
          uiDispatch({ type: "open-overlay", overlay: effect.overlay });
          break;
        case "focus-view":
          uiDispatch({ type: "focus-view", view: effect.view });
          break;
        case "clear-conversation":
          bus.publish({ type: "conversation.clear" });
          break;
        case "set-model": {
          const previous = store.getState().model.name;
          if (effect.model === previous) break;
          agent?.setModel?.(effect.model);
          bus.publish({ type: "model.changed", name: effect.model });
          if (!agent?.validateModel) {
            bus.publish({ type: "notification", kind: "success", text: `Model: ${effect.model}` });
            break;
          }
          bus.publish({ type: "notification", kind: "info", text: `Validating ${effect.model}…` });
          const result = await agent.validateModel();
          if (result === true) {
            bus.publish({ type: "notification", kind: "success", text: `Model: ${effect.model}` });
          } else {
            agent?.setModel?.(previous);
            bus.publish({ type: "model.changed", name: previous });
            bus.publish({ type: "notification", kind: "error", text: `${effect.model} ${result}` });
          }
          break;
        }
        case "set-tier": {
          const previousTier = store.getState().model.provider;
          if (effect.tier === previousTier) break;
          agent?.setTier?.(effect.tier);
          setModels(null); // invalidate the Ctrl+M cache — it belongs to the old tier
          bus.publish({ type: "model.changed", name: store.getState().model.name, provider: effect.tier });
          bus.publish({ type: "notification", kind: "success", text: `Tier: ${effect.tier}` });
          break;
        }
        case "activate-skill": {
          const registry = agent?.getSkillsRegistry?.();
          const meta = registry?.get(effect.id);
          if (!meta) {
            bus.publish({ type: "notification", kind: "error", text: `Unknown skill: ${effect.id}` });
            break;
          }
          agent?.pinSkill?.(effect.id);
          bus.publish({ type: "notification", kind: "success", text: `Skill pinned: ${meta.name}` });
          break;
        }
        case "init-workspace": {
          const root = workspaceRoot ?? process.cwd();
          const dir = join(root, ".devagent");
          mkdirSync(join(dir, "skills"), { recursive: true });
          writeFileSync(
            join(dir, "config.json"),
            JSON.stringify(
              {
                model: store.getState().model.name,
                tier: store.getState().model.provider,
                host: process.env.OLLAMA_HOST || null,
              },
              null,
              2,
            ),
          );
          bus.publish({ type: "notification", kind: "success", text: `.devagent/ created in ${dir}` });

          const agentsPath = join(root, "AGENTS.md");
          if (!existsSync(agentsPath) && agent) {
            const initPrompt = [
              `I just initialized DevAgent in \`${root}\`. Create \`AGENTS.md\` at the project root — this file tells future DevAgent sessions how to work with this codebase.`,
              "",
              "First explore the project (read key configs, understand the structure, check the tech stack, testing setup, linting rules, build system, etc).",
              "Then write `AGENTS.md` using the write_file tool. Cover:",
              "- Project purpose (brief)",
              "- Tech stack (language, framework, runtime)",
              "- Testing framework and how to run tests",
              "- Linting/formatting conventions",
              "- Build system and commands",
              "- Key directory structure",
              "- Any notable architecture decisions or conventions you observe",
              "",
              "Only create the file if you can successfully explore the project first. Be thorough.",
            ].join("\n");
            bus.publish({ type: "conversation.message", role: "user", text: initPrompt });
            setBusy(true);
            bus.publish({ type: "mode.changed", mode: "streaming" });
            agent
              .runUserMessage(initPrompt)
              .catch(() => {})
              .finally(() => {
                setBusy(false);
                bus.publish({ type: "model.streaming", streaming: false });
                bus.publish({ type: "mode.changed", mode: "idle" });
              });
          }
          break;
        }
        case "reset-context":
          agent?.resetContext?.();
          bus.publish({ type: "notification", kind: "info", text: "Context reset" });
          break;
        case "resume-session": {
          const restored = agent?.resumeSession?.();
          if (!restored || restored.length === 0) {
            bus.publish({ type: "notification", kind: "info", text: "No previous session to resume" });
            break;
          }
          bus.publish({ type: "conversation.clear" });
          for (const m of restored) {
            if (m.role !== "user" && m.role !== "assistant") continue; // skip system/tool noise in the log
            if (!m.content) continue;
            bus.publish({ type: "conversation.message", role: m.role, text: m.content });
          }
          bus.publish({
            type: "notification",
            kind: "success",
            text: `Resumed session (${restored.length} messages)`,
          });
          break;
        }
        case "learn":
          if (agent && agent.addLearning) {
            agent.addLearning("user_preference", "user explicitly typed /learn", effect.rule);
            bus.publish({
              type: "notification",
              kind: "success",
              text: `Learned: ${effect.rule.slice(0, 40)}${effect.rule.length > 40 ? "..." : ""}`,
            });
          } else {
            bus.publish({ type: "notification", kind: "error", text: "Learning not supported by agent" });
          }
          break;
        case "set-agent-mode": {
          const valid = ["ask", "code", "architect", "review", "debug", "autonomous"];
          if (valid.includes(effect.mode)) {
            bus.publish({ type: "mode.agent", mode: effect.mode as any });
            bus.publish({ type: "notification", kind: "info", text: `Mode: ${effect.mode}` });
          }
          break;
        }
        case "run-shell": {
          bus.publish({ type: "conversation.message", role: "user", text: `Run: ${effect.command}` });
          if (agent) {
            setBusy(true);
            bus.publish({ type: "mode.changed", mode: "streaming" });
            agent.runUserMessage(`Run the following shell command and show me the output:\n\n${effect.command}`)
              .catch(() => {})
              .finally(() => {
                setBusy(false);
                bus.publish({ type: "model.streaming", streaming: false });
                bus.publish({ type: "mode.changed", mode: "idle" });
              });
          }
          break;
        }
        case "search":
          uiDispatch({ type: "open-overlay", overlay: "search" });
          break;
        case "next-mode": {
          const modeList = ["ask", "code", "architect", "review", "debug", "autonomous"];
          const current = store.getState().agentMode;
          const idx = modeList.indexOf(current);
          const next = modeList[(idx + 1) % modeList.length];
          bus.publish({ type: "mode.agent", mode: next as any });
          bus.publish({ type: "notification", kind: "info", text: `Mode: ${next}` });
          break;
        }
        case "quit":
          exit();
          break;
        case "error":
          bus.publish({ type: "notification", kind: "error", text: effect.text });
          break;
      }
    },
    [agent, bus, exit, setBusy, store],
  );

  const submitPrompt = useCallback(
    (text: string): void => {
      // "[Pasted text #N +K lines]" is a display-only label PromptBar uses to
      // collapse a paste — the real content is already on the following
      // lines, so drop the label itself before it leaks into the actual
      // message sent to the model / saved to history.
      const withoutPasteLabels = text
        .split("\n")
        .filter((line) => !/^\[Pasted text #\d+ \+\d+ lines\]$/.test(line))
        .join("\n");
      const trimmed = withoutPasteLabels.trim();
      if (!trimmed) return;
      history.add(trimmed);
      try {
        const root = workspaceRoot ?? process.cwd();
        const historyPath = join(root, ".devagent_history");
        writeFileSync(historyPath, history.all().join("\n"), "utf-8");
      } catch {
        // ignore
      }
      setPrompt("");
      setCompletionIndex(0);

      const slash = parseSlashInput(trimmed);
      if (slash) {
        const command = commandRegistry.find(slash.name);
        applyEffect(command ? command.execute(slash.args) : { kind: "error", text: `Unknown command: /${slash.name}` });
        return;
      }

      uiDispatch({ type: "focus-view", view: "conversation" });
      bus.publish({ type: "conversation.message", role: "user", text: trimmed });
      if (!agent) return;
      setBusy(true);
      bus.publish({ type: "mode.changed", mode: "streaming" });
      agent
        .runUserMessage(trimmed)
        .catch((e: unknown) => {
          bus.publish({ type: "error", message: e instanceof Error ? e.message : String(e) });
        })
        .finally(() => {
          setBusy(false);
          bus.publish({ type: "model.streaming", streaming: false });
          bus.publish({ type: "mode.changed", mode: "idle" });
        });
    },
    [agent, applyEffect, bus, commandRegistry, history, uiDispatch],
  );

  const handleCommand = useCallback(
    (command: UiCommand): void => {
      switch (command.type) {
        case "quit":
          exit();
          return;
        case "approve":
        case "reject": {
          const approval = store.getState().approval;
          if (approval) {
            bus.publish({ type: "approval.resolved", id: approval.id, approved: command.type === "approve" });
            bus.publish({
              type: "notification",
              kind: command.type === "approve" ? "success" : "warning",
              text: command.type === "approve" ? "Approved" : "Rejected",
            });
          }
          if (ui.overlay === "diff") uiDispatch({ type: "close-overlay" });
          return;
        }
        case "clear-conversation":
          bus.publish({ type: "conversation.clear" });
          return;
        case "open-mode":
          uiDispatch(command);
          return;
        case "next-mode": {
          const modes: Array<RuntimeState["agentMode"]> = ["ask", "code", "architect", "review", "debug", "autonomous"];
          const current = store.getState().agentMode;
          const idx = modes.indexOf(current);
          const next = modes[(idx + 1) % modes.length];
          bus.publish({ type: "mode.agent", mode: next });
          bus.publish({ type: "notification", kind: "info", text: `Mode: ${next}` });
          return;
        }
        case "cancel":
          setPrompt("");
          setCompletionIndex(0);
          history.stopBrowsing();
          return;
        default:
          uiDispatch(command);
      }
    },
    [bus, exit, history, store, ui.overlay],
  );

  useInput((input, key) => {
    if (pastingRef.current) return; // let the data handler manage paste content
    if (MOUSE_SGR_PATTERN.test(input)) return; // scroll/click artifact, never real text

    const now = Date.now();
    const gapSincePrev = now - lastInputAtRef.current;
    lastInputAtRef.current = now;
    if (gapSincePrev >= FAST_INPUT_MS) sessionStartPromptRef.current = prompt;

    const ctx = { overlay: ui.overlay, promptHasText: prompt.length > 0, mode: state.mode };
    const command = resolveKey(input, key, ctx);
    if (command) {
      handleCommand(command);
      return;
    }
    if (ui.overlay) return; // remaining keys belong to the overlay's own handler

    // Prompt editing.
    if (key.return && key.shift) {
      setPrompt((p) => p + "\n");
      return;
    }
    if (key.return && gapSincePrev < FAST_INPUT_MS) {
      // Too fast to be a deliberate keypress — the terminal is dumping a
      // multi-line paste one line at a time. Treat as a newline within the
      // paste, not a submit; collapse into a placeholder once it goes idle.
      if (!burstActiveRef.current) {
        burstActiveRef.current = true;
        burstStartPromptRef.current = sessionStartPromptRef.current;
      }
      if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
      burstTimerRef.current = setTimeout(finalizeBurst, BURST_IDLE_MS);
      setPrompt((p) => p + "\n");
      return;
    }
    if (key.return && burstActiveRef.current) {
      // A deliberate Enter arrived before the idle debounce fired — cancel
      // the pending collapse and submit the raw (still fully correct) text.
      if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
      burstActiveRef.current = false;
    }
    if (key.return) {
      submitPrompt(prompt);
      return;
    }
    if (key.backspace || key.delete) {
      setPrompt((p) => p.slice(0, -1));
      setCompletionIndex(0);
      history.stopBrowsing();
      return;
    }
    if (key.tab) {
      if (activeCompletion) {
        const item = completionItems[Math.min(completionIndex, completionItems.length - 1)];
        setPrompt(item.insert);
        setCompletionIndex(0);
      } else if (ghost) {
        setPrompt(prompt + ghost);
      }
      return;
    }
    if (key.rightArrow && ghost) {
      setPrompt(prompt + acceptWord(ghost).accepted);
      return;
    }
    if (key.upArrow) {
      if (activeCompletion) setCompletionIndex((i) => Math.max(0, i - 1));
      else setPrompt(history.up(prompt));
      return;
    }
    if (key.downArrow) {
      if (activeCompletion) setCompletionIndex((i) => Math.min(completionItems.length - 1, i + 1));
      else setPrompt(history.down(prompt));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      // Real keystrokes arrive one character at a time; a chunk containing
      // an embedded line break can only be a paste the terminal delivered
      // without bracketed-paste markers (not all terminals emit them), and
      // some encode that break as bare \r rather than \n — normalize (not
      // strip) so it's still detected and collapses the same way.
      const cleaned = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      setPrompt((p) => (cleaned.includes("\n") ? appendPasted(p, cleaned) : p + cleaned));
      setCompletionIndex(0);
    }
  });

  const ActiveView = VIEWS[ui.activeView];
  const approval = state.approval;
  const showApproval = approval != null && (ui.overlay === null || ui.overlay === "diff");
  const viewIndex = VIEW_ORDER.indexOf(ui.activeView) + 1;
  const title = ` ${viewIndex} ${VIEW_LABELS[ui.activeView]} `;
  const rule = "─".repeat(Math.max(0, width - title.length - 2));

  return (
    <Box flexDirection="column" width={width} height={height}>
      <ErrorBoundary>
        <Header state={state} width={width} now={now} />
        <Box flexDirection="column" height={viewRows}>
          <Box height={1}>
            <Text color="gray">{"─"}</Text>
            <Text color="blue" bold>
              {title}
            </Text>
            <Text color="gray" wrap="truncate">
              {rule}
            </Text>
          </Box>
          {showApproval ? (
            <ApprovalOverlay request={approval} width={width} rows={contentRows} showDiff={ui.overlay === "diff"} />
          ) : ui.overlay === "palette" ? (
            <CommandPalette
              registry={commandRegistry}
              width={width}
              rows={contentRows}
              active={true}
              onAction={(effect) => {
                uiDispatch({ type: "close-overlay" });
                applyEffect(effect);
              }}
            />
          ) : ui.overlay === "help" ? (
            <HelpOverlay width={width} rows={contentRows} />
          ) : ui.overlay === "actors" ? (
            <ActorsOverlay state={state} width={width} rows={contentRows} />
          ) : ui.overlay === "model" ? (
            <ModelSwitcher
              current={state.model.name}
              models={models}
              width={width}
              rows={contentRows}
              active={true}
              onSelect={(model) => {
                uiDispatch({ type: "close-overlay" });
                applyEffect({ kind: "set-model", model });
              }}
            />
          ) : ui.overlay === "search" ? (
            <SearchEverywhere
              state={state}
              registry={commandRegistry}
              width={width}
              rows={contentRows}
              active={true}
              onSelect={(view) => {
                uiDispatch({ type: "close-overlay" });
                uiDispatch({ type: "focus-view", view });
              }}
            />
          ) : ui.overlay === "mode" ? (
            <ModeSwitcher
              current={state.agentMode}
              width={width}
              rows={contentRows}
              active={true}
              onSelect={(mode) => {
                uiDispatch({ type: "close-overlay" });
                bus.publish({ type: "mode.agent", mode });
                bus.publish({ type: "notification", kind: "info", text: `Mode: ${mode}` });
              }}
            />
          ) : ui.overlay === "skills" ? (
            <SkillsOverlay
              skills={agent?.getSkillsRegistry?.().list() ?? []}
              width={width}
              rows={contentRows}
              active={true}
              onSelect={(id) => {
                uiDispatch({ type: "close-overlay" });
                applyEffect({ kind: "activate-skill", id });
              }}
            />
          ) : (
            <ActiveView state={state} width={width} rows={contentRows} detail={detail} />
          )}
        </Box>
        <Box height={1}>
          <Text color="gray" dimColor>
            {"─".repeat(Math.max(0, width - 1))}
          </Text>
        </Box>
        <ActivityStrip state={state} width={width} now={now} />
        <Box height={1}>
          <Text color="gray" dimColor>
            {"─".repeat(Math.max(0, width - 1))}
          </Text>
        </Box>
        <PromptBar text={prompt} ghost={ghost} width={width} busy={busy} />
        <ContextStrip
          state={state}
          width={width}
          activeView={ui.activeView}
          completionItems={activeCompletion ? completionItems : undefined}
          completionIndex={completionIndex}
        />
      </ErrorBoundary>
    </Box>
  );
}
