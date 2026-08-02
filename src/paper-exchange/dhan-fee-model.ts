import type { FeeBreakdown } from "./types.js";

// Approximates Dhan's F&O (index options/futures) intraday charge stack, so
// Paper P&L reflects the brokerage/tax drag a live fill would incur rather
// Than a frictionless price difference. Rates mirror Dhan and SEBI norms in
// Effect at the time this model was written and are not pulled live.
export class DhanFeeModel {
  private readonly brokerageRate = 0.0003; // 0.03%
  private readonly brokerageCap = 20; // Flat cap per executed order
  private readonly sttSellOptions = 0.0005; // 0.05% on sell-side premium
  private readonly exchangeTxnNseFno = 0.0000053; // NSE F&O turnover charge
  private readonly sebiFee = 0.000001; // SEBI turnover fee
  private readonly stampDutyBuyFno = 0.00003; // 0.003% on buy-side
  private readonly gstRate = 0.18; // On brokerage + exchange txn + SEBI fee

  calculate(isBuy: boolean, fillPrice: number, quantity: number): FeeBreakdown {
    const turnover = fillPrice * quantity;

    const brokerage = Math.min(turnover * this.brokerageRate, this.brokerageCap);
    const stt = isBuy ? 0 : turnover * this.sttSellOptions;
    const exchangeTxnCharges = turnover * this.exchangeTxnNseFno;
    const sebiTurnoverFee = turnover * this.sebiFee;
    const stampDuty = isBuy ? turnover * this.stampDutyBuyFno : 0;
    const gst = (brokerage + exchangeTxnCharges + sebiTurnoverFee) * this.gstRate;

    const total = brokerage + stt + exchangeTxnCharges + sebiTurnoverFee + stampDuty + gst;

    return {
      brokerage: round2(brokerage),
      stt: round2(stt),
      exchangeTxnCharges: round2(exchangeTxnCharges),
      sebiTurnoverFee: round4(sebiTurnoverFee),
      stampDuty: round2(stampDuty),
      gst: round2(gst),
      total: round2(total),
    };
  }
}

function round2(n: number): number {
  return Number(n.toFixed(2));
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}
