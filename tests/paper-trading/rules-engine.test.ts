import type { MarketContext } from "../../src/paper-trading/rules-engine.js";
import { DecoupledRuleEngine, buildConditionFromJson } from "../../src/paper-trading/rules-engine.js";

describe("DecoupledRuleEngine", () => {
  const dummyCtx: MarketContext = {
    symbol: "BTCUSDT",
    currentPrice: 50_000,
    candles: [
      { openTime: 1, open: 49_000, high: 50_500, low: 48_900, close: 50_000, volume: 10 },
    ],
    indicators: { rsi: 25, ema20: 49_500 },
  };

  test("evaluates matching rules in order", () => {
    const engine = new DecoupledRuleEngine("test_engine", "Test Strategy Engine");

    const rsiLowCondition = buildConditionFromJson({
      indicator: "rsi",
      operator: "<",
      value: 30,
    });

    engine.addRule({
      id: "rsi_oversold",
      name: "RSI Oversold Buy Signal",
      condition: rsiLowCondition,
      direction: "long",
      stopLossPct: 0.02,
      takeProfitPct: 0.04,
    });

    const signal = engine.evaluate(dummyCtx);
    expect(signal).not.toBeNull();
    expect(signal?.direction).toBe("long");
    expect(signal?.ruleId).toBe("rsi_oversold");
    expect(signal?.stopLossPct).toBe(0.02);
  });

  test("returns null if no condition matches", () => {
    const engine = new DecoupledRuleEngine("test_engine", "Test Strategy Engine");

    engine.addRule({
      id: "rsi_overbought",
      name: "RSI Overbought Sell Signal",
      condition: buildConditionFromJson({ indicator: "rsi", operator: ">", value: 70 }),
      direction: "short",
    });

    const signal = engine.evaluate(dummyCtx);
    expect(signal).toBeNull();
  });
});
