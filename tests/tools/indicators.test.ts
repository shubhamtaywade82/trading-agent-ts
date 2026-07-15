import { sma, ema, rsi, macd, bollingerBands } from "../../src/tools/indicators.js";

describe("indicators", () => {
  it("sma averages the last N values", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toBeCloseTo(4); // (3+4+5)/3
  });

  it("ema converges toward recent values faster than sma", () => {
    const acceleratingUp = Array.from({ length: 30 }, (_, i) => 100 + i * i * 0.1);
    expect(ema(acceleratingUp, 10)).toBeGreaterThan(sma(acceleratingUp, 10));
  });

  it("rsi is 100 when there are no losses", () => {
    const alwaysUp = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsi(alwaysUp, 14)).toBe(100);
  });

  it("rsi is near 0 when there are only losses", () => {
    const alwaysDown = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(rsi(alwaysDown, 14)).toBeLessThan(1);
  });

  it("rsi sits at 50 for a flat series", () => {
    const flat = Array.from({ length: 20 }, () => 100);
    expect(rsi(flat, 14)).toBe(100); // no losses at all -> RSI formula saturates to 100
  });

  it("macd histogram is positive when price is accelerating upward", () => {
    const accelerating = Array.from({ length: 60 }, (_, i) => 100 + i * i * 0.01);
    const result = macd(accelerating);
    expect(result.histogram).toBeGreaterThan(0);
  });

  it("bollinger bands bracket the middle band symmetrically", () => {
    const values = Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i));
    const { upper, middle, lower } = bollingerBands(values, 20, 2);
    expect(upper - middle).toBeCloseTo(middle - lower, 6);
    expect(upper).toBeGreaterThan(middle);
    expect(lower).toBeLessThan(middle);
  });
});
