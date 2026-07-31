import type { EntryMarginInputs } from "../../src/paper-trading/live-runner.js";
import { correlationScale, computeEntryMargin } from "../../src/paper-trading/live-runner.js";

describe("correlationScale", () => {
  it("returns 1 (no downsize) at or below the threshold", () => {
    expect(correlationScale(0, 5, 0.5)).toBe(1);
    expect(correlationScale(2, 5, 0.5)).toBe(1); // 2/5 = 0.4 < 0.5
  });

  it("downsizes once the same-direction fraction crosses the threshold", () => {
    const at3of5 = correlationScale(3, 5, 0.5); // 0.6 fraction
    const at5of5 = correlationScale(5, 5, 0.5); // 1.0 fraction, max overshoot
    expect(at3of5).toBeLessThan(1);
    expect(at3of5).toBeGreaterThan(at5of5);
  });

  it("never downsizes below the 0.4 floor even at 100% same-direction", () => {
    expect(correlationScale(10, 10, 0.5)).toBeCloseTo(0.4, 5);
  });

  it("treats zero total symbols as a no-op (returns 1, no division by zero)", () => {
    expect(correlationScale(0, 0, 0.5)).toBe(1);
  });
});

describe("computeEntryMargin", () => {
  const base: EntryMarginInputs = {
    symbolCapital: 10_000, stopPct: 0.02, leverage: 10,
    marginPerTradePct: 0.25, riskPerTradePct: 0.015,
    maxMarginUtilizationPct: 0.6, existingSameDirMargin: 0, sizeScale: 1,
  };

  it("uses risk-based sizing when it's below the marginPerTradePct ceiling", () => {
    // RiskMargin = 10000 * 0.015 / 0.02 / 10 = 750; flatMargin = 2500 -> risk wins
    expect(computeEntryMargin(base)).toBeCloseTo(750, 5);
  });

  it("caps at marginPerTradePct when a tight stop would demand more than the ceiling", () => {
    // StopPct 0.001 -> riskMargin = 10000*0.015/0.001/10 = 15000, way above flatMargin=2500
    const result = computeEntryMargin({ ...base, stopPct: 0.001 });
    expect(result).toBeCloseTo(2500, 5);
  });

  it("applies sizeScale (vol/correlation) multiplicatively on top of the risk-based margin", () => {
    const result = computeEntryMargin({ ...base, sizeScale: 0.5 });
    expect(result).toBeCloseTo(375, 5); // 750 * 0.5
  });

  it("clips to the exposure-cap headroom when an existing same-direction position already uses most of it", () => {
    // Headroom = 10000*0.60 - existing 5900 = 100, well below the 750 risk-based margin
    const result = computeEntryMargin({ ...base, existingSameDirMargin: 5900 });
    expect(result).toBeCloseTo(100, 5);
  });

  it("returns 0 (never negative) once the exposure cap is fully exhausted", () => {
    const result = computeEntryMargin({ ...base, existingSameDirMargin: 6000 }); // = cap exactly
    expect(result).toBe(0);
    const overCap = computeEntryMargin({ ...base, existingSameDirMargin: 9000 }); // Over cap
    expect(overCap).toBe(0);
  });
});
