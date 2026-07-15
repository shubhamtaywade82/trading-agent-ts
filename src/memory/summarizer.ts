import { MemoryStore } from "./store.js";
import { Provider, ChatMessage } from "../provider/provider.js";

const SUMMARY_PROMPT =
  "Summarize the conversation so far in 3-5 short bullet points, focused on what was built or changed. Output only the bullet points, no preamble.";

export async function generateSummary(store: MemoryStore, provider: Provider): Promise<string> {
  const recent = store.recentMessages(20);
  const messages: ChatMessage[] = [
    ...recent.map((m) => ({ role: m.role as ChatMessage["role"], content: m.content })),
    { role: "user", content: SUMMARY_PROMPT },
  ];

  const response = await provider.chat(messages, { stream: false });
  const summary = (response.message?.content ?? "").trim();
  store.setProjectNote("summary", summary);
  return summary;
}
