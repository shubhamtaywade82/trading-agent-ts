import { SymbolPositionManager, flatPosition, StrategyIntent, SymbolPosition } from "../../src/paper-trading/symbol-position.js";

function intent(overrides: Partial<StrategyIntent>): StrategyIntent {
  return {
    strategyId: "x", symbol: "XRPUSDT", tf: "1h", direction: "long",
    stopPct: 0.03, targetPct: 0.06, maxHoldBars: 48,
    entryBarIdx: 0, entryBarOpenTime: 0,
    ...overrides,
  };
}

// leverage=5, feeBps=10 (0.1%) chosen so every hand-computed number below is exact
// (or a clean repeating decimal, asserted with toBeCloseTo).
const mgr = new SymbolPositionManager(5, 10);

describe("SymbolPositionManager", () => {
  it("runs the full open -> add -> reduce -> close sequence with exact weighted-average-cost math", () => {
    let pos: SymbolPosition = flatPosition("XRPUSDT");

    // 1. OPEN: strategy A, long, entry=100, qty=10
    const openIntent = intent({ strategyId: "A", entryBarIdx: 5, entryBarOpenTime: 5_000 });
    const openResult = mgr.applyIntent(pos, openIntent, 100, 10);
    pos = openResult.position;

    expect(openResult.fills).toHaveLength(1);
    expect(openResult.fills[0]).toMatchObject({
      action: "open", strategyId: "A", triggerStrategyId: "A",
      qty: 10, notionalDelta: 1000, marginDelta: 200, realizedPnl: 0, feeUsd: 1,
    });
    expect(pos).toMatchObject({
      direction: "long", qty: 10, avgEntryPrice: 100, notional: 1000, margin: 200,
      governingStrategyId: "A", governingStopPrice: 97, governingTargetPrice: 106,
      governingMaxHoldBars: 48, governingEntryBarIdx: 5,
      contributingStrategyIds: ["A"],
    });

    // 2. ADD: strategy B, same direction, entry=110, qty=5 -> averages into the position.
    // newAvgEntry = (10*100 + 5*110) / 15 = 103.333...
    const addIntent = intent({ strategyId: "B", entryBarIdx: 6, entryBarOpenTime: 6_000 });
    const addResult = mgr.applyIntent(pos, addIntent, 110, 5);
    pos = addResult.position;

    expect(addResult.fills).toHaveLength(1);
    expect(addResult.fills[0]).toMatchObject({
      action: "add", strategyId: "B", triggerStrategyId: "B",
      qty: 5, notionalDelta: 550, marginDelta: 110, realizedPnl: 0, feeUsd: 0.55,
    });
    expect(pos.qty).toBe(15);
    expect(pos.avgEntryPrice).toBeCloseTo(103.333333, 5);
    expect(pos.notional).toBe(1550);
    expect(pos.margin).toBe(310);
    // Governing risk plan is UNCHANGED by the add -- still strategy A's.
    expect(pos.governingStrategyId).toBe("A");
    expect(pos.governingStopPrice).toBe(97);
    expect(pos.governingTargetPrice).toBe(106);
    expect(pos.governingEntryBarIdx).toBe(5);
    expect(pos.contributingStrategyIds).toEqual(["A", "B"]);

    // 3. REDUCE: strategy C signals opposite direction, qty=6 < current 15 -> partial reduce.
    // grossPnl = (120 - 103.333...) * 6 = 100 exactly; fee = 720*0.001=0.72; realizedPnl=99.28
    const reduceIntent = intent({ strategyId: "C", direction: "short", entryBarIdx: 7, entryBarOpenTime: 7_000 });
    const reduceResult = mgr.applyIntent(pos, reduceIntent, 120, 6);
    pos = reduceResult.position;

    expect(reduceResult.fills).toHaveLength(1); // all 6 consumed from lot A (qty 10), lot B untouched
    const reduceFill = reduceResult.fills[0];
    expect(reduceFill.action).toBe("reduce");
    expect(reduceFill.strategyId).toBe("A");
    expect(reduceFill.triggerStrategyId).toBe("C");
    expect(reduceFill.qty).toBe(6);
    expect(reduceFill.realizedPnl).toBeCloseTo(99.28, 6);
    expect(reduceFill.feeUsd).toBeCloseTo(0.72, 6);
    expect(reduceFill.notionalDelta).toBeCloseTo(-720, 6);
    expect(reduceFill.marginDelta).toBeCloseTo(-124, 6);
    expect(pos.qty).toBe(9);
    expect(pos.avgEntryPrice).toBeCloseTo(103.333333, 5); // unchanged by a reduce
    expect(pos.notional).toBeCloseTo(930, 6);
    expect(pos.margin).toBeCloseTo(186, 6);
    expect(pos.contributingStrategyIds).toEqual(["A", "B"]); // both lots still present (A has 4 left, B has 5)

    // 4. CLOSE the rest via risk management (target hit), triggered by the governing strategy.
    // grossPnl = (106 - 103.333...) * 9 = 24 exactly; fee = 954*0.001=0.954; realizedPnl=23.046
    // Split FIFO across remaining lots {A: 4, B: 5}: A gets 4/9 share, B gets the remainder.
    const closeResult = mgr.closePosition(pos, "A", 106, "target");
    pos = closeResult.position;

    expect(closeResult.fills).toHaveLength(2);
    const [closeA, closeB] = closeResult.fills;
    expect(closeA).toMatchObject({ action: "close", strategyId: "A", triggerStrategyId: "A", qty: 4, reason: "target" });
    expect(closeA.realizedPnl).toBeCloseTo(10.242667, 5);
    expect(closeB).toMatchObject({ action: "close", strategyId: "B", triggerStrategyId: "A", qty: 5, reason: "target" });
    expect(closeB.realizedPnl).toBeCloseTo(12.803333, 5);
    // The two slices sum back exactly to the one true realized PnL (23.046) -- no rounding drift.
    expect(closeA.realizedPnl + closeB.realizedPnl).toBeCloseTo(23.046, 9);
    expect(closeA.feeUsd + closeB.feeUsd).toBeCloseTo(0.954, 9);

    expect(pos).toEqual(flatPosition("XRPUSDT"));
  });

  it("flips a position when an opposite-direction intent requests more qty than currently held", () => {
    let pos: SymbolPosition = flatPosition("XRPUSDT");
    const openX = intent({ strategyId: "X", entryBarIdx: 1, entryBarOpenTime: 1_000 });
    pos = mgr.applyIntent(pos, openX, 100, 10).position;

    const flipY = intent({ strategyId: "Y", direction: "short", entryBarIdx: 2, entryBarOpenTime: 2_000 });
    const flipResult = mgr.applyIntent(pos, flipY, 90, 20);
    pos = flipResult.position;

    expect(flipResult.fills).toHaveLength(2);
    const [closeFill, openFill] = flipResult.fills;
    // Closing the old long: grossPnl=(90-100)*10=-100; fee=900*0.001=0.9; realizedPnl=-100.9
    expect(closeFill).toMatchObject({ action: "flip_close", strategyId: "X", triggerStrategyId: "Y", qty: 10 });
    expect(closeFill.realizedPnl).toBeCloseTo(-100.9, 6);
    // Opening the new short with the remainder (20-10=10 qty), governed by Y.
    expect(openFill).toMatchObject({ action: "flip_open", strategyId: "Y", triggerStrategyId: "Y", qty: 10 });

    expect(pos.direction).toBe("short");
    expect(pos.qty).toBe(10);
    expect(pos.avgEntryPrice).toBe(90);
    expect(pos.governingStrategyId).toBe("Y");
    expect(pos.governingStopPrice).toBeCloseTo(92.7, 6); // short: entry*(1+stopPct)
    expect(pos.governingTargetPrice).toBeCloseTo(84.6, 6); // short: entry*(1-targetPct)
    expect(pos.contributingStrategyIds).toEqual(["Y"]);
  });

  it("computes the liquidation price consistently for long and short opens", () => {
    const longPos = mgr.applyIntent(flatPosition("XRPUSDT"), intent({ direction: "long" }), 100, 10).position;
    expect(longPos.liqPrice).toBeCloseTo(80.5, 6); // 100*(1-1/5+0.005)

    const shortPos = mgr.applyIntent(flatPosition("XRPUSDT"), intent({ direction: "short" }), 100, 10).position;
    expect(shortPos.liqPrice).toBeCloseTo(119.5, 6); // 100*(1+1/5-0.005)
  });
});
