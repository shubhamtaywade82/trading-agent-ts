import { DhanFeeModel } from "./dhan-fee-model.js";
import type { FillEvent, InstrumentMetadata, NormalizedTick, OrderIntent, OrderStatus, PaperOrder } from "./types.js";

const DEFAULT_TICK_SIZE = 0.05;
const OPEN_STATUSES: ReadonlySet<OrderStatus> = new Set(["PENDING", "TRIGGER_PENDING"]);

export type InstrumentResolver = (securityId: string, exchangeSegment: string) => InstrumentMetadata | undefined;

// Matches pending paper orders against live ticks. Decoupled from any
// Broker: strategies only ever see OrderIntent in, FillEvent out, so the
// Same call sites work unchanged once a live DhanLiveGateway replaces this.
export class PaperOrderMatcher {
  // Full order log, keyed by orderId — includes terminal orders (TRADED,
  // CANCELLED, REJECTED) so callers can look up order history, not just
  // What's currently open.
  private readonly orders = new Map<string, PaperOrder>();
  private readonly feeModel: DhanFeeModel;
  private readonly slippageTicks: number;
  private readonly resolveInstrument: InstrumentResolver | undefined;

  constructor(options?: { feeModel?: DhanFeeModel; slippageTicks?: number; resolveInstrument?: InstrumentResolver }) {
    this.feeModel = options?.feeModel ?? new DhanFeeModel();
    this.slippageTicks = options?.slippageTicks ?? 1;
    this.resolveInstrument = options?.resolveInstrument;
  }

  submitOrder(intent: OrderIntent): PaperOrder {
    const rejectReason = this.validateIntent(intent);
    const isTriggerOrder = intent.orderType === "SL" || intent.orderType === "SL-M";

    let status: OrderStatus;
    if (rejectReason) {
      status = "REJECTED";
    } else if (isTriggerOrder) {
      status = "TRIGGER_PENDING";
    } else {
      status = "PENDING";
    }

    const order: PaperOrder = {
      ...intent,
      orderId: `paper_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`,
      status,
      filledQty: 0,
      avgFillPrice: 0,
      createdAt: Date.now(),
      ...(rejectReason ? { rejectReason } : {}),
    };
    this.orders.set(order.orderId, order);
    return order;
  }

  // Only validates what the matcher itself needs to simulate correctly
  // (a known instrument and a lot-size-aligned quantity). Margin, exposure,
  // And kill-switch checks belong to a separate risk engine upstream.
  private validateIntent(intent: OrderIntent): string | undefined {
    if (!this.resolveInstrument) return undefined;
    const instrument = this.resolveInstrument(intent.securityId, intent.exchangeSegment);
    if (!instrument) return "unknown_instrument";
    if (intent.quantity <= 0 || intent.quantity % instrument.lotSize !== 0) return "invalid_lot_size";
    return undefined;
  }

  cancelOrder(orderId: string): boolean {
    const order = this.orders.get(orderId);
    if (!order || !OPEN_STATUSES.has(order.status)) return false;
    order.status = "CANCELLED";
    return true;
  }

  getOrder(orderId: string): PaperOrder | undefined {
    return this.orders.get(orderId);
  }

  getPendingOrders(): PaperOrder[] {
    return [...this.orders.values()].filter((order) => OPEN_STATUSES.has(order.status));
  }

  onTick(tick: NormalizedTick): FillEvent[] {
    const fills: FillEvent[] = [];
    for (const order of this.orders.values()) {
      if (!OPEN_STATUSES.has(order.status)) continue;
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
