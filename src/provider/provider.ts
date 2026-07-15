export class RateLimitError extends Error {}
export class ProviderError extends Error {}
export class TimeoutError extends Error {}

const MAX_ERROR_BODY_CHARS = 500;

function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9]{6,}/g, "[REDACTED]")
    .slice(0, MAX_ERROR_BODY_CHARS);
}

export type Tier = "local" | "cloud";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
}

export interface OllamaToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResponse {
  message: { role: string; content: string; tool_calls?: unknown[] };
  done: boolean;
  [key: string]: unknown;
}

export interface ChatOptions {
  tools?: OllamaToolSchema[];
  stream?: boolean;
  onChunk?: (chunk: ChatResponse) => void;
}

export interface ProviderOptions {
  tier: Tier;
  model: string;
  host?: string;
  apiKey?: string;
  /** Pool of Ollama Cloud API keys (e.g. separate accounts). On a 429 the
   * provider rotates to the next key and retries before giving up — this is
   * for availability across your own accounts, not multi-vendor routing. */
  apiKeys?: string[];
  timeoutMs?: number;
}

export class Provider {
  private tier: Tier;
  private model: string;
  private host: string;
  private readonly apiKeys: string[];
  private apiKeyIndex = 0;
  private readonly timeoutMs: number;

  constructor(opts: ProviderOptions) {
    this.tier = opts.tier;
    this.model = opts.model;
    this.host =
      opts.host ??
      (opts.tier === "cloud" ? "https://ollama.com" : process.env.OLLAMA_HOST ?? "http://localhost:11434");
    this.apiKeys = opts.apiKeys && opts.apiKeys.length > 0 ? opts.apiKeys : opts.apiKey ? [opts.apiKey] : [];
    // Cloud has a 60s connect timeout; local has no timeout — never kill a running generation.
    this.timeoutMs = opts.timeoutMs ?? (opts.tier === "cloud" ? 60_000 : 0);
  }

  get currentModel(): string {
    return this.model;
  }

  get currentTier(): Tier {
    return this.tier;
  }

  setModel(model: string): void {
    this.model = model;
  }

  setTier(tier: Tier): void {
    this.tier = tier;
  }

  setRuntimeHost(host: string): void {
    this.host = host;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResponse> {
    if (this.tier === "cloud" && this.apiKeys.length === 0) {
      throw new ProviderError("missing apiKey for cloud chat");
    }

    const body: Record<string, unknown> = { model: this.model, messages, stream: opts.stream ?? false };
    if (opts.tools) body.tools = opts.tools;

    // Cloud with multiple keys: rotate to the next key on a 429 and retry
    // before giving up — resilience across your own accounts, not a router.
    const maxAttempts = this.tier === "cloud" ? this.apiKeys.length : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.tier === "cloud") headers.Authorization = `Bearer ${this.apiKeys[this.apiKeyIndex]}`;

      let resp: Response;
      if (this.tier === "local" || this.timeoutMs === 0) {
        // Local: no timeout at all — let the model take as long as it needs.
        resp = await fetch(`${this.host}/api/chat`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
      } else {
        // Cloud: use a connect timeout only for the initial HTTP response headers.
        // Once headers arrive the stream is open; we cancel the abort so the body
        // reads freely without a hard deadline.
        const connectAbort = new AbortController();
        const connectTimer = setTimeout(
          () => connectAbort.abort(new TimeoutError(`connect timeout after ${this.timeoutMs}ms`)),
          this.timeoutMs,
        );
        try {
          resp = await fetch(`${this.host}/api/chat`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: connectAbort.signal,
          });
        } finally {
          clearTimeout(connectTimer);
        }
      }

      if (resp.status === 429) {
        if (attempt < maxAttempts - 1) {
          this.apiKeyIndex = (this.apiKeyIndex + 1) % this.apiKeys.length;
          continue;
        }
        throw new RateLimitError(`${this.model} (${this.tier}) rate limited on all ${this.apiKeys.length} key(s)`);
      }
      if (!resp.ok) {
        throw new ProviderError(`Ollama ${this.tier} ${resp.status}: ${redactSecrets(await resp.text())}`);
      }

      return opts.stream ? this.streamChunks(resp, opts.onChunk) : ((await resp.json()) as ChatResponse);
    }

