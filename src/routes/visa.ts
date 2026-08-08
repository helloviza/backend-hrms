// apps/backend/src/routes/visa.ts
//
// Phase 2a — read-only customer-facing API behind the destination picker
// (screen 1) and rule/pricing detail (screen 2): GET /destinations, GET
// /rules, GET /content/:iso2. VisaRule and VisaDestinationContent are
// GLOBAL reference data — not workspace-scoped.
//
// Phase 3a — the write path behind screen 3: GET /travellers (picker data),
// POST /requests (create the draft), GET /requests, GET /requests/:id.
// VisaRequest/VisaApplication ARE workspace-scoped (see docs/audits/
// visa-module-recon.md §5) — every query is filtered on
// req.workspaceObjectId, never a client-supplied id.
//
// Phase 4a (added below) — document upload and the booking lookup behind
// screen 4: POST/GET .../documents, GET /documents/:id/url, DELETE
// /documents/:id, GET .../travel-bookings. No extraction — extractionStatus
// starts and stays "PENDING" here; see docs/audits/visa-module-recon.md §4.
//
// Phase 4b (added below) — passport MRZ extraction. The upload route now
// fires services/visaPassportExtraction.ts asynchronously (never awaited)
// for the passport document type only (isPassportDocCode, which resolves
// BOTH the legacy DOC-01 and the catalogue PASSPORT_ORIGINAL); every other
// docCode still stays
// PENDING with no extraction. PATCH /documents/:id/extracted-fields is the
// ONLY path that ever writes extracted passport data onto a
// TravellerProfile, and only after explicit user confirmation — extraction
// alone never mutates a traveller's profile.
//
// Phase 4c (added below) — link an existing flight/hotel booking instead of
// uploading DOC-08/DOC-07. PATCH /applications/:id/linked-bookings never
// trusts a client-supplied bookingId; it re-runs the SAME traveller-email +
// date-range match GET .../travel-bookings uses (findMatchingTravelBookings)
// before linking. A linked booking is a reference on VisaApplication
// (linkedBookings), never a VisaDocument — no file, no upload, no second
// source of truth. hydrateDocumentRequirements marks the corresponding
// checklist row satisfiedByBooking so screen 4 (and any other consumer of
// GET /requests, /requests/:id) sees it as complete without an upload.
//
// Every route here, every phase, sits behind requireAuth + requireWorkspace
// + requireFeature("visaEnabled") at mount time (see server.ts), matching
// how sbtEnabled/cstepEnabled gate other modules.
//
// Permissions: none of these routes gate on the visaApplication permission
// key — that key is wired (UserPermission.ts / levelTemplates.ts /
// featureToModules.ts / AccessConsole.tsx) for the concierge console in a
// later phase, not for this customer-facing surface.
//
// Nationality: GET /rules takes an optional nationality=<iso2> query param
// (validated through normaliseToIso2()), defaulting to "IN" when absent.
// VisaRule is keyed on nationality deliberately — every rule today happens
// to be Indian, but the schema was designed around passport nationality
// determining visa requirements, not just destination, so the API must not
// discard that at the door.

import { Router } from "express";
import mongoose from "mongoose";
import multer from "multer";
import VisaRule, {
  VISA_PURPOSES,
  VISA_SERVICE_TIERS,
  type VisaCategory,
  type VisaDocumentRequirement,
  type VisaPurpose,
} from "../models/VisaRule.js";
import VisaDestinationContent from "../models/VisaDestinationContent.js";
import VisaRequest, { recomputeRequestStatus } from "../models/VisaRequest.js";
import VisaApplication, {
  clearActionRequired,
  isTravellerErased,
  VISA_APPLICATION_ERASED_MESSAGE,
  type VisaRuleSnapshot,
  type VisaIndicativeCostSnapshot,
} from "../models/VisaApplication.js";
import VisaDocument from "../models/VisaDocument.js";
import TravellerProfile from "../models/TravellerProfile.js";
import TravelBooking from "../models/TravelBooking.js";
import User from "../models/User.js";
import CustomerMember from "../models/CustomerMember.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import { getCountryByIso2, normaliseToIso2 } from "../utils/countryCodes.js";
import {
  getVisaDocumentCodeDef,
  VISA_DOCUMENT_CODE_SET,
} from "../config/visaDocumentCodes.js";
import {
  hydrateVisaChecklist,
  computeOutstandingRequirements,
} from "../utils/visaChecklistHydration.js";
import { getReferencedApplicantAttributeFields } from "../utils/visaChecklistResolver.js";
import {
  deriveCorporateApplicantProfileDefaults,
  VISA_EMPLOYMENT_STATUSES,
  VISA_SPONSOR_TYPES,
  VISA_INVITATION_SOURCES,
  VISA_MARITAL_STATUSES,
  type VisaApplicantProfile,
} from "../models/visaAttributes.js";
import {
  CURRENT_VISA_CONSENT_VERSION,
  VISA_CONSENT_CLAUSE_IDS,
} from "../config/visaConsent.js";
import { VISA_FEATURED_DESTINATIONS } from "../config/visaFeaturedDestinations.js";
import { computeVisaFeeBlock } from "../utils/visaFee.js";
import {
  computeEstimatedDecisionWindow,
  assessProcessingRisk,
} from "../utils/visaEta.js";
import { maskTailId } from "../utils/piiMask.js";
import { uploadBufferToS3 } from "../utils/s3Upload.js";
import { presignGetObject } from "../utils/s3Presign.js";
import VisaTemplate from "../models/VisaTemplate.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";
import { runVisaPassportExtraction } from "../services/visaPassportExtraction.js";
import { isPassportDocCode, isPhotographDocCode } from "../config/visaDocumentTypeCatalogue.js";
import { resolveMrzDate } from "../utils/mrz.js";
import VisaActivityLog, {
  logVisaActivity,
  VISA_ACTIVITY_CUSTOMER_VISIBLE_EVENT_TYPES,
  type VisaActivityActorType,
} from "../models/VisaActivityLog.js";

const visaLogger = logger.child({ module: "visa" });

const router = Router();

const DEFAULT_APPLICANT_NATIONALITY = "IN";

// A rule stored as TOURIST_OR_BUSINESS must satisfy BOTH a TOURIST query
// and a BUSINESS query — it's one rule covering two purposes, not a third
// distinct purpose a caller would ever ask for directly. TRANSIT (and any
// other purpose) matches itself only — no widening.
const PURPOSE_QUERY_EXPANSIONS: Partial<Record<VisaPurpose, VisaPurpose[]>> = {
  TOURIST: ["TOURIST", "TOURIST_OR_BUSINESS"],
  BUSINESS: ["BUSINESS", "TOURIST_OR_BUSINESS"],
};

function purposeMatchValues(purpose: VisaPurpose): VisaPurpose[] {
  return PURPOSE_QUERY_EXPANSIONS[purpose] ?? [purpose];
}

// The purposes a customer actually picks from — TOURIST_OR_BUSINESS is never
// one of them, it's a single RULE that covers two of them at once (see
// PURPOSE_QUERY_EXPANSIONS above). VISA_PURPOSES' own declared order
// (TOURIST, BUSINESS, TRANSIT once TOURIST_OR_BUSINESS is dropped) doubles
// as the canonical card order GET /destinations reports in.
const CUSTOMER_FACING_PURPOSES: VisaPurpose[] = VISA_PURPOSES.filter(
  (p) => p !== "TOURIST_OR_BUSINESS",
);

// The inverse of purposeMatchValues(): given a rule's OWN stored purpose,
// which customer-facing purpose(s) should it surface as? A TOURIST_OR_
// BUSINESS rule answers to both a TOURIST and a BUSINESS query, so it must
// surface as BOTH cards, not a third one nobody would recognise — same
// widening GET /rules already applies, read in the other direction so the
// two can never drift apart.
function customerPurposesForRule(rulePurpose: VisaPurpose): VisaPurpose[] {
  return CUSTOMER_FACING_PURPOSES.filter((p) =>
    purposeMatchValues(p).includes(rulePurpose),
  );
}

// Cheapest/most-common tier first, not alphabetical — an alphabetical sort
// on serviceTier put EXPRESS before STANDARD (E < S) and defaulted the UI to
// a tier above the cheapest available, over-quoting the customer. Unknown
// tiers sort last rather than throwing, so a future tier value added to
// VISA_SERVICE_TIERS without a matching rule set never breaks this route.
const SERVICE_TIER_RANK: ReadonlyMap<string, number> = new Map(
  VISA_SERVICE_TIERS.map((tier, index) => [tier, index]),
);
function serviceTierRank(tier: string): number {
  return SERVICE_TIER_RANK.get(tier) ?? VISA_SERVICE_TIERS.length;
}

// Phase 10b — checklist resolution/hydration/completeness all now live in
// utils/visaChecklistResolver.ts + utils/visaChecklistHydration.ts (one
// resolver, wired into every read path below: GET /rules, GET /rules/:id,
// hydrateApplicationsWithTravellers, and the completeness check). See those
// files for LINKABLE_DOC_CODE_SERVICE/CONCIERGE_ARRANGEABLE_DOC_CODES
// (still keyed on the legacy DOC-07/DOC-08/DOC-09 codes — task brief §4 —
// plus their new semantic equivalents, additively) and
// computeOutstandingRequirements (replaces the old, docCode-counting
// computeOutstandingRequiredDocCodes — see recordCustomerResponseDuringActionRequired
// below for its call site).

// Shared by GET /rules (one entry per matching variant) and GET /rules/:id
// (this shape plus destination/purpose, since a by-id caller doesn't
// already know those the way a by-destination-and-purpose caller does).
// Document checklist hydration and fee computation happen here, once, so
// neither route can drift from the other.
//
// applicantProfile (corridor-desk restructure, 2026-08-07) — optional,
// forwarded to hydrateVisaChecklist verbatim. GET /rules (the variant-
// comparison list, screen 2 step 2) never passes one — nobody's answered
// any attribute question yet at that point, so every variant's checklist
// stays the full unfiltered preview, same as always. GET /rules/:id now
// accepts one (see that route below) so the requirements page can filter
// the SELECTED variant's checklist live as attribute answers change.
// totalRequirementCount is a SECOND, always-unfiltered hydration — cheap
// (pure in-memory re-resolve of data already fetched, no extra DB call) —
// so "N requirements — filtered from M" always has both numbers, whether
// or not a profile was supplied for this call.
function mapRuleToVariant(r: any, opts: { applicantProfile?: Partial<VisaApplicantProfile> | null } = {}) {
  const checklist = hydrateVisaChecklist(r, { applicantProfile: opts.applicantProfile });
  const totalRequirementCount = hydrateVisaChecklist(r).documentGroups.length;
  return {
    ruleId: String(r._id),
    entryType: r.entryType,
    serviceTier: r.serviceTier,
    // Phase 10a's variant fields, exposed to the customer payload
    // 2026-08-08. A corridor can publish several rules at the SAME
    // serviceTier that differ only by variantKey (Türkiye's e-visa at
    // ₹5,589 beside its sticker visa at ₹21,829; Canada's US-visa-holder
    // variant; Sweden's group-of-20; South Africa's official/diplomatic).
    // Without these two fields the requirements page had nothing to tell
    // them apart and rendered two identical "Standard" cards at different
    // prices — see frontend requirements/TierComparisonCards.tsx.
    //
    // variantLabel is the ops-authored human description (VisaRule.ts) and
    // is what the UI shows; variantKey travels with it because it is the
    // stable identifier, and because "is this the DEFAULT variant" is a
    // question the client answers without having to infer it from a label
    // that may be absent.
    variantKey: r.variantKey,
    variantLabel: r.variantLabel,
    category: r.visaCategory,
    productClass: r.productClass,
    destinationName: r.destinationName,
    isSchengen: r.isSchengen,
    eta: { minDays: r.etaMinDays, maxDays: r.etaMaxDays, basis: r.etaBasis },
    validityDays: r.validityDays,
    permittedStayDays: r.maxStayDays,
    isExtension: r.isExtension,
    appointmentRequired: r.appointmentRequired,
    biometricsRequired: r.biometricsRequired,
    documents: checklist.documents,
    documentGroups: checklist.documentGroups,
    totalRequirementCount,
    // Screen 3 (ApplyPage) reads this off GET /rules/:id to know which
    // applicant-profile questions the SELECTED rule actually depends on —
    // task brief §3: "ask the rest only when some requirement in the
    // selected rule actually depends on it".
    applicantAttributeFieldsReferenced: getReferencedApplicantAttributeFields(r),
    fee: computeVisaFeeBlock(r),
  };
}

// Query-string -> Partial<VisaApplicantProfile>, for GET /rules/:id's
// optional live-filtering params. Returns undefined (not {}) when NONE of
// the recognised params are present at all — that's the signal
// mapRuleToVariant/hydrateVisaChecklist treat as "no applicant known yet"
// (bypass filtering entirely), preserving every existing caller's exact
// current behaviour (ApplyPage's own GET /rules/:id call never sends these).
// Reuses the exact enum/boolean validation POST /requests' own
// validateApplicantProfileAnswer applies to a JSON body — same whitelist,
// different transport (query strings, so booleans arrive as "true"/"false").
function parseApplicantProfileFromQuery(query: any): Partial<VisaApplicantProfile> | undefined {
  const profile: Partial<VisaApplicantProfile> = {};
  let any = false;

  if (query.employmentStatus != null && VISA_EMPLOYMENT_STATUSES.includes(query.employmentStatus)) {
    profile.employmentStatus = query.employmentStatus;
    any = true;
  }
  if (query.sponsorType != null && VISA_SPONSOR_TYPES.includes(query.sponsorType)) {
    profile.sponsorType = query.sponsorType;
    any = true;
  }
  if (query.invitationSource != null && VISA_INVITATION_SOURCES.includes(query.invitationSource)) {
    profile.invitationSource = query.invitationSource;
    any = true;
  }
  if (query.maritalStatus != null && VISA_MARITAL_STATUSES.includes(query.maritalStatus)) {
    profile.maritalStatus = query.maritalStatus;
    any = true;
  }
  for (const key of ["isMinor", "isSponsored", "holdsUsVisa", "holdsSchengenVisa"] as const) {
    const raw = query[key];
    if (raw === "true" || raw === "false") {
      profile[key] = raw === "true";
      any = true;
    }
  }

  return any ? profile : undefined;
}

// A destination-level boolean field (biometricsRequired, appointmentRequired)
// reduced across every PUBLISHED rule for that destination — regardless of
// purpose, entryType or serviceTier. Corridor-card rebuild (2026-08-06):
// the picker used to never surface these at all; now that it does, a
// destination whose rules genuinely disagree (e.g. biometrics required for
// BUSINESS but not TOURIST) must say so explicitly rather than the response
// silently reporting whichever rule happened to be aggregated last. "VARIES"
// is the honest third state — the frontend renders it as "Varies by
// purpose/tier" rather than a flat yes/no.
type TriState = boolean | "VARIES";
function reduceTriState(values: Set<boolean>): TriState {
  if (values.size === 1) return values.has(true);
  return "VARIES";
}

interface DestinationCheapestFee {
  amountInr: number;
  gstApplicable: boolean;
  displayMode: VisaRuleDisplayModeLike;
}
type VisaRuleDisplayModeLike = "ITEMISED" | "INDICATIVE";

