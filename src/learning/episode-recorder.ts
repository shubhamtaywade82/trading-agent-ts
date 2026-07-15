import { randomUUID } from "node:crypto";
import { Episode, ToolEvent } from "./types.js";

/**
 * Builds one Episode per runUserMessage call by observing the Agent's
 * existing event surface. It stores compact outcomes rather than full tool
 * payloads, keeping persisted traces cheap and safe to reflect on.
 */
export class EpisodeRecorder {
  private current: Episode | null = null;
  private pendingCall: { name: string; args: Record<string, unknown>; at: number } | null = null;

  begin(goal: string, activatedSkillIds: string[]): void {
    this.current = {
      id: randomUUID(),
      goal: goal.slice(0, 2000),
      startedAt: Date.now(),
      endedAt: 0,
      toolEvents: [],
      activatedSkillIds,
      terminal: "answered",
      finalAssistantText: "",
    };
    this.pendingCall = null;
  }

  onToolCall(name: string, args: Record<string, unknown>): void {
    this.pendingCall = { name, args: this.compactArgs(args), at: Date.now() };
  }

  onToolResult(name: string, result: Record<string, unknown>): void {
    if (!this.current) return;
    const started = this.pendingCall?.name === name ? this.pendingCall.at : Date.now();
    const errorLabel = this.errorLabel(result);
    const event: ToolEvent = {
      name,
      args: this.pendingCall?.name === name ? this.pendingCall.args : {},
      ok: errorLabel === undefined,
      durationMs: Date.now() - started,
      at: started,
    };
    if (errorLabel !== undefined) event.errorLabel = errorLabel.slice(0, 200);
    this.current.toolEvents.push(event);
    this.pendingCall = null;
  }

  onError(err: Error): void {
    if (!this.current || !this.pendingCall) return;
    this.current.toolEvents.push({
      name: this.pendingCall.name,
      args: this.pendingCall.args,
      ok: false,
      errorLabel: `${err.constructor.name}: ${err.message}`.slice(0, 200),
      durationMs: Date.now() - this.pendingCall.at,
      at: this.pendingCall.at,
    });
    this.pendingCall = null;
  }

  end(terminal: Episode["terminal"], finalAssistantText: string): Episode | null {
    if (!this.current) return null;
    const episode = this.current;
    episode.endedAt = Date.now();
    episode.terminal = terminal;
    episode.finalAssistantText = finalAssistantText.slice(0, 4000);
    this.current = null;
    this.pendingCall = null;
    return episode;
  }

  private errorLabel(result: Record<string, unknown>): string | undefined {
    if (typeof result.error === "string") return result.error;
    if (typeof result.exitCode === "number" && result.exitCode !== 0) return `exit ${result.exitCode}`;
    return undefined;
  }

  /** Keep only short scalar args; large strings (file bodies, patches) are elided. */
  private compactArgs(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string") out[key] = value.length > 300 ? `${value.slice(0, 300)}…[${value.length}]` : value;
      else if (typeof value === "number" || typeof value === "boolean" || value == null) out[key] = value;
      else out[key] = "[object]";
    }
    return out;
  }
}
