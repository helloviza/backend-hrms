// PlumConnect Slice 0 — the canonical phone module. Every case here is one
// the implementation plan's Definition of Done names (§2), plus the
// round-trips between the three shapes the repo actually stores.
import { describe, it, expect } from "vitest";
import { toCanonical, toE164Plus, toIndiaNational, looseMatchRegex } from "./phone.js";

describe("toCanonical", () => {
  it("strips formatting from a +91 number", () => {
    expect(toCanonical("+91 98765 43210")).toBe("919876543210");
    expect(toCanonical("+91-98765-43210")).toBe("919876543210");
    expect(toCanonical("+919876543210")).toBe("919876543210");
  });

  it("accepts a number already carrying the country code", () => {
    expect(toCanonical("919876543210")).toBe("919876543210");
  });

  it("drops the 0 trunk on an 11-digit Indian number", () => {
    expect(toCanonical("09876543210")).toBe("919876543210");
  });

  it("infers 91 for a bare 10-digit Indian number", () => {
    expect(toCanonical("9876543210")).toBe("919876543210");
  });

  it("takes a foreign number as-is (no inference)", () => {
    expect(toCanonical("+1 415 555 2671")).toBe("14155552671");
    expect(toCanonical("+44 20 7946 0958")).toBe("442079460958");
  });

  it("returns null, never an empty string, on rejection", () => {
    expect(toCanonical("abc")).toBeNull();
    expect(toCanonical("")).toBeNull();
    expect(toCanonical(null)).toBeNull();
    expect(toCanonical(undefined)).toBeNull();
    expect(toCanonical("   ")).toBeNull();
  });

  it("rejects fewer than 8 digits", () => {
    expect(toCanonical("1234567")).toBeNull(); // 7
    expect(toCanonical("+12")).toBeNull();
  });

  it("rejects more than 15 digits", () => {
    expect(toCanonical("1234567890123456")).toBeNull(); // 16
  });

  it("accepts the 8- and 15-digit boundaries", () => {
    expect(toCanonical("12345678")).toBe("12345678");
    expect(toCanonical("123456789012345")).toBe("123456789012345");
  });

  it("coerces non-string input the way the User.waId setter does", () => {
    expect(toCanonical(919876543210)).toBe("919876543210");
  });
});

describe("toE164Plus", () => {
  it("prefixes + and never doubles it", () => {
    expect(toE164Plus("919876543210")).toBe("+919876543210");
    expect(toE164Plus("+919876543210")).toBe("+919876543210");
  });

  it("round-trips through toCanonical", () => {
    const c = toCanonical("+91 98765 43210")!;
    expect(toCanonical(toE164Plus(c))).toBe(c);
  });
});

describe("toIndiaNational", () => {
  it("returns the 10 national digits for an Indian number", () => {
    expect(toIndiaNational("919876543210")).toBe("9876543210");
  });

  it("returns null for a non-Indian number instead of truncating", () => {
    expect(toIndiaNational("14155552671")).toBeNull();
    expect(toIndiaNational("442079460958")).toBeNull();
  });

  it("round-trips through toCanonical", () => {
    const c = toCanonical("9876543210")!;
    expect(toCanonical(toIndiaNational(c))).toBe(c);
  });
});

describe("looseMatchRegex", () => {
  const re = looseMatchRegex("919876543210");

  it("matches the common free-text spellings of the same number", () => {
    expect(re.test("9876543210")).toBe(true);
    expect(re.test("98765 43210")).toBe(true);
    expect(re.test("98765-43210")).toBe(true);
    expect(re.test("+91 9876543210")).toBe(true);
    expect(re.test("+91-98765-43210")).toBe(true);
    expect(re.test("0 9876543210")).toBe(true);
  });

  it("does not match a different number", () => {
    expect(re.test("9876543211")).toBe(false);
    expect(re.test("8876543210")).toBe(false);
  });

  it("uses the whole number when it is shorter than ten digits", () => {
    const short = looseMatchRegex("12345678");
    expect(short.test("1234 5678")).toBe(true);
    expect(short.test("1234 5670")).toBe(false);
  });
});
