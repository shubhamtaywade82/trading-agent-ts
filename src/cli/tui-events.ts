import chalk from "chalk";
import type { Ora } from "ora";

import type { Agent } from "./agent.js";

/* eslint-disable no-console -- TUI stream output goes to stdout via console.log */

export interface RunState {
  isStreaming: boolean;
  isThinking: boolean;
  lastToolName: string;
  lastToolArgs: Record<string, unknown>;
}

export interface StateRef {
  current: RunState;
}

export interface ToolOutcome {
  outcome: string;
  isError: boolean;
}

type ToolResult = Record<string, unknown> | string;

export function createRunState(): RunState {
  return { isStreaming: false, isThinking: false, lastToolName: "", lastToolArgs: {} };
}

export function attachAgentEvents(agent: Agent, stateRef: StateRef, spinner: Ora): void {
  agent
    .on("onStatus", (status: string) => {
      handleStatus(status, stateRef, spinner);
    })
    .on("onThinking", (thinkingChunk: string) => {
      handleThinking(thinkingChunk, stateRef, spinner);
    })
    .on("onAssistantText", (chunk: string) => {
      handleAssistantText(chunk, stateRef, spinner);
    })
    .on("onToolCall", (name: string, args: Record<string, unknown>) => {
      handleToolCall(name, args, stateRef, spinner);
    })
    .on("onToolResult", (name: string, result: ToolResult) => {
      handleToolResult(name, result, stateRef, spinner);
    })
    .on("onError", (error: Error) => {
      handleError(error, spinner);
    });
}

function handleStatus(status: string, stateRef: StateRef, spinner: Ora): void {
  const s = stateRef.current;
  if (s.isThinking) {
    process.stdout.write("\n");
    s.isThinking = false;
  }
  if (s.isStreaming) {
    process.stdout.write("\n");
    s.isStreaming = false;
  }
  const turnMatch = /^turn (\d+)$/.exec(status);
  const label = turnMatch ? `Thinking (turn ${turnMatch[1] ?? ""})...` : status;
  spinner.text = chalk.cyan(label);
  if (!spinner.isSpinning) spinner.start();
}

function handleThinking(chunk: string, stateRef: StateRef, spinner: Ora): void {
  const s = stateRef.current;
  if (spinner.isSpinning) spinner.stop();
  if (s.isStreaming) {
    process.stdout.write("\n");
    s.isStreaming = false;
  }
  if (!s.isThinking) {
    s.isThinking = true;
    process.stdout.write(chalk.gray.italic(" Thinking: "));
  }
  process.stdout.write(chalk.gray.italic(chunk));
}

function handleAssistantText(chunk: string, stateRef: StateRef, spinner: Ora): void {
  const s = stateRef.current;
  if (spinner.isSpinning) spinner.stop();
  if (s.isThinking) {
    process.stdout.write("\n");
    s.isThinking = false;
  }
  if (!s.isStreaming) {
    s.isStreaming = true;
    process.stdout.write(chalk.magenta.bold(" TradingAgent: "));
  }
  process.stdout.write(chunk);
}

function handleToolCall(name: string, args: Record<string, unknown>, stateRef: StateRef, spinner: Ora): void {
  const s = stateRef.current;
  s.lastToolName = name;
  s.lastToolArgs = args;
  if (s.isThinking) {
    process.stdout.write("\n");
    s.isThinking = false;
  }
  if (s.isStreaming) {
    process.stdout.write("\n");
    s.isStreaming = false;
  }
  if (spinner.isSpinning) spinner.stop();
  spinner.start(chalk.yellow(` Executing [${name}] ${describeToolCall(name, args)}...`));
}

function handleToolResult(name: string, result: ToolResult, stateRef: StateRef, spinner: Ora): void {
  if (spinner.isSpinning) spinner.stop();
  const desc = describeToolCall(name, stateRef.current.lastToolArgs);
  const status = toolOutcome(name, result);
  if (status.isError) {
    spinner.fail(chalk.red(`[${name}] ${desc} (${status.outcome})`));
  } else {
    spinner.succeed(chalk.green(`[${name}] ${desc} (${status.outcome})`));
  }
}

function handleError(error: Error, spinner: Ora): void {
  if (spinner.isSpinning) spinner.stop();
  console.log(chalk.red.bold(` Agent Error: ${error.message}`));
}

function describeToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
    case "write_file": {
      return args["path"] as string;
    }
    case "run_shell": {
      return `"${args["command"] as string}"`;
    }
    default: {
      return "";
    }
  }
}

function toolOutcome(name: string, result: ToolResult): ToolOutcome {
  switch (name) {
    case "read_file": {
      return readFileOutcome(result);
    }
    case "write_file": {
      return writeFileOutcome(result);
    }
    case "run_shell": {
      return runShellOutcome(result);
    }
    default: {
      return defaultOutcome(result);
    }
  }
}

function readFileOutcome(result: ToolResult): ToolOutcome {
  if (typeof result === "string") {
    return { outcome: `${String(result.split("\n").length)} lines read`, isError: false };
  }
  const error = result["error"];
  if (error) return { outcome: toMessage(error), isError: true };
  return { outcome: "", isError: false };
}

function writeFileOutcome(result: ToolResult): ToolOutcome {
  const error = result && typeof result === "object" ? result["error"] : undefined;
  if (error) return { outcome: toMessage(error), isError: true };
  return { outcome: "written successfully", isError: false };
}

function runShellOutcome(result: ToolResult): ToolOutcome {
  if (!result || typeof result !== "object") {
    return { outcome: result, isError: false };
  }
  const code = result["exitCode"] as number;
  const isError = code !== 0;
  let msg = `exit code ${String(code)}`;
  const stderr = result["stderr"];
  if (isError && stderr) msg += ` - ${toMessage(stderr).slice(0, 100).trim()}`;
  return { outcome: msg, isError };
}

function defaultOutcome(result: ToolResult): ToolOutcome {
  const msg = typeof result === "string" ? result : JSON.stringify(result);
  return { outcome: msg, isError: false };
}

function toMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  // Fallback mirrors String(value): objects render via Object.prototype.toString
  return (value as { toString: () => string }).toString();
}
