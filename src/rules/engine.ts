import type { Account, MarketBar, Signal } from "../domain/types.js";

export interface RuleContext {
  symbol: string;
  bars: MarketBar[]; // oldest -> newest for this symbol
  account: Account;
}

export interface Rule {
  id: string;
  describe(): string;
  evaluate(ctx: RuleContext): Signal | null;
}

export class RuleEngine {
  constructor(private readonly rules: Rule[]) {}

  run(symbols: Map<string, MarketBar[]>, account: Account): Signal[] {
    const out: Signal[] = [];
    for (const [symbol, bars] of symbols) {
      if (bars.length === 0) continue;
      const ctx: RuleContext = { symbol, bars, account };
      for (const rule of this.rules) {
        const sig = rule.evaluate(ctx);
        if (sig) out.push(sig);
      }
    }
    return out; // deterministic set; order = rule registration order
  }
}
