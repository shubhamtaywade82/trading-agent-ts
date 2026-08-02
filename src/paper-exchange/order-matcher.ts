import { DhanFeeModel } from "./dhan-fee-model.js";
import type { FillEvent, InstrumentMetadata, NormalizedTick, OrderIntent, PaperOrder } from "./types.js";

const DEFAULT_TICK_SIZE = 0.05;

export type InstrumentResolver = (securityId: string, exchangeSegment: string) => InstrumentMetadata | undefined;

// Matches pending paper orders against live ticks. Decoupled from any
// Broker: strategies only ever see OrderIntent in, FillEvent out, so the
// Same call sites work unchanged once a live DhanLiveGateway replaces this.
export class PaperOrderMatcher {
  private readonly pendingOrders = new Map<string, PaperOrder>();
  private readonly feeModel: DhanFeeModel;
  private readonly slippageTicks: number;
  private readonly resolveInstrument: InstrumentResolver | undefined;

  constructor(options?: { feeModel?: DhanFeeModel; slippageTicks?: number; resolveInstrument?: InstrumentResolver }) {
    this.feeModel = options?.feeModel ?? new DhanFeeModel();
    this.slippageTicks = options?.slippageTicks ?? 1;
    this.resolveInstrument = options?.resolveInstrument;
  }

  submitOrder(intent: OrderIntent): PaperOrder {
    const isTriggerOrder = intent.orderType === "SL" || intent.orderType === "SL-M";
    const order: PaperOrder = {
      ...intent,
      orderId: `paper_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`,
      status: isTriggerOrder ? "TRIGGER_PENDING" : "PENDING",
      filledQty: 0,
      avgFillPrice: 0,
      createdAt: Date.now(),
    };
    this.pendingOrders.set(order.orderId, order);
    return order;
  }

  cancelOrder(orderId: string): boolean {
    const order = this.pendingOrders.get(orderId);
    if (!order || order.status === "TRADED") return false;
    order.status = "CANCELLED";
    this.pendingOrders.delete(orderId);
    return true;
  }

  getPendingOrders(): PaperOrder[] {
    return [...this.pendingOrders.values()];
  }

  onTick(tick: NormalizedTick): FillEvent[] {
    const fills: FillEvent[] = [];
    for (const order of this.pendingOrders.values()) {
      const fill = this.tryFillOrder(order, tick);
      if (fill) fills.push(fill);
    }
    return fills;
  }

  private tryFillOrder(order: PaperOrder, tick: NormalizedTick): FillEvent | null {
    if (order.securityId !== tick.securityId || order.exchangeSegment !== tick.exchangeSegment) {
      return null;
    }

    if (order.status === "TRIGGER_PENDING") {
      if (!this.isTriggered(order, tick)) return null;
      order.status = "PENDING";
    }
    if (order.status !== "PENDING") return null;

    const tickSize = this.resolveInstrument?.(order.securityId, order.exchangeSegment)?.tickSize ?? DEFAULT_TICK_SIZE;
    const fillPrice = this.calculateFillPrice(order, tick, tickSize);
    if (fillPrice === null) return null;

    return this.executeFill(order, tick, fillPrice);
  }

  private executeFill(order: PaperOrder, tick: NormalizedTick, fillPrice: number): FillEvent {
    const isBuy = order.transactionType === "BUY";
    const fees = this.feeModel.calculate(isBuy, fillPrice, order.quantity);

    order.filledQty += order.quantity;
    order.avgFillPrice = fillPrice;
    order.status = "TRADED";
    this.pendingOrders.delete(order.orderId);

    return {
      orderId: order.orderId,
      correlationId: order.correlationId,
      strategyId: order.strategyId,
      securityId: order.securityId,
      exchangeSegment: order.exchangeSegment,
      transactionType: order.transactionType,
      fillQty: order.quantity,
      fillPrice,
      fees,
      timestamp: tick.timestamp,
    };
  }

  private isTriggered(order: PaperOrder, tick: NormalizedTick): boolean {
    if (order.triggerPrice === undefined) return false;
    return order.transactionType === "BUY" ? tick.ltp >= order.triggerPrice : tick.ltp <= order.triggerPrice;
  }

  private calculateFillPrice(order: PaperOrder, tick: NormalizedTick, tickSize: number): number | null {
    const slippage = this.slippageTicks * tickSize;

    if (order.orderType === "MARKET" || order.orderType === "SL-M") {
      return this.marketFillPrice(order, tick, slippage);
    }
    return this.limitFillPrice(order, tick, slippage);
  }

  private marketFillPrice(order: PaperOrder, tick: NormalizedTick, slippage: number): number {
    return order.transactionType === "BUY"
      ? (tick.bestAsk ?? tick.ltp) + slippage
      : (tick.bestBid ?? tick.ltp) - slippage;
  }

  // LIMIT, or SL once triggered (behaves as a limit at order.price).
  private limitFillPrice(order: PaperOrder, tick: NormalizedTick, slippage: number): number | null {
    if (order.price === undefined) return null;

    if (order.transactionType === "BUY") {
      const marketSellPrice = tick.bestAsk ?? tick.ltp;
      if (marketSellPrice > order.price) return null;
      return Math.min(order.price, marketSellPrice) - slippage / 2;
    }

    const marketBuyPrice = tick.bestBid ?? tick.ltp;
    if (marketBuyPrice < order.price) return null;
    return Math.max(order.price, marketBuyPrice) + slippage / 2;
  }
}
