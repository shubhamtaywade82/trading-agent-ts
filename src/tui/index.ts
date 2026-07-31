import "dotenv/config";
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { render } from "ink";
import React from "react";

import { Agent } from "../cli/agent.js";
import { loadConfig } from "../cli/config.js";
import { EventBus } from "../runtime/events.js";
import { initialRuntimeState, Store } from "../runtime/store.js";

import { App } from "./App.js";
import type { BridgeableAgent } from "./agent-bridge.js";
import { wireAgentBridge } from "./agent-bridge.js";
function enableTerminalFeatures(): () => void {
  if (!process.stdin.isTTY) return () => {};
  process.stdout.write("\x1B[?1000h\x1B[?1002h\x1B[?1006h\x1B[?2004h");
  return () => {
    process.stdout.write("\x1B[?2004l\x1B[?1006l\x1B[?1002l\x1B[?1000l");
  };
}

function currentBranch(workspaceRoot: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

if (process.env["TRADINGAGENT_DEBUG_STDIN"] === "1" && process.stdin.isTTY) {
  const debugDir = path.join(process.cwd(), ".trading-agent");
  mkdirSync(debugDir, { recursive: true });
  const logPath = path.join(debugDir, "paste-debug.log");
  process.stdin.prependListener("data", (data: Buffer) => {
    appendFileSync(logPath, `${new Date().toISOString()} len=${data.length} ${JSON.stringify(data.toString())}\n`);
  });
}

const cfg = loadConfig();

(async () => {
  const bus = new EventBus();
  const store = new Store(
    initialRuntimeState({
      workspace: path.basename(cfg.workspaceRoot),
      branch: currentBranch(cfg.workspaceRoot),
      model: cfg.model,
      provider: cfg.tier,
    }),
  );
  store.attach(bus);

  const agent = new Agent({ config: cfg });

  // Agent.on<E extends AgentEventName> is structurally compatible with
  // BridgeableAgent.on<E extends string> at runtime (the bridge only uses
  // Event names Agent emits), but TypeScript's generic-method variance rules
  // Reject the assignment statically because AgentEventName is narrower than
  // String. Cast at this single bootstrap boundary.
  wireAgentBridge(agent as unknown as BridgeableAgent, bus);

  const shellAgent = {
    runUserMessage: (message: string) => agent.runUserMessage(message),
    setModel: (model: string) => { agent.setModel(model); },
    setTier: (tier: string) => { agent.setTier(tier); },
    resetContext: () => { agent.resetContext(); },
    listModels: () => agent.listModels(),
    validateModel: () => agent.validateModel(),
    getSkillsRegistry: () => agent.getSkillsRegistry(),
    pinSkill: (id: string | null) => { agent.pinSkill(id); },
  };

  const disableFeatures = enableTerminalFeatures();
  const { waitUntilExit } = render(
    React.createElement(App, { bus, store, agent: shellAgent, workspaceRoot: cfg.workspaceRoot }),
  );
  await waitUntilExit();
  disableFeatures();
})();
