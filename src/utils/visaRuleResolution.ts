// apps/backend/src/utils/visaRuleResolution.ts
//
// ══════════════════════════════════════════════════════════════════════
// THE PURPOSE-SCOPED RULE PICK — ONE FUNCTION, BOTH SIDES OF THE QUOTE.
// ══════════════════════════════════════════════════════════════════════
//
// This is `resolveRuleFor`, moved out of routes/consumer.applications.ts
// unchanged. It did not move for tidiness — it moved because a SECOND
// caller now needs it, and that caller is the one the customer sees.
//
// ── THE BUG THIS EXTRACTION EXISTS TO CLOSE ──────────────────────────
// The Apply flow's document checklist and price came from
// GET /public/visa/country/:iso2, whose contract is explicitly "ONE
// REPRESENTATIVE rule for the corridor" — tourist-ish preferred, then
// cheapest. That contract is right for the requirements slider, which is
// a browse surface. It is wrong for Apply, which is a surface where the
// reader has already told us which visa they want.
//
// On a corridor publishing more than one purpose the two disagree, and
// on AU they disagree completely: the public pool filters to TOURIST
// before selecting, so the TRANSIT rule is never a candidate at all. A
// consumer applying for an Australian transit visa was shown the Tourist
// rule's four document slots (no PHOTOGRAPH) and the Tourist rule's
// ₹19,610, then had an application created against the Transit rule at
// ₹1,770 with fourteen checklist rows.
//
// utils/visaHeadlineRule.ts already warned about exactly this: "Both must
// resolve identically or a consumer is quoted one price and booked at
// another." It was believed to be guaranteed by both callers sharing
// selectHeadlineRule — but sharing the TIE-BREAKER does not make the
// CANDIDATE POOLS equal, and the pools were never equal. Sharing this
// function does, because the pool is built here.
//
// ── WHO CALLS IT ─────────────────────────────────────────────────────
//   routes/consumer.applications.ts  POST /  — what gets STORED (charge)
//   routes/public.visa.ts   GET /visa/corridor/:iso2/:purpose — what the
//                           Apply flow SHOWS (quote)
//
// Those are the two ends of the same promise, and they now compute it
// with the same code rather than with two readings of the same intent.
//
// GET /visa/country/:iso2 deliberately does NOT call this. Its
// representative-rule contract is correct for what it serves and it is
// left exactly as it was.
import VisaRule from "../models/VisaRule.js";
import { purposeMatchValues } from "./visaPurposes.js";
import { selectHeadlineRule } from "./visaHeadlineRule.js";

/** The nationality every public/consumer surface resolves against. */
export const PUBLIC_NATIONALITY = "IN";

/**
 * The published rule for THIS corridor and THIS purpose, or null.
 *
 * purposeMatchValues widens TOURIST to also match a TOURIST_OR_BUSINESS
 * rule — the same widening GET /rules applies (utils/visaPurposes.ts) —
 * so a corridor whose only rule is TOURIST_OR_BUSINESS is bookable as
 * either, exactly as the purpose cards offered it. TRANSIT and BUSINESS
 * match themselves only.
 *
 * Null means "this corridor publishes nothing for that purpose", which is
 * a real answer and not an error: a caller must not fall back to another
 * purpose's rule, because doing so is the bug above.
 */
export async function resolveRuleFor(iso2: string, purpose: string) {
  const rules = await VisaRule.find({
    status: "PUBLISHED",
    nationality: PUBLIC_NATIONALITY,
    destinationIso2: iso2,
    purpose: { $in: purposeMatchValues(purpose as any) },
  }).lean();

  if (rules.length === 0) return null;

  // The final pick, shared with the browse endpoint. `?? null` keeps the
  // documented null contract (selectHeadlineRule only returns undefined
  // for an empty array, which the guard above has already excluded).
  return selectHeadlineRule(rules as any[]) ?? null;
}
