// Symbol-level position state machine: one net position per symbol, shared
// across every strategy registered on it. A strategy's fired entry signal is
// an *intent*, not a position owner — this module decides whether an intent
// opens, adds to (averages into), reduces, closes, or flips the symbol's one
// true position, using weighted-average-cost accounting (the same method a
// real exchange uses to compute a perpetual position's average entry price —
// not FIFO lot accounting for the trading economics; FIFO is used only to
// attribute realized PnL back to contributing strategies for display).
//
// Pure, side-effect-free: no fs/journal access. The caller (LivePaperRunner)
// owns persistence and journaling of the PositionFill[] this returns.

export type Direction = "long" | "short";

export type FillAction = "open" | "add" | "reduce" | "close" | "flip_close" | "flip_open";

export type ExitReason =
  | "signal"
  | "opposite_signal_reduce"
  | "opposite_signal_flip"
  | "stop"
  | "target"
  | "liquidation"
  | "timeout";

export interface StrategyIntent {
  strategyId: string;
  symbol: string;
  tf: string;
  direction: Direction;
  stopPct: number;
  targetPct: number;
  maxHoldBars: number;
  entryBarIdx: number;
  entryBarOpenTime: number;
}

export interface PositionFill {
  action: FillAction;
  strategyId: string; // attribution target (FIFO-lot sliced on reduce/close)
  triggerStrategyId: string; // the signal/risk-plan that actually caused this fill
  direction: Direction;
  price: number;
  qty: number;
  notionalDelta: number; // positive
  marginDelta: number; // + for open/add, - for reduce/close
  entryPriceAtFill: number;
  entryTimeAtFill: number | null;
  realizedPnl: number; // 0 for open/add
  feeUsd: number;
  reason: ExitReason;
}

interface Lot {
  strategyId: string;
  qty: number;
  entryBarOpenTime: number;
}

export interface SymbolPosition {
  symbol: string;
  direction: Direction | null;
  qty: number;
  avgEntryPrice: number;
  notional: number;
  margin: number;
  // Only the strategy that OPENED the position governs its risk plan — adds
  // from other (or the same) strategy change qty/avgEntryPrice but never the
  // governing stop/target/maxHoldBars-clock-anchor. See applyIntent's `add`
  // path for the rationale.
  governingStrategyId: string | null;
  governingStopPrice: number | null;
  governingTargetPrice: number | null;
  governingMaxHoldBars: number | null;
  governingEntryBarIdx: number | null;
  liqPrice: number | null;
  contributingStrategyIds: string[];
  lots: Lot[]; // FIFO, oldest first — attribution only, never affects P&L math
}

const EPS = 1e-9;

export function flatPosition(symbol: string): SymbolPosition {
  return {
    symbol,
    direction: null,
    qty: 0,
    avgEntryPrice: 0,
    notional: 0,
    margin: 0,
    governingStrategyId: null,
    governingStopPrice: null,
    governingTargetPrice: null,
    governingMaxHoldBars: null,
    governingEntryBarIdx: null,
    liqPrice: null,
    contributingStrategyIds: [],
    lots: [],
  };
}

function computeStopTarget(direction: Direction, entryPrice: number, stopPct: number, targetPct: number) {
  const stopPrice = direction === "long" ? entryPrice * (1 - stopPct) : entryPrice * (1 + stopPct);
  const targetPrice = direction === "long" ? entryPrice * (1 + targetPct) : entryPrice * (1 - targetPct);
  return { stopPrice, targetPrice };
}

function computeLiqPrice(direction: Direction, entryPrice: number, leverage: number): number {
  return direction === "long"
    ? entryPrice * (1 - 1 / leverage + 0.005)
    : entryPrice * (1 + 1 / leverage - 0.005);
}

