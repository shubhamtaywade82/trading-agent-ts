import { mkdtemp, rm, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { BinanceStreamManager } from "../../src/exchange/binance-stream.js";
import { ShadowSignalTracker, CandidateSignal, summarizeShadowJournal } from "../../src/paper-trading/shadow-signal-tracker.js";

describe("ShadowSignalTracker (real network)", () => {
  let dir: string;
  let stateFile: string;
  let journalFile: string;
  let stream: BinanceStreamManager;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "shadow-tracker-"));
    stateFile = join(dir, "shadow-state.json");
    journalFile = join(dir, "shadow-trades.jsonl");
    stream = new BinanceStreamManager();
  });

  afterEach(async () => {
    stream.closeAll();
    await rm(dir, { recursive: true, force: true });
  });

  function alwaysFiresLong(id: string, symbol: string, overrides: Partial<CandidateSignal> = {}): CandidateSignal {
    return {
      id, symbol, shadow: true, checkFire: async () => "long",
      stopPct: 0.5, targetPct: 0.5, maxHoldMs: 4 * 60 * 60 * 1000, // wide enough not to trigger by accident
      ...overrides,
    };
  }

  it("opens a position when checkFire signals a direction", async () => {
    const tracker = new ShadowSignalTracker([alwaysFiresLong("t1", "BTCUSDT")], stream, { stateFile, journalFile });
    await tracker.tick();
    const journal = await readFile(journalFile, "utf-8");
    expect(journal).toContain('"type":"shadow_open"');
    expect(journal).toContain('"id":"t1"');
  }, 20000);

  it("does not open a second position while one is already open for the same candidate", async () => {
    const tracker = new ShadowSignalTracker([alwaysFiresLong("t1", "BTCUSDT")], stream, { stateFile, journalFile });
    await tracker.tick();
    await tracker.tick();
    const journal = await readFile(journalFile, "utf-8");
    const opens = journal.split("\n").filter(l => l.includes('"type":"shadow_open"'));
    expect(opens).toHaveLength(1);
  }, 20000);

  it("closes on timeout when maxHoldMs has already elapsed", async () => {
    const tracker = new ShadowSignalTracker([alwaysFiresLong("t1", "BTCUSDT", { maxHoldMs: 0 })], stream, { stateFile, journalFile });
    await tracker.tick(); // opens
    await tracker.tick(); // next mark-to-market sees maxHoldMs already exceeded
    const journal = await readFile(journalFile, "utf-8");
    expect(journal).toContain('"type":"shadow_close"');
    expect(journal).toContain('"reason":"timeout"');
  }, 20000);

  it("closes on stop when the live price has already crossed it", async () => {
    // Open once to learn the current live price, then reopen with a stop
    // guaranteed to already be crossed on the very next mark (same trick
    // tests/exchange/paper-trading.test.ts uses for its stop-hit test).
    const probe = new ShadowSignalTracker([alwaysFiresLong("probe", "BTCUSDT")], stream, {
      stateFile: join(dir, "probe-state.json"), journalFile: join(dir, "probe-journal.jsonl"),
    });
    await probe.tick();
    const tick = stream.getLatest("BTCUSDT")!;

    const candidate: CandidateSignal = {
      id: "t1", symbol: "BTCUSDT", shadow: true, checkFire: async () => "long",
      stopPct: 0.5, targetPct: 0.99, maxHoldMs: 4 * 60 * 60 * 1000,
    };
    const tracker = new ShadowSignalTracker([candidate], stream, { stateFile, journalFile });
    // Force a stop price above the current price on a long (guaranteed hit)
    // by opening manually through tick() then rewriting state before the
    // next mark — simplest way to make this deterministic without waiting
    // for a real 0.5% move.
    await tracker.tick();
    const state = JSON.parse(await readFile(stateFile, "utf-8"));
    state.t1.stopPrice = tick.price * 1.5;
    await writeFile(stateFile, JSON.stringify(state));
    const reloaded = new ShadowSignalTracker([candidate], stream, { stateFile, journalFile });
    await reloaded.tick();
    const journal = await readFile(journalFile, "utf-8");
    expect(journal).toContain('"reason":"stop"');
  }, 20000);

  it("persists open positions across a new tracker instance pointed at the same state file", async () => {
    const first = new ShadowSignalTracker([alwaysFiresLong("t1", "BTCUSDT")], stream, { stateFile, journalFile });
    await first.tick();
    const second = new ShadowSignalTracker([alwaysFiresLong("t1", "BTCUSDT")], stream, { stateFile, journalFile });
    await second.tick(); // should see the position already open, not open a duplicate
    const journal = await readFile(journalFile, "utf-8");
    const opens = journal.split("\n").filter(l => l.includes('"type":"shadow_open"'));
    expect(opens).toHaveLength(1);
  }, 20000);
});

describe("summarizeShadowJournal", () => {
  it("computes fires/wins/losses/winRate/pf/verdict per candidate id", () => {
    const entries = [
      { type: "shadow_open", id: "obi-XRPUSDT" },
      { type: "shadow_close", id: "obi-XRPUSDT", reason: "target", pnlPct: 0.03 },
      { type: "shadow_open", id: "obi-XRPUSDT" },
      { type: "shadow_close", id: "obi-XRPUSDT", reason: "stop", pnlPct: -0.015 },
      { type: "shadow_open", id: "obi-ETHUSDT" },
      { type: "shadow_close", id: "obi-ETHUSDT", reason: "timeout", pnlPct: 0.005 },
    ];
    const summary = summarizeShadowJournal(entries);
    expect(summary["obi-XRPUSDT"]).toEqual({
      fires: 2, wins: 1, losses: 1, winRate: 0.5, pf: 0.03 / 0.015,
      totalPnlPct: 0.03 - 0.015, verdict: "NOT_YET",
    });
    expect(summary["obi-ETHUSDT"].fires).toBe(1);
  });

  it("flags SURVIVES only at >=20 fires and net-positive totalPnlPct", () => {
    const entries: { type: string; id: string; reason?: string; pnlPct?: number }[] = [];
    for (let i = 0; i < 20; i++) {
      entries.push({ type: "shadow_open", id: "obi-XRPUSDT" });
      entries.push({ type: "shadow_close", id: "obi-XRPUSDT", reason: i % 2 === 0 ? "target" : "stop", pnlPct: i % 2 === 0 ? 0.03 : -0.01 });
    }
    const summary = summarizeShadowJournal(entries);
    expect(summary["obi-XRPUSDT"].fires).toBe(20);
    expect(summary["obi-XRPUSDT"].verdict).toBe("SURVIVES");
  });
});
