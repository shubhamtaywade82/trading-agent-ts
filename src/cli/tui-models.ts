import * as fs from "node:fs";

export async function listModels(host: string | undefined, tier: string): Promise<string[]> {
  const base =
    host ?? (tier === "cloud" ? "https://ollama.com" : (process.env["OLLAMA_HOST"] ?? "http://localhost:11434"));
  const path = tier === "cloud" ? "/v1/models" : "/api/tags";
  try {
    const resp = await fetch(`${base}${path}`);
    if (!resp.ok) return [];
    if (tier === "cloud") {
      const data = (await resp.json()) as { data?: Array<{ id: string }> };
      return (data.data ?? []).map((m) => m.id);
    }
    const data = (await resp.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

export class ModelAccess {
  private readonly access = new Map<string, boolean>();
  private readonly cachePath: string;

  constructor(cachePath: string) {
    this.cachePath = cachePath;
  }

  get(model: string): boolean | undefined {
    return this.access.get(model);
  }

  set(model: string, free: boolean): void {
    this.access.set(model, free);
  }

  load(): void {
    try {
      const raw = fs.readFileSync(this.cachePath, "utf8");
      const data = JSON.parse(raw) as Record<string, boolean>;
      for (const [m, free] of Object.entries(data)) this.access.set(m, free);
    } catch {
      // No cache yet
    }
  }

  save(): void {
    try {
      const data: Record<string, boolean> = {};
      for (const [m, free] of this.access) data[m] = free;
      fs.writeFileSync(this.cachePath, JSON.stringify(data, null, 2), "utf8");
    } catch {
      // Ignore write errors
    }
  }

  async probe(models: string[], host: string | undefined, apiKey: string | undefined): Promise<void> {
    const toProbe = models.filter((m) => !this.access.has(m));
    if (!toProbe.length) return;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const url = `${host ?? "https://ollama.com"}/api/chat`;
    const results = await Promise.allSettled(toProbe.map((m) => probeModel(url, headers, m)));
    for (const r of results) {
      if (r.status === "fulfilled") this.access.set(r.value[0], r.value[1]);
    }
    this.save();
  }
}

async function probeModel(url: string, headers: Record<string, string>, model: string): Promise<[string, boolean]> {
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages: [{ role: "user", content: "." }], stream: false }),
      signal: AbortSignal.timeout(25_000),
    });
    if (resp.status === 429) return [model, true];
    if (resp.status === 200) {
      const errMsg = subscriptionError(await resp.json());
      if (errMsg.includes("subscription") || errMsg.includes("upgrade")) return [model, false];
      return [model, true];
    }
    const text = await resp.text();
    return [model, !(text.includes("subscription") || text.includes("upgrade"))];
  } catch {
    return [model, true];
  }
}

function subscriptionError(body: unknown): string {
  if (typeof body !== "object" || body === null || !("error" in body)) return "";
  return typeof body.error === "string" ? body.error : "";
}
