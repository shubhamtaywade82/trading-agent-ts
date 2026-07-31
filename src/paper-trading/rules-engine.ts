import { Candle } from "../backtest/types.js";

export interface MarketContext {
  symbol: string;
  currentPrice: number;
  candles: Candle[];
  indicators?: Record<string, number>;
}

export interface RuleSignal {
  symbol: string;
  direction: "long" | "short" | "flat";
  stopLossPct?: number;
  takeProfitPct?: number;
  rationale: string;
  ruleId: string;
}

export type RuleCondition = (ctx: MarketContext) => boolean;

export interface TradingRule {
  id: string;
  name: string;
  condition: RuleCondition;
  direction: "long" | "short" | "flat";
  stopLossPct?: number;
  takeProfitPct?: number;
}

export interface Strategy {
  id: string;
  name: string;
  rules: TradingRule[];
  evaluate(ctx: MarketContext): RuleSignal | null;
}

export class DecoupledRuleEngine implements Strategy {
  constructor(
    public id: string,
    public name: string,
    public rules: TradingRule[] = [],
  ) {}

  addRule(rule: TradingRule): void {
    this.rules.push(rule);
  }

  evaluate(ctx: MarketContext): RuleSignal | null {
    if (!ctx || ctx.candles.length === 0) return null;

    for (const rule of this.rules) {
      if (rule.condition(ctx)) {
        return {
          symbol: ctx.symbol,
          direction: rule.direction,
          stopLossPct: rule.stopLossPct,
          takeProfitPct: rule.takeProfitPct,
          rationale: `Rule '${rule.name}' [${rule.id}] evaluated to true`,
          ruleId: rule.id,
        };
      }
    }
    return null;
  }
}

// JSON-rule condition parser for simple indicator thresholds
export interface JsonRuleCondition {
  indicator: string;
  operator: ">" | "<" | ">=" | "<=" | "==";
  value: number;
}

export function buildConditionFromJson(cond: JsonRuleCondition): RuleCondition {
  return (ctx: MarketContext) => {
    if (!ctx.indicators || ctx.indicators[cond.indicator] === undefined) {
      return false;
    }
    const val = ctx.indicators[cond.indicator];
    switch (cond.operator) {
      case ">": return val > cond.value;
      case "<": return val < cond.value;
      case ">=": return val >= cond.value;
      case "<=": return val <= cond.value;
      case "==": return val === cond.value;
      default: return false;
    }
  };
}
