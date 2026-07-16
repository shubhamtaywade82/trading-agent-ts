// Shared Ollama Cloud key resolution — same env vars and pooling behavior as
// the main app's config.ts (src/cli/config.ts), so one .env value covers
// both the interactive agent and the paper-trading LLM components.
export function resolveOllamaCloudKeys(): { apiKey?: string; apiKeys?: string[] } {
  const primary = process.env.OLLAMA_API_KEY;
  const pool = (process.env.OLLAMA_API_KEYS ?? "").split(",").map(k => k.trim()).filter(Boolean);
  const apiKeys = [...new Set([...(primary ? [primary] : []), ...pool])];
  return { apiKey: primary, apiKeys: apiKeys.length ? apiKeys : undefined };
}
