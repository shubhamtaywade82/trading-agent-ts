import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { CliConfig, loadConfig } from "./config.js";
import { Provider, ChatMessage } from "../provider/provider.js";
import { Router } from "../provider/router.js";
import { Capability, ModelCatalog } from "../provider/catalog.js";
import { CheckpointStore, sanitizeResumedSteps } from "../runtime/checkpoint.js";
import { SessionStore } from "../runtime/session.js";
import { LoopDetector } from "../orchestrator/loop-detector.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { AgentStepRunner } from "../orchestrator/agent-planner.js";
import { PlanStep, Planner } from "../orchestrator/types.js";
import { SkillMeta } from "../skills/types.js";
import { MemoryStore } from "../memory/store.js";
import { generateSummary } from "../memory/summarizer.js";
import { AgentConversation } from "./agent-conversation.js";
import { AgentToolManager } from "./agent-tools.js";
import { AgentLearning } from "./agent-learning.js";
import { DynamicToolSelector } from "../tools/discovery.js";
import { BrowserManager } from "../browser/manager.js";
import { BinanceStreamManager } from "../exchange/binance-stream.js";

export interface AgentEvents {
  onAssistantText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: Record<string, unknown>) => void;
  onError?: (error: Error) => void;
  onStatus?: (status: string) => void;
  onShellOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  onMemorySummary?: (summary: string) => void;
  onSkillsActivated?: (skills: SkillMeta[]) => void;
}

type AgentEventName = keyof AgentEvents;
type AgentEventHandler<E extends AgentEventName> = NonNullable<AgentEvents[E]>;

export interface AgentOptions {
  config?: Partial<CliConfig>;
  events?: AgentEvents;
  skillsHomeDir?: string;
}

export class Agent {
  readonly conversation: AgentConversation;
  readonly tools: AgentToolManager;
  readonly learning: AgentLearning;
  readonly memory: MemoryStore;
  readonly browser: BrowserManager;
  readonly binanceStream: BinanceStreamManager;
  private readonly toolSelector: DynamicToolSelector;

  private readonly provider: Provider;
  private readonly catalog: ModelCatalog;
  private readonly router: Router;
  private catalogRefreshed: Promise<void> | null = null;
  private readonly planCheckpoint: CheckpointStore;
  private readonly sessionStore: SessionStore;
  private readonly loopDetector = new LoopDetector();
  private readonly maxToolTurns = 128;
  readonly events: AgentEvents;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(opts: AgentOptions = {}) {
    const cfg = { ...loadConfig(), ...(opts.config ?? {}) };

    this.provider = new Provider({
      tier: cfg.tier,
      model: cfg.model,
      host: cfg.host,
      apiKey: cfg.apiKey,
      apiKeys: cfg.apiKeys,
      ...(cfg.timeoutMs ? { timeoutMs: cfg.timeoutMs } : {}),
    });

    // Separate provider pool for capability-routed delegation (see classifyCapability),
    // kept independent of `this.provider` so the primary conversation's model/tier is
    // never mutated. Cloud provider is omitted entirely when no API key is configured.
    const localProvider = new Provider({
      tier: "local",
      model: cfg.model,
      host: cfg.tier === "local" ? cfg.host : undefined,
      apiKeys: cfg.apiKeys,
      ...(cfg.timeoutMs ? { timeoutMs: cfg.timeoutMs } : {}),
    });
    const cloudProvider = cfg.apiKey
      ? new Provider({
          tier: "cloud",
          model: cfg.model,
          host: cfg.tier === "cloud" ? cfg.host : undefined,
          apiKey: cfg.apiKey,
          apiKeys: cfg.apiKeys,
          ...(cfg.timeoutMs ? { timeoutMs: cfg.timeoutMs } : {}),
        })
      : undefined;

    this.catalog = new ModelCatalog(localProvider, cloudProvider);
    this.router = new Router({
      local: localProvider,
      cloud: cloudProvider,
      catalog: this.catalog,
      logger: { warn: (msg: string) => this.emit("onStatus", msg) },
    });

    this.events = opts.events ?? {};

    this.conversation = new AgentConversation();

    this.tools = new AgentToolManager();
    this.tools.registerBaseTools(cfg.workspaceRoot, (stream, chunk) =>
      this.emit("onShellOutput", stream, chunk),
    );

    this.browser = new BrowserManager();
    this.tools.registerBrowserTools(this.browser);
    this.binanceStream = new BinanceStreamManager();
    this.tools.registerBinanceStreamTools(this.binanceStream);

    const devagentDir = join(cfg.workspaceRoot, ".devagent");
    mkdirSync(devagentDir, { recursive: true });

    this.memory = new MemoryStore(join(devagentDir, "memory.db"));
    this.planCheckpoint = new CheckpointStore(join(devagentDir, "checkpoint.json"));
    this.sessionStore = new SessionStore(join(devagentDir, "session.json"));

    this.learning = new AgentLearning({
      workspaceRoot: cfg.workspaceRoot,
      provider: this.provider,
      memory: this.memory,
      skillsHomeDir: opts.skillsHomeDir,
    });

    this.toolSelector = new DynamicToolSelector({
      mode: cfg.toolSelectionMode,
      maxActiveTools: cfg.maxActiveTools,
      provider: this.provider,
    });
  }

