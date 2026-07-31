import {
  DEFAULT_TRADING_CONFIG,
  validateTradingConfig,
  calculatePositionQuantity,
} from "../../src/paper-trading/trading-config.js";

describe("TradingConfig", () => {
  test("validates default config", () => {
    const config = validateTradingConfig({});
    expect(config.initialCapital).toBe(10_000);
    expect(config.riskPercentageOfCapital).toBe(0.015);
  });

  test("throws on invalid initial capital", () => {
    expect(() => validateTradingConfig({ initialCapital: 0 })).toThrow("initialCapital must be positive");
  });

  test("calculates position quantity based on risk percentage", () => {
    const config = validateTradingConfig({
      initialCapital: 10_000,
      riskPercentageOfCapital: 0.01, // $100 risk
      stopLossPct: 0.05, // 5% stop loss
    });
    // Risk amount = $100. Loss per unit at entryPrice 100 = 100 * 0.05 = 5.
    // Qty = 100 / 5 = 20.
    const qty = calculatePositionQuantity(config, 10_000, 100);
    expect(qty).toBeCloseTo(20, 2);
  });

  test("returns 0 quantity for invalid equity or entry price", () => {
    const qty = calculatePositionQuantity(DEFAULT_TRADING_CONFIG, -100, 100);
    expect(qty).toBe(0);
  });
});
