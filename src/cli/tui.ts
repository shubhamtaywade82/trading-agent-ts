import "dotenv/config";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import ora from "ora";
import boxen from "boxen";
import { marked } from "marked";
import TerminalRenderer from "marked-terminal";

import { Agent } from "./agent.js";
import { CliConfig, loadConfig } from "./config.js";

// Setup marked terminal styling for premium aesthetics
marked.setOptions({
  renderer: new TerminalRenderer({
    code: chalk.yellow,
    blockquote: chalk.gray.italic,
    html: chalk.gray,
    heading: chalk.bold.cyan,
    firstHeading: chalk.bold.cyan,
    link: chalk.blue,
    href: chalk.blue.underline,
    listitem: (text: string) => ` • ${text}`,
    tab: 2,
  }) as any,
});

async function listModels(host: string | undefined, tier: string): Promise<string[]> {
  const base = host ?? (tier === "cloud" ? "https://ollama.com" : process.env.OLLAMA_HOST ?? "http://localhost:11434");
  const path = tier === "cloud" ? "/v1/models" : "/api/tags";
  try {
    const resp = await fetch(`${base}${path}`);
    if (!resp.ok) return [];
    if (tier === "cloud") {
      const data = (await resp.json()) as { data?: Array<{ id: string }> };
      return (data.data ?? []).map((m) => m.id);
    }
    const data = (await resp.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

export async function startTui(opts?: { config?: Partial<CliConfig> }): Promise<void> {
  const cfg = { ...loadConfig(), ...(opts?.config ?? {}) };
  const agent = new Agent({ config: cfg });

  // Per-run state for event handlers (one run at a time)
  let runState = { isStreaming: false, isThinking: false, lastToolName: "", lastToolArgs: {} as Record<string, any> };

  // Model accessibility cache: true = free/accessible, false = requires subscription
  const modelCachePath = path.join(cfg.workspaceRoot, ".devagent", "models.json");
  const modelAccess = new Map<string, boolean>();

  function loadModelCache(): void {
    try {
      const raw = fs.readFileSync(modelCachePath, "utf-8");
      const data = JSON.parse(raw) as Record<string, boolean>;
      for (const [m, free] of Object.entries(data)) modelAccess.set(m, free);
    } catch {
      // no cache yet
    }
  }

  function saveModelCache(): void {
    try {
      const data: Record<string, boolean> = {};
      for (const [m, free] of modelAccess) data[m] = free;
      fs.writeFileSync(modelCachePath, JSON.stringify(data, null, 2), "utf-8");
    } catch {
      // ignore write errors
    }
  }

  loadModelCache();

  async function probeModels(models: string[]): Promise<void> {
    const toProbe = models.filter((m) => !modelAccess.has(m));
    if (!toProbe.length) return;
    const base = cfg.host ?? "https://ollama.com";
    const url = `${base}/api/chat`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    const probeOne = async (m: string): Promise<[string, boolean]> => {
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: m, messages: [{ role: "user", content: "." }], stream: false }),
          signal: AbortSignal.timeout(25_000),
        });
        if (resp.status === 429) return [m, true];
        if (resp.status === 200) {
          const body = await resp.json() as any;
          const errMsg = typeof body?.error === "string" ? body.error : "";
          if (errMsg.includes("subscription") || errMsg.includes("upgrade")) return [m, false];
          return [m, true];
        }
        const text = await resp.text();
        return [m, !(text.includes("subscription") || text.includes("upgrade"))];
      } catch {
        return [m, true];
      }
    };
    const results = await Promise.allSettled(toProbe.map(probeOne));
    for (const r of results) {
      if (r.status === "fulfilled") modelAccess.set(r.value[0], r.value[1]);
    }
    saveModelCache();
  }

  agent
    .on("onStatus", (status: string) => {
      const s = runState;
      if (s.isThinking) { process.stdout.write("\n"); s.isThinking = false; }
      if (s.isStreaming) { process.stdout.write("\n"); s.isStreaming = false; }
      const turnMatch = status.match(/^turn (\d+)$/);
      const label = turnMatch ? `Thinking (turn ${turnMatch[1]})...` : status;
      spinner.text = chalk.cyan(label);
      if (!spinner.isSpinning) spinner.start();
    })
    .on("onThinking", (thinkingChunk: string) => {
      const s = runState;
      if (spinner.isSpinning) spinner.stop();
      if (s.isStreaming) { process.stdout.write("\n"); s.isStreaming = false; }
      if (!s.isThinking) { s.isThinking = true; process.stdout.write(chalk.gray.italic(" Thinking: ")); }
      process.stdout.write(chalk.gray.italic(thinkingChunk));
    })
    .on("onAssistantText", (chunk: string) => {
      const s = runState;
      if (spinner.isSpinning) spinner.stop();
      if (s.isThinking) { process.stdout.write("\n"); s.isThinking = false; }
      if (!s.isStreaming) { s.isStreaming = true; process.stdout.write(chalk.magenta.bold(" DevAgent: ")); }
      process.stdout.write(chunk);
    })
    .on("onToolCall", (name: string, args: Record<string, unknown>) => {
      const s = runState;
      s.lastToolName = name;
      s.lastToolArgs = args;
      if (s.isThinking) { process.stdout.write("\n"); s.isThinking = false; }
      if (s.isStreaming) { process.stdout.write("\n"); s.isStreaming = false; }
      if (spinner.isSpinning) spinner.stop();
      let desc = "";
      if (name === "read_file") desc = args.path as string;
      else if (name === "write_file") desc = args.path as string;
      else if (name === "run_shell") desc = `"${args.command}"`;
      spinner.start(chalk.yellow(` Executing [${name}] ${desc}...`));
    })
    .on("onToolResult", (name: string, result: Record<string, unknown> | string) => {
      const s = runState;
      if (spinner.isSpinning) spinner.stop();
      let desc = "";
      if (name === "read_file") desc = s.lastToolArgs.path as string;
      else if (name === "write_file") desc = s.lastToolArgs.path as string;
      else if (name === "run_shell") desc = `"${s.lastToolArgs.command}"`;
      let outcome = "";
      let isError = false;
      if (name === "read_file") {
        if (typeof result === "string") outcome = `${result.split("\n").length} lines read`;
        else if (result && result.error) { outcome = String(result.error); isError = true; }
      } else if (name === "write_file") {
        const resObj = result as any;
        if (resObj && resObj.error) { outcome = String(resObj.error); isError = true; }
        else outcome = "written successfully";
      } else if (name === "run_shell") {
        if (result && typeof result === "object") {
          const code = result.exitCode as number;
          isError = code !== 0;
          outcome = `exit code ${code}`;
          if (isError && result.stderr) outcome += ` - ${String(result.stderr).substring(0, 100).trim()}`;
        } else outcome = String(result);
      } else outcome = typeof result === "string" ? result : JSON.stringify(result);
      if (isError) spinner.fail(chalk.red(`[${name}] ${desc} (${outcome})`));
      else spinner.succeed(chalk.green(`[${name}] ${desc} (${outcome})`));
    })
    .on("onError", (error: Error) => {
      if (spinner.isSpinning) spinner.stop();
      console.log(chalk.red.bold(` Agent Error: ${error.message}`));
    });

  // Pre-fetch models list for autocomplete support
  const modelsList = await listModels(cfg.host, cfg.tier);

  // Render a high-fidelity startup banner
  const bannerText = [
    chalk.bold.magenta("⚡ DevAgent TS Ecosystem CLI ⚡"),
    "",
    `${chalk.bold("Model:")}      ${chalk.cyan(agent.currentModel)}`,
    `${chalk.bold("Workspace:")}  ${chalk.gray(cfg.workspaceRoot)}`,
    `${chalk.bold("Host:")}       ${chalk.gray(cfg.host ?? "default local Ollama")}`,
    `${chalk.bold("Tools:")}      ${chalk.yellow(
      [...agent.getRegistry().schemas()].map((s) => s.function.name).join(", ")
    )}`,
    "",
    chalk.dim("Press [Tab] for commands, type /help, or use Ctrl-C to quit.")
  ].join("\n");

  console.log(
    boxen(bannerText, {
      padding: 1,
      margin: { top: 1, bottom: 1, left: 0, right: 0 },
      borderColor: "magenta",
      borderStyle: "double",
      title: "DevAgent",
      titleAlignment: "center",
    })
  );

  // Tab completion implementation
  const completer = (line: string) => {
    const completions = ["/help", "/models", "/model ", "/clear", "/reset", "/exit", "/quit"];
    
    if (line.startsWith("/model ")) {
      const partialModel = line.slice("/model ".length);
      const modelHits = modelsList.filter((m) => m.startsWith(partialModel));
      return [modelHits.map((m) => `/model ${m}`), line];
    }

    const hits = completions.filter((c) => c.startsWith(line));
    return [hits.length ? hits : completions, line];
  };

  const historyPath = path.join(cfg.workspaceRoot, ".devagent_history");
  let initialHistory: string[] = [];
  try {
    if (fs.existsSync(historyPath)) {
      const content = fs.readFileSync(historyPath, "utf-8");
      initialHistory = content
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    }
  } catch {
    // Ignore history load errors
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer,
  });

  // Assign history and ensure uniqueness
  const seenHistory = new Set<string>();
  (rl as any).history = initialHistory.filter((item) => {
    const trimmed = item.trim();
    if (seenHistory.has(trimmed)) return false;
    seenHistory.add(trimmed);
    return true;
  });

  const saveHistory = () => {
    try {
      const seen = new Set<string>();
      const uniqueHistory = ((rl as any).history as string[]).filter((item) => {
        const trimmed = item.trim();
        if (!trimmed || trimmed.startsWith("/") || seen.has(trimmed)) {
          return false;
        }
        seen.add(trimmed);
        return true;
      });
      fs.writeFileSync(historyPath, uniqueHistory.join("\n"), "utf-8");
    } catch {
      // Ignore history save errors
    }
  };

  const updatePrompt = () => {
    rl.setPrompt(
      chalk.magenta.bold("devagent-ts") +
        " " +
        chalk.cyan(`(${agent.currentModel})`) +
        chalk.green.bold(" ❯ ")
    );
  };

  updatePrompt();
  rl.prompt();

  const spinner = ora({
    color: "cyan",
    spinner: "dots",
  });

  rl.on("line", async (raw) => {
    saveHistory();

    const text = raw.trim();
    if (!text) {
      rl.prompt();
      return;
    }

    // Command handling
    if (text.startsWith("/")) {
      if (text === "/help") {
        const helpText = [
          chalk.bold.blue("💡 Available Commands:"),
          "",
          `${chalk.cyan("/model <name>")}  Switch Ollama model for this session`,
          `${chalk.cyan("/models")}        List available models tagged Free/Subscription`,
          `${chalk.cyan("/clear")}         Clear the terminal screen`,
          `${chalk.cyan("/reset")}         Reset conversation history`,
          `${chalk.cyan("/exit")}          Exit DevAgent`,
          `${chalk.cyan("/quit")}          Exit DevAgent`,
        ].join("\n");
        console.log(
          boxen(helpText, {
            padding: 1,
            margin: { top: 0, bottom: 1, left: 0, right: 0 },
            borderColor: "blue",
            borderStyle: "round",
          })
        );
        rl.prompt();
        return;
      }

      if (text === "/exit" || text === "/quit") {
        rl.close();
        return;
      }

      if (text === "/clear") {
        console.clear();
        rl.prompt();
        return;
      }

      if (text === "/reset") {
        agent.resetContext();
        console.log(chalk.green("✔ Conversation history has been reset."));
        rl.prompt();
        return;
      }

      if (text === "/models") {
        console.log(chalk.dim("Fetching available models..."));
        let models: string[];
        try {
          models = await listModels(cfg.host, cfg.tier);
        } catch {
          models = [];
        }
        if (models.length === 0) {
          console.log(chalk.red("✖ No models found or Ollama is unreachable."));
        } else {
          console.log(chalk.dim("Probing model accessibility..."));
          await probeModels(models);
          console.log(chalk.bold("\nAvailable Ollama Models:"));
          for (const m of models) {
            const tag = modelAccess.get(m);
            if (tag === false) {
              console.log(` - ${chalk.dim(m)} ${chalk.red("(Subscription)")}`);
            } else if (tag === true) {
              console.log(` - ${chalk.cyan(m)} ${chalk.green("(Free)")}`);
            } else {
              console.log(` - ${chalk.cyan(m)} ${chalk.dim("(Untested)")}`);
            }
          }
          console.log();
        }
        rl.prompt();
        return;
      }

      if (text.startsWith("/model ")) {
        const modelName = text.slice("/model ".length).trim();
        if (!modelName) {
          console.log(chalk.red("✖ Usage: /model <model_name>"));
          rl.prompt();
          return;
        }
        if (modelAccess.get(modelName) === false) {
          console.log(chalk.red(`✖ ${modelName} requires a subscription — upgrade at https://ollama.com/upgrade`));
          updatePrompt();
          rl.prompt();
          return;
        }
        const prevModel = agent.currentModel;
        agent.setModel(modelName);
        console.log(chalk.dim(`Probing ${modelName}...`));
        const status = await agent.validateModel();
        modelAccess.set(modelName, status === true);
        saveModelCache();
        if (status !== true) {
          agent.setModel(prevModel);
          console.log(chalk.red(`✖ ${modelName} ${status}`));
          updatePrompt();
          rl.prompt();
          return;
        }
        console.log(chalk.green(`✔ Switched model to: ${chalk.bold(agent.currentModel)}`));
        updatePrompt();
        rl.prompt();
        return;
      }

      if (text.startsWith("/tier ")) {
        const tierValue = text.slice("/tier ".length).trim();
        if (!["local", "cloud"].includes(tierValue)) {
          console.log(chalk.red("✖ Usage: /tier local|cloud"));
          rl.prompt();
          return;
        }
        (agent as any).provider.setTier?.(tierValue);
        console.log(chalk.green(`✔ Switched tier to: ${chalk.bold(tierValue)}`));
        updatePrompt();
        rl.prompt();
        return;
      }

      if (text.startsWith("/host ")) {
        const hostValue = text.slice("/host ".length).trim();
        if (!hostValue) {
          console.log(chalk.red("✖ Usage: /host <url>"));
          rl.prompt();
          return;
        }
        (agent as any).provider.setRuntimeHost?.(hostValue);
        console.log(chalk.green(`✔ Switched host to: ${chalk.bold(hostValue)}`));
        updatePrompt();
        rl.prompt();
        return;
      }

      console.log(chalk.red(`✖ Unknown command: ${text}. Type /help for available commands.`));
      rl.prompt();
      return;
    }

    // Pause readline input to avoid overlapping prompts/keypresses during agent run
    rl.pause();

    // Reset per-run state and execute
    runState = { isStreaming: false, isThinking: false, lastToolName: "", lastToolArgs: {} };
    spinner.start("Initializing task execution...");
    try {
      await agent.runUserMessage(text);
      
      if (spinner.isSpinning) {
        spinner.stop();
      }
      if (runState.isThinking) {
        process.stdout.write("\n");
        runState.isThinking = false;
      }
      if (runState.isStreaming) {
        process.stdout.write("\n");
        runState.isStreaming = false;
      }
      console.log(); // trailing newline for spacing
    } catch (e) {
      if (spinner.isSpinning) {
        spinner.stop();
      }
      console.error(chalk.red(`\n✖ Execution aborted: ${(e as Error).message}\n`));
    } finally {
      // Resume user input
      rl.resume();
      updatePrompt();
      rl.prompt();
    }
  });

  rl.on("close", () => {
    console.log(chalk.cyan("\nGoodbye! 👋\n"));
    process.exit(0);
  });

  rl.on("SIGINT", () => {
    rl.close();
  });
}
