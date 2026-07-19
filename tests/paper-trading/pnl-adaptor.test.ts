import { decideSizeMultiplier, decidePrune, DEFAULT_PNL_ADAPTOR_CONFIG } from "../../src/paper-trading/pnl-adaptor.js";
import { ClosedTrade } from "../../src/paper-trading/trade-analyst.js";

const cfg = DEFAULT_PNL_ADAPTOR_CONFIG;

function trade(pnl: number): ClosedTrade {
  return { strategyId: "s", symbol: "XRPUSDT", tf: "1h", direction: "short", entryPrice: 100, exitPrice: 99, entryTime: "t", exitTime: "t", reason: "target", pnl };
}

// n trades with the given win-rate, sized so PF lands close to the target ratio.
function tradesWithPf(n: number, pf: number): ClosedTrade[] {
  const wins = Math.round(n / 2);
  const losses = n - wins;
  const winPnl = pf; // grossProfit = wins * pf
  const lossPnl = 1; // grossLoss = losses * 1
  return [
    ...Array.from({ length: wins }, () => trade(winPnl)),
    ...Array.from({ length: losses }, () => trade(-lossPnl)),
  ];
}

describe("decideSizeMultiplier", () => {
  it("returns null below the minimum sample size", () => {
    const trades = tradesWithPf(cfg.minSampleSize - 1, 0.3);
    expect(decideSizeMultiplier(trades, 2.0, 1, cfg)).toBeNull();
  });

  it("scales down when live PF trails backtest PF (below 70%)", () => {
    const trades = tradesWithPf(cfg.minSampleSize, 0.5); // livePf well under 70% of backtestPf=2.0
    const result = decideSizeMultiplier(trades, 2.0, 1, cfg);
    expect(result).not.toBeNull();
    expect(result!).toBeLessThan(1);
    expect(result!).toBeGreaterThanOrEqual(cfg.sizeMultiplierMin);
  });

  it("scales up when live PF clears backtest PF outright", () => {
    const trades = tradesWithPf(cfg.minSampleSize, 3.0); // livePf > backtestPf=1.5
    const result = decideSizeMultiplier(trades, 1.5, 1, cfg);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(1);
  });

  it("caps the scale-up at sizeMultiplierMax over repeated cycles", () => {
    const trades = tradesWithPf(cfg.minSampleSize, 3.0);
    const result = decideSizeMultiplier(trades, 1.5, cfg.sizeMultiplierMax, cfg);
    expect(result).toBeNull(); // already at the ceiling -- no further change
  });

  it("returns null when live PF is within the normal band (no change)", () => {
    const trades = tradesWithPf(cfg.minSampleSize, 1.8); // between 70% and 100% of backtestPf=2.0
    expect(decideSizeMultiplier(trades, 2.0, 1, cfg)).toBeNull();
  });
});

describe("decidePrune", () => {
  it("does not prune below pruneMinSample even if PF is terrible", () => {
    const trades = tradesWithPf(cfg.pruneMinSample - 1, 0.2);
    expect(decidePrune(trades, cfg).prune).toBe(false);
  });

  it("prunes when PF stays decisively under floor with no recent recovery", () => {
    const trades = tradesWithPf(cfg.pruneMinSample, 0.2); // overall PF ~0.2, well under pruneFloorPf=0.5
    const result = decidePrune(trades, cfg);
    expect(result.prune).toBe(true);
    expect(result.reason).toContain("live PF");
  });

  it("does not prune when the most recent slice has recovered above floor", () => {
    const base = tradesWithPf(cfg.pruneMinSample - cfg.recoverySliceSize, 0.2);
    const recovered = tradesWithPf(cfg.recoverySliceSize, 5.0); // strong recent PF pulls the recovery slice up
    const result = decidePrune([...base, ...recovered], cfg);
    expect(result.prune).toBe(false);
  });
});
