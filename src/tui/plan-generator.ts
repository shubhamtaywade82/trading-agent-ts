import { Provider, ChatMessage } from "../provider/provider.js";
import { PlanStep } from "../orchestrator/types.js";

export class PlanGenerationError extends Error {}

const PLAN_PROMPT = `Decompose the following task into a short ordered list of steps.
Respond with ONLY a JSON array, no prose, in this exact shape:
[{"id": "s1", "description": "...", "dependencies": []}, ...]
Each step's "dependencies" lists the "id"s of steps that must complete first (empty array if none).`;

interface RawStep {
  id: unknown;
  description: unknown;
  dependencies: unknown;
}

function extractJsonArray(text: string): unknown {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new PlanGenerationError(`model response did not contain a JSON array: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new PlanGenerationError(
      `model response contained malformed JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function validateSteps(parsed: unknown): PlanStep[] {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new PlanGenerationError("model response was not a non-empty JSON array");
  }
  return parsed.map((raw: RawStep, i) => {
    if (typeof raw.id !== "string" || typeof raw.description !== "string" || !Array.isArray(raw.dependencies)) {
      throw new PlanGenerationError(`step at index ${i} is missing required fields (id, description, dependencies)`);
    }
    if (!raw.dependencies.every((dep) => typeof dep === "string")) {
      throw new PlanGenerationError(`step at index ${i} has invalid dependencies: all elements must be strings`);
    }
    return {
      id: raw.id,
      description: raw.description,
      dependencies: raw.dependencies as string[],
      status: "pending",
      retryCount: 0,
    };
  });
}

export async function generatePlan(userRequest: string, provider: Provider): Promise<PlanStep[]> {
  const messages: ChatMessage[] = [
    { role: "system", content: PLAN_PROMPT },
    { role: "user", content: userRequest },
  ];
  const response = await provider.chat(messages, { stream: false });
  const content = response.message?.content ?? "";
  const parsed = extractJsonArray(content);
  return validateSteps(parsed);
}
