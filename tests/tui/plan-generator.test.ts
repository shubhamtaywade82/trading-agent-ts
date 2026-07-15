import { generatePlan, PlanGenerationError } from "../../src/tui/plan-generator.js";
import { Provider } from "../../src/provider/provider.js";

function fakeProvider(content: string) {
  return {
    chat: jest.fn().mockResolvedValue({ message: { role: "assistant", content }, done: true }),
  } as unknown as Provider;
}

describe("generatePlan", () => {
  it("parses a valid JSON step array into PlanStep[] with pending status and zero retries", async () => {
    const provider = fakeProvider(
      JSON.stringify([
        { id: "s1", description: "create types.ts", dependencies: [] },
        { id: "s2", description: "create registry", dependencies: ["s1"] },
      ]),
    );

    const steps = await generatePlan("add a CommandRegistry", provider);

    expect(steps).toEqual([
      { id: "s1", description: "create types.ts", dependencies: [], status: "pending", retryCount: 0 },
      { id: "s2", description: "create registry", dependencies: ["s1"], status: "pending", retryCount: 0 },
    ]);
  });

  it("extracts a JSON array embedded in surrounding prose", async () => {
    const provider = fakeProvider('Here is the plan:\n[{"id":"s1","description":"do it","dependencies":[]}]\nDone.');

    const steps = await generatePlan("do it", provider);

    expect(steps).toEqual([{ id: "s1", description: "do it", dependencies: [], status: "pending", retryCount: 0 }]);
  });

  it("throws PlanGenerationError on malformed JSON, without a silent single-step fallback", async () => {
    const provider = fakeProvider("not json at all");

    await expect(generatePlan("do it", provider)).rejects.toThrow(PlanGenerationError);
  });

  it("throws PlanGenerationError when a step is missing required fields", async () => {
    const provider = fakeProvider(JSON.stringify([{ id: "s1" }]));

    await expect(generatePlan("do it", provider)).rejects.toThrow(PlanGenerationError);
  });

  it("throws PlanGenerationError when a step has non-string elements in dependencies", async () => {
    const provider = fakeProvider(JSON.stringify([{ id: "s1", description: "step one", dependencies: [1, 2, null] }]));

    await expect(generatePlan("do it", provider)).rejects.toThrow(PlanGenerationError);
  });
});
