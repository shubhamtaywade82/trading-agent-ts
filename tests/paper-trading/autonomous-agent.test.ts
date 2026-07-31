import { AutonomousTradingAgent } from "../../src/paper-trading/autonomous-agent.js";
import { PaperTradingBrokerageService } from "../../src/paper-trading/brokerage.js";
import type { MarketContext } from "../../src/paper-trading/rules-engine.js";
import { DecoupledRuleEngine, buildConditionFromJson } from "../../src/paper-trading/rules-engine.js";
import { DEFAULT_TRADING_CONFIG } from "../../src/paper-trading/trading-config.js";

describe("AutonomousTradingAgent", () => {
  let agent: AutonomousTradingAgent;
  let ruleEngine: DecoupledRuleEngine;
  let brokerage: PaperTradingBrokerageService;

  beforeEach(async () => {
    ruleEngine = new DecoupledRuleEngine("auto_engine", "Autonomous Rules Engine");
    ruleEngine.addRule({
      id: "rsi_low_buy",
      name: "RSI Low Buy Rule",
      condition: buildConditionFromJson({ indicator: "rsi", operator: "<", value: 30 }),
      direction: "long",
      stopLossPct: 0.02,
      takeProfitPct: 0.04,
    });

    brokerage = new PaperTradingBrokerageService(DEFAULT_TRADING_CONFIG);
    agent = new AutonomousTradingAgent(DEFAULT_TRADING_CONFIG, ruleEngine, brokerage);
    await agent.initialize();
  });

  test("runs tick loop autonomously and executes trade on matching rule", async () => {
    const marketCtx: MarketContext = {
      symbol: "BTCUSDT",
      currentPrice: 50_000,
      candles: [{ openTime: 1, open: 50_000, high: 50_100, low: 49_900, close: 50_000, volume: 100 }],
      indicators: { rsi: 20 },
    };

    const result = await agent.runTick(marketCtx);

    expect(result).not.toBeNull();
    expect(result?.status).toBe("filled");
    expect(result?.direction).toBe("long");
    expect(agent.fsm.getState()).toBe("IDLE");

    const positions = await brokerage.getOpenPositions("BTCUSDT");
    expect(positions).toHaveLength(1);
    expect(positions[0].stopPrice).toBeCloseTo(49_000, 0);
  });

  test("returns null and remains IDLE if no rule triggers", async () => {
    const marketCtx: MarketContext = {
      symbol: "BTCUSDT",
      currentPrice: 50_000,
      candles: [{ openTime: 1, open: 50_000, high: 50_100, low: 49_900, close: 50_000, volume: 100 }],
      indicators: { rsi: 50 },
    };

    const result = await agent.runTick(marketCtx);
    expect(result).toBeNull();
    expect(agent.fsm.getState()).toBe("IDLE");

    const positions = await brokerage.getOpenPositions();
    expect(positions).toHaveLength(0);
  });
});
