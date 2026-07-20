import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { FundingArbTracker, computeBasisPnl, FundingArbDeps, summarizeFundingArbJournal } from "../../src/paper-trading/funding-arb.js";

describe("computeBasisPnl", () => {
  it("short perp: profits when basis narrows (converges toward spot)", () => {
    // entryBasis 10, currentBasis 4 -> basis narrowed by 6, short perp profits
    expect(computeBasisPnl(100, 10, 4, "short")).toBeCloseTo(600);
  });

  it("short perp: loses when basis widens", () => {
    expect(computeBasisPnl(100, 10, 16, "short")).toBeCloseTo(-600);
  });

  it("long perp: profits when basis widens", () => {
    expect(computeBasisPnl(100, 10, 16, "long")).toBeCloseTo(600);
  });
});

describe("FundingArbTracker", () => {
  let dir: string;
  let stateFile: string;
  let journalFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "funding-arb-"));
    stateFile = join(dir, "state.json");
    journalFile = join(dir, "trades.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function deps(overrides: Partial<FundingArbDeps> = {}): FundingArbDeps {
    return {
      fetchSpotPrice: async () => ({ price: 100 }),
      fetchFuturesStats: async () => ({ markPrice: 101, lastFundingRate: 0.0005, nextFundingTime: 0, openInterest: 0 }),
      fetchFundingRates: async () => [0.0005],
      ...overrides,
    };
  }

  it("opens a short-perp position when funding rate is positive and above threshold", async () => {
    const tracker = new FundingArbTracker(["XRPUSDT"], { stateFile, journalFile }, deps());
    const result = await tracker.tick();
    expect(result.opened).toEqual(["XRPUSDT"]);
    const journal = await readFile(journalFile, "utf-8");
    expect(journal).toContain('"type":"funding_arb_open"');
    expect(journal).toContain('"perpDirection":"short"');
  });

  it("opens a long-perp position when funding rate is negative and below -threshold", async () => {
    const tracker = new FundingArbTracker(["XRPUSDT"], { stateFile, journalFile }, deps({
      fetchFuturesStats: async () => ({ markPrice: 99, lastFundingRate: -0.0005, nextFundingTime: 0, openInterest: 0 }),
    }));
    const result = await tracker.tick();
    expect(result.opened).toEqual(["XRPUSDT"]);
    const journal = await readFile(journalFile, "utf-8");
    expect(journal).toContain('"perpDirection":"long"');
  });

  it("does not open when funding rate is below threshold", async () => {
    const tracker = new FundingArbTracker(["XRPUSDT"], { stateFile, journalFile }, deps({
      fetchFuturesStats: async () => ({ markPrice: 100.1, lastFundingRate: 0.00005, nextFundingTime: 0, openInterest: 0 }),
    }));
    const result = await tracker.tick();
    expect(result.opened).toEqual([]);
  });

  it("does not open a second position while one is already open for a symbol", async () => {
    const tracker = new FundingArbTracker(["XRPUSDT"], { stateFile, journalFile }, deps());
    await tracker.tick();
    const result = await tracker.tick(Date.now() + 1000); // still within an 8h boundary, no funding accrual expected
    expect(result.opened).toEqual([]);
  });

  it("closes on max hold and reports realized PnL = funding + basis PnL", async () => {
    let now = 1_700_000_000_000;
    const tracker = new FundingArbTracker(["XRPUSDT"], { stateFile, journalFile, maxHoldMs: 1000 }, deps());
    await tracker.tick(now);
    now += 2000; // past maxHoldMs
    const result = await tracker.tick(now);
    expect(result.closed).toEqual(["XRPUSDT"]);
    const journal = await readFile(journalFile, "utf-8");
    expect(journal).toContain('"type":"funding_arb_close"');
    expect(journal).toContain('"reason":"timeout"');
  });

  it("closes when funding rate normalizes below the exit threshold", async () => {
    let now = 1_700_000_000_000;
    const openDeps = deps();
    const tracker = new FundingArbTracker(["XRPUSDT"], { stateFile, journalFile }, openDeps);
    await tracker.tick(now);
    now += 1000;
    const closeDeps = deps({ fetchFuturesStats: async () => ({ markPrice: 100.05, lastFundingRate: 0.00001, nextFundingTime: 0, openInterest: 0 }) });
    const tracker2 = new FundingArbTracker(["XRPUSDT"], { stateFile, journalFile }, closeDeps);
    const result = await tracker2.tick(now);
    expect(result.closed).toEqual(["XRPUSDT"]);
    const journal = await readFile(journalFile, "utf-8");
    expect(journal).toContain('"reason":"normalized"');
  });

  it("persists open positions across a new tracker instance pointed at the same state file", async () => {
    const first = new FundingArbTracker(["XRPUSDT"], { stateFile, journalFile }, deps());
    await first.tick();
    const second = new FundingArbTracker(["XRPUSDT"], { stateFile, journalFile }, deps());
    await second.tick(Date.now() + 1000);
    const journal = await readFile(journalFile, "utf-8");
    const opens = journal.split("\n").filter(l => l.includes('"type":"funding_arb_open"'));
    expect(opens).toHaveLength(1);
  });
});

describe("summarizeFundingArbJournal", () => {
  it("aggregates closed positions per symbol", () => {
    const entries = [
      { type: "funding_arb_open", symbol: "XRPUSDT" },
      { type: "funding_arb_close", symbol: "XRPUSDT", reason: "normalized", realizedPnlUsd: 12.5, accruedFundingUsd: 15, basisPnl: -2.5 },
      { type: "funding_arb_open", symbol: "XRPUSDT" },
      { type: "funding_arb_close", symbol: "XRPUSDT", reason: "timeout", realizedPnlUsd: -3, accruedFundingUsd: 8, basisPnl: -11 },
    ];
    const summary = summarizeFundingArbJournal(entries);
    expect(summary["XRPUSDT"]).toEqual({
      closedCount: 2, totalRealizedPnlUsd: 9.5, totalFundingCollected: 23, totalBasisPnl: -13.5,
    });
  });
});
