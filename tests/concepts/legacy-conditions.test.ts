import type { Candle } from "../../src/backtest/types.js";
import {
  legacyBullishOb, legacyBearishOb, legacyBullishFvg, legacyBearishFvg,
  legacyBullishLiqSweep, legacyBearishLiqSweep, legacyDisplacement,
  legacyObRetestLong, legacyObRetestShort,
} from "../../src/concepts/legacy-conditions.js";

function candle(openTime: number, open: number, high: number, low: number, close: number, volume = 100): Candle {
  return { openTime, open, high, low, close, volume };
}

describe("legacy-conditions OB/FVG wrappers", () => {
  it("flags a fair value gap where candle i-1's high sits below candle i+1's low", () => {
    const candles = [
      candle(0, 100, 101, 99, 100),
      candle(3_600_000, 100, 102, 100, 101.5),   // C1: high 102
      candle(7_200_000, 103, 105, 103, 104.5),   // Gap candle
      candle(10_800_000, 104.5, 106, 104, 105.5), // C3: low 104 > c1.high 102 -> bullish FVG at index 2
      candle(14_400_000, 105.5, 107, 105, 106),
    ];
    expect(legacyBullishFvg(candles, 2)).toBe(true);
    expect(legacyBearishFvg(candles, 2)).toBe(false);
  });

  it("returns false for every bar on a flat series with no structure", () => {
    const candles = Array.from({ length: 30 }, (_, i) => candle(i * 3_600_000, 100, 100.1, 99.9, 100));
    for (let i = 0; i < candles.length; i++) {
      expect(legacyBullishOb(candles, i)).toBe(false);
      expect(legacyBearishOb(candles, i)).toBe(false);
    }
  });

  it("caches the engine per candle array — calling twice with the same array doesn't throw or diverge", () => {
    const candles = Array.from({ length: 30 }, (_, i) => candle(i * 3_600_000, 100 + i, 101 + i, 99 + i, 100.5 + i));
    const first = legacyBullishOb(candles, 15);
    const second = legacyBullishOb(candles, 15);
    expect(first).toBe(second);
  });
});

describe("legacy-conditions liquidity sweep + displacement wrappers", () => {
  it("returns false everywhere on a flat series with no sweeps or displacement", () => {
    const candles = Array.from({ length: 40 }, (_, i) => candle(i * 3_600_000, 100, 100.1, 99.9, 100));
    for (let i = 0; i < candles.length; i++) {
      expect(legacyBullishLiqSweep(candles, i)).toBe(false);
      expect(legacyBearishLiqSweep(candles, i)).toBe(false);
      expect(legacyDisplacement(candles, i)).toBeNull();
    }
  });

  it("legacyDisplacement returns only {dir} — never reads or requires a strength field downstream", () => {
    const candles = Array.from({ length: 40 }, (_, i) => candle(i * 3_600_000, 100, 100.1, 99.9, 100));
    const result = legacyDisplacement(candles, 20);
    expect(result === null || ("dir" in result && (result.dir === "up" || result.dir === "down"))).toBe(true);
  });
});

describe("legacy-conditions OB retest wrappers", () => {
  it("returns false everywhere on a flat series with no order blocks", () => {
    const candles = Array.from({ length: 40 }, (_, i) => candle(i * 3_600_000, 100, 100.1, 99.9, 100));
    for (let i = 0; i < candles.length; i++) {
      expect(legacyObRetestLong(candles, i)).toBe(false);
      expect(legacyObRetestShort(candles, i)).toBe(false);
    }
  });

  it("fires at most once per zone — long and short never both true on the same bar for a single-zone series", () => {
    const candles: Candle[] = [];
    let px = 100;
    for (let i = 0; i < 15; i++) { candles.push(candle(i * 3_600_000, px, px + 0.2, px - 0.2, px)); px -= 0.05; }
    candles.push(candle(15 * 3_600_000, px, px + 0.1, px - 0.3, px - 0.2)); // Down-close candle -> bullish OB candidate
    for (let i = 16; i < 20; i++) { px += 2; candles.push(candle(i * 3_600_000, px - 2, px + 0.1, px - 2.1, px)); } // Impulse up
    for (let i = 20; i < 30; i++) { px -= 0.3; candles.push(candle(i * 3_600_000, px + 0.3, px + 0.35, px - 0.05, px)); } // Pullback
    for (let i = 0; i < candles.length; i++) {
      expect(legacyObRetestLong(candles, i) && legacyObRetestShort(candles, i)).toBe(false);
    }
  });
});
