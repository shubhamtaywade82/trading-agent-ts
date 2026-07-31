/**
 * TUI shell hub. Owns the runtime wiring (store subscription, terminal
 * size, reducer, history, model list) and feeds it to the extracted
 * modules: app-command-effects (side effects), app-command-dispatch
 * (keybinding commands), app-input (prompt/paste/keyboard), app-zones
 * (the layout tree). App.js keeps the public entry surface stable.
 */

import { useApp, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { Dispatch, JSX, SetStateAction } from "react";

import { completions, ghostSuffix } from "../interaction/completion.js";
import type { CompletionItem } from "../interaction/completion.js";
import type { HistoryManager } from "../interaction/history.js";
import type { UiCommand } from "../interaction/keybindings.js";
import type { CommandEffect, SlashCommandRegistry } from "../interaction/slash-commands.js";
import { builtinCommands } from "../interaction/slash-commands.js";
import { initialUiState, uiReduce } from "../interaction/ui-state.js";
import type { OverlayId } from "../interaction/ui-state.js";
import { activeViewRows, densityForWidth, detailForDensity } from "../layout/density.js";
import type { EventBus } from "../runtime/events.js";
import type { Store } from "../runtime/store.js";
import type { RuntimeState } from "../runtime/types.js";

import { dispatchCommand } from "./app-command-dispatch.js";
import { applyEffect as applyEffectCmd } from "./app-command-effects.js";
import type { ShellAgent } from "./app-command-effects.js";
import { createHistory, submitPrompt, useInputSession } from "./app-input.js";
import type { InputSession } from "./app-input.js";
import { renderShell } from "./app-zones.js";
import { promptBarRows } from "./zones/PromptBar.js";

export type { ShellAgent } from "./app-command-effects.js";

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

function useTerminalSize(columns?: number, rows?: number): { width: number; height: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    width: columns ?? (stdout.columns || 100),
    height: rows ?? (stdout.rows || 30),
  });
  useEffect(
    () => {
      if (columns !== undefined && rows !== undefined) return;
      const onResize = (): void => {
        setSize({ width: columns ?? (stdout.columns || 100), height: rows ?? (stdout.rows || 30) });
      };
      stdout.on("resize", onResize);
      return () => {
        stdout.off("resize", onResize);
      };
    },
    [stdout, columns, rows],
  );
  if (columns !== undefined && rows !== undefined) return { width: columns, height: rows };
  return size;
}

