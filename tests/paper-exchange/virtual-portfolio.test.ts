import type { FeeBreakdown, FillEvent } from "../../src/paper-exchange/types.js";
import { VirtualPortfolio } from "../../src/paper-exchange/virtual-portfolio.js";

const NO_FEES: FeeBreakdown = {
  brokerage: 0,
  stt: 0,
  exchangeTxnCharges: 0,
  sebiTurnoverFee: 0,
  stampDuty: 0,
  gst: 0,
  total: 0,
};

const NIFTY_CE = "NIFTY-25000-CE";

function fill(overrides: Partial<FillEvent> = {}): FillEvent {
  return {
    orderId: "order_1",
    correlationId: "corr_1",
    strategyId: "nifty_momentum",
    securityId: NIFTY_CE,
    exchangeSegment: "NSE_FNO",
    transactionType: "BUY",
    fillQty: 75,
    fillPrice: 150,
    fees: NO_FEES,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe("VirtualPortfolio", () => {
  test("starts with the configured initial capital", () => {
    const portfolio = new VirtualPortfolio(100_000);
    expect(portfolio.snapshot().cash).toBe(100_000);
    expect(portfolio.snapshot().equity).toBe(100_000);
  });

  test("debits cash and opens a long position on a BUY fill", () => {
    const portfolio = new VirtualPortfolio(100_000);
    portfolio.applyFill(fill({ transactionType: "BUY", fillQty: 75, fillPrice: 150 }));

    const snap = portfolio.snapshot();
    expect(snap.cash).toBe(100_000 - 75 * 150);
    expect(snap.positions).toHaveLength(1);
    expect(snap.positions[0]).toMatchObject({ netQty: 75, avgPrice: 150 });
  });

  test("deducts fees from cash and tracks total fees paid", () => {
    const portfolio = new VirtualPortfolio(100_000);
    const fees: FeeBreakdown = { ...NO_FEES, brokerage: 20, gst: 3.6, total: 23.6 };
    portfolio.applyFill(fill({ fees }));

    const snap = portfolio.snapshot();
    expect(snap.cash).toBe(100_000 - 75 * 150 - 23.6);
    expect(snap.totalFeesPaid).toBeCloseTo(23.6, 5);
  });

  test("realizes P&L when a SELL fully closes a long position", () => {
    const portfolio = new VirtualPortfolio(100_000);
    portfolio.applyFill(fill({ transactionType: "BUY", fillQty: 75, fillPrice: 150 }));
    portfolio.applyFill(fill({ transactionType: "SELL", fillQty: 75, fillPrice: 160 }));

    const snap = portfolio.snapshot();
    expect(snap.positions).toHaveLength(0);
    expect(snap.realizedPnl).toBeCloseTo((160 - 150) * 75, 5);
    expect(snap.cash).toBeCloseTo(100_000 + (160 - 150) * 75, 5);
  });

  test("flips a long position to short and reprices the remainder at the fill price", () => {
    const portfolio = new VirtualPortfolio(100_000);
    portfolio.applyFill(fill({ transactionType: "BUY", fillQty: 75, fillPrice: 150 }));
    portfolio.applyFill(fill({ transactionType: "SELL", fillQty: 150, fillPrice: 140 }));

    const snap = portfolio.snapshot();
    expect(snap.positions).toHaveLength(1);
    expect(snap.positions[0]).toMatchObject({ netQty: -75, avgPrice: 140 });
    // Realized P&L only on the 75 qty that closed the original long
    expect(snap.realizedPnl).toBeCloseTo((140 - 150) * 75, 5);
  });

  test("marks unrealized P&L to the latest tick price", () => {
    const portfolio = new VirtualPortfolio(100_000);
    portfolio.applyFill(fill({ transactionType: "BUY", fillQty: 75, fillPrice: 150 }));

    portfolio.markToMarket(new Map([[NIFTY_CE, { securityId: NIFTY_CE, exchangeSegment: "NSE_FNO", ltp: 160 }]]));

    const snap = portfolio.snapshot();
    expect(snap.unrealizedPnl).toBeCloseTo((160 - 150) * 75, 5);
    expect(snap.equity).toBeCloseTo(snap.cash + snap.unrealizedPnl, 5);
  });

  test("getPosition returns undefined for an untraded security", () => {
    const portfolio = new VirtualPortfolio(100_000);
    expect(portfolio.getPosition(NIFTY_CE, "NSE_FNO")).toBeUndefined();
  });

  test("getTrades returns fills newest-first", () => {
    const portfolio = new VirtualPortfolio(100_000);
    portfolio.applyFill(fill({ orderId: "order_1", fillPrice: 150 }));
    portfolio.applyFill(fill({ orderId: "order_2", fillPrice: 155 }));

    const trades = portfolio.getTrades();

    expect(trades.map((t) => t.orderId)).toStrictEqual(["order_2", "order_1"]);
  });

  test("getTrades respects the limit", () => {
    const portfolio = new VirtualPortfolio(100_000);
    portfolio.applyFill(fill({ orderId: "order_1" }));
    portfolio.applyFill(fill({ orderId: "order_2" }));
    portfolio.applyFill(fill({ orderId: "order_3" }));

    expect(portfolio.getTrades(2).map((t) => t.orderId)).toStrictEqual(["order_3", "order_2"]);
  });
});
