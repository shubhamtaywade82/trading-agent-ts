import { BUILTIN_CASES } from "../../src/benchmark/cases.js";
import { ChatResponse } from "../../src/provider/provider.js";

const jsonCase = BUILTIN_CASES.find((c) => c.id === "json-validity")!;
const toolCase = BUILTIN_CASES.find((c) => c.id === "tool-calling")!;

function response(overrides: Partial<ChatResponse["message"]> = {}): ChatResponse {
  return { message: { role: "assistant", content: "", ...overrides }, done: true };
}

describe("json-validity case", () => {
  it("passes on exact valid JSON", () => {
    expect(jsonCase.validate(response({ content: '{"answer": 4}' })).pass).toBe(true);
  });

  it("passes when the model wraps JSON in a markdown fence anyway", () => {
    expect(jsonCase.validate(response({ content: '```json\n{"answer": 4}\n```' })).pass).toBe(true);
  });

  it("fails on invalid JSON", () => {
    const result = jsonCase.validate(response({ content: "the answer is 4" }));
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/not valid JSON/);
  });

  it("fails on the wrong value", () => {
    const result = jsonCase.validate(response({ content: '{"answer": 5}' }));
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/expected answer:4/);
  });
});

describe("tool-calling case", () => {
  it("passes when the model calls get_weather with Paris", () => {
    const result = toolCase.validate(
      response({
        content: "",
        tool_calls: [{ function: { name: "get_weather", arguments: { city: "Paris" } } }],
      }),
    );
    expect(result.pass).toBe(true);
  });

  it("passes when arguments arrive as a JSON string (some models do this)", () => {
    const result = toolCase.validate(
      response({
        content: "",
        tool_calls: [{ function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
      }),
    );
    expect(result.pass).toBe(true);
  });

  it("fails when the model answers in prose instead of calling the tool", () => {
    const result = toolCase.validate(response({ content: "It's sunny in Paris." }));
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/no tool call/);
  });

  it("fails when the wrong tool is called", () => {
    const result = toolCase.validate(
      response({ content: "", tool_calls: [{ function: { name: "search", arguments: { q: "Paris weather" } } }] }),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/called search/);
  });

  it("fails when the city argument is wrong", () => {
    const result = toolCase.validate(
      response({ content: "", tool_calls: [{ function: { name: "get_weather", arguments: { city: "London" } } }] }),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/London/);
  });
});
