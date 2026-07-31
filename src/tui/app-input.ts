/**
 * Prompt input machinery for the TUI shell: key handling, paste detection
 * (bracketed markers plus the burst fallback), history creation, and prompt
 * submission. All of it is side-effect-only and render-free — the component
 * tree stays snapshot-stable. FAST_INPUT_MS and BURST_IDLE_MS tune the
 * burst-paste collapse (see the App component for the design notes).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { useInput } from "ink";
import type { Key } from "ink";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

import { acceptWord } from "../interaction/completion.js";
import type { CompletionItem } from "../interaction/completion.js";
import { HistoryManager } from "../interaction/history.js";
import { resolveKey } from "../interaction/keybindings.js";
import type { KeyContext, UiCommand } from "../interaction/keybindings.js";
import { parseSlashInput } from "../interaction/slash-commands.js";
import type { CommandEffect, SlashCommandRegistry } from "../interaction/slash-commands.js";
import type { OverlayId } from "../interaction/ui-state.js";
import type { EventBus } from "../runtime/events.js";
import type { RuntimeMode } from "../runtime/types.js";

import { runAgentTask } from "./app-command-effects.js";
import type { ShellAgent } from "./app-command-effects.js";

const FAST_INPUT_MS = 20;
const BURST_IDLE_MS = 60;
// Built via RegExp so the ESC control character avoids no-control-regex;
// The pattern is a fixed constant string.
// eslint-disable-next-line security/detect-non-literal-regexp
const MOUSE_SGR_PATTERN = new RegExp(String.raw`\x1B?\x5B<\d+;\d+;\d+[Mm]`);
const PASTE_START_MARKER = "\x1B[200~";
const PASTE_END_MARKER = "\x1B[201~";

export interface InputSession {
  prompt: string;
  ghost: string;
  activeCompletion: boolean;
  completionItems: CompletionItem[];
  completionIndex: number;
  overlay: OverlayId | null;
  mode: RuntimeMode;
  history: HistoryManager;
  setPrompt: Dispatch<SetStateAction<string>>;
  setCompletionIndex: Dispatch<SetStateAction<number>>;
  submit: (text: string) => void;
  dispatch: (command: UiCommand) => void;
}

export interface SubmitDeps {
  history: HistoryManager;
  workspaceRoot?: string | undefined;
  setPrompt: Dispatch<SetStateAction<string>>;
  setCompletionIndex: Dispatch<SetStateAction<number>>;
  registry: SlashCommandRegistry;
  applyEffect: (effect: CommandEffect) => void;
  uiDispatch: Dispatch<UiCommand>;
  bus: EventBus;
  agent?: ShellAgent | undefined;
  setBusy: Dispatch<SetStateAction<boolean>>;
}

interface InputRefs {
  buf: RefObject<string>;
  pasteBuf: RefObject<string>;
  pasting: RefObject<boolean>;
  lastInputAt: RefObject<number>;
  sessionStartPrompt: RefObject<string>;
  burstActive: RefObject<boolean>;
  burstStartPrompt: RefObject<string>;
  burstTimer: RefObject<ReturnType<typeof setTimeout> | null>;
  appendPasted: (prev: string, pasted: string) => string;
  finalizeBurst: () => void;
}

/** Loads prompt history (new JSON file plus the legacy flat file) from disk. */
export function createHistory(workspaceRoot?: string): HistoryManager {
  const root = workspaceRoot ?? process.cwd();
  const historyFile = join(root, ".trading-agent", "history.json");
  const legacyPath = join(root, ".trading-agent_history");
  let initialHistory: string[] = [];
  try {
    if (existsSync(legacyPath)) {
      const content = readFileSync(legacyPath, "utf8");
      initialHistory = content.split("\n").filter(Boolean);
    }
  } catch {
    // Ignore
  }
  const mgr = new HistoryManager(initialHistory, 200, historyFile);
  mgr.load();
  return mgr;
}

function appendPastedText(prev: string, pasted: string, count: RefObject<number>): string {
  const lineCount = pasted.split("\n").length;
  if (lineCount <= 1) return prev + pasted;
  count.current += 1;
  const prefix = prev ? `${prev}\n` : "";
  return `${prefix}[Pasted text #${String(count.current)} +${String(lineCount)} lines]\n${pasted}`;
}

function collapseBurst(current: string, start: string, appendPasted: (prev: string, pasted: string) => string): string {
  if (!current.startsWith(start)) return current; // State diverged; leave it alone
  const added = current.slice(start.length).replace(/^\n/, "");
  if (added.split("\n").length <= 1) return current;
  return appendPasted(start, added);
}

/**
 * Detects bracketed paste markers on stdin. Uses prependListener so this
 * handler runs BEFORE Ink's — once pasting is active, useInput bails out and
 * this handler sets the prompt directly.
 */
