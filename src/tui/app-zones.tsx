/**
 * JSX composition for the TUI shell. Everything here is a plain render
 * function over ShellProps — no hooks, no state — so App keeps the
 * runtime wiring and this module owns the layout tree.
 */

import { Box, Text } from "ink";
import React from "react";

import type { CompletionItem } from "../interaction/completion.js";
import type { UiCommand } from "../interaction/keybindings.js";
import type { CommandEffect, SlashCommandRegistry } from "../interaction/slash-commands.js";
import type { OverlayId, UiState } from "../interaction/ui-state.js";
import type { DetailLevel } from "../layout/density.js";
import type { EventBus } from "../runtime/events.js";
import { VIEW_ORDER } from "../runtime/types.js";
import type { RuntimeState, ViewId } from "../runtime/types.js";

import { ErrorBoundary } from "./ErrorBoundary.js";
import type { ShellAgent } from "./app-command-effects.js";
import { ActorsOverlay } from "./overlays/ActorsOverlay.js";
import { ApprovalOverlay } from "./overlays/ApprovalOverlay.js";
import { CommandPalette } from "./overlays/CommandPalette.js";
import { HelpOverlay } from "./overlays/HelpOverlay.js";
import { ModeSwitcher } from "./overlays/ModeSwitcher.js";
import { ModelSwitcher } from "./overlays/ModelSwitcher.js";
import { SearchEverywhere } from "./overlays/SearchEverywhere.js";
import { SkillsOverlay } from "./overlays/SkillsOverlay.js";
import { ConversationView } from "./views/ConversationView.js";
import type { ViewProps } from "./views/ConversationView.js";
import { ExecutionView } from "./views/ExecutionView.js";
import { FileExplorerView } from "./views/FileExplorerView.js";
import { GitView } from "./views/GitView.js";
import { LogsView } from "./views/LogsView.js";
import { McpView } from "./views/McpView.js";
import { MemoryView } from "./views/MemoryView.js";
import { ModelsView } from "./views/ModelsView.js";
import { SettingsView } from "./views/SettingsView.js";
import { TasksView } from "./views/TasksView.js";
import { ToolTimelineView } from "./views/ToolTimelineView.js";
import { ActivityStrip } from "./zones/ActivityStrip.js";
import { ContextStrip } from "./zones/ContextStrip.js";
import { Header } from "./zones/Header.js";
import { PromptBar } from "./zones/PromptBar.js";

const VIEWS: Record<ViewId, (props: ViewProps) => JSX.Element> = {
  conversation: ConversationView,
  execution: ExecutionView,
  tasks: TasksView,
  git: GitView,
  logs: LogsView,
  memory: MemoryView,
  models: ModelsView,
  mcp: McpView,
  files: FileExplorerView,
  settings: SettingsView,
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
  files: "Files",
  settings: "Settings",
  timeline: "Timeline",
};

export interface ShellProps {
  state: RuntimeState;
  ui: UiState;
  agent?: ShellAgent | undefined;
  models: string[] | null;
  commandRegistry: SlashCommandRegistry;
  detail: DetailLevel;
  width: number;
  height: number;
  now?: number | undefined;
  viewRows: number;
  contentRows: number;
  prompt: string;
  ghost: string;
  busy: boolean;
  completionIndex: number;
  completionItems: CompletionItem[];
  activeCompletion: boolean;
  onEffect: (effect: CommandEffect) => void;
  onUiAction: (action: UiCommand) => void;
  bus: EventBus;
}

function renderHeaderRow(title: string, rule: string): JSX.Element {
  return (
    <Box height={1}>
      <Text color="gray">{"─"}</Text>
      <Text color="blue" bold>
        {title}
      </Text>
      <Text color="gray" wrap="truncate">
        {rule}
      </Text>
    </Box>
  );
}

function renderActiveView(props: ShellProps): JSX.Element {
  const activeView = VIEWS[props.ui.activeView];
  return activeView({ state: props.state, width: props.width, rows: props.contentRows, detail: props.detail });
}

function closeOverlay(props: ShellProps): void {
  props.onUiAction({ type: "close-overlay" });
}

function renderPalette(props: ShellProps): JSX.Element {
  return (
    <CommandPalette
      registry={props.commandRegistry}
      width={props.width}
      rows={props.contentRows}
      active={true}
      onAction={(effect) => {
        closeOverlay(props);
        props.onEffect(effect);
      }}
    />
  );
}

function renderHelp(props: ShellProps): JSX.Element {
  return <HelpOverlay width={props.width} rows={props.contentRows} />;
}