// One row per distinct serviceTier found among a destination's PUBLISHED
// rules, aggregated across every purpose/entryType that tier appears under.
// etaMinDays/etaMaxDays are the WIDEST honest range across every matching
// rule (never one rule's number picked silently) — a tier whose ETA is
// identical everywhere it appears just collapses to min===max, same as a
// single rule would report. entryTypes lists every distinct entry type this
// tier has been published with; cost/gstApplicable/displayMode reflect
// whichever matching rule is cheapest (starting-cost semantics — a
// legitimate "from ₹X", not a disagreement that needs hiding).
interface DestinationTierAgg {
  etaMinDays: number | null;
  etaMaxDays: number | null;
  etaBasis: Set<VisaEtaBasisLike>;
  entryTypes: Set<string>;
  cheapest: DestinationCheapestFee | null;
}
type VisaEtaBasisLike = "BUSINESS" | "CALENDAR";

function updateCheapest(
  current: DestinationCheapestFee | null,
  candidate: DestinationCheapestFee,
): DestinationCheapestFee {
  if (!current || candidate.amountInr < current.amountInr) return candidate;
  return current;
}

/* ─────────────────────────────────────────────────────────────────────
 * GET /destinations — distinct destinations carrying at least one
 * PUBLISHED VisaRule (any nationality is irrelevant here — a destination
 * is listed if it has ANY published rule). categories always lists every
 * distinct visaCategory found; `category` is populated as a convenience
 * only when there's exactly one, so the client isn't forced to branch on
 * array length for the common single-category case.
 *
 * purposes is the distinct set of CUSTOMER-facing purposes this
 * destination's rules actually cover (customerPurposesForRule() above) —
 * screen 1's purpose picker (task brief, 2026-08-03: "derive the purpose
 * options from real rules") renders exactly these, in VISA_PURPOSES'
 * canonical order, instead of always offering all three regardless of
 * what's actually published. A destination whose rules are ALL e.g.
 * TRANSIT-only reports purposes: ["TRANSIT"], not the full hardcoded set.
 *
 * featured (2026-08-05) — VISA_FEATURED_DESTINATIONS filtered down to
 * codes actually present in `destinations`, order preserved. The picker
 * grid (task brief: "redesign for scale") shows this shortlist ahead of
 * the full catalogue instead of rendering all of it at once.
 *
 * searchTerms (2026-08-05) — every string search should match for this
 * destination: name, iso2, iso3, demonym and any aliases from
 * countryCodes.ts (so "UAE", "Dubai", "Holland", "Turkiye" all resolve),
 * not just a substring of `name`. Computed here rather than duplicating
 * COUNTRY_CODES on the frontend.
 *
 * Corridor-card rebuild (2026-08-06) — the destination picker moved from a
 * small tile (name + tiny thumbnail + category badge) to a photo-led card
 * that needs to show, without a second request, everything a customer
 * would otherwise only learn on screen 2:
 *   - serviceTiers: every distinct serviceTier published for this
 *     destination (any purpose/entryType), each with its aggregated
 *     processing-time range, entry type(s), and starting cost — see
 *     DestinationTierAgg above for exactly how disagreement is handled.
 *   - biometricsRequired / appointmentRequired: boolean, OR "VARIES" when
 *     this destination's rules don't all agree (see reduceTriState above)
 *     — never silently collapsed to one rule's value.
 *   - startingCost: the single cheapest total across every published rule
 *     for this destination, any purpose/tier — legitimate "from ₹X"
 *     e-commerce semantics, not a disagreement. gstApplicable reflects
 *     whether GST (already baked into totalInr by computeVisaFeeBlock) was
 *     part of that specific winning rule's total, so the card can caption
 *     "from ₹X (incl. GST)" only when true.
 *   - iso3 / demonym: card overlay text ("United Arab Emirates · Emirati ·
 *     ARE") — iso3/demonym already existed in COUNTRY_CODES and were only
 *     ever folded into searchTerms before; now returned as their own
 *     fields too.
 *   - heroImageUrl alongside thumbnailUrl: same PUBLISHED-only join as the
 *     existing thumbnail. The card prefers thumbnailUrl (the crop actually
 *     sized for a picker tile) and falls back to heroImageUrl when only
 *     the requirements-page hero has been published for a destination —
 *     see DestinationCard.tsx on the frontend for where that fallback is
 *     applied.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/destinations", async (req: any, res: any) => {
  try {
    // Corridor-desk restructure (2026-08-07) — optional ?iso2= filter, added
    // so RequirementsPage.tsx's step-1 purpose picker can fetch a SINGLE
    // destination's summary (name/purposes/photo/etc.) without pulling all
    // ~35 published destinations just to read one. Filters the SAME initial
    // VisaRule query the full-list path already runs — everything below
    // this line is completely unchanged, so a single-destination response
    // is byte-for-byte the same shape as one entry of the full array.
    const iso2Filter = String(req.query?.iso2 || "").trim().toUpperCase();
    const ruleFilter: Record<string, unknown> = { status: "PUBLISHED" };
    if (iso2Filter) ruleFilter.destinationIso2 = iso2Filter;

    const rules = await VisaRule.find(ruleFilter)
      .select(
        "destinationIso2 destinationName visaCategory purpose serviceTier entryType " +
          "etaMinDays etaMaxDays etaBasis appointmentRequired biometricsRequired " +
          "embassyFeeInr vfsFeeInr plumtripsServiceFeeInr indicativeVisaCostInr",
      )
      .lean();

    const byIso2 = new Map<
      string,
      {
        destinationName: string;
        categories: Set<VisaCategory>;
        purposes: Set<VisaPurpose>;
        biometricsValues: Set<boolean>;
        appointmentValues: Set<boolean>;
        tiers: Map<string, DestinationTierAgg>;
        cheapest: DestinationCheapestFee | null;
      }
    >();
    for (const r of rules) {
      let entry = byIso2.get(r.destinationIso2);
      if (!entry) {
        entry = {
          destinationName: r.destinationName,
          categories: new Set(),
          purposes: new Set(),
          biometricsValues: new Set(),
          appointmentValues: new Set(),
          tiers: new Map(),
          cheapest: null,
        };
        byIso2.set(r.destinationIso2, entry);
      }

      entry.categories.add(r.visaCategory);
      for (const p of customerPurposesForRule(r.purpose)) entry.purposes.add(p);
      entry.biometricsValues.add(Boolean(r.biometricsRequired));
      entry.appointmentValues.add(Boolean(r.appointmentRequired));

      const fee = computeVisaFeeBlock(r);
      const cheapestCandidate: DestinationCheapestFee = {
        amountInr: fee.totalInr,
        gstApplicable: fee.displayMode === "ITEMISED" && r.plumtripsServiceFeeInr != null,
        displayMode: fee.displayMode,
      };
      entry.cheapest = updateCheapest(entry.cheapest, cheapestCandidate);

      let tier = entry.tiers.get(r.serviceTier);
      if (!tier) {
        tier = { etaMinDays: null, etaMaxDays: null, etaBasis: new Set(), entryTypes: new Set(), cheapest: null };
        entry.tiers.set(r.serviceTier, tier);
      }
      if (r.etaMinDays != null) {
        tier.etaMinDays = tier.etaMinDays == null ? r.etaMinDays : Math.min(tier.etaMinDays, r.etaMinDays);
      }
      if (r.etaMaxDays != null) {
        tier.etaMaxDays = tier.etaMaxDays == null ? r.etaMaxDays : Math.max(tier.etaMaxDays, r.etaMaxDays);
      }
      if (r.etaBasis) tier.etaBasis.add(r.etaBasis);
      tier.entryTypes.add(r.entryType);
      tier.cheapest = updateCheapest(tier.cheapest, cheapestCandidate);
    }

    // Every PUBLISHED rule's purpose maps to at least one customer-facing
    // purpose (customerPurposesForRule never returns empty for a real
    // VisaPurpose value) — so a destination reporting zero here would mean
    // a real data problem (a rule whose `purpose` somehow isn't one
    // customerPurposesForRule recognises), not an expected case. Reported,
    // never silently hidden from the picker as an unselectable destination.
    const destinationsWithNoPurposes: string[] = [];

    // Thumbnail + hero join — country imagery (2026-08-03, widened
    // 2026-08-06). "Corridor card never imageless" (2026-08-07) —
    // DELIBERATELY not gated on content.status === "PUBLISHED" the way
    // GET /content/:iso2's editorial copy still is. The image and the
    // editorial copy are two independent concerns: heroImageUrl/
    // thumbnailUrl are only ever set once a candidate has already cleared
    // the deterministic contrast gate (utils/heroImageContrast.ts, gated
    // against the worst of thirteen palettes) — via a human pick, the bulk
    // auto-select backfill, or the publish-time auto-fetch trigger (see
    // services/visaDestinationImageService.ts) — so a photo is safe to
    // show regardless of whether anyone has reviewed/published the
    // business/tourism highlight blocks for that destination yet. Keeping
    // the old PUBLISHED-only gate here would have meant an auto-selected
    // image sits fully vetted in the database and the corridor card still
    // shows the watermark plate — exactly the "imageless" outcome this
    // phase exists to close. GET /content/:iso2 (the requirements-page
    // hero + editorial highlights) is unchanged and still PUBLISHED-only —
    // that copy genuinely does need a human's sign-off before a customer
    // reads it, unlike a contrast-gated photo.
    const imageRows = await VisaDestinationContent.find({
      destinationIso2: { $in: Array.from(byIso2.keys()) },
    })
      .select("destinationIso2 thumbnailUrl heroImageUrl")
      .lean();
    const imageByIso2 = new Map(
      imageRows.map((r) => [r.destinationIso2, { thumbnailUrl: r.thumbnailUrl ?? null, heroImageUrl: r.heroImageUrl ?? null }]),
    );

    const destinations = Array.from(byIso2.entries()).map(([iso2, entry]) => {
      const country = getCountryByIso2(iso2);
      const categories = Array.from(entry.categories);
      const purposes = CUSTOMER_FACING_PURPOSES.filter((p) => entry.purposes.has(p));
      if (purposes.length === 0) destinationsWithNoPurposes.push(iso2);
      const name = country?.name ?? entry.destinationName;
      const searchTerms = Array.from(
        new Set(
          [iso2, name, country?.iso3, country?.demonym, ...(country?.aliases ?? [])].filter(
            (t): t is string => Boolean(t),
          ),
        ),
      );

      const serviceTiers = Array.from(entry.tiers.entries())
        .sort(([a], [b]) => serviceTierRank(a) - serviceTierRank(b))
        .map(([tier, agg]) => ({
          tier,
          etaMinDays: agg.etaMinDays,
          etaMaxDays: agg.etaMaxDays,
          etaBasis: agg.etaBasis.size === 1 ? Array.from(agg.etaBasis)[0] : "VARIES",
          entryTypes: Array.from(agg.entryTypes),
          startingFromInr: agg.cheapest?.amountInr ?? null,
          gstApplicable: agg.cheapest?.gstApplicable ?? false,
          displayMode: agg.cheapest?.displayMode ?? null,
        }));

      const image = imageByIso2.get(iso2);

      return {
        iso2,
        iso3: country?.iso3 ?? null,
        name,
        demonym: country?.demonym ?? null,
        region: country?.region ?? null,
        categories,
        category: categories.length === 1 ? categories[0] : undefined,
        purposes,
        serviceTiers,
        biometricsRequired: reduceTriState(entry.biometricsValues),
        appointmentRequired: reduceTriState(entry.appointmentValues),
        startingCost: entry.cheapest
          ? {
              amountInr: entry.cheapest.amountInr,
              gstApplicable: entry.cheapest.gstApplicable,
              displayMode: entry.cheapest.displayMode,
            }
          : null,
        thumbnailUrl: image?.thumbnailUrl ?? null,
        heroImageUrl: image?.heroImageUrl ?? null,
        searchTerms,
      };
    });

    destinations.sort((a, b) => a.name.localeCompare(b.name));

    if (destinationsWithNoPurposes.length > 0) {
      console.error(
        "[visa destinations GET] destination(s) with a PUBLISHED rule but zero customer-facing purposes:",
        destinationsWithNoPurposes.join(", "),
      );
    }

    const featured = VISA_FEATURED_DESTINATIONS.filter((iso2) => byIso2.has(iso2));

    res.json({ ok: true, destinations, featured });
  } catch (err: any) {
    console.error("[visa destinations GET]", err?.message);
    res
      .status(500)
      .json({ error: err?.message || "Failed to load visa destinations" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /rules?destination=<iso2>&purpose=<PURPOSE>&nationality=<iso2> —
 * every PUBLISHED rule for that {nationality, destination, purpose}, one
 * entry per {entryType, serviceTier} variant. nationality defaults to "IN"
 * when absent, so existing callers are unaffected. Document checklist is
 * hydrated server-side and the fee block is fully computed server-side —
 * the client never needs a second call for either.
 *
 * purpose matching is WIDENED, not exact — see purposeMatchValues() above.
 * A rule stored as TOURIST_OR_BUSINESS is one rule covering two purposes,
 * so it must come back for both a TOURIST query and a BUSINESS query.
 * TRANSIT matches only TRANSIT.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/rules", async (req: any, res: any) => {
  try {
    const destination = String(req.query?.destination || "")
      .trim()
      .toUpperCase();
    const purpose = String(req.query?.purpose || "")
      .trim()
      .toUpperCase() as VisaPurpose;
    const nationalityRaw = req.query?.nationality;
    const nationality = nationalityRaw
      ? normaliseToIso2(String(nationalityRaw))
      : DEFAULT_APPLICANT_NATIONALITY;

    if (!destination) {
      return res.status(400).json({ error: "destination is required" });
    }
    if (!VISA_PURPOSES.includes(purpose)) {
      return res
        .status(400)
        .json({ error: `purpose must be one of ${VISA_PURPOSES.join(", ")}` });
    }
    if (!nationality) {
      return res
        .status(400)
        .json({
          error: `nationality '${nationalityRaw}' is not a recognised country`,
        });
    }

    const rules = await VisaRule.find({
      status: "PUBLISHED",
      nationality,
      destinationIso2: destination,
      purpose: { $in: purposeMatchValues(purpose) },
    })
      .sort({ entryType: 1 })
      .lean();

    // serviceTier is sorted by the defined tier sequence (see
    // serviceTierRank above), NOT alphabetically — Mongo's .sort() can't
    // express an arbitrary enum order, so this is a stable in-memory
    // resort. Stable means entries that tie on tier rank keep the
    // entryType order the query already applied.
    rules.sort(
      (a, b) => serviceTierRank(a.serviceTier) - serviceTierRank(b.serviceTier),
    );

    const variants = rules.map((r) => mapRuleToVariant(r));

    const nationalityCountry = getCountryByIso2(nationality);
    const nationalityInfo = {
      iso2: nationality,
      name: nationalityCountry?.name ?? nationality,
      demonym: nationalityCountry?.demonym ?? nationality,
    };

    res.json({
      ok: true,
      destination,
      purpose,
      nationality: nationalityInfo,
      variants,
    });
  } catch (err: any) {
    console.error("[visa rules GET]", err?.message);
    res
      .status(500)
      .json({ error: err?.message || "Failed to load visa rules" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /rules/:id — a single rule, PUBLISHED only, 404 otherwise (missing,
 * malformed id, or DRAFT — never distinguished from "missing" to a
 * customer-facing caller, same posture as the other read routes here).
 *
 * Exists because screen 3 (/visa/apply?rule=<id>) only ever has the id —
 * there's no destination/purpose/nationality to call GET /rules with, and
 * router `state` from screen 2's CTA doesn't survive a refresh, bookmark,
 * or shared link. Shaped exactly like one entry of GET /rules' variants
 * array (mapRuleToVariant, including the computed fee block) plus
 * destination/purpose at the top level, since a by-destination-and-purpose
 * caller already knows those but a by-id caller doesn't.
 *
 * Applicant-attribute query params (corridor-desk restructure, 2026-08-07)
 * — optional: employmentStatus, sponsorType, invitationSource,
 * maritalStatus, isMinor, isSponsored, holdsUsVisa, holdsSchengenVisa (see
 * parseApplicantProfileFromQuery). When any are present, `documents/
 * documentGroups` in the response are FILTERED against them (the
 * requirements page's live "N requirements — filtered from M" panel);
 * `totalRequirementCount` is always the unfiltered baseline regardless.
 * When none are present, behaviour is byte-for-byte what it always was —
 * ApplyPage's own call site never sends these, so it's unaffected.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/rules/:id", async (req: any, res: any) => {
  try {
    const id = req.params.id;
    if (!id || !mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: "Visa rule not found" });
    }

    const rule = await VisaRule.findOne({
      _id: id,
      status: "PUBLISHED",
    }).lean();
    if (!rule) {
      return res.status(404).json({ error: "Visa rule not found" });
    }

    const applicantProfile = parseApplicantProfileFromQuery(req.query || {});

    res.json({
      ok: true,
      rule: {
        destination: rule.destinationIso2,
        purpose: rule.purpose,
        ...mapRuleToVariant(rule, { applicantProfile }),
      },
    });
  } catch (err: any) {
    console.error("[visa rules/:id GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load visa rule" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /templates?codes=A,B,C — bulk existence check, not the file itself.
 * Corridor-desk restructure (2026-08-07) — "requirement rows referencing a
 * VisaTemplate should offer it... render the link only when an s3Key
 * exists, and say nothing when it doesn't". A checklist can reference
 * several templateCodes at once (one per documentGroup); this answers
 * "which of these actually have a file" in one round trip instead of N,
 * without ever exposing the raw s3Key to the client — that's only ever
 * resolved into a short-TTL presigned URL, on demand, by
 * GET /templates/:code/url below.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/templates", async (req: any, res: any) => {
  try {
    const codes = String(req.query?.codes || "")
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    if (codes.length === 0) return res.json({ ok: true, templates: [] });

    const rows = await VisaTemplate.find({ code: { $in: codes } })
      .select("code name s3Key")
      .lean();

    res.json({
      ok: true,
      templates: rows.map((t) => ({ code: t.code, name: t.name, hasFile: Boolean(t.s3Key) })),
    });
  } catch (err: any) {
    console.error("[visa templates GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load templates" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /templates/:code/url — short-TTL presigned GET, forceDownload (a
 * form template should save, not render inline — same distinction
 * PutObjectCommand's own `view` vs `forceDownload` option draws for the
 * CSTEP Tour Proposal PDF's explicit Download button). 404s both for an
 * unknown code and for a real template row with no file yet — s3Key is
 * nullable by design (VisaTemplate.ts's own header: "12 templates are
 * seeded with no files"), and this route never distinguishes the two
 * cases to the client, same posture as every other 404 in this router.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/templates/:code/url", async (req: any, res: any) => {
  try {
    const code = String(req.params.code || "").trim().toUpperCase();
    if (!code) return res.status(404).json({ error: "Template not found" });

    const template = await VisaTemplate.findOne({ code }).lean();
    if (!template || !template.s3Key) {
      return res.status(404).json({ error: "Template not found" });
    }

    const url = await presignGetObject({
      bucket: env.S3_BUCKET,
      key: template.s3Key,
      filename: `${template.name || code}.pdf`,
      expiresInSeconds: env.PRESIGN_TTL,
      forceDownload: true,
    });

    res.json({ ok: true, url, expiresIn: env.PRESIGN_TTL });
  } catch (err: any) {
    console.error("[visa templates/:code/url GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to generate template URL" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /content/:iso2 — VisaDestinationContent, ONLY when status is
 * PUBLISHED. 404 for a missing destination, a DRAFT-only destination, or an
 * unknown iso2 — never a 500, and never DRAFT content leaked to a customer.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/content/:iso2", async (req: any, res: any) => {
  try {
    const iso2 = String(req.params.iso2 || "")
      .trim()
      .toUpperCase();
    if (!iso2)
      return res.status(404).json({ error: "Destination content not found" });

    const content = await VisaDestinationContent.findOne({
      destinationIso2: iso2,
      status: "PUBLISHED",
    }).lean();

    if (!content) {
      return res.status(404).json({ error: "Destination content not found" });
    }

    res.json({
      ok: true,
      content: {
        destinationIso2: content.destinationIso2,
        businessBlock: content.businessBlock,
        tourismBlock: content.tourismBlock,
        entrySnapshot: content.entrySnapshot,
        heroImageUrl: content.heroImageUrl,
        thumbnailUrl: content.thumbnailUrl,
        lastReviewedAt: content.lastReviewedAt,
      },
    });
  } catch (err: any) {
    console.error("[visa content GET]", err?.message);
    res
      .status(500)
      .json({ error: err?.message || "Failed to load destination content" });
  }
});

// CustomerMember.role's three values (models/CustomerMember.ts) — the set
// requireActiveMember + ensureTravellerWriteAccess between them accept for a
// create. Compared against a plain trim+uppercase, NOT this file's own
// normRole(): that one also strips underscores (WORKSPACE_LEADER ->
// WORKSPACELEADER) because it exists to fold User.roles[] spellings, and
// CustomerMember.role stores the underscored literal.
//
// Note the model declares these only as a TS union — the Mongoose field
// carries no enum — so an unrecognised role IS reachable from the DB and
// must resolve to false here rather than be assumed away.
const VISA_TRAVELLER_CREATE_ROLES = new Set([
  "WORKSPACE_LEADER",
  "APPROVER",
  "REQUESTER",
]);

/**
 * capabilities.canCreate for GET /travellers — a PREDICTION of what POST
 * /api/workspace/travellers (the endpoint AddTravellerModal actually posts
 * to, see its file header) will decide, so the picker can withhold an Add
 * control that would otherwise only fail on submit.
 *
 * That route gates on requireActiveMember and THEN
 * ensureTravellerWriteAccess(..., "create") — and for the "create" action
 * the second of those adds nothing beyond a recognised role, so the whole
 * decision reduces to requireActiveMember's own test, restated here:
 * SUPERADMIN passes outright; everyone else needs an active CustomerMember
 * row for THIS workspace's customer (req.workspace.customerId, the same id
 * requireActiveMember reads — not req.user.customerId) whose role is one of
 * CustomerMember's three values. A staff/HOUSE account browsing /visa/apply
 * has no such row, which is precisely the 403 this flag exists to predict.
 *
 * Deliberately restated rather than imported from workspace.travellers.ts:
 * that module is a Router whose import chain pulls in customerUsers.ts,
 * multer and exceljs, none of which this read has any business loading.
 * Kept narrow enough (membership, not the write matrix) that it has no
 * branch of its own to drift.
 *
 * Advisory only — it is NOT a gate on this read, and must never become one.
 * Any authenticated workspace user may still SEE the roster; that
 * read-vs-write split is workspace.travellers.ts's documented design
 * (its file header §"Read-vs-write RBAC split"). false here removes a
 * button, never a traveller.
 */
