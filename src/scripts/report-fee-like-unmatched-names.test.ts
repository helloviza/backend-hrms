import { describe, it, expect } from "vitest";
import { findFeeLikeUnmatchedNames, FEE_OR_PAYMENT_PATTERN } from "./report-fee-like-unmatched-names.js";

describe("FEE_OR_PAYMENT_PATTERN", () => {
  it("matches the two confirmed South Africa fee lines", () => {
    expect(FEE_OR_PAYMENT_PATTERN.test("Non-Refundable Visa fee")).toBe(true);
    expect(FEE_OR_PAYMENT_PATTERN.test("Non-Refundable VFS Service fee")).toBe(true);
  });

  it("matches a currency amount", () => {
    expect(FEE_OR_PAYMENT_PATTERN.test("of USD 36 (for countries that are not fee exempt)")).toBe(true);
  });

  it("matches payment-handling phrases", () => {
    expect(FEE_OR_PAYMENT_PATTERN.test("USD 80 to be charged in UGX (collected based on daily forex rate)")).toBe(true);
  });

  it("does not false-positive on an unrelated document name", () => {
    expect(FEE_OR_PAYMENT_PATTERN.test("Bank Letter")).toBe(false);
    expect(FEE_OR_PAYMENT_PATTERN.test("Employee ID Card copy")).toBe(false);
    expect(FEE_OR_PAYMENT_PATTERN.test("Coffee shop receipt")).toBe(false); // word-boundaried "fee" must not match inside "coffee"
  });
});

describe("findFeeLikeUnmatchedNames", () => {
  it("flags a name matching on its own text", () => {
    const liveNameCounts = new Map([["Non-Refundable Visa fee", 4]]);
    const context = new Map();
    const matches = findFeeLikeUnmatchedNames(liveNameCounts, context);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ name: "Non-Refundable Visa fee", occurrences: 4 });
  });

  it("flags a name that only matches via its sourceDescription context", () => {
    const liveNameCounts = new Map([["Visa Fee", 2]]);
    const context = new Map([["Visa Fee", { descriptions: new Set(["of USD 36 for countries that are not fee exempt"]), sourceFiles: new Set(["South_Africa-document-checklist.json"]) }]]);
    const matches = findFeeLikeUnmatchedNames(liveNameCounts, context);
    expect(matches).toHaveLength(1);
    expect(matches[0].sourceDescriptions).toEqual(["of USD 36 for countries that are not fee exempt"]);
  });

  it("leaves a genuine document name alone", () => {
    const liveNameCounts = new Map([["Bank Letter", 3]]);
    const matches = findFeeLikeUnmatchedNames(liveNameCounts, new Map());
    expect(matches).toHaveLength(0);
  });

  it("sorts by occurrence count, most-affected first", () => {
    const liveNameCounts = new Map([
      ["Non-Refundable Visa fee", 4],
      ["Non-Refundable VFS Service fee", 8],
    ]);
    const matches = findFeeLikeUnmatchedNames(liveNameCounts, new Map());
    expect(matches.map((m) => m.name)).toEqual(["Non-Refundable VFS Service fee", "Non-Refundable Visa fee"]);
  });
});
