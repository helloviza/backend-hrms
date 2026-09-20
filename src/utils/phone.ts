// apps/backend/src/utils/phone.ts
//
// PlumConnect Slice 0 — the ONE canonical phone format for the codebase.
//
// Canonical = E.164 digits WITHOUT the leading "+": "919876543210". That is
// the shape Meta delivers on the wire (`from` / `wa_id`), the shape User.waId
// already stores (models/User.ts setter), and what toWaRecipient() produces
// (utils/waNumber.ts). Every other shape in the repo is a derived view:
//   • "+919876543210"  — ArrivalSession.phone / TripWatch.notifyTarget → toE164Plus()
//   • "9876543210"     — Consumer.verifiedPhone (India national)        → toIndiaNational()
//
// Nothing calls this module yet (Slice 0 is additive). The private
// normalisers it will eventually replace — normalizeWaId() in the expense
// worker, toE164() in arrivalInbound, normaliseIndiaMobile() in
// consumerMobileOtp, normalizeDigits()/digitsToLooseRegex() in customerUsers —
// stay exactly where they are until each caller is migrated deliberately.

/** E.164 allows 8–15 digits; mirrors isValidWhatsAppNumber() in waNumber.ts. */
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

const INDIA_CC = "91";

/**
 * Normalise anything a human or a system might hand us into the canonical
 * form, or null when it cannot be one. null, never "" — a caller that does
 * `if (!phone)` should not have to guess which falsy it got.
 *
 * India is the ONLY country code we ever infer, and only for the two shapes a
 * domestic number is habitually written in: bare 10 digits ("9876543210") and
 * the 0-trunk 11-digit form ("09876543210"). This is the same stance as
 * normaliseIndiaMobile() (consumerMobileOtp.ts): a number we cannot place is
 * rejected rather than guessed at. Anything already carrying a country code
 * ("+91…", "91…", "+1…") is taken as-is.
 */
export function toCanonical(raw: unknown): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/[^0-9]/g, "");
  if (!digits) return null;

  let candidate = digits;
  if (digits.length === 10) {
    // Bare Indian number — infer the country code (normaliseIndiaMobile does
    // the same for any ten digits; we deliberately do not second-guess the
    // first digit here).
    candidate = INDIA_CC + digits;
  } else if (digits.length === 11 && digits.startsWith("0")) {
    // 0-trunk Indian form ("09876543210") — drop the trunk, add the code.
    candidate = INDIA_CC + digits.slice(1);
  }

  if (candidate.length < MIN_DIGITS || candidate.length > MAX_DIGITS) return null;
  return candidate;
}

/** The "+"-prefixed E.164 view (ArrivalSession.phone / TripWatch.notifyTarget). */
export function toE164Plus(canonical: string): string {
  return "+" + String(canonical ?? "").replace(/^\+/, "");
}

/**
 * The 10-digit India-national view (Consumer.verifiedPhone), or null when the
 * number is not an Indian one. Never truncates a foreign number to its last
 * ten digits — that is exactly the mistake normaliseIndiaMobile() guards
 * against.
 */
export function toIndiaNational(canonical: string): string | null {
  const c = String(canonical ?? "");
  if (c.length === 12 && c.startsWith(INDIA_CC)) return c.slice(2);
  return null;
}

/**
 * A loose regex for matching a canonical number against free-text phone
 * fields that were never normalised (User.phone, CRMContact.phone,
 * TravellerProfile.mobile, …). Lifted from routes/customerUsers.ts
 * digitsToLooseRegex(): the last ten digits, each allowed to be followed by
 * any run of non-digits, so "98765 43210", "98765-43210" and "+91 9876543210"
 * all match. Ten digits because that is the national-significant part for
 * every market we operate in; for a shorter number the whole thing is used.
 */
export function looseMatchRegex(canonical: string): RegExp {
  const d = String(canonical ?? "").replace(/[^0-9]/g, "");
  const last = d.length > 10 ? d.slice(-10) : d;
  const pat = last.split("").map((ch) => `${ch}\\D*`).join("");
  return new RegExp(pat, "i");
}