// Ink 3 bundles a React 17-era reconciler without useSyncExternalStore,
// So subscribe the classic way. The re-sync inside the effect catches any
// Events published between first render and subscription.
//
// Streaming responses publish one bus event per token (see agent-bridge.ts).
// Real tokens arrive on separate event-loop turns (real network/inference
// Latency between them), not in a same-tick burst — same-tick coalescing
// (the previous approach here) does nothing for that case, since there's
// Only ever one event per turn to coalesce. Calling setState on every single
// Token is what causes the flicker: Ink 3's renderer isn't a real diffing
// Engine, so every commit is close to a full-screen repaint.
//
// Real fix: a leading+trailing time-window throttle, independent of how the
// Events are spaced. The first update in a quiet period renders immediately
// (stays responsive); anything within RENDER_THROTTLE_MS of the last render
// Is deferred to a single trailing flush instead of one render each.
const RENDER_THROTTLE_MS = 50; // ~20fps cap — well above flicker threshold, still feels live
function useRuntimeState(store: Store): RuntimeState {
  const [state, setState] = useState<RuntimeState>(() => store.getState());
  useEffect(
    () => {
      setState(store.getState());
      let lastFlush = 0;
      let pendingTimer: ReturnType<typeof setTimeout> | null = null;
      const flush = (): void => {
        pendingTimer = null;
        lastFlush = Date.now();
        setState(store.getState());
      };
      const unsubscribe = store.subscribe(() => {
        if (pendingTimer) return; // A trailing flush is already scheduled — it'll pick up this update
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
    },
    [store],
  );
  return state;
}

/** Lazy-loads the model list when the model switcher opens; caches afterwards. */
function useModelList(agent: ShellAgent | undefined, overlay: OverlayId | null): [string[] | null, Dispatch<SetStateAction<string[] | null>>] {
  const [models, setModels] = useState<string[] | null>(null);
  useEffect(
    () => {
      if (overlay !== "model" || models !== null) return;
      const listModels = agent?.listModels;
      if (!listModels) {
        setModels([]);
        return;
      }
      let cancelled = false;
      const loadModels = async (): Promise<void> => {
        const list = await listModels();
        if (!cancelled) setModels(list);
      };
      loadModels().catch(() => {
        if (!cancelled) setModels([]);
      });
      return () => {
        cancelled = true;
      };
    },
    [overlay, models, agent],
  );
  return [models, setModels];
}

interface PromptState {
  prompt: string;
  setPrompt: Dispatch<SetStateAction<string>>;
  completionIndex: number;
  setCompletionIndex: Dispatch<SetStateAction<number>>;
  completionItems: CompletionItem[];
  activeCompletion: boolean;
  ghost: string;
}

function usePromptState(history: HistoryManager, commandRegistry: SlashCommandRegistry): PromptState {
  const [prompt, setPrompt] = useState("");
  const [completionIndex, setCompletionIndex] = useState(0);
  const completionItems = completions(prompt, commandRegistry);
  const activeCompletion = completionItems.length > 0;
  const ghost = activeCompletion ? "" : ghostSuffix(prompt, history.all());
  return { prompt, setPrompt, completionIndex, setCompletionIndex, completionItems, activeCompletion, ghost };
}

// React components are PascalCase; this config's naming-convention has no
// ReactComponents exception (repo-wide pre-existing pattern).
// eslint-disable-next-line @typescript-eslint/naming-convention
export function App({ bus, store, agent, registry, columns, rows, now, workspaceRoot }: AppProps): JSX.Element {
  const { exit } = useApp();
  const state = useRuntimeState(store);
  const { width, height } = useTerminalSize(columns, rows);
  const [ui, uiDispatch] = useReducer(uiReduce, undefined, initialUiState);
  const [busy, setBusy] = useState(false);
  const [history] = useState(() => createHistory(workspaceRoot));
  const commandRegistry = useMemo(() => registry ?? builtinCommands(), [registry]);
  const [models, setModels] = useModelList(agent, ui.overlay);
  const promptState = usePromptState(history, commandRegistry);

  const density = densityForWidth(width);
  const detail = ui.zoom ? "full" : detailForDensity(density);
  const viewRows = activeViewRows(height, promptBarRows(promptState.prompt));
  const contentRows = Math.max(2, viewRows - 1);

  const applyEffect = useCallback((effect: CommandEffect): void => { applyEffectCmd(effect, { agent, bus, exit, setBusy, setModels, store, uiDispatch, workspaceRoot }); }, [agent, bus, exit, setBusy, setModels, store, uiDispatch, workspaceRoot]);
  const handleCommand = useCallback((command: UiCommand): void => { dispatchCommand(command, { bus, exit, history, overlay: ui.overlay, setCompletionIndex: promptState.setCompletionIndex, setPrompt: promptState.setPrompt, store, uiDispatch }); }, [bus, exit, history, promptState.setCompletionIndex, promptState.setPrompt, store, ui.overlay, uiDispatch]);
  const submit = useCallback((text: string): void => { submitPrompt(text, { agent, applyEffect, bus, history, registry: commandRegistry, setBusy, setCompletionIndex: promptState.setCompletionIndex, setPrompt: promptState.setPrompt, uiDispatch, workspaceRoot }); }, [agent, applyEffect, bus, commandRegistry, history, setBusy, promptState.setCompletionIndex, promptState.setPrompt, uiDispatch, workspaceRoot]);

  const session = useMemo<InputSession>(
    () => ({ activeCompletion: promptState.activeCompletion, completionIndex: promptState.completionIndex, completionItems: promptState.completionItems, dispatch: handleCommand, ghost: promptState.ghost, history, mode: state.mode, overlay: ui.overlay, prompt: promptState.prompt, setCompletionIndex: promptState.setCompletionIndex, setPrompt: promptState.setPrompt, submit }),
    [handleCommand, history, promptState.activeCompletion, promptState.completionIndex, promptState.completionItems, promptState.ghost, promptState.prompt, promptState.setCompletionIndex, promptState.setPrompt, state.mode, submit, ui.overlay],
  );
  useInputSession(session);

  return renderShell({ activeCompletion: promptState.activeCompletion, agent, busy, bus, commandRegistry, completionIndex: promptState.completionIndex, completionItems: promptState.completionItems, contentRows, detail, ghost: promptState.ghost, height, models, now, onEffect: applyEffect, onUiAction: uiDispatch, prompt: promptState.prompt, state, ui, viewRows, width });
}
