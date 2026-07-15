import { Provider, ChatMessage, ChatResponse, ChatOptions, ProviderError, RateLimitError, TimeoutError } from "./provider.js";
import { Capability, ModelCatalog } from "./catalog.js";

export interface RouterOptions {
  local: Provider;
  cloud?: Provider;
  catalog: ModelCatalog;
  logger?: Pick<Console, "warn">;
}

export class Router {
  private readonly local: Provider;
  private readonly cloud?: Provider;
  private readonly catalog: ModelCatalog;
  private readonly logger: Pick<Console, "warn">;

  constructor(opts: RouterOptions) {
    this.local = opts.local;
    this.cloud = opts.cloud;
    this.catalog = opts.catalog;
    this.logger = opts.logger ?? console;
  }

  async route(capability: Capability, messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
    let candidates = this.catalog.modelsFor(capability);
    // A candidate tagged for the routed capability (e.g. "quick" by size, or
    // "reasoning" by name) is not necessarily tool-capable — routing solely
    // on the content-classified capability while ignoring whether this turn
    // actually sends tool schemas sends real requests to models that reject
    // them outright (e.g. Ollama 400 "does not support tools"), with no
    // fallback to a model that does. Require "tools" too whenever this turn needs it.
    if (opts?.tools && opts.tools.length > 0) {
      const toolCapable = candidates.filter((c) => c.capabilities.includes("tools"));
      // If nothing tagged for the routed capability also supports tools,
      // widen to any tool-capable model in the catalog rather than handing
      // the request to a model guaranteed to reject it.
      candidates = toolCapable.length > 0 ? toolCapable : this.catalog.modelsFor("tools");
    }
    if (candidates.length === 0) {
      throw new Error(`no model available for capability "${capability}"`);
    }

    let lastError: unknown;
    for (const candidate of candidates) {
      const provider = candidate.tier === "local" ? this.local : this.cloud;
      if (!provider) continue;

      provider.setModel(candidate.name);
      try {
        return await provider.chat(messages, opts);
      } catch (e) {
        lastError = e;
        if (!this.isRecoverable(e)) throw e;
        this.logger.warn(
          `[Router] ${(e as Error).constructor.name} on ${candidate.tier}/${candidate.name} — trying next candidate`,
        );
      }
    }

    throw lastError ?? new Error(`no reachable provider for capability "${capability}"`);
  }

  private isRecoverable(e: unknown): boolean {
    if (e instanceof RateLimitError) return true;
    if (e instanceof TimeoutError) return true;
    if (e instanceof TypeError) return true;
    // The catalog's capability filter should already exclude these, but if a
    // model still gets picked that rejects tool schemas outright, that's a
    // wrong-candidate problem, not a fatal one — try the next candidate.
    if (e instanceof ProviderError && /does not support tools/i.test(e.message)) return true;
    return false;
  }
}
