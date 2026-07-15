import { AgentStepRunner } from "../../src/orchestrator/agent-planner.js";
import { PlanStep } from "../../src/orchestrator/types.js";

function makeStep(id: string, description: string): PlanStep {
  return { id, description, status: "pending", dependencies: [], retryCount: 0 };
}

describe("AgentStepRunner", () => {
  it("returns a success outcome when the wrapped runner resolves with text", async () => {
    const runUserMessage = jest.fn().mockResolvedValue("done: created file");
    const runner = new AgentStepRunner({ runUserMessage } as any);

    const outcome = await runner.run(makeStep("s1", "create a file"));

    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") expect(outcome.output.text).toBe("done: created file");
  });

  it("returns a retryable outcome when the wrapped runner throws", async () => {
    const runUserMessage = jest.fn().mockRejectedValue(new Error("network blip"));
    const runner = new AgentStepRunner({ runUserMessage } as any);

    const outcome = await runner.run(makeStep("s1", "create a file"));

    expect(outcome.kind).toBe("retryable");
    if (outcome.kind === "retryable") expect(outcome.error).toBe("network blip");
  });

  it("passes the step description and priority as the user message to the wrapped agent", async () => {
    const runUserMessage = jest.fn().mockResolvedValue("ok");
    const runner = new AgentStepRunner({ runUserMessage } as any);

    const step = makeStep("s1", "add a README");
    step.priority = "low";
    await runner.run(step);

    expect(runUserMessage).toHaveBeenCalledWith("add a README", "low");
  });
});
