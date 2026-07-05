import { describe, it, expect } from "vitest";
import { parseBudget, describeBudget, type Budget } from "./plutoBudget.js";

describe("parseBudget — absolute", () => {
  it("'under USD 200' → max 200 USD", () => {
    expect(parseBudget("I am looking hotel under USD 200")).toEqual({ max: 200, currency: "USD" });
  });
  it("'beyond USD 500' → min 500 USD", () => {
    expect(parseBudget("show me few hotel beyond USD 500")).toEqual({ min: 500, currency: "USD" });
  });
  it("'under 15k' → max 15000 INR (bare number → platform currency)", () => {
    expect(parseBudget("hotels under 15k")).toEqual({ max: 15000, currency: "INR" });
  });
  it("'below ₹8000' → max 8000 INR", () => {
    expect(parseBudget("something below ₹8000")).toEqual({ max: 8000, currency: "INR" });
  });
  it("'between ₹5000 and ₹8000' → min/max INR", () => {
    expect(parseBudget("hotels between ₹5000 and ₹8000")).toEqual({ min: 5000, max: 8000, currency: "INR" });
  });
  it("'around $300' → ±15% band USD", () => {
    expect(parseBudget("hotels around $300")).toEqual({ min: 255, max: 345, currency: "USD" });
  });
  it("'$1.5k' with 'above' → min 1500 USD", () => {
    expect(parseBudget("above $1.5k please")).toEqual({ min: 1500, currency: "USD" });
  });
  it("no budget signal → null", () => {
    expect(parseBudget("show me some hotels in Pattaya")).toBeNull();
  });
  it("a restatement overrides the existing budget", () => {
    const existing: Budget = { max: 200, currency: "USD" };
    expect(parseBudget("actually make it under USD 400", existing)).toEqual({ max: 400, currency: "USD" });
  });
});

describe("parseBudget — relative follow-ups adjust off existing", () => {
  it("'cheaper' caps below the existing floor/ceiling", () => {
    const existing: Budget = { max: 500, currency: "USD" };
    expect(parseBudget("show me cheaper options", existing)).toEqual({ max: 350, currency: "USD" });
  });
  it("'something more premium' lifts the floor above the existing ceiling", () => {
    const existing: Budget = { max: 200, currency: "USD" };
    expect(parseBudget("something more premium", existing)).toEqual({ min: 260, currency: "USD" });
  });
  it("relative currency is inherited from existing", () => {
    const existing: Budget = { min: 5000, currency: "INR" };
    expect(parseBudget("nicer hotels", existing)?.currency).toBe("INR");
  });
  it("relative with no existing budget → null (nothing to adjust)", () => {
    expect(parseBudget("cheaper please", null)).toBeNull();
  });
});

describe("describeBudget", () => {
  it("renders a range, a max, and a min", () => {
    expect(describeBudget({ min: 5000, max: 8000, currency: "INR" })).toBe("₹5000–₹8000");
    expect(describeBudget({ max: 200, currency: "USD" })).toBe("under USD 200");
    expect(describeBudget({ min: 500, currency: "USD" })).toBe("above USD 500");
  });
});
