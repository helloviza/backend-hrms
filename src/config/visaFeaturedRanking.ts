// apps/backend/src/config/visaFeaturedRanking.ts
//
// THE CURATED D2C SET — the corridors helloviza.ai is willing to quote a
// consumer price for. Ordered.
//
// ⚠ THIS IS A HAND-KEPT MIRROR of the editorial ranking that already lives at
// apps/frontend/src/pages/visa/select/visaFeaturedRanking.ts (authored
// 2026-08-13). It exists because the backend CANNOT import from the frontend:
// they are separate pnpm packages with no path mapping, and the only shared
// package (@plumtrips/shared, vendored) carries voucher templates and nothing
// else.
//
// The same constraint already forces the same compromise elsewhere in this
// codebase — services/travelIntake.create.ts:36-40 hand-keeps its
// CANONICAL_SERVICE_TYPE_MAP in lockstep with the frontend's
// constants/serviceTaxonomy.ts for exactly this reason, and says so. This
// file follows that precedent rather than inventing a new one.
//
// WHAT IS DELIBERATELY NOT COPIED: `easeStars` and `frictionNote`. Those are
// editorial COPY — a star rating and a hover sentence — with no meaning on the
// server. Duplicating a sentence across packages is how the two versions start
// disagreeing in front of a customer. Only the identity (iso2) and the order
// (rank) matter here, because the only questions this file answers are "is
// this corridor curated?" and "in what order do curated corridors appear?".
//
// TECH DEBT, RECORDED: if a third consumer of this list appears, promote it
// into @plumtrips/shared rather than adding a third copy.
//
// A code listed here with no PUBLISHED VisaRule is simply never returned by
// the public endpoints — the same tolerance config/visaFeaturedDestinations.ts
// and the frontend file both already document. This list does not need to stay
// in lockstep with what is currently published.
//
// NOT the same list as config/visaFeaturedDestinations.ts. That one is a
// 12-entry unranked "frequently requested" shortlist driving the AUTHENTICATED
// B2B destination picker. This one is the 11-entry ranked editorial set
// driving the PUBLIC consumer surface. They overlap (MY, VN, GB, US) but are
// maintained for different audiences and must not be merged.

export interface VisaFeaturedRankingEntry {
  iso2: string;
  /** 1 = shown first. Ascending. Unique. */
  rank: number;
}

export const VISA_FEATURED_RANKING: readonly VisaFeaturedRankingEntry[] = [
  { iso2: "TH", rank: 1 },
  { iso2: "MY", rank: 2 },
  { iso2: "ID", rank: 3 },
  { iso2: "AZ", rank: 4 },
  { iso2: "VN", rank: 5 },
  { iso2: "EG", rank: 6 },
  { iso2: "GE", rank: 7 },
  { iso2: "JP", rank: 8 },
  { iso2: "CN", rank: 9 },
  { iso2: "GB", rank: 10 },
  { iso2: "US", rank: 11 },
];

/** Rank by ISO2 — the lookup the price gate uses. */
export const VISA_FEATURED_RANK_BY_ISO2: ReadonlyMap<string, number> = new Map(
  VISA_FEATURED_RANKING.map((e) => [e.iso2, e.rank]),
);

/**
 * Condition (i) of the public price rule: is this corridor in the curated set?
 *
 * Being curated is NECESSARY BUT NOT SUFFICIENT — the rule must also carry a
 * populated d2cServiceFeeInr. See routes/public.visa.ts's price gate, which is
 * the one place both conditions are evaluated together.
 */
export function isCuratedCorridor(iso2: string): boolean {
  return VISA_FEATURED_RANK_BY_ISO2.has(String(iso2 || "").trim().toUpperCase());
}
