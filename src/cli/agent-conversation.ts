import { ChatMessage } from "../provider/provider.js";
import { CliConfig } from "./config.js";
import { SkillContent } from "../skills/types.js";

interface LearningEntry {
  category: string;
  lesson: string;
}

export class AgentConversation {
  private messages: ChatMessage[] = [];

  buildSystemPrompt(config: CliConfig, learnings: LearningEntry[], _skills: SkillContent[]): string {
    const learningsBlock = learnings.length > 0
      ? "\n\n[Recalled Past Learnings & User Preferences]:\n" +
        learnings.map((l) => `- [${l.category}] Lesson: ${l.lesson}`).join("\n")
      : "";

    return (
      (config.systemPrompt ?? "") +
      learningsBlock +
      "\n\nTrading rules:\n" +
      "1) Call exactly one tool per turn when appropriate. Prefer data-driven, quantitative analysis.\n" +
      "2) For market analysis, use technical indicators (binance_technical_indicators) and order book data (binance_order_book) over raw klines.\n" +
      "3) Backtest strategies before paper trading them. Validate assumptions with historical data.\n" +
      "4) Think step by step. Test hypotheses before declaring them done. If unsure, use analysis tools to confirm.\n" +
      "5) Monitor positions, track P&L, and manage risk. Set stop-losses for paper trades.\n" +
      "6) After tool results, continue toward the user's stated goal with minimal next steps."
    );
  }

  init(config: CliConfig, learnings: LearningEntry[], skills: SkillContent[]): void {
    const header = this.buildSystemPrompt(config, learnings, skills);
    this.messages = [{ role: "system", content: header }];
  }

  refreshSystemPrompt(config: CliConfig, learnings: LearningEntry[], skills: SkillContent[]): void {
    const header = this.buildSystemPrompt(config, learnings, skills);
    if (this.messages.length > 0 && this.messages[0].role === "system") {
      this.messages[0].content = header;
    } else {
      this.messages.unshift({ role: "system", content: header });
    }
  }

  injectSkill(skill: SkillContent): void {
    this.messages.push({ role: "system", content: `Skill: ${skill.name}\n\n${skill.body}` });
  }

  pushUserMessage(content: string): void {
    this.messages.push({ role: "user", content });
  }

  pushAssistantMessage(content: string, tool_calls?: ChatMessage["tool_calls"]): void {
    this.messages.push({ role: "assistant", content, tool_calls } as ChatMessage);
  }

  pushToolResult(content: string): void {
    this.messages.push({ role: "tool", content });
  }

  pushSystemMessage(content: string): void {
    this.messages.push({ role: "user", content });
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  /** Replaces the whole transcript, e.g. when resuming a persisted session.
   * The next runUserMessage call refreshes message[0]'s system prompt in
   * place via refreshSystemPrompt, so a stale saved prompt self-heals. */
  loadMessages(messages: ChatMessage[]): void {
    this.messages = messages;
  }

  pruneContext(maxMessages = 25): void {
    if (this.messages.length <= maxMessages) return;

    const systemPrompt = this.messages[0];
    const recent = this.messages.slice(-10);
    const middle = this.messages.slice(1, -10);

    const toolRunCount = middle.filter((m) => m.role === "tool").length;
    const summaryText = `[system] Bypassed ${middle.length} intermediate turns (${toolRunCount} tool calls) to save context window.`;

    this.messages = [
      systemPrompt,
      { role: "system", content: summaryText },
      ...recent,
    ];
  }

  reset(): void {
    this.messages = [];
  }

  isEmpty(): boolean {
    return this.messages.length === 0;
  }
}
