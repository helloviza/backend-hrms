// apps/backend/src/utils/visaHeadlineRule.ts
//
// WHICH RULE SPEAKS FOR A CORRIDOR.
//
// Two endpoints have to answer that question and MUST answer it the same
// way: routes/public.visa.ts picks the rule whose price becomes the public
// headline, and routes/consumer.applications.ts re-resolves the rule an
// application is actually created against. If those two disagree, a
// consumer is quoted one figure on the panel and booked against another —
// the precise mismatch that re-resolving server-side exists to prevent.
//
// They used to hold two copies of the same sort. They now both call
// selectHeadlineRule(), because a mirrored copy is a divergence waiting for
// the next person who edits one file and not the other.
//
// ── WHAT WAS WRONG WITH CHEAPEST-OF-ALL ──────────────────────────────
// Both sites sorted every published rule by D2C total and took the head.
// That is broken in two directions, and both were live:
//
//   1. AN UNPRICED RULE SORTS CHEAPEST. computeVisaFeeBlock skips a null
//      service fee rather than refusing to price, so a rule with no
//      d2cServiceFeeInr totals LESS than the same rule with one — and wins.
//      The visible consequence: authoring a D2C price changed nothing on
//      the site, because the unpriced sibling still headlined. A pricing
//      field that cannot affect the price is worse than no field.
//
//   2. AN ADD-ON OUTRANKS A VISA. ARRIVAL_CARD / FORM_SERVICE /
//      APPOINTMENT_SERVICE products are cheap by nature, so a ₹300 arrival
//      card headlined over the actual visa a traveller came to buy.
//
// ── THE LADDER ───────────────────────────────────────────────────────
// PREFERENCE, NOT A FILTER. The distinction is the whole design:
//
//   Preferred pool — priced AND genuinely sellable as the headline:
//       d2cServiceFeeInr != null
//       AND (productClass === "VISA" OR visaCategory === "VISA_FREE")
//
//     The VISA_FREE arm is not a loophole. TH and MY are visa-free for an
//     Indian passport yet carry a real, priced service product (the TDAC
//     digital arrival card). Excluding them by productClass alone would
//     make two serviced corridors silently priceless. They are the reason
//     this is an OR and not `productClass === "VISA"`.
//
//   Fallback — the pool is empty (no priced genuine-visa rule exists for
//     this corridor): return the OLD cheapest-of-all pick, unchanged.
//
// The fallback is what keeps this a preference. An uncurated corridor still
// resolves a rule, still returns documents / purposes / serviced:true, and
// simply has no price — buildPublicPrice already gates on
// d2cServiceFeeInr == null and returns null. A hard filter would instead
// return undefined here and 500 the corridor, which is exactly the failure
// mode a naive `.filter()` would have shipped for every corridor nobody has
// priced yet.
//
// ── WHY THE FALLBACK COMPARATOR HAS NO TIE-BREAK ─────────────────────
// The preferred pool sorts by total and then by variantKey, so a tie
// resolves the same way on every process and every replica rather than by
// whatever order Mongo handed the documents back.
//
// The FALLBACK deliberately does NOT get that tie-break. It is the
// unpriced/uncurated path, and the requirement there is that those
// corridors behave EXACTLY as they do today — byte-identical payloads.
// Adding a tie-break would change which rule wins for a corridor whose
// totals happen to tie, and with it the documents and purposes in the
// response. That is a real behaviour change, so it is not smuggled in
// under a bug fix. Making the fallback deterministic too is a defensible
// follow-up; it is just not this change.
import { computeVisaFeeBlock } from "./visaFee.js";

/** The shape this module actually reads. Rules arrive as lean documents. */
export interface HeadlineRuleCandidate {
  d2cServiceFeeInr?: number | null;
  productClass?: string | null;
  visaCategory?: string | null;
  variantKey?: string | null;
  [key: string]: any;
}

/**
 * Is this rule something we can honestly headline a corridor with?
 *
 * Priced, and either a real visa or a visa-free service product. Exported
 * so tests can pin the predicate directly rather than inferring it from a
 * selection result.
 */
export function isSellableHeadlineRule(rule: HeadlineRuleCandidate): boolean {
  if (rule?.d2cServiceFeeInr == null) return false;
  return rule?.productClass === "VISA" || rule?.visaCategory === "VISA_FREE";
}

/** Today's comparator, preserved verbatim for the fallback path. */
function byD2cTotal(a: HeadlineRuleCandidate, b: HeadlineRuleCandidate): number {
  return computeVisaFeeBlock(a as any, "D2C").totalInr - computeVisaFeeBlock(b as any, "D2C").totalInr;
}

/** The preferred pool's comparator: total, then a stable key. */
function byD2cTotalThenVariantKey(a: HeadlineRuleCandidate, b: HeadlineRuleCandidate): number {
  const byTotal = byD2cTotal(a, b);
  if (byTotal !== 0) return byTotal;
  return String(a?.variantKey ?? "").localeCompare(String(b?.variantKey ?? ""));
}

/**
 * Pick the rule that speaks for this corridor.
 *
 * `candidates` is whatever the caller has already narrowed to — public.visa
 * applies a tourist-ish preference in code, consumer.applications filters by
 * the chosen purpose in the query. That difference is deliberate and
 * documented at both call sites; this function is only the final pick.
 *
 * Returns undefined ONLY for an empty input. Both callers guarantee a
 * non-empty array (they return early on `rules.length === 0`), so a defined
 * result is guaranteed in practice — the selector never turns a serviced
 * corridor into a 500.
 */
export function selectHeadlineRule<T extends HeadlineRuleCandidate>(
  candidates: readonly T[],
): T | undefined {
  if (!candidates?.length) return undefined;

  const preferred = candidates.filter(isSellableHeadlineRule);
  if (preferred.length) return preferred.slice().sort(byD2cTotalThenVariantKey)[0];

  return candidates.slice().sort(byD2cTotal)[0];
}