function useBracketedPaste(refs: InputRefs, setPrompt: Dispatch<SetStateAction<string>>): void {
  useEffect(() => {
    if (!process.stdin.isTTY) return;
    const handler = (data: Buffer): void => {
      handleStdinData(data, refs, setPrompt);
    };
    process.stdin.prependListener("data", handler);
    return () => {
      process.stdin.off("data", handler);
    };
  }, [refs, setPrompt]);
}

function handleStdinData(data: Buffer, refs: InputRefs, setPrompt: Dispatch<SetStateAction<string>>): void {
  refs.buf.current += data.toString();
  if (refs.buf.current.includes(PASTE_START_MARKER)) {
    refs.pasting.current = true;
    refs.pasteBuf.current = "";
    refs.buf.current = refs.buf.current.replace(PASTE_START_MARKER, "");
  }
  if (!refs.pasting.current) {
    refs.buf.current = "";
    return;
  }
  if (!refs.buf.current.includes(PASTE_END_MARKER)) {
    refs.pasteBuf.current += refs.buf.current;
    refs.buf.current = "";
    return;
  }
  const parts = refs.buf.current.split(PASTE_END_MARKER);
  refs.pasteBuf.current += parts[0] ?? "";
  const pasted = refs.pasteBuf.current.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  refs.pasteBuf.current = "";
  setPrompt((p) => refs.appendPasted(p, pasted));
  refs.buf.current = parts.slice(1).join(PASTE_END_MARKER);
  setTimeout(() => {
    refs.pasting.current = false;
  }, 0);
}

function useInputRefs(session: InputSession): InputRefs {
  const bufRef = useRef("");
  const pasteBufRef = useRef("");
  const pastingRef = useRef(false);
  const pasteCountRef = useRef(0);
  const lastInputAtRef = useRef(0);
  const burstActiveRef = useRef(false);
  const burstStartPromptRef = useRef("");
  const burstTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionStartPromptRef = useRef("");
  const appendPasted = useCallback((prev: string, pasted: string): string => appendPastedText(prev, pasted, pasteCountRef), []);
  const finalizeBurst = useCallback(() => { burstActiveRef.current = false; burstTimerRef.current = null; session.setPrompt((current) => collapseBurst(current, burstStartPromptRef.current, appendPasted)); }, [appendPasted, session.setPrompt]);
  useEffect(
    () => () => {
      if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
    },
    [],
  );
  return useMemo<InputRefs>(
    () => ({
      buf: bufRef, pasteBuf: pasteBufRef, pasting: pastingRef, lastInputAt: lastInputAtRef,
      sessionStartPrompt: sessionStartPromptRef, burstActive: burstActiveRef,
      burstStartPrompt: burstStartPromptRef, burstTimer: burstTimerRef, appendPasted, finalizeBurst,
    }),
    [appendPasted, finalizeBurst],
  );
}

/**
 * The shell's keyboard handling. Subscribes Ink's useInput; all prompt
 * editing, paste-burst collapse, and completion/history navigation happens
 * in the module functions below, keeping the App component lean.
 */
export function useInputSession(session: InputSession): void {
  const refs = useInputRefs(session);
  useBracketedPaste(refs, session.setPrompt);
  useInput((input, key) => {
    handleInput(input, key, session, refs);
  });
}

function handleInput(input: string, key: Key, session: InputSession, refs: InputRefs): void {
  if (refs.pasting.current) return; // Let the data handler manage paste content
  if (MOUSE_SGR_PATTERN.test(input)) return; // Scroll/click artifact, never real text

  const gapSincePrev = trackGap(session, refs);
  const ctx: KeyContext = { overlay: session.overlay, promptHasText: session.prompt.length > 0, mode: session.mode };
  const command = resolveKey(input, key, ctx);
  if (command) {
    session.dispatch(command);
    return;
  }
  if (session.overlay) return; // Remaining keys belong to the overlay's own handler

  if (key.return) {
    handleReturnKey(key, gapSincePrev, session, refs);
    return;
  }
  if (handleNavigation(key, session)) return;
  if (input && !key.ctrl && !key.meta) handleTyping(input, session, refs);
}

function trackGap(session: InputSession, refs: InputRefs): number {
  const now = Date.now();
  const gapSincePrev = now - refs.lastInputAt.current;
  refs.lastInputAt.current = now;
  if (gapSincePrev >= FAST_INPUT_MS) refs.sessionStartPrompt.current = session.prompt;
  return gapSincePrev;
}

function handleNavigation(key: Key, session: InputSession): boolean {
  if (key.backspace || key.delete) {
    session.setPrompt((p) => p.slice(0, -1));
    session.setCompletionIndex(0);
    session.history.stopBrowsing();
    return true;
  }
  if (key.tab) {
    handleTab(session);
    return true;
  }
  if (key.rightArrow && session.ghost) {
    session.setPrompt(session.prompt + acceptWord(session.ghost).accepted);
    return true;
  }
  if (key.upArrow) {
    handleArrow(-1, session);
    return true;
  }
  if (key.downArrow) {
    handleArrow(1, session);
    return true;
  }
  return false;
}

