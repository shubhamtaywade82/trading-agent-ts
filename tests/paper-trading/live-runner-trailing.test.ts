import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync } from "fs";
import { LivePaperRunner } from "../../src/paper-trading/live-runner.js";

function fakeKlines(closes: number[], startMs: number): unknown[][] {
  return closes.map((c, i) => {
    const t = startMs + i * 3600000;
    return [t, c, c + 0.5, c - 0.5, c, "100", t + 3599999, "0", 0, "0", "0", "0"];
  });
}

// Mocks global.fetch to serve an ever-growing candle series from `closes`,
// honoring the startTime cursor fetchCandlesRange pages with (same
// requirement live-runner-oi.test.ts documents — the mock must return []
// once exhausted or the pagination loop spins forever).
function mockKlineFetch(getCloses: () => number[], startMs: number) {
  (globalThis as any).fetch = jest.fn().mockImplementation((url: URL) => {
    const closes = getCloses();
    const timestamps = closes.map((_, i) => startMs + i * 3600000);
    const reqStart = Number(url.searchParams.get("startTime") ?? 0);
    const keep = timestamps.filter(t => t >= reqStart).length;
    const rows = keep > 0 ? fakeKlines(closes.slice(closes.length - keep), timestamps[timestamps.length - keep]) : [];
    return Promise.resolve({ ok: true, status: 200, json: async () => rows });
  });
}

describe("LivePaperRunner: trailing stop integration", () => {
  let dir: string;
  let poolPath: string;
  const originalFetch = global.fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "live-runner-trailing-"));
    poolPath = join(dir, "strategies.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    (globalThis as any).fetch = originalFetch;
  });

  it("opens a position with trailing state initialized, then trails the stop as price runs favorably", async () => {
    // Anchored 22h in the past (not 20h) so the candle appended for tick 2
    // has already fully closed by the time it's fetched -- processGroup
    // drops a still-forming last candle (openTime + tfMs > now).
    const start = Date.now() - 22 * 3600000;
    // rsi_below value=100 fires on the very first bar RSI(14) is computable
    // for -- deterministic entry without needing to engineer a specific
    // price shape. Mildly-varying warmup so ATR settles small, then a big
    // favorable move to force trailing activation on the next tick.
    let closes = Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i / 3) * 0.3);

    writeFileSync(poolPath, JSON.stringify({
      symbols: {
        XRPUSDT: [{
          id: "trail-test", tf: "1h", direction: "long",
          entry: [{ type: "rsi_below", period: 14, value: 100 }],
          risk: { stopPct: 0.05, targetPct: 0.10 }, maxHoldBars: 200,
          trailing: {
            enabled: true, breakevenAtrMult: 1.0, breakevenOffsetBps: 5,
            activationAtrMult: 2.0, trailAtrMult: 1.5, minTrailPct: 0.005, maxTrailPct: 0.04,
          },
        }],
      },
    }));

    mockKlineFetch(() => closes, start);

    const runner = new LivePaperRunner({
      stateFile: join(dir, "paper-state.json"),
      journalFile: join(dir, "paper-trades.jsonl"),
      aiMode: "no-ai",
      lookbackDaysByTf: { "1h": 1 },
      volSizing: false, // isolate trailing behavior from ATR-based sizing noise
      correlationGuard: false,
    }, poolPath);

    await runner.tick();
    let pos = runner.getSymbolPositions().find(p => p.symbol === "XRPUSDT")!;
    expect(pos.direction).toBe("long");
    expect(pos.trailing).toEqual({ phase: "initial", extremePrice: pos.avgEntryPrice });
    const originalStop = pos.governingStopPrice!;
    expect(originalStop).toBeCloseTo(pos.avgEntryPrice * 0.95, 6); // 5% fixed stop, untouched yet

    // Big favorable move: next tick's closed candle runs price up ~10%,
    // well past both breakeven and activation thresholds on a near-zero
    // ATR base.
    closes = [...closes, closes[closes.length - 1] * 1.10];
    await runner.tick();

    pos = runner.getSymbolPositions().find(p => p.symbol === "XRPUSDT")!;
    expect(pos.direction).toBe("long"); // still open -- the whole point of trailing is not exiting at the old fixed target
    expect(pos.trailing?.phase).toBe("trailing");
    expect(pos.governingStopPrice!).toBeGreaterThan(originalStop);
    expect(pos.governingStopPrice!).toBeGreaterThan(pos.avgEntryPrice); // trailing stop now sits above entry, not just above the old stop
  });

  it("never opens trailing state for a strategy without a trailing config", async () => {
    const start = Date.now() - 20 * 3600000;
    const closes = Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i / 3) * 0.3);

    writeFileSync(poolPath, JSON.stringify({
      symbols: {
        XRPUSDT: [{
          id: "no-trail-test", tf: "1h", direction: "long",
          entry: [{ type: "rsi_below", period: 14, value: 100 }],
          risk: { stopPct: 0.05, targetPct: 0.10 }, maxHoldBars: 200,
        }],
      },
    }));

    mockKlineFetch(() => closes, start);

    const runner = new LivePaperRunner({
      stateFile: join(dir, "paper-state.json"),
      journalFile: join(dir, "paper-trades.jsonl"),
      aiMode: "no-ai",
      lookbackDaysByTf: { "1h": 1 },
    }, poolPath);

    await runner.tick();
    const pos = runner.getSymbolPositions().find(p => p.symbol === "XRPUSDT")!;
    expect(pos.direction).toBe("long");
    expect(pos.trailing).toBeNull();
    expect(pos.trailingConfig).toBeNull();
  });
});