async function resolveTravellerCanCreate(req: any): Promise<boolean> {
  if (isSuperAdmin(req)) return true;

  const customerId = req.workspace?.customerId;
  const email = req.user?.email;
  if (!customerId || !email) return false;

  const member: any = await CustomerMember.findOne({
    customerId: String(customerId),
    email: String(email).toLowerCase(),
  })
    .select("role isActive")
    .lean();

  if (!member || member.isActive === false) return false;
  return VISA_TRAVELLER_CREATE_ROLES.has(
    String(member.role ?? "").trim().toUpperCase(),
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * GET /travellers — picker data for screen 3 (traveller selection).
 *
 * routes/workspace.travellers.ts's GET / already exists and is workspace-
 * scoped — reused for the masking convention, not reimplemented: same
 * maskTailId() last-4 mask as that route's passportMasked field. The
 * picker doesn't need the full passport number to let someone choose which
 * saved traveller to apply for; it needs passportExpiry (unmasked — the
 * six-month-validity warning reads the real date) and enough to tell two
 * people with the same name apart. The full passportNo is read
 * server-side, later, by POST /requests directly off TravellerProfile —
 * the client never supplies or needs to see it. This still lives here
 * (rather than reusing GET /workspace/travellers) because that route never
 * returns passportExpiry at all, for the same list; this is additive
 * picker shaping, not a passport-number exposure.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/travellers", async (req: any, res: any) => {
  try {
    // Cross-tenant guard — the same one workspace.travellers.ts applies to
    // every one of its own TravellerProfile handlers (requireWorkspaceContext,
    // see its doc comment for the full failure mode). requireWorkspace's
    // SUPERADMIN bypass only attaches req.workspaceObjectId when an explicit
    // workspaceId reached it via body/query/params/header or the JWT; a
    // SUPERADMIN session with none of those leaves it undefined. Here that is
    // worse than the quiet-empty-result it causes there: Mongoose STRIPS an
    // undefined value out of the filter rather than matching on it, so
    // { workspaceId: undefined, isActive: true } degrades to { isActive: true }
    // — every active TravellerProfile in every workspace, masked passports and
    // all. Fail loudly before the query instead.
    if (!req.workspaceObjectId) {
      return res.status(400).json({
        error:
          "No workspace context. SUPERADMIN: pass workspaceId in body, query, or x-workspace-id header.",
      });
    }

    const workspaceId = req.workspaceObjectId;
    const docs = await TravellerProfile.find({ workspaceId, isActive: true })
      .select(
        "firstName middleName lastName dob email nationality passportNo passportExpiry linkedMemberId",
      )
      .sort({ firstName: 1, lastName: 1 })
      .lean();

    const travellers = docs.map((d: any) => ({
      id: String(d._id),
      name: [d.firstName, d.middleName, d.lastName].filter(Boolean).join(" "),
      // Disambiguators for two people sharing a name — dob/email are the
      // same tier-2/tier-1 identity keys travellerMatch.ts already uses.
      dob: d.dob ?? null,
      email: d.email ?? null,
      nationality: d.nationality ?? null,
      passportMasked: maskTailId(d.passportNo) ?? null,
      passportExpiry: d.passportExpiry ?? null,
      // Phase 10b (task brief §3) — lets screen 3 skip asking
      // employmentStatus/sponsorType for a traveller who'll get them
      // corporate-defaulted anyway at POST /requests (see
      // buildApplicantProfileForTraveller) — never the raw linkedMemberId.
      isWorkspaceMember: !!d.linkedMemberId,
    }));

    res.json({
      ok: true,
      travellers,
      capabilities: { canCreate: await resolveTravellerCanCreate(req) },
    });
  } catch (err: any) {
    console.error("[visa travellers GET]", err?.message);
    res
      .status(500)
      .json({ error: err?.message || "Failed to load travellers" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * Shared helpers for the /requests routes below.
 * ───────────────────────────────────────────────────────────────────── */

function buildRuleSnapshot(rule: any): VisaRuleSnapshot {
  return {
    ruleId: rule._id,
    capturedAt: new Date(),
    destinationName: rule.destinationName,
    isSchengen: rule.isSchengen,
    productClass: rule.productClass,
    visaCategory: rule.visaCategory,
    purpose: rule.purpose,
    entryType: rule.entryType,
    serviceTier: rule.serviceTier,
    validityDays: rule.validityDays,
    maxStayDays: rule.maxStayDays,
    isExtension: rule.isExtension,
    etaMinDays: rule.etaMinDays,
    etaMaxDays: rule.etaMaxDays,
    etaBasis: rule.etaBasis,
    appointmentRequired: rule.appointmentRequired,
    biometricsRequired: rule.biometricsRequired,
    // Cloned, not the source array by reference — this is an embedded
    // POINT-IN-TIME copy (see VisaApplication.ts file header); the source
    // VisaRule must be free to change later without that ever being
    // visible through an application already created from it.
    documentRequirements: (rule.documentRequirements || []).map((d: any) => ({
      ...d,
    })),
    // Phase 10b — captured alongside documentRequirements above so a NEW
    // application preserves group/appliesWhen fidelity going forward
    // (existing applications' snapshots are immutable history and never
    // gain this retroactively — see VisaRuleSnapshot's own doc comment).
    // undefined (not []) when the rule itself has no groups, so "old-shape"
    // and "legacy-only rule" both resolve identically downstream.
    documentGroups:
      rule.documentGroups && rule.documentGroups.length > 0
        ? rule.documentGroups.map((g: any) => ({
            ...g,
            docTypeCodes: [...(g.docTypeCodes || [])],
            appliesWhen: g.appliesWhen ? g.appliesWhen.map((c: any) => ({ ...c })) : undefined,
          }))
        : undefined,
  };
}

// Same computeVisaFeeBlock the read route (GET /rules) uses — never a
// separately-maintained pricing calculation for the write path.
function buildIndicativeCostSnapshot(rule: any): VisaIndicativeCostSnapshot {
  const fee = computeVisaFeeBlock(rule);
  return {
    embassyFeeInr: rule.embassyFeeInr,
    vfsFeeInr: rule.vfsFeeInr,
    plumtripsServiceFeeInr: rule.plumtripsServiceFeeInr,
    indicativeVisaCostInr: rule.indicativeVisaCostInr,
    displayMode: fee.displayMode,
    totalInr: fee.totalInr,
    priceNote: fee.priceNote,
  };
}

function travellerDisplayName(t: any): string {
  return [t?.firstName, t?.middleName, t?.lastName].filter(Boolean).join(" ");
}

// Phase 10b (task brief §3) — the applicant-profile fields screen 3 may
// actually submit an answer for. Whitelist + enum-validated so a malformed
// client payload 400s instead of silently writing garbage into
// VisaApplication.applicantProfile. employmentStatus/sponsorType/isMinor
// ARE included here (not corporate-defaults-only) — a NON-workspace-member
// traveller (e.g. a family member on the same trip) gets no default for
// them, so if the selected rule actually depends on one, screen 3 must
// still be able to ask and submit it. See buildApplicantProfileForTraveller
// below for how an answer and a corporate default combine.
function validateApplicantProfileAnswer(
  input: unknown,
): { ok: true; value: Partial<VisaApplicantProfile> } | { ok: false; error: string } {
  if (input == null) return { ok: true, value: {} };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "applicantProfileAnswers entry must be an object" };
  }
  const b = input as Record<string, unknown>;
  const value: Partial<VisaApplicantProfile> = {};

  if (b.employmentStatus !== undefined) {
    if (!VISA_EMPLOYMENT_STATUSES.includes(b.employmentStatus as any)) {
      return { ok: false, error: `employmentStatus must be one of ${VISA_EMPLOYMENT_STATUSES.join(", ")}` };
    }
    value.employmentStatus = b.employmentStatus as any;
  }
  if (b.sponsorType !== undefined) {
    if (!VISA_SPONSOR_TYPES.includes(b.sponsorType as any)) {
      return { ok: false, error: `sponsorType must be one of ${VISA_SPONSOR_TYPES.join(", ")}` };
    }
    value.sponsorType = b.sponsorType as any;
  }
  if (b.invitationSource !== undefined) {
    if (!VISA_INVITATION_SOURCES.includes(b.invitationSource as any)) {
      return { ok: false, error: `invitationSource must be one of ${VISA_INVITATION_SOURCES.join(", ")}` };
    }
    value.invitationSource = b.invitationSource as any;
  }
  if (b.maritalStatus !== undefined) {
    if (!VISA_MARITAL_STATUSES.includes(b.maritalStatus as any)) {
      return { ok: false, error: `maritalStatus must be one of ${VISA_MARITAL_STATUSES.join(", ")}` };
    }
    value.maritalStatus = b.maritalStatus as any;
  }
  for (const key of ["isMinor", "isSponsored", "holdsUsVisa", "holdsSchengenVisa"] as const) {
    if (b[key] !== undefined) {
      if (typeof b[key] !== "boolean") return { ok: false, error: `${key} must be a boolean` };
      value[key] = b[key] as boolean;
    }
  }
  return { ok: true, value };
}

// Corporate defaults first (workspace-member => EMPLOYED/EMPLOYER, isMinor
// from dob — task brief §3), then whatever screen 3 actually asked and the
// traveller answered on top. A traveller who ISN'T a workspace member (e.g.
// a family member on the same trip) gets no employmentStatus/sponsorType
// default at all — if the selected rule depends on one for them, the
// answer (not a fabricated default) is what fills it in.
function buildApplicantProfileForTraveller(
  traveller: { linkedMemberId?: unknown; dob?: string | null },
  answer: Partial<VisaApplicantProfile>,
): VisaApplicantProfile {
  const defaults = deriveCorporateApplicantProfileDefaults({
    isWorkspaceMember: !!traveller.linkedMemberId,
    dob: traveller.dob,
  });
  return { ...defaults, ...answer };
}

// Attaches a lightweight traveller summary to each application — GET
// /requests and GET /requests/:id both need "applications and their
// travellers" (never a live re-join of the rule; ruleSnapshot already
// embeds everything rule-related).
//
// documentRequirements is hydrated with name/category/notes HERE, in the
// response shape only — via the same hydrateDocumentRequirements() GET
// /rules already uses — never on the stored ruleSnapshot itself.
// ruleSnapshot.documentRequirements stays the raw {docCode, requirement,
// condition} it always was (models/VisaApplication.ts); a point-in-time
// snapshot storing codes rather than display strings is correct — codes
// don't drift if config/visaDocumentCodes.ts's copy later changes, display
// strings would. (Screen 4, apps/frontend/src/pages/visa/documents, used to
// carry its own frontend copy of that catalogue to work around this
// endpoint not hydrating — deleted once this hydration landed.)
// timeline opts are only ever populated by GET /requests/:id — the task
// brief scopes the timeline fields to that route specifically, not the
// GET /requests list (screen 7 already answers "where is everything"
// without them; adding them there would mean resolving a User lookup and
// re-computing an ETA window for every application in the workspace on
// every list load, for data screen 7 never renders).
//
// assignedConciergeName is resolved PER APPLICATION here (Phase 9a — case
// assignment moved from VisaRequest.assignedConciergeUserId, one concierge
// shared by every traveller on a request, to VisaApplication.
// assignedConciergeUserId, independently settable per traveller — see
// models/VisaApplication.ts). A single User.find({$in:...}) covers every
// distinct concierge across the whole applications array, not one query
// per application.
async function hydrateApplicationsWithTravellers(
  applications: any[],
  workspaceId: any,
  timelineOpts?: { includeTimelineFields: true },
) {
  const travellerIds = applications.map((a) => a.travellerProfileId);
  const travellers = await TravellerProfile.find({
    _id: { $in: travellerIds },
    workspaceId,
  })
    // gender / passportIssueCountry added for screen 5's review summary
    // (2026-08-09). Both are ALREADY CAPTURED — gender by the traveller form
    // and by the passport confirm's fill-if-blank, passportIssueCountry by
    // the passport confirm's write-back — they were simply never projected,
    // so the review page had no way to show what it already held. No new
    // capture, no new field on the model: a select list that was narrower
    // than the screen downstream needed.
    .select(
      "firstName middleName lastName dob email nationality gender passportNo passportExpiry passportIssueCountry",
    )
    .lean();
  const travellerById = new Map(travellers.map((t: any) => [String(t._id), t]));

  let conciergeNameByUserId = new Map<string, string | null>();
  if (timelineOpts) {
    const conciergeIds = [
      ...new Set(
        applications
          .map((a) => a.assignedConciergeUserId)
          .filter(Boolean)
          .map((id) => String(id)),
      ),
    ];
    if (conciergeIds.length) {
      const concierges = await User.find({ _id: { $in: conciergeIds } })
        .select("name email")
        .lean();
      conciergeNameByUserId = new Map(
        concierges.map((u: any) => [String(u._id), u.name || u.email || null]),
      );
    }
  }

  return applications.map((a) => {
    const traveller = travellerById.get(String(a.travellerProfileId)) || null;
    const linkedBookings = a.linkedBookings || [];
    const linkedServices = new Set<string>(
      linkedBookings.map((lb: any) => lb.service),
    );
    // Real per-traveller applicantProfile (schema default {} — see
    // models/VisaApplication.ts) — this is what narrows the rule's ~22
    // requirements down to the ~10 that apply to THIS traveller (task brief
    // §1/§3). An old-shape ruleSnapshot (no documentGroups at all) simply
    // has nothing structured to filter by, so it renders in full either way.
    const checklist = hydrateVisaChecklist(a.ruleSnapshot || {}, {
      applicantProfile: a.applicantProfile || {},
      linkedServices,
    });
    const base = {
      ...a,
      linkedBookings,
      ruleSnapshot: {
        ...a.ruleSnapshot,
        documentRequirements: checklist.documents,
        documentGroups: checklist.documentGroups,
      },
      traveller: traveller
        ? {
            id: String(traveller._id),
            name: travellerDisplayName(traveller),
            dob: traveller.dob ?? null,
            email: traveller.email ?? null,
            nationality: traveller.nationality ?? null,
            gender: traveller.gender ?? null,
            passportNo: traveller.passportNo ?? null,
            passportExpiry: traveller.passportExpiry ?? null,
            passportIssueCountry: traveller.passportIssueCountry ?? null,
          }
        : null,
    };

    if (!timelineOpts) return base;

    return {
      ...base,
      lodgedAt: a.lodgedAt ?? null,
      assignedConciergeName: a.assignedConciergeUserId
        ? (conciergeNameByUserId.get(String(a.assignedConciergeUserId)) ?? null)
        : null,
      // Per-application, not per-request — each traveller's own passport
      // lodges (and is decided) independently, even though they share one
      // VisaRequest. Null until THIS application has actually been lodged
      // (computeEstimatedDecisionWindow's own null-propagation) — never a
      // guessed window (task brief).
      estimatedDecision: computeEstimatedDecisionWindow(
        a.lodgedAt,
        a.ruleSnapshot?.etaMinDays,
        a.ruleSnapshot?.etaMaxDays,
        a.ruleSnapshot?.etaBasis,
      ),
    };
  });
}

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests — create the draft. Body: { ruleId, travellerProfileIds[],
 * travelDateFrom?, travelDateTo? }. Creates one VisaRequest plus one
 * VisaApplication per traveller, all in draft. See file-level guards —
 * same requireAuth + requireWorkspace + requireFeature("visaEnabled") as
 * every other route here, applied at mount time in server.ts.
 *
 * Ordering is deliberate: BOTH the rule and every traveller are validated
 * before anything is written. A request with even one traveller outside
 * this workspace is rejected whole — never a partial create with the bad
 * traveller silently dropped.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests", async (req: any, res: any) => {
  try {
    const workspaceId = req.workspaceObjectId;
    const {
      ruleId,
      travellerProfileIds,
      travelDateFrom,
      travelDateTo,
      applicantProfileAnswers,
    } = req.body || {};

    if (!ruleId || !mongoose.isValidObjectId(ruleId)) {
      return res.status(404).json({ error: "Visa rule not found" });
    }
    if (
      !Array.isArray(travellerProfileIds) ||
      travellerProfileIds.length === 0
    ) {
      return res
        .status(400)
        .json({ error: "travellerProfileIds must be a non-empty array" });
    }
    const invalidId = travellerProfileIds.find(
      (id: any) => !mongoose.isValidObjectId(id),
    );
    if (invalidId != null) {
      return res
        .status(400)
        .json({ error: `'${invalidId}' is not a valid traveller id` });
    }

    // Phase 10b (task brief §3) — optional, keyed by travellerProfileId:
    // { [travellerProfileId]: Partial<VisaApplicantProfile> }. Validated
    // whole (every entry) before anything is written, same "all or nothing"
    // posture as the rest of this route.
    const applicantProfileAnswerById = new Map<string, Partial<VisaApplicantProfile>>();
    if (applicantProfileAnswers != null) {
      if (typeof applicantProfileAnswers !== "object" || Array.isArray(applicantProfileAnswers)) {
        return res.status(400).json({ error: "applicantProfileAnswers must be an object keyed by travellerProfileId" });
      }
      for (const [travellerId, answer] of Object.entries(applicantProfileAnswers)) {
        const validated = validateApplicantProfileAnswer(answer);
        if (validated.ok === false) {
          return res.status(400).json({ error: `applicantProfileAnswers['${travellerId}']: ${validated.error}` });
        }
        applicantProfileAnswerById.set(travellerId, validated.value);
      }
    }

    let parsedFrom: Date | undefined;
    let parsedTo: Date | undefined;
    if (travelDateFrom != null) {
      parsedFrom = new Date(travelDateFrom);
      if (Number.isNaN(parsedFrom.getTime())) {
        return res
          .status(400)
          .json({ error: "travelDateFrom is not a valid date" });
      }
    }
    if (travelDateTo != null) {
      parsedTo = new Date(travelDateTo);
      if (Number.isNaN(parsedTo.getTime())) {
        return res
          .status(400)
          .json({ error: "travelDateTo is not a valid date" });
      }
    }

    // Rule must exist and be PUBLISHED — same bar the customer-facing read
    // route (GET /rules) already holds every quoted variant to.
    const rule = await VisaRule.findById(ruleId).lean();
    if (!rule || rule.status !== "PUBLISHED") {
      return res.status(404).json({ error: "Visa rule not found" });
    }

    // Every travellerProfileId must belong to req.workspace — the canonical
    // tenancy boundary (docs/audits/visa-module-recon.md §5), never a
    // client-supplied workspaceId. Reject the WHOLE request if the counts
    // don't match; never silently drop the ones that don't belong.
    const travellers = await TravellerProfile.find({
      _id: { $in: travellerProfileIds },
      workspaceId,
    }).lean();
    if (travellers.length !== travellerProfileIds.length) {
      return res
        .status(400)
        .json({
          error: "One or more travellers do not belong to this workspace",
        });
    }
    const travellerById = new Map(
      travellers.map((t: any) => [String(t._id), t]),
    );

    const raisedByUserId = req.user?._id ?? req.user?.id ?? req.user?.sub;
    // Set ONCE, here, from the raiser's OWN customerId/businessId — never
    // re-derived later, and never guessed from workspaceId (models/
    // VisaRequest.ts's own doc comment on this field explains why: that's
    // exactly the many-Customers-one-workspace ambiguity this field exists
    // to stop depending on). null for a staff-raised request (no
    // customerId on the account at all — the existing HOUSE test data
    // shape) rather than a guess.
    const customerId = req.user?.customerId || req.user?.businessId || null;

    // Duplicate-application warning (2026-08-02) — checked BEFORE creating,
    // but never blocks it: a genuine second application for the same trip
    // is possible (a rejected first attempt, a changed service tier), and
    // rejecting it would be worse than the duplicate (task brief). A match
    // is an existing application for one of THESE travellers, same
    // destination, an overlapping travel window, and a non-terminal,
    // non-draft status: decision_received/closed are done, a cancelled
    // REQUEST never progressed past draft in the first place (POST
    // /requests/:id/cancel only allows cancelling a draft, so excluding
    // cancelled requests is belt-and-braces alongside the draft-status
    // exclusion below, not load-bearing on its own), and a draft is the
    // traveller's own in-progress attempt — warning them about their own
    // unfinished work is noise, never included here.
    let duplicateWarnings: Array<{
      travellerProfileId: string;
      travellerName: string;
      existingRequestId: string;
      existingReferenceNumber: string;
      existingApplicationId: string;
      existingStatus: string;
      destinationName: string;
    }> = [];

    if (parsedFrom && parsedTo) {
      const candidateRequests = await VisaRequest.find({
        workspaceId,
        destinationIso2: rule.destinationIso2,
        status: { $ne: "cancelled" },
        travelDateFrom: { $lte: parsedTo },
        travelDateTo: { $gte: parsedFrom },
      })
        .select("_id referenceNumber")
        .lean();

      if (candidateRequests.length > 0) {
        const candidateRequestById = new Map(
          candidateRequests.map((r: any) => [String(r._id), r]),
        );
        const candidateApplications = await VisaApplication.find({
          workspaceId,
          requestId: { $in: candidateRequests.map((r: any) => r._id) },
          travellerProfileId: { $in: travellerProfileIds },
          status: { $nin: ["draft", "decision_received", "closed"] },
        })
          .select(
            "_id requestId travellerProfileId status ruleSnapshot.destinationName",
          )
          .lean();

        duplicateWarnings = candidateApplications.map((a: any) => {
          const existingRequest = candidateRequestById.get(String(a.requestId));
          const traveller = travellerById.get(String(a.travellerProfileId));
          return {
            travellerProfileId: String(a.travellerProfileId),
            travellerName: travellerDisplayName(traveller),
            existingRequestId: String(a.requestId),
            existingReferenceNumber: existingRequest?.referenceNumber || "",
            existingApplicationId: String(a._id),
            existingStatus: a.status,
            destinationName:
              a.ruleSnapshot?.destinationName || rule.destinationName,
          };
        });
      }
    }

    // Reference number is minted ONCE here, by VisaRequest's own pre-save
    // hook (see models/VisaRequest.ts, mintVisaRequestReferenceNumber) —
    // never generated by this route. status is deliberately OMITTED — the
    // schema's own `default: "draft"` covers the initial value, and the
    // authoritative value afterwards comes only from recomputeRequestStatus()
    // below. Never assign VisaRequest.status directly in a route.
    const visaRequest = await VisaRequest.create({
      workspaceId,
      raisedByUserId,
      customerId,
      destinationIso2: rule.destinationIso2,
      purpose: rule.purpose,
      travelDateFrom: parsedFrom,
      travelDateTo: parsedTo,
      applicationIds: [],
    });

    const ruleSnapshot = buildRuleSnapshot(rule);
    const indicativeCostSnapshot = buildIndicativeCostSnapshot(rule);

    // travellerProfileIds order is preserved — travellers.find() above may
    // not match input order, so applications are built off the ORIGINAL
    // array, not the query result. ruleSnapshot/indicativeCostSnapshot are
    // plain objects built fresh above — every application gets its own
    // copy via the object spread each entry does implicitly on insert, not
    // a shared reference to one snapshot object.
    const applicationInputs = travellerProfileIds.map((id: string) => {
      const traveller = travellerById.get(String(id));
      const nationalityIso2 = normaliseToIso2(traveller?.nationality);
      const answer = applicantProfileAnswerById.get(String(id)) || {};
      return {
        workspaceId,
        requestId: visaRequest._id,
        // Copied from the parent request, not re-derived (task brief,
        // 2026-08-01) — see models/VisaApplication.ts's own doc comment.
        customerId,
        travellerProfileId: traveller!._id,
        nationality: nationalityIso2, // null when it doesn't resolve — see model comment
        nationalityUnresolved: nationalityIso2 == null,
        // Phase 10b (task brief §3) — corporate defaults (workspace member
        // => EMPLOYED/EMPLOYER, isMinor from dob) merged with whatever
        // screen 3 actually asked and this traveller answered. This is what
        // lets the resolver narrow the rule's checklist down per traveller
        // from GET /requests/:id onward.
        applicantProfile: buildApplicantProfileForTraveller(traveller!, answer),
        ruleSnapshot,
        indicativeCostSnapshot,
        status: "draft",
      };
    });

    const insertedApplications =
      await VisaApplication.insertMany(applicationInputs);

    await VisaRequest.findByIdAndUpdate(visaRequest._id, {
      $set: { applicationIds: insertedApplications.map((a: any) => a._id) },
    });

    // status is DERIVED — never assigned directly. See recomputeRequestStatus
    // doc comment (models/VisaRequest.ts) for the rollup rule.
    await recomputeRequestStatus(visaRequest._id);

    await logVisaActivity({
      requestId: visaRequest._id,
      workspaceId,
      eventType: "REQUEST_CREATED",
      actorUserId: raisedByUserId,
      actorType: "CUSTOMER",
      detail: {
        destinationIso2: rule.destinationIso2,
        purpose: rule.purpose,
        travellerCount: insertedApplications.length,
      },
    });
    for (const app of insertedApplications as any[]) {
      await logVisaActivity({
        applicationId: app._id,
        requestId: visaRequest._id,
        workspaceId,
        eventType: "APPLICATION_CREATED",
        actorUserId: raisedByUserId,
        actorType: "CUSTOMER",
        detail: {
          destinationName: ruleSnapshot.destinationName,
          purpose: ruleSnapshot.purpose,
          serviceTier: ruleSnapshot.serviceTier,
        },
      });
    }

    const finalRequest = await VisaRequest.findById(visaRequest._id).lean();
    const finalApplications = await VisaApplication.find({
      requestId: visaRequest._id,
    }).lean();
    const hydrated = await hydrateApplicationsWithTravellers(
      finalApplications,
      workspaceId,
    );

    res
      .status(201)
      .json({
        ok: true,
        request: finalRequest,
        applications: hydrated,
        warnings: duplicateWarnings,
      });
  } catch (err: any) {
    console.error("[visa requests POST]", err?.message);
    res
      .status(500)
      .json({ error: err?.message || "Failed to create visa request" });
  }
});

// Normalises a role token the same way every other WORKSPACE_LEADER check
// in this codebase does (myBookings.ts, utils/cstepAccess.ts,
// travelForm.ts, sbt.*.ts, invoices.ts, admin*.billing.ts) — kept local
// rather than importing one of theirs, since none of those files export
// this specific helper, but the algorithm itself must stay identical.
function normRole(v: unknown): string {
  return String(v ?? "")
    .toUpperCase()
    .replace(/[\s_-]+/g, "");
}

/**
 * GET /requests's own access scope (2026-08-01) — a customer-side user sees
 * either their whole CUSTOMER's requests (WORKSPACE_LEADER — "someone who
 * can raise for others") or only their own (everyone else).
 *
 * Deliberately CUSTOMER-scoped, not workspace-scoped: HOUSE has 62
 * Customers sharing one CustomerWorkspace, and a raw { workspaceId } org
 * filter would hand a HOUSE WORKSPACE_LEADER every one of those 62
 * companies' requests — the same class of cross-tenant leak already fixed
 * once this session for billing (services/visaBillingSync.ts's
 * resolveBillingCustomer). Org scope now filters VisaRequest.customerId
 * DIRECTLY (a stored, indexed fact set once at creation from the raiser's
 * own customerId — see models/VisaRequest.ts and this file's own POST
 * /requests) rather than re-deriving it every read through a
 * customerId->users->raisedByUserId join. That join is kept ONLY as a
 * fallback for records that predate the field (customerId: null), and only
 * even queried when such a row exists in this workspace at all — so a
 * fully-backfilled workspace never pays for it, and one that isn't gets a
 * log line naming the gap (see migrations/2026-08-01-backfill-visa-request-
 * customer-id.ts for the one-time bulk fix).
 *
 * The WORKSPACE_LEADER check itself is looked up FRESH from CustomerMember
 * here (not read off req.user.customerMemberRole, the JWT claim stamped at
 * login) so a user with NO CustomerMember record at all can be detected and
 * logged, not just silently defaulted — a real, observed data gap (some
 * customer-side Users have customerId set with no CustomerMember row at
 * all), not something this filter should absorb without a trace. Missing a
 * record still safely falls through to REQUESTER-tier (own-scope only) —
 * logging is so the gap gets FIXED elsewhere, not because own-scope is
 * unsafe.
 */
interface VisaRequestsScopedFilter {
  filter: Record<string, any>;
  // ORG = this user may see their whole customer's cases (WORKSPACE_LEADER);
  // OWN = requests they raised, or requests where they're the claimed
  // traveller, only. Surfaced alongside the filter (rather than recomputed
  // by callers) so GET /summary (2026-08-01) can label its dashboard "your
  // team's applications" vs "your applications" from the SAME determination
  // GET /requests already makes — never a second, potentially-diverging
  // WORKSPACE_LEADER check.
  scope: "ORG" | "OWN";
}

async function resolveVisaRequestsFilter(
  req: any,
  workspaceId: any,
): Promise<VisaRequestsScopedFilter> {
  const user = req.user;
  const userId = actorId(req);
  const rolesNorm = (Array.isArray(user?.roles) ? user.roles : []).map(
    normRole,
  );
  const customerId = user?.customerId || user?.businessId || null;

  let memberRole: string | null = null;
  if (customerId && user?.email) {
    const member = await CustomerMember.findOne({
      customerId: String(customerId),
      email: String(user.email).toLowerCase(),
    })
      .select("role")
      .lean();
    memberRole = (member as any)?.role ?? null;
    if (!member) {
      visaLogger.warn(
        "GET /requests: no CustomerMember record for this customer-side user — defaulting to REQUESTER-tier (own-scope only)",
        {
          userId: String(userId || ""),
          customerId: String(customerId),
        },
      );
    }
  }

  const isOrgScope =
    rolesNorm.includes("WORKSPACELEADER") || memberRole === "WORKSPACE_LEADER";

  if (isOrgScope && customerId) {
    // The direct, indexed path — what this whole change exists to add.
    const hasLegacyRows = await VisaRequest.exists({
      workspaceId,
      customerId: null,
    });
    if (!hasLegacyRows) {
      return {
        filter: { workspaceId, customerId: String(customerId) },
        scope: "ORG",
      };
    }

    // Fallback for pre-field rows ONLY — same indirect join this route
    // used exclusively before customerId existed. Logged every time it's
    // exercised so the backfill gap stays visible rather than quietly
    // permanent.
    visaLogger.warn(
      "GET /requests: workspace has VisaRequest rows with no customerId — falling back to the indirect raisedByUserId join for org scope",
      {
        workspaceId: String(workspaceId),
        customerId: String(customerId),
      },
    );
    const teamUserIds = await User.find({
      $or: [
        { customerId: String(customerId) },
        { businessId: String(customerId) },
      ],
    })
      .select("_id")
      .lean();
    return {
      filter: {
        workspaceId,
        $or: [
          { customerId: String(customerId) },
          {
            customerId: null,
            raisedByUserId: { $in: teamUserIds.map((u: any) => u._id) },
          },
        ],
      },
      scope: "ORG",
    };
  }

  // OWN scope — requests they raised, OR requests where they are the
  // traveller (task brief, 2026-08-01). The traveller link is
  // TravellerProfile.claimedBy ONLY — never inferred from an email match
  // (see that field's own doc comment, and models/TravellerProfile.ts's
  // header) — so an unclaimed traveller (no login, or never claimed) gets
  // no extra visibility here, same as today.
  const claimedTravellerIds = await TravellerProfile.find({
    workspaceId,
    claimedBy: userId,
  }).distinct("_id");
  const requestIdsAsTraveller = await VisaApplication.find({
    workspaceId,
    travellerProfileId: { $in: claimedTravellerIds },
  }).distinct("requestId");

  return {
    filter: {
      workspaceId,
      $or: [
        { raisedByUserId: userId },
        { _id: { $in: requestIdsAsTraveller } },
      ],
    },
    scope: "OWN",
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * GET /requests — scoped list (2026-08-01: customer-scoped for
 * WORKSPACE_LEADER, own-requests-or-own-traveller for everyone else — see
 * resolveVisaRequestsFilter above), for the tracking screen and for
 * resuming a draft. Includes each request's applications and their
 * travellers.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/requests", async (req: any, res: any) => {
  try {
    const workspaceId = req.workspaceObjectId;
    const { filter } = await resolveVisaRequestsFilter(req, workspaceId);
    const requests = await VisaRequest.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    const requestIds = requests.map((r: any) => r._id);
    const applications = await VisaApplication.find({
      workspaceId,
      requestId: { $in: requestIds },
    }).lean();
    const hydrated = await hydrateApplicationsWithTravellers(
      applications,
      workspaceId,
    );

    const applicationsByRequest = new Map<string, any[]>();
    for (const app of hydrated) {
      const key = String(app.requestId);
      if (!applicationsByRequest.has(key)) applicationsByRequest.set(key, []);
      applicationsByRequest.get(key)!.push(app);
    }

    const result = requests.map((r: any) => ({
      ...r,
      applications: applicationsByRequest.get(String(r._id)) || [],
    }));

    res.json({ ok: true, requests: result });
  } catch (err: any) {
    console.error("[visa requests GET list]", err?.message);
    res
      .status(500)
      .json({ error: err?.message || "Failed to load visa requests" });
  }
});

// Stages counted in the dashboard's IN PROGRESS breakdown — every non-
// terminal, non-interrupt stage. "draft" is excluded (not yet a real case
// worth showing on a dashboard) and "action_required" is excluded (it has
// its own top-priority NEEDS YOU section below and must never be double-
// counted here) — same STAGE_ORDER vocabulary as the frontend's
// pages/visa/track/status.ts, minus draft.
const DASHBOARD_IN_PROGRESS_STAGES = [
  "submitted",
  "docs_under_review",
  "cost_confirmed",
  "lodged",
  "decision_received",
];

/* ─────────────────────────────────────────────────────────────────────
 * GET /summary — the one aggregate the customer-facing /visa dashboard
 * calls (2026-08-01). Same resolveVisaRequestsFilter as GET /requests
 * above — org scope for a WORKSPACE_LEADER, own scope otherwise — never
 * re-derived here. Read-only: every item carries just enough (requestId,
 * applicationId, traveller name) to link straight to its case; nothing
 * here is itself actionable.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/summary", async (req: any, res: any) => {
  try {
    const workspaceId = req.workspaceObjectId;
    const { filter, scope } = await resolveVisaRequestsFilter(req, workspaceId);
    const requests = await VisaRequest.find(filter)
      .select("_id destinationIso2 purpose travelDateFrom travelDateTo status")
      .lean();

    if (requests.length === 0) {
      return res.json({
        ok: true,
        scope,
        totalApplications: 0,
        stageCounts: [],
        needsAction: [],
        upcomingTravel: [],
        atRisk: [],
      });
    }

    const requestById = new Map(requests.map((r: any) => [String(r._id), r]));
    const requestIds = requests.map((r: any) => r._id);
    const applications = await VisaApplication.find({
      workspaceId,
      requestId: { $in: requestIds },
    }).lean();

    if (applications.length === 0) {
      return res.json({
        ok: true,
        scope,
        totalApplications: 0,
        stageCounts: [],
        needsAction: [],
        upcomingTravel: [],
        atRisk: [],
      });
    }

    const hydrated = await hydrateApplicationsWithTravellers(
      applications,
      workspaceId,
    );

    const stageCounts = DASHBOARD_IN_PROGRESS_STAGES.map((status) => ({
      status,
      count: hydrated.filter((a: any) => a.status === status).length,
    })).filter((s) => s.count > 0);

    const needsAction = hydrated
      .filter((a: any) => a.status === "action_required")
      .map((a: any) => ({
        requestId: String(a.requestId),
        applicationId: String(a._id),
        travellerName: a.traveller?.name || "Traveller",
        reason: a.actionRequiredReason || null,
        destinationName: a.ruleSnapshot?.destinationName || null,
      }));

    const now = new Date();
    const horizon = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
    const upcomingTravel = hydrated
      .map((a: any) => ({ a, request: requestById.get(String(a.requestId)) }))
      .filter(({ a, request }: any) => {
        if (a.status === "draft") return false;
        const from = request?.travelDateFrom
          ? new Date(request.travelDateFrom)
          : null;
        return Boolean(from && from >= now && from <= horizon);
      })
      .map(({ a, request }: any) => ({
        requestId: String(a.requestId),
        applicationId: String(a._id),
        travellerName: a.traveller?.name || "Traveller",
        destinationName: a.ruleSnapshot?.destinationName || null,
        travelDateFrom: request.travelDateFrom,
        decided: Boolean(a.outcome),
        outcome: a.outcome || null,
      }))
      .sort(
        (a: any, b: any) =>
          new Date(a.travelDateFrom).getTime() -
          new Date(b.travelDateFrom).getTime(),
      );

    // Mirrors admin.visa.ts's computeRowRisk exactly — same "nothing left
    // to risk" exclusion (outcome set, or status closed/draft) and the same
    // single call to assessProcessingRisk, reused rather than recomputed.
    const atRisk = hydrated
      .map((a: any) => {
        const request = requestById.get(String(a.requestId));
        if (a.outcome || a.status === "closed" || a.status === "draft")
          return null;
        const risk = assessProcessingRisk(
          request?.travelDateFrom,
          a.ruleSnapshot?.etaMaxDays,
          a.ruleSnapshot?.etaBasis,
        );
        if (!risk?.atRisk) return null;
        return {
          requestId: String(a.requestId),
          applicationId: String(a._id),
          travellerName: a.traveller?.name || "Traveller",
          destinationName: a.ruleSnapshot?.destinationName || null,
          travelDateFrom: request?.travelDateFrom || null,
          marginDays: risk.marginDays,
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => a.marginDays - b.marginDays);

    res.json({
      ok: true,
      scope,
      totalApplications: applications.length,
      stageCounts,
      needsAction,
      upcomingTravel,
      atRisk,
    });
  } catch (err: any) {
    console.error("[visa summary GET]", err?.message);
    res
      .status(500)
      .json({ error: err?.message || "Failed to load visa summary" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /requests/:id — workspace-scoped detail, with applications and
 * their travellers.
 *
 * Screen 6 (tracking detail) additions — each application in the response
 * also carries lodgedAt, assignedConciergeName (resolved from THIS
 * application's own assignedConciergeUserId — Phase 9a moved case
 * assignment off VisaRequest onto VisaApplication, see models/
 * VisaApplication.ts — so a five-traveller request can show five different
 * concierges), and estimatedDecision. assignedConciergeName is null — never
 * omitted, never a placeholder string — when unset; the frontend is what
 * degrades that to "your concierge team" (task brief).
 * ───────────────────────────────────────────────────────────────────── */
router.get("/requests/:id", async (req: any, res: any) => {
  try {
    const workspaceId = req.workspaceObjectId;
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: "Visa request not found" });
    }

    const visaRequest = await VisaRequest.findOne({
      _id: req.params.id,
      workspaceId,
    }).lean();
    if (!visaRequest) {
      return res.status(404).json({ error: "Visa request not found" });
    }

    const applications = await VisaApplication.find({
      requestId: visaRequest._id,
      workspaceId,
    }).lean();
    const hydrated = await hydrateApplicationsWithTravellers(
      applications,
      workspaceId,
      {
        includeTimelineFields: true,
      },
    );

    // Trimmed, customer-safe activity feed — lifecycle and document events
    // only (VISA_ACTIVITY_CUSTOMER_VISIBLE_EVENT_TYPES); assignment/cost/
    // billing/extraction rows never reach this surface. Capped rather than
    // paginated — no route has asked for paging through a single request's
    // history yet, and a request's lifetime activity is bounded.
    const activityRows = await VisaActivityLog.find({
      requestId: visaRequest._id,
      workspaceId,
      eventType: { $in: [...VISA_ACTIVITY_CUSTOMER_VISIBLE_EVENT_TYPES] },
    })
      .sort({ at: -1 })
      .limit(200)
      .lean();
    const activity = activityRows.map((e: any) => ({
      id: String(e._id),
      applicationId: e.applicationId ? String(e.applicationId) : null,
      eventType: e.eventType,
      actorType: e.actorType,
      at: e.at,
      detail: e.detail || {},
    }));

    res.json({
      ok: true,
      request: visaRequest,
      applications: hydrated,
      activity,
    });
  } catch (err: any) {
    console.error("[visa requests GET detail]", err?.message);
    res
      .status(500)
      .json({ error: err?.message || "Failed to load visa request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/submit — screen 5 (review & submit). Body:
 * { acceptedClauseIds: string[] } — every one of
 * config/visaConsent.ts's VISA_CONSENT_CLAUSE_IDS must be present;
 * anything missing is a hard block, and the error names exactly which
 * clause(s) are missing rather than a generic "consent required" message.
 *
 * Consent is validated FIRST and is a hard block — no consent, no write,
 * regardless of application state (task brief). The checklist is
 * deliberately NOT checked here: concierge chases whatever's missing after
 * submission, so an incomplete checklist must never block this route.
 *
 * Idempotency: VisaRequest.consents being empty is the atomic claim. The
 * findOneAndUpdate filter only matches while "consents.0" doesn't exist, so
 * a double-click (or a retried request) racing the same filter finds it
 * already populated on the second attempt and gets a clean 409 — never a
 * second write, never a second status transition. Cheaper and safer than a
 * read-then-write existence check, which has a race window between the
 * read and the write. All three clause entries are pushed in the SAME
 * atomic update, never one at a time — a request is either fully consented
 * or not consented at all, no partially-populated consents array is ever
 * observable.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests/:id/submit", async (req: any, res: any) => {
  try {
    const workspaceId = req.workspaceObjectId;
    const requestId = req.params.id;
    if (!mongoose.isValidObjectId(requestId)) {
      return res.status(404).json({ error: "Visa request not found" });
    }

    const acceptedClauseIds = new Set(
      Array.isArray(req.body?.acceptedClauseIds)
        ? req.body.acceptedClauseIds.map(String)
        : [],
    );
    const missingClauseIds = VISA_CONSENT_CLAUSE_IDS.filter(
      (id) => !acceptedClauseIds.has(id),
    );
    if (missingClauseIds.length > 0) {
      return res.status(400).json({
        error: `Consent is required for: ${missingClauseIds.join(", ")}`,
        missingClauseIds,
      });
    }

    // Existence + tenancy check up front, separate from the atomic claim
    // below — so a bad/cross-workspace id always 404s, never a 409 (which
    // would otherwise be indistinguishable from "not found" to the caller
    // but wrong: 409 should mean "found, already submitted", not "not
    // found at all").
    const owned = await VisaRequest.findOne({ _id: requestId, workspaceId })
      .select("_id")
      .lean();
    if (!owned) {
      return res.status(404).json({ error: "Visa request not found" });
    }

    const acceptedAt = new Date();
    const acceptedByUserId = actorId(req);
    // Constructed from the canonical VISA_CONSENT_CLAUSE_IDS list, never
    // from the client's raw acceptedClauseIds array — the validation above
    // only checked SET MEMBERSHIP, a client could in principle send extra
    // garbage ids alongside the three real ones, and findOneAndUpdate's
    // $push doesn't run schema validators to catch that for us.
    const claimed = await VisaRequest.findOneAndUpdate(
      { _id: requestId, workspaceId, "consents.0": { $exists: false } },
      {
        $push: {
          consents: {
            $each: VISA_CONSENT_CLAUSE_IDS.map((clauseId) => ({
              clauseId,
              version: CURRENT_VISA_CONSENT_VERSION,
              acceptedAt,
              acceptedByUserId,
            })),
          },
        },
      },
      { new: true },
    );

    if (!claimed) {
      return res
        .status(409)
        .json({ error: "This visa request has already been submitted." });
    }

    // Only applications still in "draft" transition — never re-touches one
    // that (in principle) already progressed further. status is set here
    // as a FACT; VisaRequest.status itself is never assigned directly —
    // recomputeRequestStatus derives it below, same rule as every other
    // write path in this file.
    const draftApplications = await VisaApplication.find({
      requestId,
      workspaceId,
      status: "draft",
    })
      .select("_id")
      .lean();

    await VisaApplication.updateMany(
      { requestId, workspaceId, status: "draft" },
      { $set: { status: "submitted", submittedAt: new Date() } },
    );

    for (const app of draftApplications as any[]) {
      await logVisaActivity({
        applicationId: app._id,
        requestId,
        workspaceId,
        eventType: "SUBMITTED",
        actorUserId: actorId(req),
        actorType: "CUSTOMER",
      });
    }

    await recomputeRequestStatus(requestId);

    const finalRequest = await VisaRequest.findById(requestId).lean();
    const applications = await VisaApplication.find({
      requestId,
      workspaceId,
    }).lean();
    const hydrated = await hydrateApplicationsWithTravellers(
      applications,
      workspaceId,
    );

    res.json({ ok: true, request: finalRequest, applications: hydrated });
  } catch (err: any) {
    console.error("[visa requests submit POST]", err?.message);
    res
      .status(500)
      .json({ error: err?.message || "Failed to submit visa request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/cancel — abandon a draft. Draft-only: a request that
 * has already been submitted (consents populated, applications moved
 * past draft — reflected in the derived status no longer being "draft")
 * must never be cancelled through this route; the applicant's way out of a
 * SUBMITTED application is talking to their concierge, not a self-serve
 * cancel.
 *
 * cancelledAt/cancelledByUserId are AUTHORED facts (models/VisaRequest.ts's
 * doc comment) — this route sets them directly, then calls
 * recomputeRequestStatus, which short-circuits straight to "cancelled"
 * whenever cancelledAt is set, regardless of child application state. That
 * short-circuit is exactly what makes a request abandoned before any
 * application was ever submitted reachable as "cancelled" at all — nothing
 * else in the rollup rule can get there from an all-draft state.
 *
 * Idempotency mirrors POST /requests/:id/submit: the atomic claim filters
 * on { status: "draft", cancelledAt: null }, so a double-click (or retry)
 * racing the same filter finds it already claimed on the second attempt
 * and gets a clean 409 — never a second write. Existence + tenancy is
 * checked separately, up front, so a bad/cross-workspace id always 404s.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests/:id/cancel", async (req: any, res: any) => {
  try {
    const workspaceId = req.workspaceObjectId;
    const requestId = req.params.id;
    if (!mongoose.isValidObjectId(requestId)) {
      return res.status(404).json({ error: "Visa request not found" });
    }

    const owned = await VisaRequest.findOne({ _id: requestId, workspaceId })
      .select("_id status")
      .lean();
    if (!owned) {
      return res.status(404).json({ error: "Visa request not found" });
    }
    if (owned.status !== "draft") {
      return res
        .status(409)
        .json({
          error:
            "This visa request has already been submitted and can no longer be cancelled.",
        });
    }

    const claimed = await VisaRequest.findOneAndUpdate(
      { _id: requestId, workspaceId, status: "draft", cancelledAt: null },
      {
        $set: {
          cancelledAt: new Date(),
          cancelledByUserId: actorId(req),
        },
      },
      { new: true },
    );

    if (!claimed) {
      return res
        .status(409)
        .json({
          error:
            "This visa request has already been submitted and can no longer be cancelled.",
        });
    }

    await recomputeRequestStatus(requestId);

    await logVisaActivity({
      requestId,
      workspaceId,
      eventType: "REQUEST_CANCELLED",
      actorUserId: actorId(req),
      actorType: "CUSTOMER",
    });

    const finalRequest = await VisaRequest.findById(requestId).lean();
    res.json({ ok: true, request: finalRequest });
  } catch (err: any) {
    console.error("[visa requests cancel POST]", err?.message);
    res
      .status(500)
      .json({ error: err?.message || "Failed to cancel visa request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * Phase 4a — document upload and the booking lookup behind screen 4.
 * ───────────────────────────────────────────────────────────────────── */

// Allowlist mirrors manualBookings.ts's own document-attachment upload
// (ATTACHMENT_ALLOWED_MIME) — the closest sibling in this codebase: a
// general document attachment, not a phone-camera receipt (which allows
// HEIC too, in expenses.ts). PDF + the three common image formats, 15MB
// cap — same numbers as that sibling, for consistency rather than a fresh
// invented limit. An ALLOWLIST inherently rejects executables and anything
// else not explicitly permitted; nothing here blocklists by extension,
// which is trivial to spoof.
// Exported — routes/admin.visa.ts's outcome-capture route (attaching a
// scanned issued visa) reuses this SAME multer config/mw, not a second
// upload path with its own limits.
export const VISA_DOCUMENT_ALLOWED_MIME = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
];
export const VISA_DOCUMENT_MAX_BYTES = 15 * 1024 * 1024;
const visaDocumentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: VISA_DOCUMENT_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (VISA_DOCUMENT_ALLOWED_MIME.includes(file.mimetype))
      return cb(null, true);
    cb(new Error("Only PDF, PNG, JPEG, or WEBP files are allowed."));
  },
});

// Wraps multer so a rejected mime type or an oversized file returns clean
// JSON (413/400) instead of falling through to Express's default error
// handler — mirrors expenses.ts's receiptUploadMw / workspace.branding.ts.
// Exported for the same reason as the constants above.
export function visaDocumentUploadMw(req: any, res: any, next: any) {
  visaDocumentUpload.single("file")(req, res, (err: any) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: `File too large. Maximum size is ${VISA_DOCUMENT_MAX_BYTES / (1024 * 1024)}MB.`,
      });
    }
    return res.status(400).json({ error: err?.message || "Upload failed" });
  });
}

// Shared ownership check for every /applications/:applicationId/... route
// below — 404s (never a bare 403, never leaks whether the id exists in
// ANOTHER workspace) on a malformed id or an application that doesn't
// belong to req.workspace.
async function findOwnedApplication(applicationId: string, workspaceId: any) {
  if (!applicationId || !mongoose.isValidObjectId(applicationId)) return null;
  return VisaApplication.findOne({ _id: applicationId, workspaceId }).lean();
}

function actorId(req: any): any {
  return req.user?._id ?? req.user?.id ?? req.user?.sub;
}

// Never includes s3Key (internal storage path) or a presigned URL — see
// GET /documents/:documentId/url below for the only place a URL is issued.
//
// extractedFields/extractionConfidence added for screen 4 (Documents/
// extraction panel, apps/frontend/src/pages/visa/documents) — the panel
// renders and lets the user edit these values, so the list endpoint this
// screen polls (GET /applications/:applicationId/documents) must carry them,
// not just extractionStatus. Still never s3Key or a signed URL.
// Country-ish MRZ fields, projected to ISO-2 alongside the raw value.
//
// The stored value changes shape across the document's life: the MRZ gives
// ISO-3 ("IND"), and after confirmation mergeConfirmedFields rewrites the
// same key to the ISO-2 the converter produced ("IN"). Neither is what a
// client can render as a country NAME, and the ISO-3 -> ISO-2 table lives
// only in utils/countryCodes.ts — server-side.
//
// So the server projects it once, here, rather than every consumer carrying
// a mapping. That is the same call as isPassport above and for the same
// reason: the frontend's own copy of a code table is exactly what drifted in
// the DOC-01/PASSPORT_ORIGINAL bug. normaliseToIso2 accepts ISO-2, ISO-3,
// names and demonyms, so it handles both lifecycle states idempotently and
// simply omits anything it can't resolve (the client then falls back to
// showing the raw value).
const ISO2_PROJECTED_FIELDS = ["issuingState", "nationality"] as const;

function projectExtractedIso2(extractedFields: any[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ISO2_PROJECTED_FIELDS) {
    const raw = extractedFields.find((f: any) => f?.key === key)?.value;
    const iso2 = raw ? normaliseToIso2(String(raw)) : null;
    if (iso2) out[key] = iso2;
  }
  return out;
}

function mapDocumentSummary(d: any) {
  return {
    id: String(d._id),
    applicationId: String(d.applicationId),
    docCode: d.docCode,
    // Server-derived, for the same reason the checklist row carries it (see
    // HydratedChecklistDocumentRow.isPassport): consumers ask "is this the
    // passport", and the answer depends on an alias map only the server
    // holds. hasPassportUploaded / the poll trigger read THIS, never docCode.
    isPassport: isPassportDocCode(d.docCode),
    // Server-derived for the same reason as isPassport: the review screen
    // renders the applicant's photograph and has to FIND it, and which
    // docCode that is depends on an alias map only the server holds
    // (legacy "DOC-02" vs catalogue "PHOTOGRAPH"). Never compared client-side.
    isPhotograph: isPhotographDocCode(d.docCode),
    version: d.version,
    originalFilename: d.originalFilename,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    uploadedByUserId: d.uploadedByUserId ? String(d.uploadedByUserId) : null,
    uploadedAt: d.createdAt,
    extractionStatus: d.extractionStatus,
    extractedFields: d.extractedFields || [],
    // Derived at READ time — deliberately a sibling, not merged into
    // extractedFields, so that array stays a faithful mirror of what
    // extraction actually stored and can never be mistaken for a confirmed
    // value by mergeConfirmedFields.
    extractedIso2: projectExtractedIso2(d.extractedFields || []),
    extractionConfidence: d.extractionConfidence ?? null,
    reviewStatus: d.reviewStatus,
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * POST /applications/:applicationId/documents — multipart upload.
 * Body (multipart): file, docCode.
 *
 * Ordering: ownership is verified BEFORE anything else that could touch S3
 * or the DB (multer parsing the multipart body into req.file/req.body
 * happens first only because Express middleware necessarily runs before
 * the handler — no S3 write or DB write happens until after the ownership
 * check below).
 *
 * Never overwrites — the next version is one past the highest version
 * EVER issued for this {applicationId, docCode}, including soft-deleted
 * rows (models/VisaDocument.ts's unique index enforces this at the DB
 * level too, not just here). extractionStatus starts and stays "PENDING"
 * — nothing here extracts anything (see docs/audits/visa-module-recon.md
 * §4 and the OCR investigation in this phase's build report).
 * ───────────────────────────────────────────────────────────────────── */
// Extracted so routes/admin.visa.ts's outcome-capture route (attaching a
// scanned issued visa) can go through the EXACT same versioning/S3-key/
// extraction-trigger logic, rather than a second copy of it — "reusing the
// existing upload path" (task brief) means this function, not just the
// same utility calls assembled a second time. Behaviour is unchanged from
// what used to be inlined directly in the POST route below.
export async function createVisaDocumentUpload(opts: {
  workspaceId: any;
  applicationId: any;
  requestId: any;
  docCode: string;
  file: {
    buffer: Buffer;
    mimetype: string;
    originalname: string;
    size: number;
  };
  uploaderId: any;
  actorType: VisaActivityActorType;
}) {
  const {
    workspaceId,
    applicationId,
    requestId,
    docCode,
    file,
    uploaderId,
    actorType,
  } = opts;

  const latest = await VisaDocument.findOne({ applicationId, docCode })
    .sort({ version: -1 })
    .select("version")
    .lean();
  const version = (latest?.version ?? 0) + 1;

  // workspaceId IN the S3 key path (not just the workspaceId field) — see
  // models/VisaDocument.ts file header — so a key can never be reused
  // across tenants.
  const uploaded = await uploadBufferToS3({
    buffer: file.buffer,
    mime: file.mimetype,
    originalName: file.originalname,
    customerId: String(workspaceId),
    createdBy: String(uploaderId),
    keyPrefix: `visa-applications/${workspaceId}/${applicationId}`,
  });

  const doc = await VisaDocument.create({
    workspaceId,
    applicationId,
    docCode,
    version,
    s3Key: uploaded.key,
    originalFilename: file.originalname,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    uploadedByUserId: uploaderId,
    // Explicit, not just relying on the schema default — "extraction
    // starts as pending" is a requirement of this phase, not an
    // incidental default. Nothing here (or anywhere yet) extracts
    // anything for non-passport docCodes; see the OCR investigation in
    // that phase's build report.
    extractionStatus: "PENDING",
    // Also explicit, for the same reason: this call is EVERY upload,
    // including a replace of a version an agent already reviewed
    // (VERIFIED/REJECTED). A new version is a document nobody has looked
    // at yet — it must never inherit the prior version's verdict, so
    // reviewStatus/reviewedBy/reviewedAt are never copied forward here,
    // ever (task brief: "close the document-mutation hole").
    reviewStatus: "PENDING",
  });

  await logVisaActivity({
    applicationId,
    requestId,
    workspaceId,
    eventType: version === 1 ? "DOCUMENT_UPLOADED" : "DOCUMENT_REPLACED",
    actorUserId: uploaderId,
    actorType,
    detail: { documentId: String(doc._id), docCode, version },
  });

  // Fire-and-forget — the upload response must never wait on extraction.
  // Only the passport ever triggers it; every other document type stays
  // PENDING with no extraction, per the PRD.
  //
  // isPassportDocCode, not `=== PASSPORT_DOC_CODE`: an application built from
  // documentGroups sends the catalogue code (PASSPORT_ORIGINAL), and the raw
  // equality this used to be silently skipped every one of them.
  if (isPassportDocCode(docCode)) {
    runVisaPassportExtraction(String(doc._id)).catch((err: any) => {
      visaLogger.error("visa passport extraction trigger failed", {
        documentId: String(doc._id),
        error: err?.message,
      });
    });
  }

  return doc;
}

// Phase 9f — an application left sitting in action_required after the
// customer has actually uploaded reads as "blocked" on the queue when it
// isn't; the team only discovers the response by opening the case. Called
// by the customer upload route (never the admin/staff one) whenever a
// document lands while status is STILL action_required (checked by the
// caller, using the status read BEFORE this upload).
//
// Always stamps customerRespondedAt, complete or not — "responded since
// we last asked", not "resolved the ask". Only auto-clears via the
// existing clearActionRequired() helper (restoring
// statusBeforeActionRequired) when every REQUIRED document is now
// satisfied; a partial response leaves the application exactly where it
// was, action_required, with the stamp as the only change. The auto-clear
// activity event logs actorType SYSTEM — the system inferred completion,
// no concierge looked at it.
async function recordCustomerResponseDuringActionRequired(opts: {
  application: { _id: any; workspaceId: any; requestId: any };
  uploaderId: any;
  uploadedDocumentId: string;
  uploadedDocCode: string;
}): Promise<void> {
  const { application, uploaderId, uploadedDocumentId, uploadedDocCode } = opts;
  const applicationId = application._id;
  const workspaceId = application.workspaceId;

  await VisaApplication.findByIdAndUpdate(applicationId, {
    $set: { customerRespondedAt: new Date() },
  });
  await logVisaActivity({
    applicationId,
    requestId: application.requestId,
    workspaceId,
    eventType: "CUSTOMER_RESPONDED",
    actorUserId: uploaderId,
    actorType: "CUSTOMER",
    detail: { documentId: uploadedDocumentId, docCode: uploadedDocCode },
  });

  // Re-fetch the FULL application (ruleSnapshot/linkedBookings) and the
  // current document set — the caller's `application` is a pre-upload
  // snapshot, and the outstanding check must see the document that was
  // just created.
  const [fresh, documents] = await Promise.all([
    VisaApplication.findById(applicationId).lean(),
    VisaDocument.find({ applicationId, workspaceId, deletedAt: null })
      .select("docCode")
      .lean(),
  ]);
  if (!fresh) return;

  const outstanding = computeOutstandingRequirements(
    fresh?.ruleSnapshot || {},
    fresh?.applicantProfile,
    {
      uploadedDocCodes: new Set((documents as any[]).map((d) => d.docCode)),
      linkedServices: new Set(
        ((fresh as any)?.linkedBookings || []).map((lb: any) => lb.service),
      ),
    },
  );
  if (outstanding.length > 0) return; // partial response — stays action_required

  const resumed = await clearActionRequired(applicationId);
  await logVisaActivity({
    applicationId,
    requestId: application.requestId,
    workspaceId,
    eventType: "ACTION_REQUIRED_AUTO_CLEARED",
    actorUserId: null,
    actorType: "SYSTEM",
    detail: { resumedStatus: resumed?.status ?? null },
  });
}

// Upload, delete, and replace (replace is just a same-docCode upload — see
// createVisaDocumentUpload) all share this gate: allowed through
// draft/submitted/action_required — the three statuses where the applicant
// is still the one expected to be adding or changing documents. From
// docs_under_review onward an agent has started working the file
// (routes/admin.visa.ts's PATCH /applications/:id/status is what moves an
// application into docs_under_review), so a self-serve mutation landing
// mid-review could silently invalidate what the agent is already looking
// at — the applicant's route back in at that point is their concierge, not
// this endpoint. Draft is included even though screen 4's normal flow only
// reaches here pre-submission — there's no reason to block it, and PATCH
// /requests/:id/cancel already covers "the applicant wants out" separately.
const DOCUMENT_MUTATION_ALLOWED_STATUSES = [
  "draft",
  "submitted",
  "action_required",
];
const DOCUMENT_UPLOAD_BLOCKED_MESSAGE =
  "Your concierge is already reviewing this application — reply to your concierge if you need to add or change a document.";

// Independent of application status — a reviewed document (VERIFIED or
// REJECTED) stays undeletable even in an otherwise-mutable status, because
// an agent has already looked at it and recorded a verdict. Deleting it
// would erase that work with nothing left in its place; replacing it (the
// normal upload path, same docCode) keeps the old version's verdict on the
// audit trail while giving the agent a fresh PENDING one to review instead.
const DOCUMENT_DELETE_REVIEWED_MESSAGE =
  "This document has already been reviewed by your concierge — replace it instead of deleting so the review stays on record.";

router.post(
  "/applications/:applicationId/documents",
  visaDocumentUploadMw,
  async (req: any, res: any) => {
    try {
      const workspaceId = req.workspaceObjectId;
      const application = await findOwnedApplication(
        req.params.applicationId,
        workspaceId,
      );
      if (!application)
        return res.status(404).json({ error: "Visa application not found" });

      if (isTravellerErased(application)) {
        return res.status(409).json({ error: VISA_APPLICATION_ERASED_MESSAGE });
      }

      if (!DOCUMENT_MUTATION_ALLOWED_STATUSES.includes(application.status)) {
        return res.status(409).json({ error: DOCUMENT_UPLOAD_BLOCKED_MESSAGE });
      }

      const file = req.file;
      if (!file || !file.buffer) {
        return res.status(400).json({ error: "File is required" });
      }

      const docCode = String(req.body?.docCode || "")
        .trim()
        .toUpperCase();
      if (!VISA_DOCUMENT_CODE_SET.has(docCode)) {
        return res
          .status(400)
          .json({
            error: "docCode must be one of the recognised visa document codes",
          });
      }

      const uploaderId = actorId(req);

      const doc = await createVisaDocumentUpload({
        workspaceId,
        applicationId: application._id,
        requestId: (application as any).requestId,
        docCode,
        file,
        uploaderId,
        actorType: "CUSTOMER",
      });

      // Phase 9f — track the response and auto-clear action_required when
      // the checklist is complete. Best-effort: the upload itself already
      // succeeded above, so a failure here must never fail this response.
      if (application.status === "action_required") {
        try {
          await recordCustomerResponseDuringActionRequired({
            application,
            uploaderId,
            uploadedDocumentId: String(doc._id),
            uploadedDocCode: docCode,
          });
        } catch (respondErr: any) {
          visaLogger.error("visa customer-response tracking failed", {
            applicationId: String(application._id),
            documentId: String(doc._id),
            error: respondErr?.message,
          });
        }
      }

      res.status(201).json({ ok: true, document: mapDocumentSummary(doc) });
    } catch (err: any) {
      // Two concurrent uploads of the SAME docCode can both read the same
      // "latest version" above and race on the unique index — surfaced as
      // a conflict to retry, not a generic 500.
      if (err?.code === 11000) {
        return res
          .status(409)
          .json({
            error: "This document was uploaded concurrently — please retry.",
          });
      }
      console.error("[visa application documents POST]", err?.message);
      res
        .status(500)
        .json({ error: err?.message || "Failed to upload document" });
    }
  },
);

/* ─────────────────────────────────────────────────────────────────────
 * GET /applications/:applicationId/documents — latest version per docCode
 * by default; ?includeVersions=true returns every non-deleted version.
 * Never includes a presigned URL — see GET /documents/:documentId/url.
 * ───────────────────────────────────────────────────────────────────── */
router.get(
  "/applications/:applicationId/documents",
  async (req: any, res: any) => {
    try {
      const workspaceId = req.workspaceObjectId;
      const application = await findOwnedApplication(
        req.params.applicationId,
        workspaceId,
      );
      if (!application)
        return res.status(404).json({ error: "Visa application not found" });

      const includeVersions =
        req.query.includeVersions === "true" ||
        req.query.includeVersions === "1";

      const docs = await VisaDocument.find({
        applicationId: application._id,
        workspaceId,
        deletedAt: null,
      })
        .sort({ docCode: 1, version: -1 })
        .lean();

      const shaped = docs.map(mapDocumentSummary);

      if (includeVersions) {
        return res.json({ ok: true, documents: shaped });
      }

      // Latest version per docCode — first-seen wins because of the
      // {docCode: 1, version: -1} sort above.
      const seen = new Set<string>();
      const latestOnly = shaped.filter((d) => {
        if (seen.has(d.docCode)) return false;
        seen.add(d.docCode);
        return true;
      });
      res.json({ ok: true, documents: latestOnly });
    } catch (err: any) {
      console.error("[visa application documents GET]", err?.message);
      res
        .status(500)
        .json({ error: err?.message || "Failed to load documents" });
    }
  },
);

/* ─────────────────────────────────────────────────────────────────────
 * GET /documents/:documentId/url — short-TTL presigned GET.
 *
 * Ownership is checked HERE, at signing time, not inferred from the list
 * endpoint having already filtered it — a signed URL bypasses every other
 * guard once issued, for its whole TTL, so tenancy must be re-verified on
 * this exact request. Excludes soft-deleted documents (never signs a URL
 * for one). Logs who requested it and when.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/documents/:documentId/url", async (req: any, res: any) => {
  try {
    const workspaceId = req.workspaceObjectId;
    const documentId = req.params.documentId;
    if (!documentId || !mongoose.isValidObjectId(documentId)) {
      return res.status(404).json({ error: "Document not found" });
    }

    const doc = await VisaDocument.findOne({
      _id: documentId,
      workspaceId,
      deletedAt: null,
    }).lean();
    if (!doc) return res.status(404).json({ error: "Document not found" });

    const url = await presignGetObject({
      bucket: env.S3_BUCKET,
      key: doc.s3Key,
      filename: doc.originalFilename,
      expiresInSeconds: env.PRESIGN_TTL,
      view: true,
      contentType: doc.mimeType,
    });

    const requestedBy = actorId(req);
    visaLogger.info("visa document presigned URL issued", {
      documentId: String(doc._id),
      applicationId: String(doc.applicationId),
      workspaceId: String(workspaceId),
      requestedBy: requestedBy ? String(requestedBy) : null,
      requestedAt: new Date().toISOString(),
    });

    res.json({ ok: true, url, expiresIn: env.PRESIGN_TTL });
  } catch (err: any) {
    console.error("[visa document url GET]", err?.message);
    res
      .status(500)
      .json({ error: err?.message || "Failed to generate document URL" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * DELETE /documents/:documentId — soft delete only. The S3 object is
 * NEVER removed — a deleted document may still be needed for audit. See
 * models/VisaDocument.ts file header.
 *
 * Gated the same way as upload/replace (DOCUMENT_MUTATION_ALLOWED_STATUSES),
 * PLUS one more rule that upload doesn't need: a document an agent has
 * already reviewed (VERIFIED/REJECTED) can never be deleted, regardless of
 * the application's current status — see DOCUMENT_DELETE_REVIEWED_MESSAGE.
 * ───────────────────────────────────────────────────────────────────── */
router.delete("/documents/:documentId", async (req: any, res: any) => {
  try {
    const workspaceId = req.workspaceObjectId;
    const documentId = req.params.documentId;
    if (!documentId || !mongoose.isValidObjectId(documentId)) {
      return res.status(404).json({ error: "Document not found" });
    }

    const doc = await VisaDocument.findOne({
      _id: documentId,
      workspaceId,
      deletedAt: null,
    }).lean();
    if (!doc) return res.status(404).json({ error: "Document not found" });

    if (doc.reviewStatus === "VERIFIED" || doc.reviewStatus === "REJECTED") {
      return res.status(409).json({ error: DOCUMENT_DELETE_REVIEWED_MESSAGE });
    }

    const application = await findOwnedApplication(
      String(doc.applicationId),
      workspaceId,
    );
    if (!application)
      return res.status(404).json({ error: "Visa application not found" });
    if (!DOCUMENT_MUTATION_ALLOWED_STATUSES.includes(application.status)) {
      return res.status(409).json({ error: DOCUMENT_UPLOAD_BLOCKED_MESSAGE });
    }

    const deletedBy = actorId(req);
    const updated = await VisaDocument.findOneAndUpdate(
      { _id: documentId, workspaceId, deletedAt: null },
      { $set: { deletedAt: new Date(), deletedBy } },
      { new: true },
    );
    if (!updated) return res.status(404).json({ error: "Document not found" });

    await logVisaActivity({
      applicationId: application._id,
      requestId: (application as any).requestId,
      workspaceId,
      eventType: "DOCUMENT_DELETED",
      actorUserId: deletedBy,
      actorType: "CUSTOMER",
      detail: {
        documentId: String(doc._id),
        docCode: doc.docCode,
        version: doc.version,
      },
    });

    res.json({ ok: true });
  } catch (err: any) {
    console.error("[visa document DELETE]", err?.message);
    res
      .status(500)
      .json({ error: err?.message || "Failed to delete document" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /documents/:documentId/extracted-fields — Phase 4b write-back.
 *
 * The ONLY path that ever writes MRZ-derived passport data onto a
 * TravellerProfile, and only once a human has explicitly confirmed it
 * (body.confirmed === true) — extraction alone (services/
 * visaPassportExtraction.ts) never touches TravellerProfile itself.
 *
 * Ownership is re-verified at every hop (document -> application ->
 * traveller), never inferred from an earlier check — same posture as every
 * other route in this file. Only recognised passport field keys are ever
 * mapped through; MRZ ISO3 codes are normalised to ISO2 before writing
 * (TravellerProfile stores country differently from the MRZ), and MRZ
 * YYMMDD dates are resolved to TravellerProfile's "YYYY-MM-DD" string form
 * via resolveMrzDate (utils/mrz.ts), which handles the century window.
 * ───────────────────────────────────────────────────────────────────── */

// MRZ field key -> TravellerProfile field key, plus how to convert the raw
// MRZ value into the string form TravellerProfile stores. Returning
// { error } short-circuits the whole PATCH with a 400 — never a partial
// write of only the fields that happened to convert cleanly.
type FieldConverter = (value: string) => { value: string } | { error: string };

const PASSPORT_FIELD_CONVERTERS: Record<
  string,
  { profileKey: string; convert: FieldConverter }
> = {
  documentNumber: {
    profileKey: "passportNo",
    convert: (v) =>
      v.trim()
        ? { value: v.trim() }
        : { error: "documentNumber must not be empty" },
  },
  dateOfExpiry: {
    profileKey: "passportExpiry",
    convert: (v) => {
      const resolved = resolveMrzDate(v, "expiry");
      return resolved
        ? { value: resolved }
        : { error: `dateOfExpiry '${v}' is not a valid MRZ date` };
    },
  },
  dateOfBirth: {
    profileKey: "dob",
    convert: (v) => {
      const resolved = resolveMrzDate(v, "dob");
      return resolved
        ? { value: resolved }
        : { error: `dateOfBirth '${v}' is not a valid MRZ date` };
    },
  },
  issuingState: {
    profileKey: "passportIssueCountry",
    convert: (v) => {
      const iso2 = normaliseToIso2(v);
      return iso2
        ? { value: iso2 }
        : { error: `issuingState '${v}' is not a recognised country` };
    },
  },
  nationality: {
    profileKey: "nationality",
    convert: (v) => {
      const iso2 = normaliseToIso2(v);
      return iso2
        ? { value: iso2 }
        : { error: `nationality '${v}' is not a recognised country` };
    },
  },
  // MRZ TD3 does not encode an issue date at all — only accepted here when
  // the caller supplies it directly (e.g. typed in by the user during
  // review), already in TravellerProfile's own "YYYY-MM-DD" string form.
  passportIssueDate: {
    profileKey: "passportIssueDate",
    convert: (v) =>
      /^\d{4}-\d{2}-\d{2}$/.test(v)
        ? { value: v }
        : { error: `passportIssueDate '${v}' must be "YYYY-MM-DD"` },
  },
};

// MRZ sex character -> TravellerProfile.gender. "<" ("not stated") is
// deliberately absent, so it maps to undefined and is skipped — see the
// fill-if-blank block in the PATCH route below.
const MRZ_SEX_TO_PROFILE_GENDER: Record<string, string> = {
  M: "Male",
  F: "Female",
};

// Overwrites matching keys in the document's stored extractedFields with
// the confirmed values so the record reflects what was actually written,
// while leaving every check_* entry (and any unrelated key) untouched.
function mergeConfirmedFields(
  existing: { key: string; value: string }[],
  confirmed: Record<string, string>,
) {
  const merged = existing.map((f) =>
    f.key in confirmed ? { key: f.key, value: confirmed[f.key] } : f,
  );
  const seenKeys = new Set(merged.map((f) => f.key));
  for (const [key, value] of Object.entries(confirmed)) {
    if (!seenKeys.has(key)) merged.push({ key, value });
  }
  return merged;
}

router.patch(
  "/documents/:documentId/extracted-fields",
  async (req: any, res: any) => {
    try {
      const workspaceId = req.workspaceObjectId;
      const documentId = req.params.documentId;
      if (!documentId || !mongoose.isValidObjectId(documentId)) {
        return res.status(404).json({ error: "Document not found" });
      }

      const doc = await VisaDocument.findOne({
        _id: documentId,
        workspaceId,
        deletedAt: null,
      });
      if (!doc) return res.status(404).json({ error: "Document not found" });

      if (req.body?.confirmed !== true) {
        return res
          .status(400)
          .json({
            error:
              "confirmed must be true — write-back requires explicit user confirmation",
          });
      }
      if (!isPassportDocCode(doc.docCode)) {
        return res
          .status(400)
          .json({
            error: "Only passport fields can be confirmed and written back",
          });
      }

      const fields = req.body?.fields;
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
        return res
          .status(400)
          .json({
            error: "fields must be an object of recognised passport field keys",
          });
      }

      const application = await VisaApplication.findOne({
        _id: doc.applicationId,
        workspaceId,
      });
      if (!application)
        return res.status(404).json({ error: "Visa application not found" });

      const traveller = await TravellerProfile.findOne({
        _id: (application as any).travellerProfileId,
        workspaceId,
      });
      if (!traveller)
        return res.status(404).json({ error: "Traveller profile not found" });

      const profilePatch: Record<string, string> = {};
      const confirmedFields: Record<string, string> = {};
      for (const [key, rawValue] of Object.entries(fields)) {
        const converter = PASSPORT_FIELD_CONVERTERS[key];
        if (!converter) continue; // unrecognised keys are ignored, not errors
        if (typeof rawValue !== "string") {
          return res.status(400).json({ error: `${key} must be a string` });
        }
        const outcome = converter.convert(rawValue);
        if ("error" in outcome) {
          return res.status(400).json({ error: outcome.error });
        }
        profilePatch[converter.profileKey] = outcome.value;
        confirmedFields[key] = outcome.value;
      }

      if (Object.keys(profilePatch).length === 0) {
        return res
          .status(400)
          .json({ error: "No recognised passport fields were provided" });
      }

      // ── MRZ sex -> profile gender, FILL-IF-BLANK ONLY ──────────────────
      // Mirrors the names refusal (surname/givenNames are never written over
      // a human-entered name) but resolves the opposite case: /visa/apply's
      // compact add-traveller form doesn't ask for gender at all, so these
      // profiles routinely have none, and the passport states it
      // authoritatively. Filling an EMPTY field takes nothing away; changing
      // a set one would overrule the person about their own record, which
      // this must never do.
      //
      // Read off the DOCUMENT's own stored extraction, never the request
      // body: sex is not in PASSPORT_FIELD_CONVERTERS and is not editable in
      // the UI, so a client can neither ask for this nor forge the value.
      //
      // "<" (MRZ for "not stated") is skipped entirely rather than mapped to
      // "Other" — the document declining to state a sex is not the same
      // claim as the person selecting Other, and inventing that distinction
      // would be worse than leaving the field blank.
      //
      // TravellerProfile.gender has no schema enum; "Male"/"Female" is the
      // de-facto vocabulary shared with the traveller form's own select and
      // SBTRequest's real enum.
      const existingGender = String((traveller as any).gender ?? "").trim();
      if (!existingGender) {
        const mrzSex = String(
          (doc.extractedFields || []).find((f: any) => f?.key === "sex")?.value ?? "",
        )
          .trim()
          .toUpperCase();
        const mappedGender = MRZ_SEX_TO_PROFILE_GENDER[mrzSex];
        if (mappedGender) profilePatch.gender = mappedGender;
      }

      const confirmedBy = actorId(req);
      const changed = Object.entries(profilePatch).map(([field, to]) => ({
        field,
        from: (traveller as any)[field] ?? null,
        to,
      }));

      Object.assign(traveller, profilePatch);
      await traveller.save();

      doc.extractedFields = mergeConfirmedFields(
        doc.extractedFields,
        confirmedFields,
      );
      doc.reviewStatus = "VERIFIED";
      doc.reviewedBy = confirmedBy;
      await doc.save();

      visaLogger.info(
        "visa passport fields confirmed and written back to traveller profile",
        {
          documentId: String(doc._id),
          travellerProfileId: String(traveller._id),
          workspaceId: String(workspaceId),
          confirmedBy: confirmedBy ? String(confirmedBy) : null,
          confirmedAt: new Date().toISOString(),
          changed,
        },
      );

      // detail carries the field KEYS that were confirmed, never the values
      // themselves (those are passport data — see VisaActivityLog.ts's
      // no-PII rule) — `changed` above is fine for the structured log line,
      // but must never reach the activity trail.
      await logVisaActivity({
        applicationId: (application as any)._id,
        requestId: (application as any).requestId,
        workspaceId,
        eventType: "FIELDS_CONFIRMED",
        actorUserId: confirmedBy,
        actorType: "CUSTOMER",
        detail: {
          documentId: String(doc._id),
          fields: Object.keys(profilePatch),
        },
      });

      res.json({
        ok: true,
        traveller: { id: String(traveller._id), ...profilePatch },
      });
    } catch (err: any) {
      console.error("[visa documents extracted-fields PATCH]", err?.message);
      res
        .status(500)
        .json({ error: err?.message || "Failed to confirm extracted fields" });
    }
  },
);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Shared by GET .../travel-bookings (list what could be linked) and PATCH
// .../linked-bookings (re-verify a client-supplied bookingId actually
// belongs to this applicant before linking it — never trust the id alone).
// No booking collection stores a travellerId (docs/audits/
// visa-module-recon.md §6) — match through the TravelBooking mirror on
// travellerEmail (from the applicant's TravellerProfile) intersected with
// the parent VisaRequest's travel date range. Returns raw lean TravelBooking
// docs; callers shape the response themselves (see mapTravelBooking).
async function findMatchingTravelBookings(application: any, workspaceId: any) {
  const traveller = await TravellerProfile.findOne({
    _id: application.travellerProfileId,
    workspaceId,
  })
    .select("email")
    .lean();
  if (!(traveller as any)?.email) return [];

  const visaRequest = await VisaRequest.findOne({
    _id: application.requestId,
    workspaceId,
  })
    .select("travelDateFrom travelDateTo")
    .lean();

  const filter: any = {
    workspaceId,
    isActive: true,
    service: { $in: ["FLIGHT", "HOTEL"] },
    travellerEmail: {
      $regex: new RegExp(`^${escapeRegex((traveller as any).email)}$`, "i"),
    },
  };

  const from = (visaRequest as any)?.travelDateFrom;
  const to = (visaRequest as any)?.travelDateTo;
  if (from && to) {
    // Overlap test between the booking's own [travelDate, travelDateEnd]
    // window and the request's [from, to] window.
    filter.$or = [
      { travelDate: { $gte: from, $lte: to } },
      { travelDateEnd: { $gte: from, $lte: to } },
      { travelDate: { $lte: from }, travelDateEnd: { $gte: to } },
    ];
  }

  return TravelBooking.find(filter)
    .select(
      "service destination origin travelDate travelDateEnd status bookedAt referenceModel",
    )
    .sort({ travelDate: 1 })
    .lean();
}

function mapTravelBooking(b: any) {
  return {
    id: String(b._id),
    service: b.service,
    destination: b.destination,
    origin: b.origin,
    travelDate: b.travelDate,
    travelDateEnd: b.travelDateEnd,
    status: b.status,
    bookedAt: b.bookedAt,
    source: b.referenceModel,
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * GET /applications/:applicationId/travel-bookings
 *
 * Empty is a normal result, not an error — screen 4 offers upload or a
 * concierge handoff either way.
 * ───────────────────────────────────────────────────────────────────── */
router.get(
  "/applications/:applicationId/travel-bookings",
  async (req: any, res: any) => {
    try {
      const workspaceId = req.workspaceObjectId;
      const application = await findOwnedApplication(
        req.params.applicationId,
        workspaceId,
      );
      if (!application)
        return res.status(404).json({ error: "Visa application not found" });

      const bookings = await findMatchingTravelBookings(
        application,
        workspaceId,
      );
      res.json({ ok: true, bookings: bookings.map(mapTravelBooking) });
    } catch (err: any) {
      console.error("[visa application travel-bookings GET]", err?.message);
      res
        .status(500)
        .json({ error: err?.message || "Failed to load travel bookings" });
    }
  },
);

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /applications/:applicationId/linked-bookings
 *
 * Links one or more of the applicant's own TravelBooking rows onto this
 * application as a REFERENCE — never copies booking data onto a
 * VisaDocument (a linked booking is not an uploaded file; duplicating it
 * would leave two sources of truth for the same booking). Every bookingId
 * is re-verified against findMatchingTravelBookings() — the SAME
 * traveller-email + date-range match GET .../travel-bookings itself uses —
 * never trusted from the client; a client could otherwise supply any
 * bookingId, including one belonging to another tenant.
 *
 * Idempotent: re-linking an already-linked bookingId is a no-op, not an
 * error — the frontend can safely retry without tracking what's already
 * linked.
 *
 * Body: { bookings: [{ bookingId, service }] }
 * ───────────────────────────────────────────────────────────────────── */
router.patch(
  "/applications/:applicationId/linked-bookings",
  async (req: any, res: any) => {
    try {
      const workspaceId = req.workspaceObjectId;
      const applicationId = req.params.applicationId;
      if (!applicationId || !mongoose.isValidObjectId(applicationId)) {
        return res.status(404).json({ error: "Visa application not found" });
      }

      // Fetched as a live document (no .lean()) — mutated and saved below,
      // same pattern as PATCH /documents/:documentId/extracted-fields.
      const application = await VisaApplication.findOne({
        _id: applicationId,
        workspaceId,
      });
      if (!application)
        return res.status(404).json({ error: "Visa application not found" });

      const incoming = req.body?.bookings;
      if (!Array.isArray(incoming) || incoming.length === 0) {
        return res
          .status(400)
          .json({ error: "bookings must be a non-empty array" });
      }
      for (const entry of incoming) {
        if (!entry || !mongoose.isValidObjectId(entry.bookingId)) {
          return res
            .status(400)
            .json({ error: "Each booking must have a valid bookingId" });
        }
        if (entry.service !== "FLIGHT" && entry.service !== "HOTEL") {
          return res
            .status(400)
            .json({ error: "service must be FLIGHT or HOTEL" });
        }
      }

      const matching = await findMatchingTravelBookings(
        application,
        workspaceId,
      );
      const matchingById = new Map(
        matching.map((b: any) => [String(b._id), b]),
      );

      const invalid = incoming.find((entry: any) => {
        const match = matchingById.get(String(entry.bookingId));
        return !match || match.service !== entry.service;
      });
      if (invalid) {
        return res
          .status(400)
          .json({
            error: `Booking '${invalid.bookingId}' is not linkable to this application`,
          });
      }

      const linkedByUserId = actorId(req);
      const linkedAt = new Date();
      const existing: any[] = (application as any).linkedBookings || [];
      const existingIds = new Set(
        existing.map((lb: any) => String(lb.bookingId)),
      );

      const additions = incoming
        .filter((entry: any) => !existingIds.has(String(entry.bookingId)))
        .map((entry: any) => ({
          bookingId: entry.bookingId,
          service: entry.service,
          linkedAt,
          linkedByUserId,
        }));

      if (additions.length > 0) {
        (application as any).linkedBookings = [...existing, ...additions];
        await (application as any).save();
      }

      res.json({
        ok: true,
        linkedBookings: (application as any).linkedBookings || [],
      });
    } catch (err: any) {
      console.error("[visa application linked-bookings PATCH]", err?.message);
      res
        .status(500)
        .json({ error: err?.message || "Failed to link bookings" });
    }
  },
);

export default router;
