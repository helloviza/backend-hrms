// apps/backend/src/utils/visaPurposes.ts
//
// Purpose widening, in ONE place.
//
// This logic used to live privately inside routes/visa.ts (the authenticated
// B2B router). The public consumer endpoint now needs the same answer — "which
// purposes does this corridor actually cover?" — and a second copy of a rule
// like "TOURIST_OR_BUSINESS surfaces as BOTH Tourist and Business, never as its
// own option" is a copy that will eventually disagree with the first one.
//
// So it moved here verbatim, and routes/visa.ts imports it rather than
// declaring it. Nothing about the B2B behaviour changed: same functions, same
// order, same values.
import { VISA_PURPOSES, type VisaPurpose } from "../models/VisaRule.js";

// A rule stored as TOURIST_OR_BUSINESS must satisfy BOTH a TOURIST query
// and a BUSINESS query — it's one rule covering two purposes, not a third
// distinct purpose a caller would ever ask for directly. TRANSIT (and any
// other purpose) matches itself only — no widening.
const PURPOSE_QUERY_EXPANSIONS: Partial<Record<VisaPurpose, VisaPurpose[]>> = {
  TOURIST: ["TOURIST", "TOURIST_OR_BUSINESS"],
  BUSINESS: ["BUSINESS", "TOURIST_OR_BUSINESS"],
};

export function purposeMatchValues(purpose: VisaPurpose): VisaPurpose[] {
  return PURPOSE_QUERY_EXPANSIONS[purpose] ?? [purpose];
}

// The purposes a customer actually picks from — TOURIST_OR_BUSINESS is never
// one of them, it's a single RULE that covers two of them at once (see
// PURPOSE_QUERY_EXPANSIONS above). VISA_PURPOSES' own declared order
// (TOURIST, BUSINESS, TRANSIT once TOURIST_OR_BUSINESS is dropped) doubles
// as the canonical card order GET /destinations reports in.
export const CUSTOMER_FACING_PURPOSES: VisaPurpose[] = VISA_PURPOSES.filter(
  (p) => p !== "TOURIST_OR_BUSINESS",
);

// The inverse of purposeMatchValues(): given a rule's OWN stored purpose,
// which customer-facing purpose(s) should it surface as? A TOURIST_OR_
// BUSINESS rule answers to both a TOURIST and a BUSINESS query, so it must
// surface as BOTH cards, not a third one nobody would recognise — same
// widening GET /rules already applies, read in the other direction so the
// two can never drift apart.
export function customerPurposesForRule(rulePurpose: VisaPurpose): VisaPurpose[] {
  return CUSTOMER_FACING_PURPOSES.filter((p) =>
    purposeMatchValues(p).includes(rulePurpose),
  );
}

/**
 * The DISTINCT customer-facing purposes a set of rules covers, in
 * CUSTOMER_FACING_PURPOSES order.
 *
 * Honest-render rule, and the reason this is a function rather than a
 * one-line reduce at each call site:
 *   · a TOURIST_OR_BUSINESS-only corridor reports ["TOURIST","BUSINESS"] —
 *     two real choices, never a "Tourist or Business" pseudo-option;
 *   · an all-TRANSIT corridor reports ["TRANSIT"] and nothing else — no
 *     Tourist card for a corridor where no tourist rule exists.
 * A rule whose purpose is unrecognised contributes nothing rather than
 * throwing, matching GET /destinations' own tolerance.
 */
export function customerPurposesForRules(rules: Array<{ purpose?: unknown }>): VisaPurpose[] {
  const seen = new Set<VisaPurpose>();
  for (const r of rules) {
    for (const p of customerPurposesForRule(r?.purpose as VisaPurpose)) seen.add(p);
  }
  return CUSTOMER_FACING_PURPOSES.filter((p) => seen.has(p));
}
