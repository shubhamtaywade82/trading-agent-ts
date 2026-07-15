import { activeViewRows, densityForWidth, detailForDensity } from "../../src/layout/density.js";

describe("density tiers", () => {
  it("maps widths to the frozen tiers", () => {
    expect(densityForWidth(220)).toBe("high");
    expect(densityForWidth(160)).toBe("high");
    expect(densityForWidth(159)).toBe("normal");
    expect(densityForWidth(120)).toBe("normal");
    expect(densityForWidth(119)).toBe("compact");
    expect(densityForWidth(90)).toBe("compact");
    expect(densityForWidth(89)).toBe("minimal");
    expect(densityForWidth(40)).toBe("minimal");
  });

  it("maps density to widget detail levels", () => {
    expect(detailForDensity("high")).toBe("full");
    expect(detailForDensity("normal")).toBe("expanded");
    expect(detailForDensity("compact")).toBe("normal");
    expect(detailForDensity("minimal")).toBe("compact");
  });

  it("gives the active view all rows minus the fixed chrome (6 rows: header, 2 dividers, activity strip, prompt, context strip)", () => {
    expect(activeViewRows(24)).toBe(18);
    expect(activeViewRows(30)).toBe(24);
    expect(activeViewRows(5)).toBe(3); // never less than 3
  });

  it("shrinks by one more row when the prompt bar is showing its multiline indicator", () => {
    expect(activeViewRows(24, 2)).toBe(17);
    expect(activeViewRows(30, 1)).toBe(24);
  });
});
