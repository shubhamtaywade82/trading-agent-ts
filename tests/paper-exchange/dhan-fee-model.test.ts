import { DhanFeeModel } from "../../src/paper-exchange/dhan-fee-model.js";

describe("DhanFeeModel", () => {
  let feeModel: DhanFeeModel;

  beforeEach(() => {
    feeModel = new DhanFeeModel();
  });

  test("charges STT and stamp duty on the correct side", () => {
    const buy = feeModel.calculate(true, 150, 75);
    const sell = feeModel.calculate(false, 150, 75);

    expect(buy.stt).toBe(0);
    expect(buy.stampDuty).toBeGreaterThan(0);

    expect(sell.stt).toBeGreaterThan(0);
    expect(sell.stampDuty).toBe(0);
  });

  test("caps brokerage at the flat fee for large turnover", () => {
    const fees = feeModel.calculate(true, 10_000, 500); // Turnover = 5,000,000
    expect(fees.brokerage).toBe(20);
  });

  test("charges proportional brokerage below the cap", () => {
    const fees = feeModel.calculate(true, 100, 25); // Turnover = 2,500
    // 0.03% of 2500 = 0.75, well under the ₹20 cap
    expect(fees.brokerage).toBeCloseTo(0.75, 2);
  });

  test("total equals the sum of all components", () => {
    const fees = feeModel.calculate(false, 150, 75);
    const sum = fees.brokerage + fees.stt + fees.exchangeTxnCharges + fees.sebiTurnoverFee + fees.stampDuty + fees.gst;
    expect(fees.total).toBeCloseTo(sum, 2);
  });

  test("returns zero fees for zero quantity", () => {
    const fees = feeModel.calculate(true, 150, 0);
    expect(fees.total).toBe(0);
  });
});
