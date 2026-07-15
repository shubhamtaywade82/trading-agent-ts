import { Provider, Tier } from "./provider.js";

export type Capability = "coding" | "vision" | "reasoning" | "quick" | "tools";

export interface ModelInfo {
  name: string;
  tier: Tier;
  capabilities: Capability[];
}

// Fallback only — used when real capability metadata isn't available (Ollama
// Cloud's OpenAI-compatible /v1/models doesn't expose it, matching the
// OpenAI models API shape). Local Ollama's /api/tags DOES report real
// capabilities per model (see capabilitiesFromLocalTag) — prefer that.
export function inferCapabilities(name: string): Capability[] {
  const n = name.toLowerCase();
  const caps: Capability[] = ["tools"];

  if (/(^|[^a-z])(vl|vision)([^a-z]|$)/.test(n)) caps.push("vision");
  if (/(r1|reason|thinking)/.test(n)) caps.push("reasoning");
  if (/(0\.5b|1b|2b|3b|4b|nano|mini|hermes|opencode)/.test(n)) caps.push("quick");
  if (!caps.includes("vision") && !caps.includes("reasoning")) caps.push("coding");

  return caps;
}

// Ollama's parameter_size is a free-form string like "4.7B" or "494.03M".
// Returns the size in billions of parameters, or null if unparseable.
function parseParameterSizeB(size: string | undefined): number | null {
  if (!size) return null;
  const m = size.match(/^([\d.]+)\s*([BMK])$/i);
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (Number.isNaN(value)) return null;
  const unit = m[2].toUpperCase();
  if (unit === "B") return value;
  if (unit === "M") return value / 1000;
  return value / 1_000_000; // K
}

const QUICK_MAX_PARAMS_B = 4;

interface LocalTagEntry {
  name?: string;
  model?: string;
  capabilities?: string[];
  details?: { parameter_size?: string };
}

// Local Ollama's /api/tags reports each model's real capabilities array
// (e.g. ["tools","vision","thinking","completion"]) and parameter_size —
// no heuristic guessing needed, unlike the cloud tier.
function capabilitiesFromLocalTag(entry: LocalTagEntry, name: string): Capability[] {
  if (!entry.capabilities) return inferCapabilities(name);

  const caps: Capability[] = [];
  if (entry.capabilities.includes("tools")) caps.push("tools");
  if (entry.capabilities.includes("vision")) caps.push("vision");
  if (entry.capabilities.includes("thinking")) caps.push("reasoning");

  const sizeB = parseParameterSizeB(entry.details?.parameter_size);
  if (sizeB !== null && sizeB <= QUICK_MAX_PARAMS_B) caps.push("quick");

  // Embedding-only models (capabilities: ["embedding"], no "completion") can't
  // generate text at all — don't fall back to "coding" for them, they can't
  // chat regardless of how small or generically-named they are.
  const canGenerateText = entry.capabilities.includes("completion");
  if (canGenerateText && !caps.includes("vision") && !caps.includes("reasoning")) caps.push("coding");

  return caps;
}

function localTagEntries(data: unknown): LocalTagEntry[] {
  return (data as { models?: LocalTagEntry[] } | undefined)?.models ?? [];
}

function namesFromCloudModels(data: unknown): string[] {
  const items = (data as { data?: Array<{ id?: string }> } | undefined)?.data ?? [];
  return items.map((m) => m.id).filter((n): n is string => !!n);
}

export class ModelCatalog {
  private models: ModelInfo[] = [];

  constructor(
    private readonly local?: Provider,
    private readonly cloud?: Provider,
  ) {}

  async refresh(): Promise<ModelInfo[]> {
    const results: ModelInfo[] = [];

    if (this.local) {
      try {
        const data = await this.local.availableModels();
        for (const entry of localTagEntries(data)) {
          const name = entry.name ?? entry.model;
          if (!name) continue;
          results.push({ name, tier: "local", capabilities: capabilitiesFromLocalTag(entry, name) });
        }
      } catch {
        // local Ollama not running — leave local models empty
      }
    }

    if (this.cloud) {
      try {
        const data = await this.cloud.availableModels();
        for (const name of namesFromCloudModels(data)) {
          results.push({ name, tier: "cloud", capabilities: inferCapabilities(name) });
        }
      } catch {
        // no cloud API key / unreachable — leave cloud models empty
      }
    }

    this.models = results;
    return results;
  }

  all(): ModelInfo[] {
    return this.models;
  }

  // Local-first: local candidates before cloud candidates.
  modelsFor(capability: Capability): ModelInfo[] {
    return this.models
      .filter((m) => m.capabilities.includes(capability))
      .sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "local" ? -1 : 1));
  }
}
