import type { PaperPosition } from "../exchange/paper-trading.js";

import type { TradingConfig } from "./trading-config.js";

export interface OrderRequest {
  idempotencyKey: string;
  symbol: string;
  direction: "long" | "short";
  quantity: number;
  entryPrice: number;
  stopPrice?: number;
  targetPrice?: number;
}

export interface OrderResult {
  orderId: string;
  idempotencyKey: string;
  symbol: string;
  direction: "long" | "short";
  quantity: number;
  executedPrice: number;
  status: "filled" | "rejected" | "duplicate";
  commission: number;
  timestamp: number;
  reason?: string;
}

export interface AccountBalance {
  initialCapital: number;
  cashBalance: number;
  unrealizedPnl: number;
  realizedPnl: number;
  totalEquity: number;
}

export interface BrokerageService {
  placeOrder: (req: OrderRequest) => Promise<OrderResult>;
  cancelOrder: (orderId: string) => Promise<boolean>;
  getAccountBalance: () => Promise<AccountBalance>;
  getOpenPositions: (symbol?: string) => Promise<PaperPosition[]>;
  markToMarket: (prices: Record<string, number>) => void;
}

export class PaperTradingBrokerageService implements BrokerageService {
  private cashBalance: number;
  private realizedPnl = 0;
  private readonly positions: PaperPosition[] = [];
  private readonly processedKeys = new Map<string, OrderResult>();
  private readonly orderHistory: OrderResult[] = [];
  private nextId = 1;

  constructor(private readonly config: TradingConfig) {
    this.cashBalance = config.initialCapital;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    // Idempotency check
    if (this.processedKeys.has(req.idempotencyKey)) {
      const prev = this.processedKeys.get(req.idempotencyKey)!;
      return { ...prev, status: "duplicate" };
    }

    if (req.quantity <= 0 || req.entryPrice <= 0) {
      const rejected: OrderResult = {
        orderId: `ord_${Date.now()}_${this.nextId++}`,
        idempotencyKey: req.idempotencyKey,
        symbol: req.symbol,
        direction: req.direction,
        quantity: req.quantity,
        executedPrice: req.entryPrice,
        status: "rejected",
        commission: 0,
        timestamp: Date.now(),
        reason: "Invalid quantity or entry price",
      };
      this.processedKeys.set(req.idempotencyKey, rejected);
      this.orderHistory.push(rejected);
      return rejected;
    }

    const notional = req.quantity * req.entryPrice;
    const commission = notional * this.config.commissionRatePct;
    const initialMargin = notional / this.config.leverage;

    if (this.cashBalance < initialMargin + commission) {
      const rejected: OrderResult = {
        orderId: `ord_${Date.now()}_${this.nextId++}`,
        idempotencyKey: req.idempotencyKey,
        symbol: req.symbol,
        direction: req.direction,
        quantity: req.quantity,
        executedPrice: req.entryPrice,
        status: "rejected",
        commission: 0,
        timestamp: Date.now(),
        reason: "Insufficient margin balance",
      };
      this.processedKeys.set(req.idempotencyKey, rejected);
      this.orderHistory.push(rejected);
      return rejected;
    }

    this.cashBalance -= commission;

    const pos: PaperPosition = {
      id: this.nextId++,
      symbol: req.symbol.toUpperCase(),
      direction: req.direction,
      entryPrice: req.entryPrice,
      quantity: req.quantity,
      openedAt: Date.now(),
      closedAt: null,
      closePrice: null,
      closeReason: null,
      realizedPnlPct: null,
      ...(req.stopPrice !== undefined && { stopPrice: req.stopPrice }),
      ...(req.targetPrice !== undefined && { targetPrice: req.targetPrice }),
    };
    this.positions.push(pos);

    const result: OrderResult = {
      orderId: `ord_${pos.id}`,
      idempotencyKey: req.idempotencyKey,
      symbol: pos.symbol,
      direction: pos.direction,
      quantity: pos.quantity,
      executedPrice: pos.entryPrice,
      status: "filled",
      commission,
      timestamp: pos.openedAt,
    };

    this.processedKeys.set(req.idempotencyKey, result);
    this.orderHistory.push(result);
    return result;
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    const posIndex = this.positions.findIndex((p) => `ord_${p.id}` === orderId && p.closedAt === null);
    if (posIndex === -1) return false;

    const pos = this.positions[posIndex];
    if (pos === undefined) return false;
    pos.closedAt = Date.now();
    pos.closeReason = "manual";
    pos.closePrice = pos.entryPrice;
    pos.realizedPnlPct = 0;
    return true;
  }

  markToMarket(prices: Record<string, number>): void {
    for (const p of this.positions) {
      if (p.closedAt !== null) continue;
      const currentPrice = prices[p.symbol];
      if (currentPrice === undefined) continue;

      let shouldClose = false;
      let closeReason: PaperPosition["closeReason"] = null;

      if (p.stopPrice !== undefined) {
        if (p.direction === "long" && currentPrice <= p.stopPrice) {
          shouldClose = true;
          closeReason = "stop";
        } else if (p.direction === "short" && currentPrice >= p.stopPrice) {
          shouldClose = true;
          closeReason = "stop";
        }
      }

      if (!shouldClose && p.targetPrice !== undefined) {
        if (p.direction === "long" && currentPrice >= p.targetPrice) {
          shouldClose = true;
          closeReason = "target";
        } else if (p.direction === "short" && currentPrice <= p.targetPrice) {
          shouldClose = true;
          closeReason = "target";
        }
      }

      if (shouldClose && closeReason) {
        p.closedAt = Date.now();
        p.closePrice = currentPrice;
        p.closeReason = closeReason;
        const pnlPct = p.direction === "long"
          ? (currentPrice - p.entryPrice) / p.entryPrice
          : (p.entryPrice - currentPrice) / p.entryPrice;
        p.realizedPnlPct = pnlPct;

        const pnlAmount = p.quantity * p.entryPrice * pnlPct;
        this.realizedPnl += pnlAmount;
        this.cashBalance += pnlAmount;
      }
    }
  }

  async getAccountBalance(): Promise<AccountBalance> {
    const unrealizedPnl = 0;
    for (const p of this.positions) {
      if (p.closedAt !== null) continue;
      // In absence of live tick inside balance check, unrealized is 0 until marked to market
    }

    return {
      initialCapital: this.config.initialCapital,
      cashBalance: this.cashBalance,
      unrealizedPnl,
      realizedPnl: this.realizedPnl,
      totalEquity: this.cashBalance + unrealizedPnl,
    };
  }

  async getOpenPositions(symbol?: string): Promise<PaperPosition[]> {
    const open = this.positions.filter((p) => p.closedAt === null);
    if (!symbol) return [...open];
    const sym = symbol.toUpperCase();
    return open.filter((p) => p.symbol === sym);
  }

  getOrderHistory(): OrderResult[] {
    return [...this.orderHistory];
  }
}
