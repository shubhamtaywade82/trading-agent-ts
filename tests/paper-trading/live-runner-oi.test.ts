import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync } from "fs";
import { LivePaperRunner } from "../../src/paper-trading/live-runner.js";

function fakeKlines(closes: number[], startMs: number): unknown[][] {
  return closes.map((c, i) => {
    const t = startMs + i * 3600000;
    return [t, c, c * 1.001, c * 0.999, c, "100", t + 3599999, "0", 0, "0", "0", "0"];
  });
}

describe("LivePaperRunner: OI conditions", () => {
  let dir: string;
  let poolPath: string;
  const originalFetch = global.fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "live-runner-oi-"));
    poolPath = join(dir, "strategies.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    (globalThis as any).fetch = originalFetch;
  });

  it("fetches OI history and passes it to the evaluator when an active strategy uses oi_*", async () => {
    const start = Date.now() - 20 * 3600000;
    const closes = [...Array(10).fill(100), 105, 105, 105, 105, 105, 105, 105, 105, 105, 105];
    const timestamps = closes.map((_, i) => start + i * 3600000);
    let sawOiCall = false;

    // fetchCandlesRange / fetchOpenInterestHist both page with a startTime
    // cursor until the response comes back empty — the mock must honor
    // startTime and return [] once exhausted, or the real pagination loop
    // spins forever re-requesting the same fixed batch.
    (globalThis as any).fetch = jest.fn().mockImplementation((url: URL) => {
      const href = url.toString();
      const reqStart = Number(url.searchParams.get("startTime") ?? 0);
      if (href.includes("/futures/data/openInterestHist")) {
        sawOiCall = true;
        const rows = timestamps
          .map((t, i) => ({ t, i }))
          .filter(({ t }) => t >= reqStart)
          .map(({ t, i }) => ({ symbol: "XRPUSDT", sumOpenInterest: String(1000 - i * 10), sumOpenInterestValue: "1", timestamp: t }));
        return Promise.resolve({ ok: true, status: 200, json: async () => rows });
      }
      const keep = timestamps.filter(t => t >= reqStart).length;
      const rows = keep > 0 ? fakeKlines(closes.slice(closes.length - keep), timestamps[timestamps.length - keep]) : [];
      return Promise.resolve({ ok: true, status: 200, json: async () => rows });
    });

    writeFileSync(poolPath, JSON.stringify({
      symbols: {
        XRPUSDT: [{
          id: "oi-test", tf: "1h", direction: "short",
          entry: [{ type: "oi_bearish_divergence", period: 10, value: 0.01 }],
          risk: { stopPct: 0.02, targetPct: 0.04 }, maxHoldBars: 48,
        }],
      },
    }));

    const runner = new LivePaperRunner({
      stateFile: join(dir, "paper-state.json"),
      journalFile: join(dir, "paper-trades.jsonl"),
      aiMode: "no-ai",
      lookbackDaysByTf: { "1h": 1 },
    }, poolPath);

    await runner.tick();
    expect(sawOiCall).toBe(true);
  });
});