function renderActors(props: ShellProps): JSX.Element {
  return <ActorsOverlay state={props.state} width={props.width} rows={props.contentRows} />;
}

function renderModelSwitcher(props: ShellProps): JSX.Element {
  return (
    <ModelSwitcher
      current={props.state.model.name}
      models={props.models}
      width={props.width}
      rows={props.contentRows}
      active={true}
      onSelect={(model) => {
        closeOverlay(props);
        props.onEffect({ kind: "set-model", model });
      }}
    />
  );
}

function renderSearch(props: ShellProps): JSX.Element {
  return (
    <SearchEverywhere
      state={props.state}
      registry={props.commandRegistry}
      width={props.width}
      rows={props.contentRows}
      active={true}
      onSelect={(view) => {
        closeOverlay(props);
        props.onUiAction({ type: "focus-view", view });
      }}
    />
  );
}

function renderModeSwitcher(props: ShellProps): JSX.Element {
  return (
    <ModeSwitcher
      current={props.state.agentMode}
      width={props.width}
      rows={props.contentRows}
      active={true}
      onSelect={(mode) => {
        closeOverlay(props);
        props.bus.publish({ type: "mode.agent", mode });
        props.bus.publish({ type: "notification", kind: "info", text: `Mode: ${mode}` });
      }}
    />
  );
}

function renderSkills(props: ShellProps): JSX.Element {
  return (
    <SkillsOverlay
      skills={props.agent?.getSkillsRegistry?.().list() ?? []}
      width={props.width}
      rows={props.contentRows}
      active={true}
      onSelect={(id) => {
        closeOverlay(props);
        props.onEffect({ kind: "activate-skill", id });
      }}
    />
  );
}

function renderOverlay(props: ShellProps, overlay: OverlayId): JSX.Element {
  switch (overlay) {
    case "palette": {
      return renderPalette(props);
    }
    case "help": {
      return renderHelp(props);
    }
    case "actors": {
      return renderActors(props);
    }
    case "model": {
      return renderModelSwitcher(props);
    }
    case "search": {
      return renderSearch(props);
    }
    case "mode": {
      return renderModeSwitcher(props);
    }
    case "skills": {
      return renderSkills(props);
    }
    case "diff": {
      return renderActiveView(props);
    }
  }
}

function renderContent(props: ShellProps): JSX.Element {
  const approval = props.state.approval;
  if (approval !== null && (props.ui.overlay === null || props.ui.overlay === "diff")) {
    return (
      <ApprovalOverlay
        request={approval}
        width={props.width}
        rows={props.contentRows}
        showDiff={props.ui.overlay === "diff"}
      />
    );
  }
  if (props.ui.overlay !== null) return renderOverlay(props, props.ui.overlay);
  return renderActiveView(props);
}

function renderSeparator(width: number): JSX.Element {
  return (
    <Box height={1}>
      <Text color="gray" dimColor>
        {"─".repeat(Math.max(0, width - 1))}
      </Text>
    </Box>
  );
}

function renderPromptArea(props: ShellProps): JSX.Element {
  return (
    <>
      <PromptBar text={props.prompt} ghost={props.ghost} width={props.width} busy={props.busy} />
      <ContextStrip
        state={props.state}
        width={props.width}
        activeView={props.ui.activeView}
        completionIndex={props.completionIndex}
        {...(props.activeCompletion ? { completionItems: props.completionItems } : {})}
      />
    </>
  );
}

/** The full shell layout tree; App feeds it state and callbacks each render. */
export function renderShell(props: ShellProps): JSX.Element {
  const viewIndex = VIEW_ORDER.indexOf(props.ui.activeView) + 1;
  const title = ` ${String(viewIndex)} ${VIEW_LABELS[props.ui.activeView]} `;
  const rule = "─".repeat(Math.max(0, props.width - title.length - 2));
  return (
    <Box flexDirection="column" width={props.width} height={props.height}>
      <ErrorBoundary>
        <Header state={props.state} width={props.width} {...(props.now !== undefined && { now: props.now })} />
        <Box flexDirection="column" height={props.viewRows}>
          {renderHeaderRow(title, rule)}
          {renderContent(props)}
        </Box>
        {renderSeparator(props.width)}
        <ActivityStrip state={props.state} width={props.width} {...(props.now !== undefined && { now: props.now })} />
        {renderSeparator(props.width)}
        {renderPromptArea(props)}
      </ErrorBoundary>
    </Box>
  );
}