function handleReturnKey(key: Key, gapSincePrev: number, session: InputSession, refs: InputRefs): void {
  if (key.shift) {
    session.setPrompt((p) => `${p}\n`);
    return;
  }
  if (gapSincePrev < FAST_INPUT_MS) {
    // Too fast to be a deliberate keypress — the terminal is dumping a
    // Multi-line paste one line at a time. Treat as a newline within the
    // Paste, not a submit; collapse into a placeholder once it goes idle.
    if (!refs.burstActive.current) {
      refs.burstActive.current = true;
      refs.burstStartPrompt.current = refs.sessionStartPrompt.current;
    }
    if (refs.burstTimer.current) clearTimeout(refs.burstTimer.current);
    refs.burstTimer.current = setTimeout(refs.finalizeBurst, BURST_IDLE_MS);
    session.setPrompt((p) => `${p}\n`);
    return;
  }
  if (refs.burstActive.current) {
    // A deliberate Enter arrived before the idle debounce fired — cancel
    // The pending collapse and submit the raw (still fully correct) text.
    if (refs.burstTimer.current) clearTimeout(refs.burstTimer.current);
    refs.burstActive.current = false;
  }
  session.submit(session.prompt);
}

function handleTab(session: InputSession): void {
  if (session.activeCompletion) {
    const item = session.completionItems[Math.min(session.completionIndex, session.completionItems.length - 1)];
    if (item === undefined) return;
    session.setPrompt(item.insert);
    session.setCompletionIndex(0);
  } else if (session.ghost) {
    session.setPrompt(session.prompt + session.ghost);
  }
}

function handleArrow(direction: -1 | 1, session: InputSession): void {
  if (session.activeCompletion) {
    const maxIndex = session.completionItems.length - 1;
    session.setCompletionIndex((i) => (direction < 0 ? Math.max(0, i - 1) : Math.min(maxIndex, i + 1)));
    return;
  }
  session.setPrompt(direction < 0 ? session.history.up(session.prompt) : session.history.down(session.prompt));
}

function handleTyping(input: string, session: InputSession, refs: InputRefs): void {
  // Real keystrokes arrive one character at a time; a chunk containing an
  // Embedded line break can only be a paste delivered without bracketed
  // Markers, and some terminals encode its breaks as bare \r — normalize
  // (not strip) so it's still detected and collapses the same way.
  const cleaned = input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  session.setPrompt((p) => (cleaned.includes("\n") ? refs.appendPasted(p, cleaned) : p + cleaned));
  session.setCompletionIndex(0);
}

function stripPasteLabels(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\[Pasted text #\d+ \+\d+ lines\]$/.test(line))
    .join("\n");
}

function persistLegacyHistory(history: HistoryManager, workspaceRoot?: string): void {
  try {
    const root = workspaceRoot ?? process.cwd();
    const historyPath = join(root, ".trading-agent_history");
    writeFileSync(historyPath, history.all().join("\n"), "utf8");
  } catch {
    // Ignore
  }
}

function runSlashCommand(trimmed: string, deps: SubmitDeps): boolean {
  const slash = parseSlashInput(trimmed);
  if (!slash) return false;
  const command = deps.registry.find(slash.name);
  deps.applyEffect(command ? command.execute(slash.args) : { kind: "error", text: `Unknown command: /${slash.name}` });
  return true;
}

/**
 * Submits the prompt: strips paste placeholders, persists history, routes
 * slash commands to applyEffect, and runs free text through the agent with
 * the streaming lifecycle. "[Pasted text #N +K lines]" is a display-only
 * label PromptBar uses to collapse a paste — the real content is on the
 * following lines, so the label itself must not leak into the message.
 */
export function submitPrompt(text: string, deps: SubmitDeps): void {
  const trimmed = stripPasteLabels(text).trim();
  if (!trimmed) return;
  deps.history.add(trimmed);
  persistLegacyHistory(deps.history, deps.workspaceRoot);
  deps.setPrompt("");
  deps.setCompletionIndex(0);

  if (runSlashCommand(trimmed, deps)) return;

  deps.uiDispatch({ type: "focus-view", view: "conversation" });
  deps.bus.publish({ type: "conversation.message", role: "user", text: trimmed });
  const agent = deps.agent;
  if (!agent) return;
  runAgentTask(() => agent.runUserMessage(trimmed), deps, (error: unknown) => {
    deps.bus.publish({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }).catch(() => {
    // Unreachable: runAgentTask resolves after its own error handling.
  });
}
