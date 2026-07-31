import type { Signal } from "../../domain/types.js";
import type { Rule, RuleContext } from "../engine.js";

function calculateRSI(period: number, values: number[]): number[] {
  if (values.length < period + 1) return [];
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const diff = (values[i] ?? 0) - (values[i - 1] ?? 0);
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  let avgGain = gains.slice(0, period).reduce((s, v) => s + v, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const result: number[] = [];

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + (gains[i] ?? 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (losses[i] ?? 0)) / period;
    if (avgLoss === 0) {
      result.push(100);
    } else {
      const rs = avgGain / avgLoss;
      result.push(100 - 100 / (1 + rs));
    }
  }
  return result;
}

export class RsiReversalRule implements Rule {
  readonly id = "RSI_REV_14";
  constructor(
    private readonly period = 14,
    private readonly lo = 30,
    private readonly hi = 70,
  ) {}

  describe(): string {
    return `RSI(${this.period}) < ${this.lo} buy / > ${this.hi} sell`;
  }

  evaluate({ symbol, bars }: RuleContext): Signal | null {
    if (bars.length < this.period + 2) return null;
    const closes = bars.map(b => b.c);
    const rsiSeries = calculateRSI(this.period, closes);
    const v = rsiSeries.at(-1);
    if (v === undefined) return null;

    if (v < this.lo) {
      return {
        id: crypto.randomUUID(),
        symbol,
        side: "BUY",
        kind: "ENTRY",
        reason: this.describe(),
        strength: (this.lo - v) / this.lo,
        ts: Date.now(),
        meta: { rsi: v },
      };
    }
    if (v > this.hi) {
      return {
        id: crypto.randomUUID(),
        symbol,
        side: "SELL",
        kind: "EXIT",
        reason: this.describe(),
        strength: (v - this.hi) / (100 - this.hi),
        ts: Date.now(),
        meta: { rsi: v },
      };
    }
    return null;
  }
}
