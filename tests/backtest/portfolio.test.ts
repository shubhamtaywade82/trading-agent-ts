import { runPortfolioBacktest } from "../../src/backtest/portfolio.js";
import { Candle, StrategyConfig } from "../../src/backtest/types.js";

function makeCandles(closes: number[], startTime = 0): Candle[] {
  return closes.map((c, i) => ({
    openTime: startTime + i * 60000, // 1-minute intervals
    open: c,
    high: c * 1.001,
    low: c * 0.999,
    close: c,
    volume: 100,
  }));
}

describe("runPortfolioBacktest", () => {
  it("chronologically simulates trades and respects concurrent limits", () => {
    // BTC: enters at time 14, exits at time 15 (closes[14]->closes[15])
    // ETH: enters at time 14, exits at time 15
    // With maxConcurrentPositions = 1, one of them should be skipped or open time constraints should apply.
    const btcCloses = Array.from({ length: 60 }, (_, i) => 100 + i);
    const ethCloses = Array.from({ length: 60 }, (_, i) => 200 + i);

    const btcCandles = makeCandles(btcCloses, 1000000);
    const ethCandles = makeCandles(ethCloses, 1000000);

    const strategy: StrategyConfig = {
      direction: "long",
      entry: [{ type: "rsi_below", period: 14, value: 101 }],
      risk: { stopPct: 0.5, targetPct: 0.01 }, // tight target
      feeBps: 0,
    };

    // With maxConcurrentPositions = 1
    const resultSingle = runPortfolioBacktest(
      { BTCUSDT: btcCandles, ETHUSDT: ethCandles },
      {
        initialCapital: 10000,
        maxConcurrentPositions: 1,
        allocationPerTradePct: 0.5,
        strategy,
      }
    );

    // If limit is 1, only one asset can have an active position at a time.
    // Check if any executed trades overlapped in time
    const overlaps = resultSingle.trades.some((t1, idx1) => {
      return resultSingle.trades.some((t2, idx2) => {
        if (idx1 === idx2) return false;
        const t1Entry = t1.entryTime ?? 0;
        const t1Exit = t1.exitTime ?? 0;
        const t2Entry = t2.entryTime ?? 0;
        const t2Exit = t2.exitTime ?? 0;
        return t1Entry < t2Exit && t2Entry < t1Exit;
      });
    });

    expect(overlaps).toBe(false);
    expect(resultSingle.trades.length).toBeGreaterThan(0);
    expect(resultSingle.finalCapital).toBeGreaterThan(10000);
  });

  it("handles empty candidate trades list gracefully", () => {
    const strategy: StrategyConfig = {
      direction: "long",
      entry: [{ type: "rsi_above", period: 14, value: 100 }], // never triggers
      risk: { stopPct: 0.02, targetPct: 0.02 },
    };

    const result = runPortfolioBacktest(
      { BTCUSDT: makeCandles([100, 101, 102]) },
      { strategy }
    );

    expect(result.trades).toHaveLength(0);
    expect(result.finalCapital).toBe(10000);
    expect(result.metrics.totalTrades).toBe(0);
  });
});
