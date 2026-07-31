import { appendFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DriftMonitor } from "../../src/paper-trading/drift-monitor.js";

function basisLine(symbol: string, basisBps: number) {
  return `${JSON.stringify({ ts: new Date().toISOString(), symbol, eventType: "entry", direction: "long", binancePrice: 100, coindcxPrice: 100 * (1 + basisBps / 10_000), basisBps })  }\n`;
}

describe("DriftMonitor basis-drift alert", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "drift-monitor-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeMonitor(overrides: Record<string, unknown> = {}) {
    return new DriftMonitor({
      journalFile: join(dir, "paper-trades.jsonl"), // Absent -> reconstructClosedTrades returns []
      poolPath: join(dir, "strategies.json"),
      stateFile: join(dir, "drift-monitor-state.json"),
      logFile: join(dir, "drift-alerts.jsonl"),
      basisLogFile: join(dir, "coindcx-basis.jsonl"),
      basisWindow: 5,
      basisThresholdBps: 15,
      notifyTelegram: false,
      ...overrides,
    });
  }

  it("does not alert below the basis window minimum", async () => {
    const basisFile = join(dir, "coindcx-basis.jsonl");
    for (let i = 0; i < 4; i++) appendFileSync(basisFile, basisLine("XRPUSDT", 50));
    const monitor = makeMonitor();
    const result = await monitor.check();
    expect(result.alerts).toStrictEqual([]);
  });

  it("alerts once avg |basis| over the window exceeds the threshold", async () => {
    const basisFile = join(dir, "coindcx-basis.jsonl");
    for (let i = 0; i < 5; i++) appendFileSync(basisFile, basisLine("XRPUSDT", 50));
    const monitor = makeMonitor();
    const result = await monitor.check();
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toContain("XRPUSDT");
    expect(result.alerts[0]).toContain("BASIS DRIFT");
  });

  it("does not re-alert on a second check while still drifting", async () => {
    const basisFile = join(dir, "coindcx-basis.jsonl");
    for (let i = 0; i < 5; i++) appendFileSync(basisFile, basisLine("XRPUSDT", 50));
    const monitor = makeMonitor();
    await monitor.check();
    const second = await monitor.check();
    expect(second.alerts).toStrictEqual([]);
  });

  it("re-arms and alerts again after recovering then drifting again", async () => {
    const basisFile = join(dir, "coindcx-basis.jsonl");
    for (let i = 0; i < 5; i++) appendFileSync(basisFile, basisLine("XRPUSDT", 50));
    const monitor = makeMonitor();
    await monitor.check(); // Fires

    writeFileSync(basisFile, ""); // Simulate recovery: fresh calm window
    for (let i = 0; i < 5; i++) appendFileSync(basisFile, basisLine("XRPUSDT", 2));
    const calm = await monitor.check();
    expect(calm.alerts).toStrictEqual([]);

    for (let i = 0; i < 5; i++) appendFileSync(basisFile, basisLine("XRPUSDT", 50));
    const again = await monitor.check();
    expect(again.alerts).toHaveLength(1);
  });

  it("stays under threshold when basis is small", async () => {
    const basisFile = join(dir, "coindcx-basis.jsonl");
    for (let i = 0; i < 10; i++) appendFileSync(basisFile, basisLine("ETHUSDT", 3));
    const monitor = makeMonitor();
    const result = await monitor.check();
    expect(result.alerts).toStrictEqual([]);
  });
});
