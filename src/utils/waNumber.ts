// apps/backend/src/utils/waNumber.ts
//
// E.164-ish validation for an opt-in WhatsApp number. The explicitly captured
// number is the ONLY notify target — we never silently trust passengers[].phone.

/** true when `n` is "+" followed by 8–15 digits (E.164 range). */
export function isValidWhatsAppNumber(n: unknown): boolean {
  if (typeof n !== "string") return false;
  return /^\+\d{8,15}$/.test(n.trim());
}

/** Meta Cloud API wants the number WITHOUT the leading "+". */
export function toWaRecipient(n: string): string {
  return n.trim().replace(/^\+/, "");
}