// Splits a reduce/close's total realized PnL/fee/notional/margin across the
// FIFO lots being consumed, purely for per-strategy attribution display —
// the trading economics (the four totals) are computed once by the caller
// off the position's single true avgEntryPrice and never recomputed here.
// The last consumed slice takes the remainder of each total instead of its
// proportional share, so the slices always sum back exactly (no rounding
// drift from repeated multiplication).
function allocateAcrossLots(
  lots: Lot[],
  qtyToConsume: number,
  totalPnl: number,
  totalFee: number,
  totalNotional: number,
  totalMargin: number,
  triggerStrategyId: string,
  direction: Direction,
  price: number,
  avgEntryPrice: number,
  reason: ExitReason,
): { fills: PositionFill[]; remainingLots: Lot[] } {
  const fills: PositionFill[] = [];
  const remainingLots: Lot[] = [];
  let toConsume = qtyToConsume;
  let pnlDone = 0,
    feeDone = 0,
    notionalDone = 0,
    marginDone = 0;

  for (const lot of lots) {
    if (toConsume <= EPS) {
      remainingLots.push(lot);
      continue;
    }
    const consumeQty = Math.min(lot.qty, toConsume);
    const remainingAfter = toConsume - consumeQty;
    const isLast = remainingAfter <= EPS;
    const share = consumeQty / qtyToConsume;

    const slicePnl = isLast ? totalPnl - pnlDone : totalPnl * share;
    const sliceFee = isLast ? totalFee - feeDone : totalFee * share;
    const sliceNotional = isLast ? totalNotional - notionalDone : totalNotional * share;
    const sliceMargin = isLast ? totalMargin - marginDone : totalMargin * share;
    pnlDone += slicePnl;
    feeDone += sliceFee;
    notionalDone += sliceNotional;
    marginDone += sliceMargin;

    fills.push({
      action: "reduce", // caller overwrites with "close"/"flip_close" as appropriate
      strategyId: lot.strategyId,
      triggerStrategyId,
      direction,
      price,
      qty: consumeQty,
      notionalDelta: -sliceNotional,
      marginDelta: -sliceMargin,
      entryPriceAtFill: avgEntryPrice,
      entryTimeAtFill: lot.entryBarOpenTime,
      realizedPnl: slicePnl,
      feeUsd: sliceFee,
      reason,
    });

    const remainingLotQty = lot.qty - consumeQty;
    if (remainingLotQty > EPS) remainingLots.push({ ...lot, qty: remainingLotQty });
    toConsume = remainingAfter;
  }

  return { fills, remainingLots };
}

export class SymbolPositionManager {
  constructor(
    private leverage: number,
    private feeBps: number,
  ) {}

  private fee(notional: number): number {
    return notional * (this.feeBps / 10000);
  }

  /** Signal-driven: a fired strategy intent opens, adds to, reduces, or flips the symbol's position. */
  applyIntent(
    current: SymbolPosition,
    intent: StrategyIntent,
    entryPrice: number,
    qtyRequested: number,
  ): { position: SymbolPosition; fills: PositionFill[] } {
    if (current.direction === null) return this.open(current, intent, entryPrice, qtyRequested);
    if (current.direction === intent.direction) return this.add(current, intent, entryPrice, qtyRequested);
    if (qtyRequested >= current.qty) return this.flip(current, intent, entryPrice, qtyRequested);
    return this.reduceBy(current, qtyRequested, entryPrice, intent.strategyId, "opposite_signal_reduce");
  }

  /** Risk-driven: unconditional full close from exit management (stop/target/liquidation/timeout). */
  closePosition(
    current: SymbolPosition,
    triggerStrategyId: string,
    exitPrice: number,
    reason: "stop" | "target" | "liquidation" | "timeout",
  ): { position: SymbolPosition; fills: PositionFill[] } {
    return this.reduceBy(current, current.qty, exitPrice, triggerStrategyId, reason, "close");
  }

  private open(
    current: SymbolPosition,
    intent: StrategyIntent,
    entryPrice: number,
    qty: number,
  ): { position: SymbolPosition; fills: PositionFill[] } {
    const { stopPrice, targetPrice } = computeStopTarget(intent.direction, entryPrice, intent.stopPct, intent.targetPct);
    const liqPrice = computeLiqPrice(intent.direction, entryPrice, this.leverage);
    const notional = qty * entryPrice;
    const margin = notional / this.leverage;
    const feeUsd = this.fee(notional);

    const position: SymbolPosition = {
      symbol: current.symbol,
      direction: intent.direction,
      qty,
      avgEntryPrice: entryPrice,
      notional,
      margin,
      governingStrategyId: intent.strategyId,
      governingStopPrice: stopPrice,
      governingTargetPrice: targetPrice,
      governingMaxHoldBars: intent.maxHoldBars,
      governingEntryBarIdx: intent.entryBarIdx,
      liqPrice,
      contributingStrategyIds: [intent.strategyId],
      lots: [{ strategyId: intent.strategyId, qty, entryBarOpenTime: intent.entryBarOpenTime }],
    };

    const fill: PositionFill = {
      action: "open",
      strategyId: intent.strategyId,
      triggerStrategyId: intent.strategyId,
      direction: intent.direction,
      price: entryPrice,
      qty,
      notionalDelta: notional,
      marginDelta: margin,
      entryPriceAtFill: entryPrice,
      entryTimeAtFill: intent.entryBarOpenTime,
      realizedPnl: 0,
      feeUsd,
      reason: "signal",
    };

    return { position, fills: [fill] };
  }

