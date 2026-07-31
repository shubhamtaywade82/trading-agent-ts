import type { Config } from "./config/schema.js";
import type { MarketBar, Signal } from "./domain/types.js";
import type { IBrokerage } from "./brokerage/IBrokerage.js";
import type { IMarketDataFeed } from "./data/IMarketDataFeed.js";
import { RuleEngine } from "./rules/engine.js";
import { RiskManager, type RiskDecision } from "./risk/riskManager.js";
import { AgentMachine, type AgentState } from "./fsm/agentMachine.js";
import { TradeJournal, type JournalEntry } from "./logging/tradeJournal.js";

export class TradingAgent {
  private machine: AgentMachine;
  private bars = new Map<string, MarketBar[]>();
  private signals: Signal[] = [];
  private intents: RiskDecision[] = [];
  private journal = new TradeJournal();

  constructor(
    private readonly cfg: Config,
    private readonly feed: IMarketDataFeed,
    private readonly broker: IBrokerage,
    private readonly rules: RuleEngine,
    private readonly risk: RiskManager,
  ) {
    this.machine = new AgentMachine({
      FETCH_DATA: this.fetchData.bind(this),
      EVALUATE_RULES: this.evaluate.bind(this),
      RISK_CHECK: this.riskCheck.bind(this),
      EXECUTE: this.execute.bind(this),
      RECONCILE: this.reconcile.bind(this),
      ERROR: this.handleError.bind(this),
      HALTED: async () => "HALTED",
    }, (from, to) => this.journal.append({ ts: Date.now(), state: `${from}->${to}` }));
  }

  getFSM(): AgentMachine {
    return this.machine;
  }

  async stepOnce(): Promise<AgentState> {
    return this.machine.step();
  }

  async run(): Promise<void> {
    while (this.machine.current() !== "HALTED") {
      await this.machine.step();
      if (this.machine.current() === "IDLE" || this.machine.current() === "RECONCILE") {
        await new Promise(r => setTimeout(r, this.cfg.execution.tickIntervalMs));
      }
    }
  }

  private async fetchData(): Promise<AgentState> {
    this.bars = await this.feed.next();
    const prices = new Map([...this.bars].map(([s, b]) => [s, b.at(-1)?.c ?? 0]));
    this.broker.markToMarket(prices);
    return "EVALUATE_RULES";
  }

  private async evaluate(): Promise<AgentState> {
    this.signals = this.rules.run(this.bars, this.broker.getAccount());
    return "RISK_CHECK";
  }

  private async riskCheck(): Promise<AgentState> {
    const acc = this.broker.getAccount();
    this.intents = this.signals.map(s => {
      const price = this.bars.get(s.symbol)?.at(-1)?.c ?? 0;
      const atr = this.bars.get(s.symbol)?.at(-1)?.atr ?? price * 0.01;
      const d = this.risk.decide(s, acc, price, atr);
      const entry: JournalEntry = {
        ts: Date.now(),
        state: "RISK_CHECK",
        signal: s,
        ...(d.intent && { intent: d.intent }),
        ...(!d.ok && {
          fill: {
            idempotencyKey: s.id,
            status: "REJECTED",
            avgPrice: 0,
            filledQty: 0,
            fee: 0,
            ts: Date.now(),
            ...(d.rejectReason !== undefined && { rejectReason: d.rejectReason }),
          },
        }),
      };
      this.journal.append(entry);
      return d;
    });
    return "EXECUTE";
  }

  private async execute(): Promise<AgentState> {
    for (const d of this.intents) {
      if (!d.ok || !d.intent) continue;
      const fill = await this.broker.submit(d.intent);
      this.journal.append({ ts: Date.now(), state: "EXECUTE", intent: d.intent, fill });
    }
    return "RECONCILE";
  }

  private async reconcile(): Promise<AgentState> {
    return "IDLE";
  }

  private async handleError(): Promise<AgentState> {
    return "HALTED";
  }
}
