import { AgentFSM } from "./fsm.js";
import { StructuredLogger } from "./logger.js";
import { TradingConfig, calculatePositionQuantity } from "./trading-config.js";
import { DecoupledRuleEngine, MarketContext, RuleSignal } from "./rules-engine.js";
import { BrokerageService, OrderResult } from "./brokerage.js";

export class AutonomousTradingAgent {
  public fsm: AgentFSM;
  public logger: StructuredLogger;
  private orderCounter = 0;

  constructor(
    public config: TradingConfig,
    public ruleEngine: DecoupledRuleEngine,
    public brokerage: BrokerageService,
  ) {
    this.logger = new StructuredLogger("AutonomousAgent");
    this.fsm = new AgentFSM(this.logger);
  }

  async initialize(): Promise<void> {
    this.logger.info("Initializing Autonomous Trading Agent", { config: this.config });
    this.fsm.transitionTo("FETCHING_MARKET_DATA", "Initialization complete");
    this.fsm.transitionTo("IDLE", "Ready for tick loop");
  }

  async runTick(context: MarketContext): Promise<OrderResult | null> {
    if (this.fsm.getState() !== "IDLE") {
      this.logger.warn(`Cannot run tick from state ${this.fsm.getState()}`);
      return null;
    }

    // Step 1: Mark open positions to market
    this.brokerage.markToMarket({ [context.symbol]: context.currentPrice });

    // Step 2: Fetch market data state
    this.fsm.transitionTo("FETCHING_MARKET_DATA", `Processing tick for ${context.symbol}`);
    
    // Step 3: Evaluate rules
    this.fsm.transitionTo("EVALUATING_RULES", "Evaluating rules against market context");
    const signal: RuleSignal | null = this.ruleEngine.evaluate(context);

    if (!signal || signal.direction === "flat") {
      this.logger.info("No actionable rule signal generated");
      this.fsm.transitionTo("IDLE", "Tick completed without trade");
      return null;
    }

    // Step 4: Sizing and trade placement
    const account = await this.brokerage.getAccountBalance();
    const qty = calculatePositionQuantity(
      this.config,
      account.totalEquity,
      context.currentPrice,
      signal.stopLossPct,
    );

    if (qty <= 0) {
      this.logger.warn("Calculated position size is 0, skipping trade placement");
      this.fsm.transitionTo("IDLE", "Position size calculation returned 0");
      return null;
    }

    this.fsm.transitionTo("PLACING_TRADE", `Placing ${signal.direction} order for ${qty} ${context.symbol}`);

    const stopLossPct = signal.stopLossPct ?? this.config.stopLossPct;
    const takeProfitPct = signal.takeProfitPct ?? this.config.takeProfitPct;

    const stopPrice = signal.direction === "long"
      ? context.currentPrice * (1 - stopLossPct)
      : context.currentPrice * (1 + stopLossPct);

    const targetPrice = signal.direction === "long"
      ? context.currentPrice * (1 + takeProfitPct)
      : context.currentPrice * (1 - takeProfitPct);

    const idempotencyKey = `auto_${context.symbol}_${Date.now()}_${++this.orderCounter}`;

    const orderResult = await this.brokerage.placeOrder({
      idempotencyKey,
      symbol: context.symbol,
      direction: signal.direction,
      quantity: qty,
      entryPrice: context.currentPrice,
      stopPrice,
      targetPrice,
    });

    this.logger.info("Trade placement result", { orderResult });
    this.fsm.transitionTo("IDLE", "Trade placement finished");

    return orderResult;
  }
}