  private add(
    current: SymbolPosition,
    intent: StrategyIntent,
    entryPrice: number,
    qtyAdd: number,
  ): { position: SymbolPosition; fills: PositionFill[] } {
    const newQty = current.qty + qtyAdd;
    const newAvgEntry = (current.qty * current.avgEntryPrice + qtyAdd * entryPrice) / newQty;
    const addNotional = qtyAdd * entryPrice;
    const addMargin = addNotional / this.leverage;
    const feeUsd = this.fee(addNotional);

    const contributingStrategyIds = current.contributingStrategyIds.includes(intent.strategyId)
      ? current.contributingStrategyIds
      : [...current.contributingStrategyIds, intent.strategyId];

    const position: SymbolPosition = {
      ...current,
      qty: newQty,
      avgEntryPrice: newAvgEntry,
      notional: current.notional + addNotional,
      margin: current.margin + addMargin,
      // governing* deliberately untouched — see class header comment.
      contributingStrategyIds,
      lots: [...current.lots, { strategyId: intent.strategyId, qty: qtyAdd, entryBarOpenTime: intent.entryBarOpenTime }],
    };

    const fill: PositionFill = {
      action: "add",
      strategyId: intent.strategyId,
      triggerStrategyId: intent.strategyId,
      direction: intent.direction,
      price: entryPrice,
      qty: qtyAdd,
      notionalDelta: addNotional,
      marginDelta: addMargin,
      entryPriceAtFill: newAvgEntry,
      entryTimeAtFill: intent.entryBarOpenTime,
      realizedPnl: 0,
      feeUsd,
      reason: "signal",
    };

    return { position, fills: [fill] };
  }

  private reduceBy(
    current: SymbolPosition,
    qty: number,
    price: number,
    triggerStrategyId: string,
    reason: ExitReason,
    forceAction?: FillAction,
  ): { position: SymbolPosition; fills: PositionFill[] } {
    const dir = current.direction!;
    const sign = dir === "long" ? 1 : -1;
    const grossPnl = (price - current.avgEntryPrice) * sign * qty;
    const notionalReduced = qty * price;
    const feeUsd = this.fee(notionalReduced);
    const realizedPnl = grossPnl - feeUsd;
    const marginReleased = current.margin * (qty / current.qty);

    const { fills, remainingLots } = allocateAcrossLots(
      current.lots,
      qty,
      realizedPnl,
      feeUsd,
      notionalReduced,
      marginReleased,
      triggerStrategyId,
      dir,
      price,
      current.avgEntryPrice,
      reason,
    );

    const remainingQty = current.qty - qty;
    const action: FillAction = remainingQty <= EPS ? (forceAction ?? "close") : "reduce";
    const finalFills = fills.map((f) => ({ ...f, action }));

    if (remainingQty <= EPS) {
      return { position: flatPosition(current.symbol), fills: finalFills };
    }

    const position: SymbolPosition = {
      ...current,
      qty: remainingQty,
      notional: remainingQty * current.avgEntryPrice,
      margin: current.margin - marginReleased,
      lots: remainingLots,
      contributingStrategyIds: [...new Set(remainingLots.map((l) => l.strategyId))],
    };

    return { position, fills: finalFills };
  }

  private flip(
    current: SymbolPosition,
    intent: StrategyIntent,
    price: number,
    qtyRequested: number,
  ): { position: SymbolPosition; fills: PositionFill[] } {
    const closeQty = current.qty;
    const { position: flatPos, fills: closeFills } = this.reduceBy(
      current,
      closeQty,
      price,
      intent.strategyId,
      "opposite_signal_flip",
      "flip_close",
    );

    const remainderQty = qtyRequested - closeQty;
    const { position: openPos, fills: openFills } = this.open(flatPos, intent, price, remainderQty);
    const openFillsFlagged = openFills.map((f) => ({ ...f, action: "flip_open" as FillAction }));

    return { position: openPos, fills: [...closeFills, ...openFillsFlagged] };
  }
}
