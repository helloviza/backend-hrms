// The ONE company-name dedupe key. These pin the rule so a future "helpful"
// change (strip punctuation, drop "Ltd") cannot silently re-key
// crmcompanies.nameNormalized — the prod unique+partial index and every
// existing row depend on this exact function.
import { describe, it, expect } from "vitest";
import { normalizeCompanyName } from "./companyName.js";
import { normalizeCompanyName as reExported } from "./crmCompany.js";

describe("normalizeCompanyName", () => {
  it("trims, collapses internal whitespace and lowercases", () => {
    expect(normalizeCompanyName("  Ather   Energy \t Pvt  Ltd  ")).toBe("ather energy pvt ltd");
  });

  it("is idempotent", () => {
    const once = normalizeCompanyName("Ather Energy");
    expect(normalizeCompanyName(once)).toBe(once);
  });

  it("collapses case and spacing variants onto the same key", () => {
    const key = normalizeCompanyName("Ather Energy");
    expect(normalizeCompanyName("ATHER ENERGY")).toBe(key);
    expect(normalizeCompanyName("ather  energy")).toBe(key);
    expect(normalizeCompanyName("\nAther\nEnergy\n")).toBe(key);
  });

  it("keeps punctuation — alias collapsing is a human decision, not a key rule", () => {
    expect(normalizeCompanyName("Acme.com")).toBe("acme.com");
    expect(normalizeCompanyName("Acme")).not.toBe(normalizeCompanyName("Acme.com"));
    expect(normalizeCompanyName("Suprajit Eng.")).not.toBe(normalizeCompanyName("Suprajit Eng"));
  });

  it("returns '' for blank / null / undefined / non-string input", () => {
    expect(normalizeCompanyName("")).toBe("");
    expect(normalizeCompanyName("   ")).toBe("");
    expect(normalizeCompanyName(null)).toBe("");
    expect(normalizeCompanyName(undefined)).toBe("");
    expect(normalizeCompanyName(42 as unknown)).toBe("42");
  });

  it("is the same function utils/crmCompany.ts re-exports (one rule, one module)", () => {
    expect(reExported).toBe(normalizeCompanyName);
  });
});
