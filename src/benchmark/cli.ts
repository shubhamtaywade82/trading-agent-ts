#!/usr/bin/env node
import { loadConfig } from "../cli/config.js";
import { ModelCatalog } from "../provider/catalog.js";
import { Provider } from "../provider/provider.js";

import { BUILTIN_CASES } from "./cases.js";
import { formatReport } from "./report.js";
import type { BenchmarkTarget } from "./runner.js";
import { runBenchmark } from "./runner.js";
import { scoreByModel } from "./score.js";

async function main() {
  const cfg = loadConfig();

  const local = new Provider({
    tier: "local",
    model: cfg.model,
    ...(cfg.tier === "local" && cfg.host !== undefined ? { host: cfg.host } : {}),
  });
  const cloud = cfg.apiKey
    ? new Provider({
        tier: "cloud",
        model: cfg.model,
        apiKey: cfg.apiKey,
        ...(cfg.tier === "cloud" && cfg.host !== undefined ? { host: cfg.host } : {}),
      })
    : undefined;

  const catalog = new ModelCatalog(local, cloud);
  const models = await catalog.refresh();

  if (models.length === 0) {
    console.error("No models discovered (local Ollama unreachable and no cloud API key configured).");
    process.exitCode = 1;
    return;
  }

  console.log(`Benchmarking ${models.length} model(s) across ${BUILTIN_CASES.length} case(s)...\n`);

  const targets: BenchmarkTarget[] = [];
  for (const m of models) {
    const provider = m.tier === "local" ? local : cloud;
    if (provider === undefined) continue;
    targets.push({ model: m.name, tier: m.tier, provider });
  }

  const results = await runBenchmark(targets, BUILTIN_CASES);
  const failures = results.filter((r) => !r.pass);

  console.log(formatReport(scoreByModel(results)));

  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log(`  ${f.tier}/${f.model} — ${f.caseId}: ${f.error ?? f.reason ?? "unknown"}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
