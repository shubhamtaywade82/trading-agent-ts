import { describe, it, expect } from "@jest/globals";
import { RiskManager } from "../src/risk/riskManager.js";
import { loadConfig } from "../src/config/loader.js";
import type { Account, Signal } from "../src/domain/types.js";

const makeAccount = (): Account => ({
  cash: 100_000,
  equity: 100_000,
  positions: new Map(),
  dailyPnl: 0,
});

const makeSignal = (): Signal => ({
  id: "test-signal-1",
  symbol: "AAPL",
  side: "BUY",
  kind: "ENTRY",
  reason: "EMA Cross",
  strength: 1,
  ts: Date.now(),
});

describe("RiskManager Sizing & Hard Gates", () => {
  it("calculates sizing as a percentage of equity without hardcoded currency literals", () => {
    const cfg = loadConfig(undefined, {
      paper: { enabled: true, initialCapital: 100_000, baseCurrency: "USD" },
      risk: {
        riskPerTradePct: 1,
        maxPositionPct: 100,
        maxOpenPositions: 5,
        maxDailyLossPct: 5,
        defaultStopAtrMult: 2,
        defaultTakeProfitRR: 2,
      },
    });
    const rm = new RiskManager(cfg);

    // price = 100, atr = 1 => stopDistance = 2 => riskBudget = 1000 => qty = 500
    const decision = rm.decide(makeSignal(), makeAccount(), 100, 1);
    expect(decision.ok).toBe(true);
    expect(decision.intent?.qty).toBe(500);
    expect(decision.intent?.stopLoss).toBeCloseTo(98);
    expect(decision.intent?.takeProfit).toBeCloseTo(104);
  });

  it("halts entry orders on daily loss circuit breaker", () => {
    const cfg = loadConfig(undefined, {
      risk: { maxDailyLossPct: 3 },
    });
    const rm = new RiskManager(cfg);
    const acc = makeAccount();
    acc.dailyPnl = -3100; // > 3% of 100,000 equity

    const decision = rm.decide(makeSignal(), acc, 100, 1);
    expect(decision.ok).toBe(false);
    expect(decision.rejectReason).toBe("daily_loss_limit");
  });
});
