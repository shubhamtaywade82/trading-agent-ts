import type * as readline from "node:readline";

import boxen from "boxen";
import chalk from "chalk";
import type { Ora } from "ora";

import type { Agent } from "./agent.js";
import type { CliConfig } from "./config.js";
import { createRunState } from "./tui-events.js";
import type { StateRef } from "./tui-events.js";
import { listModels } from "./tui-models.js";
import type { ModelAccess } from "./tui-models.js";

/* eslint-disable no-console -- TUI command output is user-facing stdout text */

export interface ReplContext {
  rl: readline.Interface;
  agent: Agent;
  cfg: CliConfig;
  modelAccess: ModelAccess;
  stateRef: StateRef;
  spinner: Ora;
  saveHistory: () => void;
  updatePrompt: () => void;
}

export async function handleLine(ctx: ReplContext, raw: string): Promise<void> {
  ctx.saveHistory();
  const text = raw.trim();
  if (!text) {
    ctx.rl.prompt();
    return;
  }
  if (text.startsWith("/")) {
    await runCommand(ctx, text);
    return;
  }
  ctx.rl.pause();
  ctx.stateRef.current = createRunState();
  ctx.spinner.start("Initializing task execution...");
  try {
    await ctx.agent.runUserMessage(text);
    finishRun(ctx);
    console.log();
  } catch (e) {
    const message = (e as Error).message;
    console.error(chalk.red(`\n✖ Execution aborted: ${message}\n`));
  } finally {
    ctx.rl.resume();
    ctx.updatePrompt();
    ctx.rl.prompt();
  }
}

function finishRun(ctx: ReplContext): void {
  const s = ctx.stateRef.current;
  if (ctx.spinner.isSpinning) ctx.spinner.stop();
  if (s.isThinking) {
    process.stdout.write("\n");
    s.isThinking = false;
  }
  if (s.isStreaming) {
    process.stdout.write("\n");
    s.isStreaming = false;
  }
}

type SyncCommand = (ctx: ReplContext) => void;
type AsyncCommand = (ctx: ReplContext) => Promise<void>;

const SYNC_COMMANDS: Record<string, SyncCommand> = {
  "/help": printHelp,
  "/clear": clearScreen,
  "/reset": resetConversation,
  "/exit": exitRepl,
  "/quit": exitRepl,
};

const ASYNC_COMMANDS: Record<string, AsyncCommand> = {
  "/models": listModelsCommand,
};

async function runCommand(ctx: ReplContext, text: string): Promise<void> {
  const sync = SYNC_COMMANDS[text];
  const asyncCmd = ASYNC_COMMANDS[text];
  if (sync) {
    sync(ctx);
    return;
  }
  if (asyncCmd) {
    await asyncCmd(ctx);
    return;
  }
  if (text.startsWith("/model ")) {
    await switchModel(ctx, text.slice("/model ".length).trim());
    return;
  }
  if (text.startsWith("/tier ")) {
    switchTier(ctx, text.slice("/tier ".length).trim());
    return;
  }
  if (text.startsWith("/host ")) {
    switchHost(ctx, text.slice("/host ".length).trim());
    return;
  }
  console.log(chalk.red(`✖ Unknown command: ${text}. Type /help for available commands.`));
  ctx.rl.prompt();
}

function exitRepl(ctx: ReplContext): void {
  ctx.rl.close();
}

function printHelp(ctx: ReplContext): void {
  const helpText = [
    chalk.bold.blue("💡 Available Commands:"),
    "",
    `${chalk.cyan("/model <name>")}  Switch Ollama model for this session`,
    `${chalk.cyan("/models")}        List available models tagged Free/Subscription`,
    `${chalk.cyan("/clear")}         Clear the terminal screen`,
    `${chalk.cyan("/reset")}         Reset conversation history`,
    `${chalk.cyan("/exit")}          Exit TradingAgent`,
    `${chalk.cyan("/quit")}          Exit TradingAgent`,
  ].join("\n");

  console.log(
    boxen(helpText, {
      padding: 1,
      margin: { top: 0, bottom: 1, left: 0, right: 0 },
      borderColor: "blue",
      borderStyle: "round",
    }),
  );
  ctx.rl.prompt();
}

function clearScreen(ctx: ReplContext): void {
  console.clear();
  ctx.rl.prompt();
}

function resetConversation(ctx: ReplContext): void {
  ctx.agent.resetContext();
  console.log(chalk.green("✔ Conversation history has been reset."));
  ctx.rl.prompt();
}

async function listModelsCommand(ctx: ReplContext): Promise<void> {
  console.log(chalk.dim("Fetching available models..."));
  const models = await listModels(ctx.cfg.host, ctx.cfg.tier);
  if (models.length === 0) {
    console.log(chalk.red("✖ No models found or Ollama is unreachable."));
  } else {
    console.log(chalk.dim("Probing model accessibility..."));
    await ctx.modelAccess.probe(models, ctx.cfg.host, ctx.cfg.apiKey);
    console.log(chalk.bold("\nAvailable Ollama Models:"));
    for (const m of models) printModelRow(m, ctx.modelAccess.get(m));
    console.log();
  }
  ctx.rl.prompt();
}

function printModelRow(model: string, tag: boolean | undefined): void {
  if (tag === false) {
    console.log(` - ${chalk.dim(model)} ${chalk.red("(Subscription)")}`);
  } else if (tag === true) {
    console.log(` - ${chalk.cyan(model)} ${chalk.green("(Free)")}`);
  } else {
    console.log(` - ${chalk.cyan(model)} ${chalk.dim("(Untested)")}`);
  }
}

async function switchModel(ctx: ReplContext, modelName: string): Promise<void> {
  if (!modelName) {
    printUsage(ctx, "✖ Usage: /model <model_name>");
    return;
  }
  if (ctx.modelAccess.get(modelName) === false) {
    console.log(chalk.red(`✖ ${modelName} requires a subscription — upgrade at https://ollama.com/upgrade`));
    ctx.updatePrompt();
    ctx.rl.prompt();
    return;
  }
  const prevModel = ctx.agent.currentModel;
  ctx.agent.setModel(modelName);
  console.log(chalk.dim(`Probing ${modelName}...`));
  const status = await ctx.agent.validateModel();
  ctx.modelAccess.set(modelName, status === true);
  ctx.modelAccess.save();
  if (status !== true) {
    ctx.agent.setModel(prevModel);
    console.log(chalk.red(`✖ ${modelName} ${status}`));
  } else {
    console.log(chalk.green(`✔ Switched model to: ${chalk.bold(ctx.agent.currentModel)}`));
  }
  ctx.updatePrompt();
  ctx.rl.prompt();
}

function switchTier(ctx: ReplContext, tierValue: string): void {
  if (!["local", "cloud"].includes(tierValue)) {
    printUsage(ctx, "✖ Usage: /tier local|cloud");
    return;
  }
  ctx.agent.setTier(tierValue);
  console.log(chalk.green(`✔ Switched tier to: ${chalk.bold(tierValue)}`));
  ctx.updatePrompt();
  ctx.rl.prompt();
}

function switchHost(ctx: ReplContext, hostValue: string): void {
  if (!hostValue) {
    printUsage(ctx, "✖ Usage: /host <url>");
    return;
  }
  ctx.agent.setRuntimeHost(hostValue);
  console.log(chalk.green(`✔ Switched host to: ${chalk.bold(hostValue)}`));
  ctx.updatePrompt();
  ctx.rl.prompt();
}

function printUsage(ctx: ReplContext, text: string): void {
  console.log(chalk.red(text));
  ctx.rl.prompt();
}
