import { describe, it, expect } from "vitest";
import { resolveIATA } from "./plutoIata.js";

describe("resolveIATA", () => {
  it("maps a known city (case/whitespace-insensitive)", () => {
    expect(resolveIATA("Delhi")).toBe("DEL");
    expect(resolveIATA("  mumbai ")).toBe("BOM");
    expect(resolveIATA("New Delhi")).toBe("DEL");
  });

  it("accepts an explicit 3-letter airport code typed directly", () => {
    expect(resolveIATA("DEL")).toBe("DEL");
    expect(resolveIATA("bom")).toBe("BOM"); // known alias wins, still uppercased
    expect(resolveIATA("JFK")).toBe("JFK");
  });

  it("returns null for an unknown city — never a guessed 3-letter code", () => {
    expect(resolveIATA("Zermatt")).toBeNull();
    expect(resolveIATA("Timbuktu")).toBeNull();
    // The old behaviour would have returned "YOU" here — must not happen.
    expect(resolveIATA("your destination")).toBeNull();
  });

  it("returns null for empty / nullish input", () => {
    expect(resolveIATA("")).toBeNull();
    expect(resolveIATA(null)).toBeNull();
    expect(resolveIATA(undefined)).toBeNull();
  });
});
