import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync } from "fs";
import { LivePaperRunner } from "../../src/paper-trading/live-runner.js";

function pool(strats: any[]) {
  return { symbols: { XRPUSDT: strats } };
}

function strat(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, tf: "1h", direction: "short", entry: [{ type: "bearish_fvg" }],
    risk: { stopPct: 0.02, targetPct: 0.04 }, maxHoldBars: 48,
    ...overrides,
  };
}

describe("LivePaperRunner.reloadPool", () => {
  let dir: string;
  let poolPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "live-runner-reload-"));
    poolPath = join(dir, "strategies.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeRunner() {
    return new LivePaperRunner({
      stateFile: join(dir, "paper-state.json"),
      journalFile: join(dir, "paper-trades.jsonl"),
      aiMode: "no-ai",
    }, poolPath);
  }

  it("picks up a new id (existing add-only behavior, unchanged)", () => {
    writeFileSync(poolPath, JSON.stringify(pool([strat("a")])));
    const runner = makeRunner();
    expect(runner.getStatus().map(s => s.id)).toEqual(["a"]);

    writeFileSync(poolPath, JSON.stringify(pool([strat("a"), strat("b")])));
    const added = runner.reloadPool(poolPath);
    expect(added).toBe(1);
    expect(runner.getStatus().map(s => s.id).sort()).toEqual(["a", "b"]);
  });

  it("updates sizeMultiplier in place for an existing id without touching entry/risk", async () => {
    writeFileSync(poolPath, JSON.stringify(pool([strat("a")])));
    const runner = makeRunner();

    writeFileSync(poolPath, JSON.stringify(pool([strat("a", { sizeMultiplier: 0.5 })])));
    runner.reloadPool(poolPath);

    expect(runner.getStatus().map(s => s.id)).toEqual(["a"]); // still present, not removed
    const journal = await readFile(join(dir, "paper-trades.jsonl"), "utf-8");
    expect(journal).toContain("size_multiplier_updated");
    expect(journal).toContain('"to":0.5');
  });

  it("removes an id from the active pool when enabled:false, logging the prune", async () => {
    writeFileSync(poolPath, JSON.stringify(pool([strat("a"), strat("b")])));
    const runner = makeRunner();
    expect(runner.getStatus().map(s => s.id).sort()).toEqual(["a", "b"]);

    writeFileSync(poolPath, JSON.stringify(pool([strat("a"), strat("b", { enabled: false })])));
    runner.reloadPool(poolPath);

    expect(runner.getStatus().map(s => s.id)).toEqual(["a"]);
    const journal = await readFile(join(dir, "paper-trades.jsonl"), "utf-8");
    expect(journal).toContain("strategy_pruned");
  });

  it("a freshly-constructed runner filters out enabled:false strategies from the start", () => {
    writeFileSync(poolPath, JSON.stringify(pool([strat("a"), strat("b", { enabled: false })])));
    const runner = makeRunner();
    expect(runner.getStatus().map(s => s.id)).toEqual(["a"]);
  });
});
