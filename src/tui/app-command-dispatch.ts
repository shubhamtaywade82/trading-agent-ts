/**
 * Keybinding command dispatch for the TUI shell.
 *
 * dispatchCommand() handles the UiCommands that need shell state (approval
 * resolution, quit/clear/next-mode, cancel) and passes everything else
 * straight to the ui reducer. Side-effect-only — it never renders.
 */

import type { Dispatch, SetStateAction } from "react";

import type { HistoryManager } from "../interaction/history.js";
import type { UiCommand } from "../interaction/keybindings.js";
import type { OverlayId } from "../interaction/ui-state.js";
import type { EventBus } from "../runtime/events.js";
import type { Store } from "../runtime/store.js";

import { cycleNextMode, notify } from "./app-command-effects.js";

export interface CommandDeps {
  bus: EventBus;
  store: Store;
  exit: () => void;
  overlay: OverlayId | null;
  uiDispatch: Dispatch<UiCommand>;
  setPrompt: Dispatch<SetStateAction<string>>;
  setCompletionIndex: Dispatch<SetStateAction<number>>;
  history: HistoryManager;
}

type ApproveRejectCommand = Extract<UiCommand, { type: "approve" } | { type: "reject" }>;

function handleApproval(command: ApproveRejectCommand, deps: CommandDeps): void {
  const approved = command.type === "approve";
  const approval = deps.store.getState().approval;
  if (approval) {
    deps.bus.publish({ type: "approval.resolved", id: approval.id, approved });
    notify(deps.bus, approved ? "success" : "warning", approved ? "Approved" : "Rejected");
  }
  if (deps.overlay === "diff") deps.uiDispatch({ type: "close-overlay" });
}

const handleCommandNextMode: CommandHandlerMap["next-mode"] = (_command, deps) => {
  cycleNextMode(deps.store, deps.bus);
};

function handleCommandCancel(_command: Extract<UiCommand, { type: "cancel" }>, deps: CommandDeps): void {
  deps.setPrompt("");
  deps.setCompletionIndex(0);
  deps.history.stopBrowsing();
}

const handleCommandQuit: CommandHandlerMap["quit"] = (_command, deps) => {
  deps.exit();
};

const handleCommandClear: CommandHandlerMap["clear-conversation"] = (_command, deps) => {
  deps.bus.publish({ type: "conversation.clear" });
};

const passThrough: (command: UiCommand, deps: CommandDeps) => void = (command, deps) => {
  deps.uiDispatch(command);
};

type CommandHandlerMap = {
  [K in UiCommand["type"]]: (command: Extract<UiCommand, { type: K }>, deps: CommandDeps) => void;
};

const COMMAND_HANDLERS: CommandHandlerMap = {
  quit: handleCommandQuit,
  approve: handleApproval,
  reject: handleApproval,
  "clear-conversation": handleCommandClear,
  "open-mode": passThrough,
  "next-mode": handleCommandNextMode,
  cancel: handleCommandCancel,
  "focus-view": passThrough,
  "next-view": passThrough,
  "prev-view": passThrough,
  "open-overlay": passThrough,
  "close-overlay": passThrough,
  "toggle-zoom": passThrough,
  "view-diff": passThrough,
};

/** Handles a keybinding UiCommand; unhandled chords go to the ui reducer. */
export function dispatchCommand(command: UiCommand, deps: CommandDeps): void {
  callCommandHandler(command.type, command, deps);
}

function callCommandHandler<K extends UiCommand["type"]>(
  type: K,
  command: Extract<UiCommand, { type: K }>,
  deps: CommandDeps,
): void {
  COMMAND_HANDLERS[type](command, deps);
}
