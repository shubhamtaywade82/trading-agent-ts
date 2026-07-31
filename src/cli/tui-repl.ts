import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

import chalk from "chalk";
import type { Ora } from "ora";

import type { Agent } from "./agent.js";
import type { CliConfig } from "./config.js";
import { handleLine } from "./tui-commands.js";
import type { ReplContext } from "./tui-commands.js";
import type { StateRef } from "./tui-events.js";
import type { ModelAccess } from "./tui-models.js";

/* eslint-disable no-console -- TUI output goes to stdout via console.log */

export interface ReplOptions {
  agent: Agent;
  cfg: CliConfig;
  modelAccess: ModelAccess;
  stateRef: StateRef;
  spinner: Ora;
  modelsList: string[];
}

export function makeRepl(opts: ReplOptions): ReplContext {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: makeCompleter(opts.modelsList),
  });
  const historyPath = path.join(opts.cfg.workspaceRoot, ".trading-agent_history");
  applyHistory(rl, loadHistory(historyPath));

  const ctx: ReplContext = {
    rl,
    agent: opts.agent,
    cfg: opts.cfg,
    modelAccess: opts.modelAccess,
    stateRef: opts.stateRef,
    spinner: opts.spinner,
    saveHistory: () => {
      saveHistoryFile(rl, historyPath);
    },
    updatePrompt: () => {
      updatePrompt(rl, opts.agent);
    },
  };

  attachLineHandler(ctx);
  attachCloseHandler(ctx);
  return ctx;
}

function attachLineHandler(ctx: ReplContext): void {
  ctx.rl.on("line", (raw: string): void => {
    handleLine(ctx, raw).catch((error: unknown) => {
      console.error(toErrorMessage(error));
    });
  });
}

function attachCloseHandler(ctx: ReplContext): void {
  ctx.rl.on("close", () => {
    console.log(chalk.cyan("\nGoodbye! 👋\n"));
    // eslint-disable-next-line n/no-process-exit -- process must exit once stdin closes: lingering handles keep Node alive
    process.exit(0);
  });
  ctx.rl.on("SIGINT", () => {
    ctx.rl.close();
  });
}

function toErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
}

function makeCompleter(modelsList: string[]): readline.Completer {
  return (line: string) => {
    const completions = ["/help", "/models", "/model ", "/clear", "/reset", "/exit", "/quit"];
    if (line.startsWith("/model ")) {
      const partialModel = line.slice("/model ".length);
      const modelHits = modelsList.filter((m) => m.startsWith(partialModel));
      return [modelHits.map((m) => `/model ${m}`), line];
    }
    const hits = completions.filter((c) => c.startsWith(line));
    return [hits.length ? hits : completions, line];
  };
}

function loadHistory(historyPath: string): string[] {
  try {
    if (!fs.existsSync(historyPath)) return [];
    const content = fs.readFileSync(historyPath, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // Ignore history load errors
    return [];
  }
}

function applyHistory(rl: readline.Interface, history: string[]): void {
  const seenHistory = new Set<string>();
  (rl as unknown as { history: string[] }).history = history.filter((item) => {
    const trimmed = item.trim();
    if (seenHistory.has(trimmed)) return false;
    seenHistory.add(trimmed);
    return true;
  });
}

function saveHistoryFile(rl: readline.Interface, historyPath: string): void {
  try {
    const seen = new Set<string>();
    const uniqueHistory = (rl as unknown as { history: string[] }).history.filter((item) => {
      const trimmed = item.trim();
      if (!trimmed || trimmed.startsWith("/") || seen.has(trimmed)) {
        return false;
      }
      seen.add(trimmed);
      return true;
    });
    fs.writeFileSync(historyPath, uniqueHistory.join("\n"), "utf8");
  } catch {
    // Ignore history save errors
  }
}

function updatePrompt(rl: readline.Interface, agent: Agent): void {
  rl.setPrompt(
    `${chalk.magenta.bold("trading-agent-ts")} ${chalk.cyan(`(${agent.currentModel})`)}${chalk.green.bold(" ❯ ")}`,
  );
}
