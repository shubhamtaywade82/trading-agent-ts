import { PlanStep, StepOutcome, StepRunner } from "./types.js";

export interface RunsUserMessages {
  runUserMessage(message: string, priority?: "low" | "medium" | "high" | "critical"): Promise<string>;
}

export class AgentStepRunner implements StepRunner {
  constructor(private readonly agent: RunsUserMessages) {}

  async run(step: PlanStep): Promise<StepOutcome> {
    try {
      const text = await this.agent.runUserMessage(step.description, step.priority);
      return { kind: "success", output: { text } };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { kind: "retryable", error };
    }
  }
}