    // Unreachable: maxAttempts is always >= 1 and the loop body always returns or throws.
    throw new RateLimitError(`${this.model} (${this.tier}) rate limited`);
  }

  async availableModels(): Promise<unknown> {
    const path = this.tier === "cloud" ? "/v1/models" : "/api/tags";
    const headers: Record<string, string> = {};
    if (this.tier === "cloud") {
      if (this.apiKeys.length === 0) throw new ProviderError("missing apiKey for cloud availableModels");
      headers.Authorization = `Bearer ${this.apiKeys[this.apiKeyIndex]}`;
    }

    let resp: Response;
    if (this.timeoutMs > 0) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new TimeoutError(`availableModels timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
      try { resp = await fetch(`${this.host}${path}`, { headers, signal: controller.signal }); }
      finally { clearTimeout(timer); }
    } else {
      resp = await fetch(`${this.host}${path}`, { headers });
    }

    if (!resp.ok) throw new ProviderError(`Ollama ${this.tier} ${resp.status}: ${redactSecrets(await resp.text())}`);
    return resp.json();
  }

  private async streamChunks(resp: Response, onChunk?: (chunk: ChatResponse) => void): Promise<ChatResponse> {
    if (!resp.body) throw new ProviderError("empty stream body");

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let final: ChatResponse | null = null;
    let accumulatedContent = "";
    let accumulatedThinking = "";
    const accumulatedToolCalls: any[] = [];

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;

        const chunk = JSON.parse(line) as ChatResponse;
        onChunk?.(chunk);

        if (chunk.message) {
          if (chunk.message.content) {
            accumulatedContent += chunk.message.content;
          }
          if ((chunk.message as any).thinking) {
            accumulatedThinking += (chunk.message as any).thinking;
          }
          if (chunk.message.tool_calls && Array.isArray(chunk.message.tool_calls)) {
            accumulatedToolCalls.push(...chunk.message.tool_calls);
          }
        }

        if (chunk.done) {
          final = chunk;
        }
      }
    }

    // Parse any remaining content in the buffer (if it didn't end with a newline)
    const remaining = buffer.trim();
    if (remaining) {
      try {
        const chunk = JSON.parse(remaining) as ChatResponse;
        onChunk?.(chunk);

        if (chunk.message) {
          if (chunk.message.content) {
            accumulatedContent += chunk.message.content;
          }
          if ((chunk.message as any).thinking) {
            accumulatedThinking += (chunk.message as any).thinking;
          }
          if (chunk.message.tool_calls && Array.isArray(chunk.message.tool_calls)) {
            accumulatedToolCalls.push(...chunk.message.tool_calls);
          }
        }

        if (chunk.done) {
          final = chunk;
        }
      } catch {
        // Ignore parse error for incomplete trailing chunks
      }
    }

    if (!final) {
      if (accumulatedContent || accumulatedThinking || accumulatedToolCalls.length > 0) {
        final = {
          message: {
            role: "assistant",
            content: accumulatedContent,
          },
          done: true,
          done_reason: "stop",
        };
      } else {
        throw new ProviderError("stream ended without a done:true chunk");
      }
    }

    // Overwrite the final message with the fully accumulated values
    final.message = {
      role: final.message?.role || "assistant",
      content: accumulatedContent,
    };
    if (accumulatedThinking) {
      (final.message as any).thinking = accumulatedThinking;
    }
    if (accumulatedToolCalls.length > 0) {
      final.message.tool_calls = accumulatedToolCalls;
    }

    return final;
  }
}
