import { BenchmarkCase } from "./types.js";

function parseContent(content: unknown): unknown {
  if (typeof content !== "string") return undefined;
  // Models sometimes wrap JSON in a ```json fence despite instructions not to.
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const raw = fenced ? fenced[1] : content;
  try {
    return JSON.parse(raw.trim());
  } catch {
    return undefined;
  }
}

export const BUILTIN_CASES: BenchmarkCase[] = [
  {
    id: "json-validity",
    description: "Responds with strictly valid, correctly-shaped JSON",
    messages: [
      {
        role: "user",
        content: 'Respond with ONLY a JSON object, no prose, no markdown fence: {"answer": <the number 2+2>}',
      },
    ],
    validate: (response) => {
      const parsed = parseContent(response.message?.content) as { answer?: unknown } | undefined;
      if (!parsed) return { pass: false, reason: "response was not valid JSON" };
      if (parsed.answer !== 4) return { pass: false, reason: `expected answer:4, got ${JSON.stringify(parsed.answer)}` };
      return { pass: true };
    },
  },
  {
    id: "tool-calling",
    description: "Calls the offered tool instead of answering in prose",
    messages: [{ role: "user", content: "What's the weather in Paris? Use the get_weather tool to find out." }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the current weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ],
    validate: (response) => {
      const toolCalls = response.message?.tool_calls as Array<{ function: { name: string; arguments: unknown } }> | undefined;
      if (!toolCalls || toolCalls.length === 0) return { pass: false, reason: "no tool call in response" };
      const call = toolCalls[0];
      if (call.function.name !== "get_weather") {
        return { pass: false, reason: `called ${call.function.name} instead of get_weather` };
      }
      const args = typeof call.function.arguments === "string" ? tryParse(call.function.arguments) : call.function.arguments;
      const city = (args as { city?: string } | undefined)?.city ?? "";
      if (!/paris/i.test(city)) return { pass: false, reason: `city argument was "${city}", expected "Paris"` };
      return { pass: true };
    },
  },
];

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