  on<E extends AgentEventName>(event: E, handler: AgentEventHandler<E>): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler as (...args: unknown[]) => void);
    this.listeners.set(event, set);
    return this;
  }

  private emit<E extends AgentEventName>(event: E, ...args: Parameters<AgentEventHandler<E>>): void {
    if (event === "onToolCall") {
      this.learning.learning.recorder.onToolCall(args[0] as string, args[1] as Record<string, unknown>);
    } else if (event === "onToolResult") {
      this.learning.learning.recorder.onToolResult(args[0] as string, args[1] as Record<string, unknown>);
    } else if (event === "onError") {
      this.learning.learning.recorder.onError(args[0] as Error);
    }

    (this.events[event] as ((...a: typeof args) => void) | undefined)?.(...args);
    this.listeners.get(event)?.forEach((h) => h(...args));
  }

  async runUserMessage(userMessage: string, priority?: PlanStep["priority"]): Promise<string> {
    const learnings = this.learning.getLearnings();
    const activatedSkills = this.learning.resolveForPrompt(userMessage);

    if (this.conversation.isEmpty()) {
      const cfg = loadConfig();
      this.conversation.init(cfg, learnings, activatedSkills);
    } else {
      const cfg = loadConfig();
      this.conversation.refreshSystemPrompt(cfg, learnings, activatedSkills);
    }

    for (const skill of activatedSkills) {
      this.conversation.injectSkill(skill);
    }
    if (activatedSkills.length) {
      this.emit(
        "onSkillsActivated",
        activatedSkills.map((s) => ({ id: s.id, name: s.name, description: s.description, tags: s.tags, version: s.version, scope: s.scope, dir: s.dir, path: s.path })),
      );
    }

    this.learning.learning.recorder.begin(
      userMessage,
      activatedSkills.map((skill) => skill.id),
    );

    this.conversation.pushUserMessage(userMessage);
    this.learning.appendMessage("user", userMessage);

    let lastAssistantText = "";
    let success = true;
    let episodeEnded = false;
    const finish = (terminal: Parameters<typeof this.learning.learning.onEpisodeEnd>[0], text: string): string => {
      if (!episodeEnded) {
        this.learning.learning.onEpisodeEnd(terminal, text);
        episodeEnded = true;
      }
      // Persist the transcript after every turn (not just success) so a
      // killed/restarted process can resume with the model still remembering
      // this turn — mirrors the plan checkpoint's "save progress as you go".
      this.sessionStore.save(this.conversation.getMessages());
      return text;
    };

    const capability = this.classifyCapability(priority, userMessage);
    if (capability) await this.ensureCatalog();
    const delegateCandidates = capability ? this.catalog.modelsFor(capability) : [];
    if (delegateCandidates.length) {
      this.emit("onStatus", `delegating task to ${delegateCandidates[0].tier}/${delegateCandidates[0].name}`);
    }

    try {
      for (let toolTurn = 0; toolTurn < this.maxToolTurns; toolTurn++) {
        this.conversation.pruneContext();
        this.emit("onStatus", `turn ${toolTurn + 1}`);

        const activeTools = await this.toolSelector.selectTools(
          userMessage,
          this.conversation.getMessages(),
          this.tools.registry.getTools(),
        );

        const chatOpts = {
          stream: true,
          tools: activeTools.length > 0 ? activeTools.map((t) => t.schema) : undefined,
          onChunk: (chunk: any) => {
            const delta = chunk.message?.content;
            if (typeof delta === "string" && delta) {
              lastAssistantText += delta;
              this.emit("onAssistantText", delta);
            }
            const thinking = (chunk.message as any)?.thinking;
            if (typeof thinking === "string" && thinking) {
              this.emit("onThinking", thinking);
            }
          },
        };
        const chatResponse = delegateCandidates.length
          ? await this.router.route(capability!, this.conversation.getMessages(), chatOpts)
          : await this.provider.chat(this.conversation.getMessages(), chatOpts);

        const assistantMessage = chatResponse.message as {
          content?: string;
          tool_calls?: Array<{ function: { name: string; arguments: any } }>;
        };
        this.conversation.pushAssistantMessage(assistantMessage.content ?? "", assistantMessage.tool_calls);

        const toolCalls = assistantMessage.tool_calls ?? [];
        const hasContent = (assistantMessage.content ?? "").trim().length > 0;

        if (!toolCalls.length) {
          if (hasContent) {
            this.learning.appendMessage("assistant", lastAssistantText);
            this.triggerSummarization();
            return finish("answered", lastAssistantText);
          }
          if (toolTurn < this.maxToolTurns - 1) {
            this.conversation.pushSystemMessage(
              "[system] You were thinking but produced no action or response. Please continue toward the goal: call a tool or provide your final answer now.",
            );
            continue;
          }
          return finish("answered", lastAssistantText || "(no response)");
        }

        for (const toolCall of toolCalls) {
          const name = toolCall.function.name;
          const rawArguments = toolCall.function.arguments;
          let args: Record<string, unknown> = {};

          if (typeof rawArguments === "object" && rawArguments !== null) {
            args = rawArguments as Record<string, unknown>;
          } else if (typeof rawArguments === "string" && rawArguments) {
            try {
              args = JSON.parse(rawArguments);
            } catch {
              // leave args empty on malformed JSON
            }
          }

          this.emit("onToolCall", name, args);

          try {
            const result = await this.tools.registry.invoke(name, args);

            if (result.error === "PathEscapeError") {
              this.conversation.pushToolResult(
                JSON.stringify({ error: "PathEscapeError", message: result.message }, null, 2),
              );
              this.emit("onToolResult", name, result);
              this.conversation.pushSystemMessage(
                "[system] The previous tool call escaped the workspace root. Retry with a path under the current workspace root.",
              );

              if (typeof result.error === "string" && this.loopDetector.record(name, args, result.error)) {
                return finish(
                  "loop_abort",
                  lastAssistantText + "\n[aborted] tool loop detected after repeated escapes.",
                );
              }
              continue;
            }

            this.emit("onToolResult", name, result);
            this.conversation.pushToolResult(
              typeof result === "string" ? result : JSON.stringify(result, null, 2),
            );

            if (typeof result.error === "string" && this.loopDetector.record(name, args, result.error)) {
              return finish("loop_abort", lastAssistantText + "\n[aborted] tool loop detected after repeated: " + name);
            }
            if (toolTurn === this.maxToolTurns - 1) {
              return finish("turn_budget", lastAssistantText || "(no response)");
            }
          } catch (e) {
            const err = e as Error;
            this.emit("onError", err);
            this.conversation.pushToolResult(
              JSON.stringify({ error: err.constructor.name, message: err.message }, null, 2),
            );
          }
        }
      }

      return finish("turn_budget", lastAssistantText || "(tool budget exceeded)");
    } catch (e) {
      success = false;
      finish("error", lastAssistantText);
      throw e;
    } finally {
      for (const skill of activatedSkills) this.learning.recordSkillUse(skill.id, success);
    }
  }

  pinSkill(id: string | null): void {
    this.learning.pinSkill(id);
  }

  getSkillsRegistry() {
    return this.learning.getSkillsRegistry();
  }

  flushLearning(): Promise<void> {
    return this.learning.flushLearning();
  }

  async runPlannedTask(steps: PlanStep[], planner: Planner): Promise<PlanStep[]> {
    const orchestrator = new Orchestrator({
      steps,
      runner: new AgentStepRunner(this),
      planner,
      runRollback: async (command: string) => {
        await this.runUserMessage(`Roll back by running exactly this: ${command}`);
      },
      checkpoint: this.planCheckpoint,
    });
    return orchestrator.run();
  }

  /**
   * Resume a plan interrupted by a crash or kill. Returns null if no
   * checkpoint exists (nothing to resume). Non-terminal step statuses are
   * reset to "pending" — the process died mid-step, so its outcome is unknown.
   */
  async resumePlannedTask(planner: Planner): Promise<PlanStep[] | null> {
    const saved = this.planCheckpoint.load();
    if (!saved) return null;

    const orchestrator = new Orchestrator({
      steps: sanitizeResumedSteps(saved.steps),
      runner: new AgentStepRunner(this),
      planner,
      runRollback: async (command: string) => {
        await this.runUserMessage(`Roll back by running exactly this: ${command}`);
      },
      checkpoint: this.planCheckpoint,
    });
    return orchestrator.run();
  }

  hasResumablePlan(): boolean {
    return this.planCheckpoint.load() !== null;
  }

  setModel(model: string): void {
    this.provider.setModel(model);
    this.conversation.reset();
  }

  setModelWithoutReset(model: string): void {
    this.provider.setModel(model);
  }

  // ponytail: keyword classification, not an LLM intent classifier — cheap and
  // deterministic. Falls back to the primary model whenever the catalog has no
  // candidate for the detected capability (e.g. no vision model installed), so
  // a wrong or missed classification never breaks the turn, only skips routing.
  private static readonly VISION_PATTERN = /\b(screenshot|diagram|image|photo|picture)\b|\.(png|jpe?g|gif|webp)\b/;
  private static readonly REASONING_PATTERN =
    /\b(architecture|trade-?offs?|root cause|design decision|why does|why is|think through|deep dive)\b/;

  private classifyCapability(priority?: string, text?: string): Capability | null {
    const desc = (text || "").toLowerCase();

    if (Agent.VISION_PATTERN.test(desc)) return "vision";
    if (Agent.REASONING_PATTERN.test(desc)) return "reasoning";

    const isNonCritical =
      priority === "low" ||
      priority === "medium" ||
      desc.includes("document") ||
      desc.includes("readme") ||
      desc.includes("comment") ||
      desc.includes("test") ||
      desc.includes("cleanup") ||
      desc.includes("lint");

    return isNonCritical ? "quick" : null;
  }

  // Refreshed once, on first delegation attempt, and cached for the Agent's lifetime.
  private ensureCatalog(): Promise<void> {
    if (!this.catalogRefreshed) {
      this.catalogRefreshed = this.catalog.refresh().then(() => undefined);
    }
    return this.catalogRefreshed;
  }

  addLearning(category: string, context: string, lesson: string): void {
    this.learning.addLearning(category, context, lesson);
  }

  async validateModel(): Promise<true | string> {
    try {
      await this.provider.chat([{ role: "user", content: "respond with just a single dot" }], { stream: false });
      return true;
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (msg.includes("403") && msg.includes("subscription")) {
        return "requires a subscription — upgrade at https://ollama.com/upgrade";
      }
      return `unreachable: ${msg}`;
    }
  }

  setTier(tier: string): void {
    this.provider.setTier(tier as any);
  }

  setRuntimeHost(host: string): void {
    this.provider.setRuntimeHost(host);
  }

  get currentModel(): string {
    return this.provider.currentModel;
  }

  get currentTier(): string {
    return this.provider.currentTier;
  }

  async listModels(): Promise<string[]> {
    const data = await this.provider.availableModels();
    if (this.provider.currentTier === "cloud") {
      const cloud = data as { data?: Array<{ id: string }> };
      return (cloud.data ?? []).map((m) => m.id);
    }
    const local = data as { models?: Array<{ name: string }> };
    return (local.models ?? []).map((m) => m.name);
  }

  resetContext(): void {
    this.conversation.reset();
    this.sessionStore.clear();
  }

  hasResumableSession(): boolean {
    return this.sessionStore.load() !== null;
  }

  /** Restores a persisted conversation transcript, e.g. after a crash/restart.
   * Returns the restored messages (for replaying into the TUI's visible chat
   * log) or null if there was nothing to resume. */
  resumeSession(): ChatMessage[] | null {
    const saved = this.sessionStore.load();
    if (!saved) return null;
    this.conversation.loadMessages(saved);
    return saved;
  }

  private isSummarizing = false;

  private triggerSummarization(): void {
    if (this.isSummarizing) return;
    this.isSummarizing = true;
    generateSummary(this.memory, this.provider)
      .then((summary) => this.emit("onMemorySummary", summary))
      .catch((e) => this.emit("onError", e instanceof Error ? e : new Error(String(e))))
      .finally(() => {
        this.isSummarizing = false;
      });
  }

  getRegistry() {
    return this.tools.registry;
  }

  async registerMcpServer(command: string, args: string[] = []): Promise<void> {
    await this.tools.registerMcpServer(command, args);
  }
}
