import * as path from "node:path";

import boxen from "boxen";
import chalk from "chalk";
import ora from "ora";

import { Agent } from "./agent.js";
import type { CliConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { attachAgentEvents, createRunState } from "./tui-events.js";
import type { StateRef } from "./tui-events.js";
import { listModels, ModelAccess } from "./tui-models.js";
import { makeRepl } from "./tui-repl.js";

/* eslint-disable no-console -- TUI startup banner is user-facing stdout output */

export async function startTui(opts?: { config?: Partial<CliConfig> }): Promise<void> {
  const cfg = { ...loadConfig(), ...opts?.config };
  const agent = new Agent({ config: cfg });

  const stateRef: StateRef = { current: createRunState() };
  const modelAccess = new ModelAccess(path.join(cfg.workspaceRoot, ".trading-agent", "models.json"));
  modelAccess.load();

  const spinner = ora({ color: "cyan", spinner: "dots" });
  attachAgentEvents(agent, stateRef, spinner);

  const modelsList = await listModels(cfg.host, cfg.tier);
  printBanner(agent, cfg);

  const repl = makeRepl({ agent, cfg, modelAccess, stateRef, spinner, modelsList });
  repl.updatePrompt();
  repl.rl.prompt();
}

function printBanner(agent: Agent, cfg: CliConfig): void {
  const bannerText = [
    chalk.bold.magenta("⚡ TradingAgent TS Ecosystem CLI ⚡"),
    "",
    `${chalk.bold("Model:")}      ${chalk.cyan(agent.currentModel)}`,
    `${chalk.bold("Workspace:")}  ${chalk.gray(cfg.workspaceRoot)}`,
    `${chalk.bold("Host:")}       ${chalk.gray(cfg.host ?? "default local Ollama")}`,
    `${chalk.bold("Tools:")}      ${chalk.yellow(
      [...agent.getRegistry().schemas()].map((s) => s.function.name).join(", "),
    )}`,
    "",
    chalk.dim("Press [Tab] for commands, type /help, or use Ctrl-C to quit."),
  ].join("\n");

  console.log(
    boxen(bannerText, {
      padding: 1,
      margin: { top: 1, bottom: 1, left: 0, right: 0 },
      borderColor: "magenta",
      borderStyle: "double",
      title: "TradingAgent",
      titleAlignment: "center",
    }),
  );
}
