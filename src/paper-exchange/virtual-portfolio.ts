import type { FillEvent } from "./types.js";

export interface PortfolioPosition {
  securityId: string;
  exchangeSegment: string;
  netQty: number; // Signed: + long, - short
  avgPrice: number;
  realizedPnl: number;
}

export interface PortfolioSnapshot {
  cash: number;
  realizedPnl: number;
  unrealizedPnl: number;
  equity: number;
  totalFeesPaid: number;
  positions: PortfolioPosition[];
}

// Tracks virtual cash, open positions, and P&L for the paper exchange.
// Consumes FillEvents from the order matcher; has no knowledge of orders,
// Ticks, or matching rules.
export class VirtualPortfolio {
  private cash: number;
  private realizedPnl = 0;
  private totalFeesPaid = 0;
  private readonly positions = new Map<string, PortfolioPosition>();
  private readonly lastPrices = new Map<string, number>();

  constructor(initialCapital: number) {
    this.cash = initialCapital;
  }

  applyFill(fill: FillEvent): void {
    const notional = fill.fillPrice * fill.fillQty;
    this.cash += (fill.transactionType === "BUY" ? -1 : 1) * notional - fill.fees.total;
    this.totalFeesPaid += fill.fees.total;

    const key = positionKey(fill.securityId, fill.exchangeSegment);
    const pos = this.positions.get(key) ?? {
      securityId: fill.securityId,
      exchangeSegment: fill.exchangeSegment,
      netQty: 0,
      avgPrice: 0,
      realizedPnl: 0,
    };
    const signedQty = fill.transactionType === "BUY" ? fill.fillQty : -fill.fillQty;

    if (pos.netQty === 0 || Math.sign(pos.netQty) === Math.sign(signedQty)) {
      this.extendPosition(pos, fill.fillPrice, signedQty);
    } else {
      this.reducePosition(pos, fill.fillPrice, signedQty);
    }

    if (pos.netQty === 0) {
      this.positions.delete(key);
    } else {
      this.positions.set(key, pos);
    }
  }

  private extendPosition(pos: PortfolioPosition, fillPrice: number, signedQty: number): void {
    const newQty = pos.netQty + signedQty;
    pos.avgPrice = newQty === 0 ? 0 : (pos.avgPrice * pos.netQty + fillPrice * signedQty) / newQty;
    pos.netQty = newQty;
  }

  private reducePosition(pos: PortfolioPosition, fillPrice: number, signedQty: number): void {
    const closingQty = Math.min(Math.abs(pos.netQty), Math.abs(signedQty));
    const pnl = (fillPrice - pos.avgPrice) * closingQty * Math.sign(pos.netQty);
    pos.realizedPnl += pnl;
    this.realizedPnl += pnl;

    const flipped = Math.abs(signedQty) > Math.abs(pos.netQty);
    pos.netQty += signedQty;
    if (flipped) {
      pos.avgPrice = fillPrice;
    }
  }

  markToMarket(prices: Map<string, { securityId: string; exchangeSegment: string; ltp: number }>): void {
    for (const { securityId, exchangeSegment, ltp } of prices.values()) {
      this.lastPrices.set(positionKey(securityId, exchangeSegment), ltp);
    }
  }

  snapshot(): PortfolioSnapshot {
    let unrealizedPnl = 0;
    const positions: PortfolioPosition[] = [];
    for (const pos of this.positions.values()) {
      const ltp = this.lastPrices.get(positionKey(pos.securityId, pos.exchangeSegment)) ?? pos.avgPrice;
      unrealizedPnl += (ltp - pos.avgPrice) * pos.netQty;
      positions.push({ ...pos });
    }

    return {
      cash: this.cash,
      realizedPnl: this.realizedPnl,
      unrealizedPnl,
      equity: this.cash + unrealizedPnl,
      totalFeesPaid: this.totalFeesPaid,
      positions,
    };
  }

  getPosition(securityId: string, exchangeSegment: string): PortfolioPosition | undefined {
    const pos = this.positions.get(positionKey(securityId, exchangeSegment));
    return pos ? { ...pos } : undefined;
  }
}

function positionKey(securityId: string, exchangeSegment: string): string {
  return `${exchangeSegment}:${securityId}`;
}
