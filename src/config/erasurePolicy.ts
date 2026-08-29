// apps/backend/src/config/erasurePolicy.ts
//
// THE ONE SWITCH ON THE CONSUMER ERASURE CASCADE — decision D1.
//
// ══════════════════════════════════════════════════════════════════════
// THE QUESTION
// ══════════════════════════════════════════════════════════════════════
// When a consumer's data is erased, a tax invoice raised to them SURVIVES
// (GST retention — see scripts/lib/consumerErasureCascade.ts, motion (b)).
// Everything else on that invoice that identifies them is stripped: email,
// street address, pincode, the stored PDF, the name embedded in the source
// booking's notes, the name on the TravelBooking mirror.
//
// The RECIPIENT NAME on the invoice itself is the one field where the law
// pulls both ways:
//
//   • Rule 46 of the CGST Rules lists "name ... of the recipient" among the
//     particulars a tax invoice SHALL contain, and s.36 requires the
//     invoice be retained. On that reading the name is not ours to remove:
//     a retained invoice missing a mandatory particular is a defective
//     invoice.
//   • DPDP's erasure right pulls the other way, subject to its own
//     "retention required by law" carve-out — which is precisely the
//     carve-out the first bullet claims.
//
// ══════════════════════════════════════════════════════════════════════
// WHY THE DEFAULT IS "KEEP THE NAME"
// ══════════════════════════════════════════════════════════════════════
// The two errors are not symmetrical, and that asymmetry — not a view on
// which reading is correct — is what sets the default:
//
//   KEEP  wrongly -> we retained one field of one document under a
//                    good-faith statutory-retention claim. Reversible: the
//                    flag flips and the next run (or a re-run against the
//                    same consumer) redacts it.
//   REDACT wrongly -> we defaced a statutory record we were required to
//                    keep intact. NOT reversible: the name is gone and
//                    there is nothing left to restore it from.
//
// So the safer default is to keep, pending counsel. This is a HOLDING
// POSITION, not a ruling. When counsel says redact, set the env var — no
// code change, no deploy of this file.
//
// ══════════════════════════════════════════════════════════════════════
// SET IT WITH:  ERASURE_REDACT_INVOICE_NAME=true
// ══════════════════════════════════════════════════════════════════════
// Absent / "" / "false" / anything else -> false (keep the name).
//
// ── WHY A LIVE process.env READ, NOT A CAPTURED env.* VALUE ───────────
// Same shape as config/visaScreening.ts and security/piiMasterKey.ts: the
// value is declared in config/env.ts for DISCOVERABILITY, but every read
// goes to process.env at call time. That is what lets a test pin either
// state without re-importing the module graph, and lets the switch be
// flipped on a running deployment without a rebuild.
//
// ── WHAT THE FLAG DOES *NOT* GOVERN ──────────────────────────────────
// It governs the name AS IT APPEARS ON A FISCAL DOCUMENT — Invoice and
// CreditNote — and nothing else. The consumer's name on ManualBooking
// passengers[], on the TravelBooking mirror, and inside the booking's
// free-text notes is ALWAYS redacted regardless of this flag: none of
// those is the tax invoice, none is a Rule 46 particular, and no
// retention argument reaches them.

/** The env var an operator sets. Named here so tests and docs cannot drift. */
export const ERASURE_REDACT_INVOICE_NAME_ENV = "ERASURE_REDACT_INVOICE_NAME";

/**
 * D1. `true` -> the recipient name is redacted from Invoice/CreditNote too.
 * `false` (the default) -> the name is KEPT on the fiscal document and
 * every other identifying field on it is still stripped.
 *
 * Read live on every call — see the header for why.
 */
export function shouldRedactInvoiceName(): boolean {
  return String(process.env[ERASURE_REDACT_INVOICE_NAME_ENV] || "").trim().toLowerCase() === "true";
}

/**
 * What a redacted name field is set TO. A visible tombstone, never "" and
 * never undefined: a blank recipient on a tax invoice reads as a rendering
 * bug and invites someone to "fix" it by re-deriving the name from a
 * booking. This says, on the face of the document, that the blank is
 * deliberate and lawful.
 */
export const ERASED_NAME_PLACEHOLDER = "[erased on request]";

/**
 * The salt for the D6 subject pseudonym (models/ConsumerErasureRequest.ts).
 * Dedicated var if set; otherwise JWT_SECRET, which requireEnv() guarantees
 * is present in every environment that can run this at all.
 *
 * CONSEQUENCE, stated rather than hidden: rotating JWT_SECRET without
 * having set ERASURE_PSEUDONYM_SALT changes every future pseudonym, so a
 * post-rotation request will not match a pre-rotation one for the same
 * person. That degrades duplicate DETECTION; it does not corrupt any
 * record. Set ERASURE_PSEUDONYM_SALT explicitly to make the mapping
 * survive a JWT rotation.
 */
export function erasurePseudonymSalt(): string {
  const dedicated = String(process.env.ERASURE_PSEUDONYM_SALT || "").trim();
  if (dedicated) return dedicated;
  return String(process.env.JWT_SECRET || "");
}
