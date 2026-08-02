import type { DhanFeeModel } from "./dhan-fee-model.js";
import type { InstrumentResolver } from "./order-matcher.js";
import { PaperOrderMatcher } from "./order-matcher.js";
import type { FillEvent, NormalizedTick, OrderIntent, PaperOrder } from "./types.js";
import type { PortfolioSnapshot } from "./virtual-portfolio.js";
import { VirtualPortfolio } from "./virtual-portfolio.js";

export interface PaperBrokerGatewayOptions {
  initialCapital: number;
  feeModel?: DhanFeeModel;
  slippageTicks?: number;
  resolveInstrument?: InstrumentResolver;
}

// Composition root for the paper exchange: routes OrderIntents through the
// Matcher, feeds resulting fills into the portfolio, and marks positions to
// Market on every tick. This is the seam a live gateway would sit behind —
// Strategies talk to this class, never to the matcher or portfolio directly.
export class PaperBrokerGateway {
  private readonly matcher: PaperOrderMatcher;
  private readonly portfolio: VirtualPortfolio;

  constructor(options: PaperBrokerGatewayOptions) {
    const matcherOptions: {
      feeModel?: DhanFeeModel;
      slippageTicks?: number;
      resolveInstrument?: InstrumentResolver;
    } = {};
    if (options.feeModel !== undefined) matcherOptions.feeModel = options.feeModel;
    if (options.slippageTicks !== undefined) matcherOptions.slippageTicks = options.slippageTicks;
    if (options.resolveInstrument !== undefined) matcherOptions.resolveInstrument = options.resolveInstrument;

    this.matcher = new PaperOrderMatcher(matcherOptions);
    this.portfolio = new VirtualPortfolio(options.initialCapital);
  }

  submitOrder(intent: OrderIntent): PaperOrder {
    return this.matcher.submitOrder(intent);
  }

  cancelOrder(orderId: string): boolean {
    return this.matcher.cancelOrder(orderId);
  }

  getPendingOrders(): PaperOrder[] {
    return this.matcher.getPendingOrders();
  }

  onTick(tick: NormalizedTick): FillEvent[] {
    const fills = this.matcher.onTick(tick);
    for (const fill of fills) this.portfolio.applyFill(fill);

    this.portfolio.markToMarket(
      new Map([
        [tick.securityId, { securityId: tick.securityId, exchangeSegment: tick.exchangeSegment, ltp: tick.ltp }],
      ]),
    );

    return fills;
  }

  getSnapshot(): PortfolioSnapshot {
    return this.portfolio.snapshot();
  }
}
