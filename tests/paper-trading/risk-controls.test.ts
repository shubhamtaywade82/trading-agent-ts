import { volScale, fundingPnl } from "../../src/paper-trading/live-runner.js";
import { realizedPnlForUtcDate } from "../../src/paper-trading/circuit-breaker.js";
import { Candle } from "../../src/backtest/types.js";

function candle(i: number, range: number, base = 100): Candle {
  return { openTime: i * 3_600_000, open: base, high: base + range / 2, low: base - range / 2, close: base, volume: 1 };
}

describe("volScale", () => {
  it("returns 1 when recent volatility matches the window average", () => {
    const candles = Array.from({ length: 100 }, (_, i) => candle(i, 1));
    expect(volScale(candles)).toBeCloseTo(1);
  });

  it("scales down when recent volatility spikes, clamped at 0.5", () => {
    const calm = Array.from({ length: 100 }, (_, i) => candle(i, 1));
    const spiky = [...calm.slice(0, 86), ...Array.from({ length: 14 }, (_, i) => candle(86 + i, 10))];
    const s = volScale(spiky);
    expect(s).toBeLessThan(1);
    expect(s).toBeGreaterThanOrEqual(0.5);
  });

  it("never scales above 1 in quiet regimes", () => {
    const spikyPast = [...Array.from({ length: 50 }, (_, i) => candle(i, 10)), ...Array.from({ length: 50 }, (_, i) => candle(50 + i, 1))];
    expect(volScale(spikyPast)).toBe(1);
  });

  it("returns 1 with too few candles", () => {
    expect(volScale([candle(0, 1), candle(1, 1)])).toBe(1);
  });
});

describe("fundingPnl", () => {
  it("longs pay positive funding, shorts receive it", () => {
    expect(fundingPnl([0.0001, 0.0001], 10000, "long")).toBeCloseTo(-2);
    expect(fundingPnl([0.0001, 0.0001], 10000, "short")).toBeCloseTo(2);
  });

  it("negative funding flips the sign", () => {
    expect(fundingPnl([-0.0002], 10000, "long")).toBeCloseTo(2);
    expect(fundingPnl([-0.0002], 10000, "short")).toBeCloseTo(-2);
  });

  it("no funding events costs nothing", () => {
    expect(fundingPnl([], 10000, "long")).toBeCloseTo(0);
  });
});

describe("realizedPnlForUtcDate", () => {
  const trade = (exitTime: string, pnl: number) => ({
    strategyId: "s", symbol: "BTCUSDT", tf: "1h", direction: "long" as const,
    entryPrice: 100, exitPrice: 101, entryTime: exitTime, exitTime, reason: "target", pnl,
  });

  it("sums only trades closed on the given UTC date", () => {
    const trades = [
      trade("2026-07-17T01:00:00.000Z", -50),
      trade("2026-07-17T09:00:00.000Z", -75),
      trade("2026-07-16T23:59:00.000Z", 500),
    ];
    expect(realizedPnlForUtcDate(trades, "2026-07-17")).toBeCloseTo(-125);
    expect(realizedPnlForUtcDate(trades, "2026-07-16")).toBeCloseTo(500);
    expect(realizedPnlForUtcDate(trades, "2026-07-15")).toBe(0);
  });
});
