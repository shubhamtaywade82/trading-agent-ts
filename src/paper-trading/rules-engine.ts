import type { Candle } from "../backtest/types.js";

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
  evaluate: (ctx: MarketContext) => RuleSignal | null;
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
          rationale: `Rule '${rule.name}' [${rule.id}] evaluated to true`,
          ruleId: rule.id,
          ...(rule.stopLossPct !== undefined && { stopLossPct: rule.stopLossPct }),
          ...(rule.takeProfitPct !== undefined && { takeProfitPct: rule.takeProfitPct }),
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
    const val = ctx.indicators?.[cond.indicator];
    if (val === undefined) return false;
    switch (cond.operator) {
      case ">": { return val > cond.value;
      }
      case "<": { return val < cond.value;
      }
      case ">=": { return val >= cond.value;
      }
      case "<=": { return val <= cond.value;
      }
      case "==": { return val === cond.value;
      }
      default: { return false;
      }
    }
  };
}

export interface CompositeJsonRuleCondition {
  logicalOperator: "AND" | "OR";
  conditions: JsonRuleCondition[];
}

export function buildCompositeConditionFromJson(composite: CompositeJsonRuleCondition): RuleCondition {
  const fns = composite.conditions.map(buildConditionFromJson);
  return (ctx: MarketContext) => {
    if (composite.logicalOperator === "AND") {
      return fns.every((fn) => fn(ctx));
    }
    return fns.some((fn) => fn(ctx));
  };
}

