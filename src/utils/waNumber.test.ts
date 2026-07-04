import { describe, it, expect } from "vitest";
import { isValidWhatsAppNumber, toWaRecipient } from "./waNumber.js";

describe("isValidWhatsAppNumber", () => {
  it("accepts + and 8–15 digits", () => {
    expect(isValidWhatsAppNumber("+919876543210")).toBe(true);
    expect(isValidWhatsAppNumber("+14155552671")).toBe(true);
    expect(isValidWhatsAppNumber(" +919876543210 ")).toBe(true); // trimmed
  });
  it("rejects malformed numbers", () => {
    expect(isValidWhatsAppNumber("919876543210")).toBe(false); // no +
    expect(isValidWhatsAppNumber("+12")).toBe(false); // too short
    expect(isValidWhatsAppNumber("+1234567890123456")).toBe(false); // too long
    expect(isValidWhatsAppNumber("+91 98765 43210")).toBe(false); // spaces
    expect(isValidWhatsAppNumber(undefined)).toBe(false);
    expect(isValidWhatsAppNumber(1234 as any)).toBe(false);
  });
  it("toWaRecipient strips the leading +", () => {
    expect(toWaRecipient("+919876543210")).toBe("919876543210");
  });
});
