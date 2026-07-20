import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { PairsArbTracker, PairsArbCandidate, PairsArbDeps, summarizePairsArbJournal } from "../../src/paper-trading/pairs-arb.js";

describe("PairsArbTracker", () => {
  let dir: string;
  let stateFile: string;
  let journalFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pairs-arb-"));
    stateFile = join(dir, "state.json");
    journalFile = join(dir, "trades.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const CANDIDATE: PairsArbCandidate = { id: "XRPUSDT-ETHUSDT", symbolA: "XRPUSDT", symbolB: "ETHUSDT", tf: "1h", lookback: 4, entryZ: 2, exitZ: 0.5, stopZ: 3.5, maxHoldBars: 20 };

  function deps(overrides: Partial<PairsArbDeps> = {}): PairsArbDeps {
    // History that produces a strong positive z-score on the latest bar (A spiked vs B).
    return {
      fetchRecentCloses: async (symbol: string) =>
        symbol === "XRPUSDT"
          ? { closes: [100, 102, 98, 101, 99, 150] }
          : { closes: [100, 100, 100, 100, 100, 100] },
      ...overrides,
    };
  }

  it("opens a position when the latest z-score exceeds entryZ", async () => {
    const tracker = new PairsArbTracker([CANDIDATE], { stateFile, journalFile }, deps());
    const result = await tracker.tick();
    expect(result.opened).toEqual(["XRPUSDT-ETHUSDT"]);
    const journal = await readFile(journalFile, "utf-8");
    expect(journal).toContain('"type":"pairs_arb_open"');
    expect(journal).toContain('"direction":"short_a_long_b"');
  });

  it("does not open when correlation-adjacent history is too short to compute a z-score", async () => {
    const tracker = new PairsArbTracker([CANDIDATE], { stateFile, journalFile }, deps({
      fetchRecentCloses: async () => ({ closes: [100, 101] }), // shorter than lookback
    }));
    const result = await tracker.tick();
    expect(result.opened).toEqual([]);
  });

  it("does not open a second position while one is already open for a pair", async () => {
    const tracker = new PairsArbTracker([CANDIDATE], { stateFile, journalFile }, deps());
    await tracker.tick();
    const result = await tracker.tick();
    expect(result.opened).toEqual([]);
  });

  it("closes on max hold and journals a finite realized PnL", async () => {
    // z≈3.09 here — above entryZ(2) so it still opens, but below stopZ(3.5)
    // so only the maxHoldBars timeout (not the stop) can close it; a bigger
    // spike would hit stopZ on the very next tick and never test timeout.
    const moderateSpikeDeps = deps({
      fetchRecentCloses: async (symbol: string) =>
        symbol === "XRPUSDT" ? { closes: [100, 102, 98, 101, 99, 105] } : { closes: [100, 100, 100, 100, 100, 100] },
    });
    const shortHold = { ...CANDIDATE, maxHoldBars: 0 };
    const tracker = new PairsArbTracker([shortHold], { stateFile, journalFile }, moderateSpikeDeps);
    await tracker.tick();
    const result = await tracker.tick();
    expect(result.closed).toEqual(["XRPUSDT-ETHUSDT"]);
    const journal = await readFile(journalFile, "utf-8");
    expect(journal).toContain('"type":"pairs_arb_close"');
    expect(journal).toContain('"reason":"timeout"');
  });

  it("persists open positions across a new tracker instance pointed at the same state file", async () => {
    const first = new PairsArbTracker([CANDIDATE], { stateFile, journalFile }, deps());
    await first.tick();
    const second = new PairsArbTracker([CANDIDATE], { stateFile, journalFile }, deps());
    await second.tick();
    const journal = await readFile(journalFile, "utf-8");
    const opens = journal.split("\n").filter(l => l.includes('"type":"pairs_arb_open"'));
    expect(opens).toHaveLength(1);
  });
});

describe("summarizePairsArbJournal", () => {
  it("aggregates closed positions per pair id", () => {
    const entries = [
      { type: "pairs_arb_open", id: "XRPUSDT-ETHUSDT" },
      { type: "pairs_arb_close", id: "XRPUSDT-ETHUSDT", reason: "target", pnlUsd: 40 },
      { type: "pairs_arb_open", id: "XRPUSDT-ETHUSDT" },
      { type: "pairs_arb_close", id: "XRPUSDT-ETHUSDT", reason: "stop", pnlUsd: -20 },
    ];
    const summary = summarizePairsArbJournal(entries);
    expect(summary["XRPUSDT-ETHUSDT"]).toEqual({ closedCount: 2, totalPnlUsd: 20, winRate: 0.5 });
  });
});
