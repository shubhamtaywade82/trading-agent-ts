import type { Signal } from "../../domain/types.js";
import type { Rule, RuleContext } from "../engine.js";

function calculateEMA(period: number, values: number[]): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const result: number[] = [ema];
  for (let i = period; i < values.length; i++) {
    ema = (values[i] ?? 0) * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

export class EmaCrossRule implements Rule {
  readonly id = "EMA_CROSS_9_21";
  constructor(
    private readonly fast = 9,
    private readonly slow = 21,
  ) {}

  describe(): string {
    return `EMA(${this.fast}) crosses EMA(${this.slow})`;
  }

  evaluate({ symbol, bars }: RuleContext): Signal | null {
    if (bars.length < this.slow + 2) return null;
    const closes = bars.map(b => b.c);
    const f = calculateEMA(this.fast, closes);
    const s = calculateEMA(this.slow, closes);
    const n = Math.min(f.length, s.length);
    if (n < 2) return null;

    const pf = f[n - 2] ?? 0;
    const ps = s[n - 2] ?? 0;
    const cf = f[n - 1] ?? 0;
    const cs = s[n - 1] ?? 0;

    if (pf <= ps && cf > cs) {
      return {
        id: crypto.randomUUID(),
        symbol,
        side: "BUY",
        kind: "ENTRY",
        reason: this.describe(),
        strength: 0.7,
        ts: Date.now(),
        meta: { emaFast: cf, emaSlow: cs },
      };
    }
    if (pf >= ps && cf < cs) {
      return {
        id: crypto.randomUUID(),
        symbol,
        side: "SELL",
        kind: "EXIT",
        reason: this.describe(),
        strength: 0.7,
        ts: Date.now(),
      };
    }
    return null;
  }
}
