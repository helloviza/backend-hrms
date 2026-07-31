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
// for docCode === PASSPORT_DOC_CODE only; every other docCode still stays
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
import { getCountryByIso2, normaliseToIso2 } from "../utils/countryCodes.js";
import { getVisaDocumentCodeDef, VISA_DOCUMENT_CODE_SET } from "../config/visaDocumentCodes.js";
import { CURRENT_VISA_CONSENT_VERSION } from "../config/visaConsent.js";
import { computeVisaFeeBlock } from "../utils/visaFee.js";
import { computeEstimatedDecisionWindow } from "../utils/visaEta.js";
import { maskTailId } from "../utils/piiMask.js";
import { uploadBufferToS3 } from "../utils/s3Upload.js";
import { presignGetObject } from "../utils/s3Presign.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";
import { runVisaPassportExtraction, PASSPORT_DOC_CODE } from "../services/visaPassportExtraction.js";
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

// The two checklist rows a linked TravelBooking can satisfy without an
// upload — DOC-07 is Hotel Booking, DOC-08 is Flight Itinerary
// (config/visaDocumentCodes.ts; both already seeded on live VisaRules, see
// scripts/seed-visa-rules.ts). Note: task briefs referring to this feature
// have used "DOC-16"/"DOC-17" — those codes don't exist anywhere in the
// registry or any seeded rule (DOC-10..DOC-25 is an unpopulated reserved
// range); DOC-07/DOC-08 are the real, live codes for these two document
// types, so linking is keyed off them instead.
const LINKABLE_DOC_CODE_SERVICE: Record<string, "FLIGHT" | "HOTEL"> = {
  "DOC-08": "FLIGHT",
  "DOC-07": "HOTEL",
};

// linkedServices is only ever passed by hydrateApplicationsWithTravellers,
// which has a real application (and thus real linkedBookings) to check
// against — GET /rules and GET /rules/:id call this before an application
// exists, so satisfiedByBooking is always false there.
function hydrateDocumentRequirements(reqs: VisaDocumentRequirement[], linkedServices?: ReadonlySet<string>) {
  return reqs.map((d) => {
    const def = getVisaDocumentCodeDef(d.docCode);
    const service = LINKABLE_DOC_CODE_SERVICE[d.docCode];
    return {
      docCode: d.docCode,
      name: def?.name ?? null,
      category: def?.category ?? null,
      notes: def?.notes ?? null,
      requirement: d.requirement,
      condition: d.condition,
      satisfiedByBooking: !!(service && linkedServices?.has(service)),
    };
  });
}

// Phase 9f — "is there anything still missing" for the auto-clear check
// after a customer upload during action_required. Deliberately CONDITIONAL
// requirements are never counted here: `condition` is freeform text (e.g.
// "if travelling for business") with no established way anywhere in this
// codebase to evaluate it as true/false, so treating it as always-required
// would be wrong far more often than not — same posture the checklist
// display (hydrateDocumentRequirements above) already takes by never
// gating on it either. A REQUIRED docCode counts as satisfied by ANY
// non-deleted uploaded version regardless of reviewStatus (PENDING
// included) — this checks whether the CUSTOMER has done their part, not
// whether a concierge has reviewed it yet — or by a linked booking
// (DOC-07/DOC-08), same as the checklist display.
export function computeOutstandingRequiredDocCodes(
  application: { ruleSnapshot?: { documentRequirements?: VisaDocumentRequirement[] } | null; linkedBookings?: Array<{ service: string }> | null },
  documents: Array<{ docCode: string }>,
): string[] {
  const requirements = application.ruleSnapshot?.documentRequirements || [];
  const uploadedCodes = new Set(documents.map((d) => d.docCode));
  const linkedServices = new Set((application.linkedBookings || []).map((lb) => lb.service));

  return requirements
    .filter((r) => r.requirement === "REQUIRED")
    .map((r) => r.docCode)
    .filter((docCode) => {
      if (uploadedCodes.has(docCode)) return false;
      const service = LINKABLE_DOC_CODE_SERVICE[docCode];
      if (service && linkedServices.has(service)) return false;
      return true;
    });
}

// Shared by GET /rules (one entry per matching variant) and GET /rules/:id
// (this shape plus destination/purpose, since a by-id caller doesn't
// already know those the way a by-destination-and-purpose caller does).
// Document checklist hydration and fee computation happen here, once, so
// neither route can drift from the other.
function mapRuleToVariant(r: any) {
  return {
    ruleId: String(r._id),
    entryType: r.entryType,
    serviceTier: r.serviceTier,
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
    documents: hydrateDocumentRequirements(r.documentRequirements),
    fee: computeVisaFeeBlock(r),
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * GET /destinations — distinct destinations carrying at least one
 * PUBLISHED VisaRule (any nationality is irrelevant here — a destination
 * is listed if it has ANY published rule). categories always lists every
 * distinct visaCategory found; `category` is populated as a convenience
 * only when there's exactly one, so the client isn't forced to branch on
 * array length for the common single-category case.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/destinations", async (_req: any, res: any) => {
  try {
    const rules = await VisaRule.find({ status: "PUBLISHED" })
      .select("destinationIso2 destinationName visaCategory")
      .lean();

    const byIso2 = new Map<string, { destinationName: string; categories: Set<VisaCategory> }>();
    for (const r of rules) {
      const existing = byIso2.get(r.destinationIso2);
      if (existing) {
        existing.categories.add(r.visaCategory);
      } else {
        byIso2.set(r.destinationIso2, {
          destinationName: r.destinationName,
          categories: new Set([r.visaCategory]),
        });
      }
    }

    const destinations = Array.from(byIso2.entries()).map(([iso2, entry]) => {
      const country = getCountryByIso2(iso2);
      const categories = Array.from(entry.categories);
      return {
        iso2,
        name: country?.name ?? entry.destinationName,
        region: country?.region ?? null,
        categories,
        category: categories.length === 1 ? categories[0] : undefined,
      };
    });

    destinations.sort((a, b) => a.name.localeCompare(b.name));

    res.json({ ok: true, destinations });
  } catch (err: any) {
    console.error("[visa destinations GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load visa destinations" });
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
    const destination = String(req.query?.destination || "").trim().toUpperCase();
    const purpose = String(req.query?.purpose || "").trim().toUpperCase() as VisaPurpose;
    const nationalityRaw = req.query?.nationality;
    const nationality = nationalityRaw
      ? normaliseToIso2(String(nationalityRaw))
      : DEFAULT_APPLICANT_NATIONALITY;

    if (!destination) {
      return res.status(400).json({ error: "destination is required" });
    }
    if (!VISA_PURPOSES.includes(purpose)) {
      return res.status(400).json({ error: `purpose must be one of ${VISA_PURPOSES.join(", ")}` });
    }
    if (!nationality) {
      return res.status(400).json({ error: `nationality '${nationalityRaw}' is not a recognised country` });
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
    rules.sort((a, b) => serviceTierRank(a.serviceTier) - serviceTierRank(b.serviceTier));

    const variants = rules.map(mapRuleToVariant);

    const nationalityCountry = getCountryByIso2(nationality);
    const nationalityInfo = {
      iso2: nationality,
      name: nationalityCountry?.name ?? nationality,
      demonym: nationalityCountry?.demonym ?? nationality,
    };

    res.json({ ok: true, destination, purpose, nationality: nationalityInfo, variants });
  } catch (err: any) {
    console.error("[visa rules GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load visa rules" });
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
 * ───────────────────────────────────────────────────────────────────── */
router.get("/rules/:id", async (req: any, res: any) => {
  try {
    const id = req.params.id;
    if (!id || !mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: "Visa rule not found" });
    }

    const rule = await VisaRule.findOne({ _id: id, status: "PUBLISHED" }).lean();
    if (!rule) {
      return res.status(404).json({ error: "Visa rule not found" });
    }

    res.json({
      ok: true,
      rule: {
        destination: rule.destinationIso2,
        purpose: rule.purpose,
        ...mapRuleToVariant(rule),
      },
    });
  } catch (err: any) {
    console.error("[visa rules/:id GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load visa rule" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /content/:iso2 — VisaDestinationContent, ONLY when status is
 * PUBLISHED. 404 for a missing destination, a DRAFT-only destination, or an
 * unknown iso2 — never a 500, and never DRAFT content leaked to a customer.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/content/:iso2", async (req: any, res: any) => {
  try {
    const iso2 = String(req.params.iso2 || "").trim().toUpperCase();
    if (!iso2) return res.status(404).json({ error: "Destination content not found" });

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
        lastReviewedAt: content.lastReviewedAt,
      },
    });
  } catch (err: any) {
    console.error("[visa content GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load destination content" });
  }
});

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
    const workspaceId = req.workspaceObjectId;
    const docs = await TravellerProfile.find({ workspaceId, isActive: true })
      .select("firstName middleName lastName dob email nationality passportNo passportExpiry")
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
    }));

    res.json({ ok: true, travellers });
  } catch (err: any) {
    console.error("[visa travellers GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load travellers" });
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
    documentRequirements: (rule.documentRequirements || []).map((d: any) => ({ ...d })),
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
  const travellers = await TravellerProfile.find({ _id: { $in: travellerIds }, workspaceId })
    .select("firstName middleName lastName dob email nationality passportNo passportExpiry")
    .lean();
  const travellerById = new Map(travellers.map((t: any) => [String(t._id), t]));

  let conciergeNameByUserId = new Map<string, string | null>();
  if (timelineOpts) {
    const conciergeIds = [
      ...new Set(applications.map((a) => a.assignedConciergeUserId).filter(Boolean).map((id) => String(id))),
    ];
    if (conciergeIds.length) {
      const concierges = await User.find({ _id: { $in: conciergeIds } }).select("name email").lean();
      conciergeNameByUserId = new Map(
        concierges.map((u: any) => [String(u._id), u.name || u.email || null]),
      );
    }
  }

  return applications.map((a) => {
    const traveller = travellerById.get(String(a.travellerProfileId)) || null;
    const linkedBookings = a.linkedBookings || [];
    const linkedServices = new Set<string>(linkedBookings.map((lb: any) => lb.service));
    const base = {
      ...a,
      linkedBookings,
      ruleSnapshot: {
        ...a.ruleSnapshot,
        documentRequirements: hydrateDocumentRequirements(a.ruleSnapshot?.documentRequirements || [], linkedServices),
      },
      traveller: traveller
        ? {
            id: String(traveller._id),
            name: travellerDisplayName(traveller),
            dob: traveller.dob ?? null,
            email: traveller.email ?? null,
            nationality: traveller.nationality ?? null,
            passportNo: traveller.passportNo ?? null,
            passportExpiry: traveller.passportExpiry ?? null,
          }
        : null,
    };

    if (!timelineOpts) return base;

    return {
      ...base,
      lodgedAt: a.lodgedAt ?? null,
      assignedConciergeName: a.assignedConciergeUserId
        ? conciergeNameByUserId.get(String(a.assignedConciergeUserId)) ?? null
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
    const { ruleId, travellerProfileIds, travelDateFrom, travelDateTo } = req.body || {};

    if (!ruleId || !mongoose.isValidObjectId(ruleId)) {
      return res.status(404).json({ error: "Visa rule not found" });
    }
    if (!Array.isArray(travellerProfileIds) || travellerProfileIds.length === 0) {
      return res.status(400).json({ error: "travellerProfileIds must be a non-empty array" });
    }
    const invalidId = travellerProfileIds.find((id: any) => !mongoose.isValidObjectId(id));
    if (invalidId != null) {
      return res.status(400).json({ error: `'${invalidId}' is not a valid traveller id` });
    }

    let parsedFrom: Date | undefined;
    let parsedTo: Date | undefined;
    if (travelDateFrom != null) {
      parsedFrom = new Date(travelDateFrom);
      if (Number.isNaN(parsedFrom.getTime())) {
        return res.status(400).json({ error: "travelDateFrom is not a valid date" });
      }
    }
    if (travelDateTo != null) {
      parsedTo = new Date(travelDateTo);
      if (Number.isNaN(parsedTo.getTime())) {
        return res.status(400).json({ error: "travelDateTo is not a valid date" });
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
      return res.status(400).json({ error: "One or more travellers do not belong to this workspace" });
    }
    const travellerById = new Map(travellers.map((t: any) => [String(t._id), t]));

    const raisedByUserId = req.user?._id ?? req.user?.id ?? req.user?.sub;

    // Reference number is minted ONCE here, by VisaRequest's own pre-save
    // hook (see models/VisaRequest.ts, mintVisaRequestReferenceNumber) —
    // never generated by this route. status is deliberately OMITTED — the
    // schema's own `default: "draft"` covers the initial value, and the
    // authoritative value afterwards comes only from recomputeRequestStatus()
    // below. Never assign VisaRequest.status directly in a route.
    const visaRequest = await VisaRequest.create({
      workspaceId,
      raisedByUserId,
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
      return {
        workspaceId,
        requestId: visaRequest._id,
        travellerProfileId: traveller!._id,
        nationality: nationalityIso2, // null when it doesn't resolve — see model comment
        nationalityUnresolved: nationalityIso2 == null,
        ruleSnapshot,
        indicativeCostSnapshot,
        status: "draft",
      };
    });

    const insertedApplications = await VisaApplication.insertMany(applicationInputs);

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
      detail: { destinationIso2: rule.destinationIso2, purpose: rule.purpose, travellerCount: insertedApplications.length },
    });
    for (const app of insertedApplications as any[]) {
      await logVisaActivity({
        applicationId: app._id,
        requestId: visaRequest._id,
        workspaceId,
        eventType: "APPLICATION_CREATED",
        actorUserId: raisedByUserId,
        actorType: "CUSTOMER",
        detail: { destinationName: ruleSnapshot.destinationName, purpose: ruleSnapshot.purpose, serviceTier: ruleSnapshot.serviceTier },
      });
    }

    const finalRequest = await VisaRequest.findById(visaRequest._id).lean();
    const finalApplications = await VisaApplication.find({ requestId: visaRequest._id }).lean();
    const hydrated = await hydrateApplicationsWithTravellers(finalApplications, workspaceId);

    res.status(201).json({ ok: true, request: finalRequest, applications: hydrated });
  } catch (err: any) {
    console.error("[visa requests POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to create visa request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /requests — workspace-scoped list, for the tracking screen and for
 * resuming a draft. Includes each request's applications and their
 * travellers.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/requests", async (req: any, res: any) => {
  try {
    const workspaceId = req.workspaceObjectId;
    const requests = await VisaRequest.find({ workspaceId }).sort({ createdAt: -1 }).lean();

    const requestIds = requests.map((r: any) => r._id);
    const applications = await VisaApplication.find({ workspaceId, requestId: { $in: requestIds } }).lean();
    const hydrated = await hydrateApplicationsWithTravellers(applications, workspaceId);

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
    res.status(500).json({ error: err?.message || "Failed to load visa requests" });
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

    const visaRequest = await VisaRequest.findOne({ _id: req.params.id, workspaceId }).lean();
    if (!visaRequest) {
      return res.status(404).json({ error: "Visa request not found" });
    }

    const applications = await VisaApplication.find({ requestId: visaRequest._id, workspaceId }).lean();
    const hydrated = await hydrateApplicationsWithTravellers(applications, workspaceId, {
      includeTimelineFields: true,
    });

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

    res.json({ ok: true, request: visaRequest, applications: hydrated, activity });
  } catch (err: any) {
    console.error("[visa requests GET detail]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load visa request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/submit — screen 5 (review & submit). Body:
 * { consentAccepted: true }.
 *
 * Consent is validated FIRST and is a hard block — no consent, no write,
 * regardless of application state (task brief). The checklist is
 * deliberately NOT checked here: concierge chases whatever's missing after
 * submission, so an incomplete checklist must never block this route.
 *
 * Idempotency: VisaRequest.consentAcceptedAt is the atomic claim. The
 * findOneAndUpdate filter only matches while it's still null, so a
 * double-click (or a retried request) racing the same filter finds it
 * already set on the second attempt and gets a clean 409 — never a second
 * write, never a second status transition. Cheaper and safer than a
 * read-then-write existence check, which has a race window between the
 * read and the write.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests/:id/submit", async (req: any, res: any) => {
  try {
    const workspaceId = req.workspaceObjectId;
    const requestId = req.params.id;
    if (!mongoose.isValidObjectId(requestId)) {
      return res.status(404).json({ error: "Visa request not found" });
    }

    if (req.body?.consentAccepted !== true) {
      return res.status(400).json({ error: "Consent is required to submit this application." });
    }

    // Existence + tenancy check up front, separate from the atomic claim
    // below — so a bad/cross-workspace id always 404s, never a 409 (which
    // would otherwise be indistinguishable from "not found" to the caller
    // but wrong: 409 should mean "found, already submitted", not "not
    // found at all").
    const owned = await VisaRequest.findOne({ _id: requestId, workspaceId }).select("_id").lean();
    if (!owned) {
      return res.status(404).json({ error: "Visa request not found" });
    }

    const claimed = await VisaRequest.findOneAndUpdate(
      { _id: requestId, workspaceId, consentAcceptedAt: null },
      {
        $set: {
          consentAcceptedAt: new Date(),
          consentAcceptedByUserId: actorId(req),
          consentVersion: CURRENT_VISA_CONSENT_VERSION,
        },
      },
      { new: true },
    );

    if (!claimed) {
      return res.status(409).json({ error: "This visa request has already been submitted." });
    }

    // Only applications still in "draft" transition — never re-touches one
    // that (in principle) already progressed further. status is set here
    // as a FACT; VisaRequest.status itself is never assigned directly —
    // recomputeRequestStatus derives it below, same rule as every other
    // write path in this file.
    const draftApplications = await VisaApplication.find({ requestId, workspaceId, status: "draft" })
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
    const applications = await VisaApplication.find({ requestId, workspaceId }).lean();
    const hydrated = await hydrateApplicationsWithTravellers(applications, workspaceId);

    res.json({ ok: true, request: finalRequest, applications: hydrated });
  } catch (err: any) {
    console.error("[visa requests submit POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to submit visa request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/cancel — abandon a draft. Draft-only: a request that
 * has already been submitted (consentAcceptedAt set, applications moved
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

    const owned = await VisaRequest.findOne({ _id: requestId, workspaceId }).select("_id status").lean();
    if (!owned) {
      return res.status(404).json({ error: "Visa request not found" });
    }
    if (owned.status !== "draft") {
      return res.status(409).json({ error: "This visa request has already been submitted and can no longer be cancelled." });
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
      return res.status(409).json({ error: "This visa request has already been submitted and can no longer be cancelled." });
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
    res.status(500).json({ error: err?.message || "Failed to cancel visa request" });
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
export const VISA_DOCUMENT_ALLOWED_MIME = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
export const VISA_DOCUMENT_MAX_BYTES = 15 * 1024 * 1024;
const visaDocumentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: VISA_DOCUMENT_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (VISA_DOCUMENT_ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
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
function mapDocumentSummary(d: any) {
  return {
    id: String(d._id),
    applicationId: String(d.applicationId),
    docCode: d.docCode,
    version: d.version,
    originalFilename: d.originalFilename,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    uploadedByUserId: d.uploadedByUserId ? String(d.uploadedByUserId) : null,
    uploadedAt: d.createdAt,
    extractionStatus: d.extractionStatus,
    extractedFields: d.extractedFields || [],
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
  file: { buffer: Buffer; mimetype: string; originalname: string; size: number };
  uploaderId: any;
  actorType: VisaActivityActorType;
}) {
  const { workspaceId, applicationId, requestId, docCode, file, uploaderId, actorType } = opts;

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
  // Only the passport docCode ever triggers it; every other document type
  // stays PENDING with no extraction, per the PRD.
  if (docCode === PASSPORT_DOC_CODE) {
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

  await VisaApplication.findByIdAndUpdate(applicationId, { $set: { customerRespondedAt: new Date() } });
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
    VisaDocument.find({ applicationId, workspaceId, deletedAt: null }).select("docCode").lean(),
  ]);
  if (!fresh) return;

  const outstanding = computeOutstandingRequiredDocCodes(fresh as any, documents as any);
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
const DOCUMENT_MUTATION_ALLOWED_STATUSES = ["draft", "submitted", "action_required"];
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
      const application = await findOwnedApplication(req.params.applicationId, workspaceId);
      if (!application) return res.status(404).json({ error: "Visa application not found" });

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

      const docCode = String(req.body?.docCode || "").trim().toUpperCase();
      if (!VISA_DOCUMENT_CODE_SET.has(docCode)) {
        return res.status(400).json({ error: "docCode must be one of the recognised visa document codes" });
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
        return res.status(409).json({ error: "This document was uploaded concurrently — please retry." });
      }
      console.error("[visa application documents POST]", err?.message);
      res.status(500).json({ error: err?.message || "Failed to upload document" });
    }
  },
);

/* ─────────────────────────────────────────────────────────────────────
 * GET /applications/:applicationId/documents — latest version per docCode
 * by default; ?includeVersions=true returns every non-deleted version.
 * Never includes a presigned URL — see GET /documents/:documentId/url.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/applications/:applicationId/documents", async (req: any, res: any) => {
  try {
    const workspaceId = req.workspaceObjectId;
    const application = await findOwnedApplication(req.params.applicationId, workspaceId);
    if (!application) return res.status(404).json({ error: "Visa application not found" });

    const includeVersions = req.query.includeVersions === "true" || req.query.includeVersions === "1";

    const docs = await VisaDocument.find({ applicationId: application._id, workspaceId, deletedAt: null })
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
    res.status(500).json({ error: err?.message || "Failed to load documents" });
  }
});

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

    const doc = await VisaDocument.findOne({ _id: documentId, workspaceId, deletedAt: null }).lean();
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
    res.status(500).json({ error: err?.message || "Failed to generate document URL" });
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

    const doc = await VisaDocument.findOne({ _id: documentId, workspaceId, deletedAt: null }).lean();
    if (!doc) return res.status(404).json({ error: "Document not found" });

    if (doc.reviewStatus === "VERIFIED" || doc.reviewStatus === "REJECTED") {
      return res.status(409).json({ error: DOCUMENT_DELETE_REVIEWED_MESSAGE });
    }

    const application = await findOwnedApplication(String(doc.applicationId), workspaceId);
    if (!application) return res.status(404).json({ error: "Visa application not found" });
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
      detail: { documentId: String(doc._id), docCode: doc.docCode, version: doc.version },
    });

    res.json({ ok: true });
  } catch (err: any) {
    console.error("[visa document DELETE]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to delete document" });
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

const PASSPORT_FIELD_CONVERTERS: Record<string, { profileKey: string; convert: FieldConverter }> = {
  documentNumber: {
    profileKey: "passportNo",
    convert: (v) => (v.trim() ? { value: v.trim() } : { error: "documentNumber must not be empty" }),
  },
  dateOfExpiry: {
    profileKey: "passportExpiry",
    convert: (v) => {
      const resolved = resolveMrzDate(v, "expiry");
      return resolved ? { value: resolved } : { error: `dateOfExpiry '${v}' is not a valid MRZ date` };
    },
  },
  dateOfBirth: {
    profileKey: "dob",
    convert: (v) => {
      const resolved = resolveMrzDate(v, "dob");
      return resolved ? { value: resolved } : { error: `dateOfBirth '${v}' is not a valid MRZ date` };
    },
  },
  issuingState: {
    profileKey: "passportIssueCountry",
    convert: (v) => {
      const iso2 = normaliseToIso2(v);
      return iso2 ? { value: iso2 } : { error: `issuingState '${v}' is not a recognised country` };
    },
  },
  nationality: {
    profileKey: "nationality",
    convert: (v) => {
      const iso2 = normaliseToIso2(v);
      return iso2 ? { value: iso2 } : { error: `nationality '${v}' is not a recognised country` };
    },
  },
  // MRZ TD3 does not encode an issue date at all — only accepted here when
  // the caller supplies it directly (e.g. typed in by the user during
  // review), already in TravellerProfile's own "YYYY-MM-DD" string form.
  passportIssueDate: {
    profileKey: "passportIssueDate",
    convert: (v) =>
      /^\d{4}-\d{2}-\d{2}$/.test(v) ? { value: v } : { error: `passportIssueDate '${v}' must be "YYYY-MM-DD"` },
  },
};

// Overwrites matching keys in the document's stored extractedFields with
// the confirmed values so the record reflects what was actually written,
// while leaving every check_* entry (and any unrelated key) untouched.
function mergeConfirmedFields(existing: { key: string; value: string }[], confirmed: Record<string, string>) {
  const merged = existing.map((f) => (f.key in confirmed ? { key: f.key, value: confirmed[f.key] } : f));
  const seenKeys = new Set(merged.map((f) => f.key));
  for (const [key, value] of Object.entries(confirmed)) {
    if (!seenKeys.has(key)) merged.push({ key, value });
  }
  return merged;
}

router.patch("/documents/:documentId/extracted-fields", async (req: any, res: any) => {
  try {
    const workspaceId = req.workspaceObjectId;
    const documentId = req.params.documentId;
    if (!documentId || !mongoose.isValidObjectId(documentId)) {
      return res.status(404).json({ error: "Document not found" });
    }

    const doc = await VisaDocument.findOne({ _id: documentId, workspaceId, deletedAt: null });
    if (!doc) return res.status(404).json({ error: "Document not found" });

    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: "confirmed must be true — write-back requires explicit user confirmation" });
    }
    if (doc.docCode !== PASSPORT_DOC_CODE) {
      return res.status(400).json({ error: "Only passport fields can be confirmed and written back" });
    }

    const fields = req.body?.fields;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      return res.status(400).json({ error: "fields must be an object of recognised passport field keys" });
    }

    const application = await VisaApplication.findOne({ _id: doc.applicationId, workspaceId });
    if (!application) return res.status(404).json({ error: "Visa application not found" });

    const traveller = await TravellerProfile.findOne({ _id: (application as any).travellerProfileId, workspaceId });
    if (!traveller) return res.status(404).json({ error: "Traveller profile not found" });

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
      return res.status(400).json({ error: "No recognised passport fields were provided" });
    }

    const confirmedBy = actorId(req);
    const changed = Object.entries(profilePatch).map(([field, to]) => ({
      field,
      from: (traveller as any)[field] ?? null,
      to,
    }));

    Object.assign(traveller, profilePatch);
    await traveller.save();

    doc.extractedFields = mergeConfirmedFields(doc.extractedFields, confirmedFields);
    doc.reviewStatus = "VERIFIED";
    doc.reviewedBy = confirmedBy;
    await doc.save();

    visaLogger.info("visa passport fields confirmed and written back to traveller profile", {
      documentId: String(doc._id),
      travellerProfileId: String(traveller._id),
      workspaceId: String(workspaceId),
      confirmedBy: confirmedBy ? String(confirmedBy) : null,
      confirmedAt: new Date().toISOString(),
      changed,
    });

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
      detail: { documentId: String(doc._id), fields: Object.keys(profilePatch) },
    });

    res.json({ ok: true, traveller: { id: String(traveller._id), ...profilePatch } });
  } catch (err: any) {
    console.error("[visa documents extracted-fields PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to confirm extracted fields" });
  }
});

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
  const traveller = await TravellerProfile.findOne({ _id: application.travellerProfileId, workspaceId })
    .select("email")
    .lean();
  if (!(traveller as any)?.email) return [];

  const visaRequest = await VisaRequest.findOne({ _id: application.requestId, workspaceId })
    .select("travelDateFrom travelDateTo")
    .lean();

  const filter: any = {
    workspaceId,
    isActive: true,
    service: { $in: ["FLIGHT", "HOTEL"] },
    travellerEmail: { $regex: new RegExp(`^${escapeRegex((traveller as any).email)}$`, "i") },
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
    .select("service destination origin travelDate travelDateEnd status bookedAt referenceModel")
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
router.get("/applications/:applicationId/travel-bookings", async (req: any, res: any) => {
  try {
    const workspaceId = req.workspaceObjectId;
    const application = await findOwnedApplication(req.params.applicationId, workspaceId);
    if (!application) return res.status(404).json({ error: "Visa application not found" });

    const bookings = await findMatchingTravelBookings(application, workspaceId);
    res.json({ ok: true, bookings: bookings.map(mapTravelBooking) });
  } catch (err: any) {
    console.error("[visa application travel-bookings GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load travel bookings" });
  }
});

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
router.patch("/applications/:applicationId/linked-bookings", async (req: any, res: any) => {
  try {
    const workspaceId = req.workspaceObjectId;
    const applicationId = req.params.applicationId;
    if (!applicationId || !mongoose.isValidObjectId(applicationId)) {
      return res.status(404).json({ error: "Visa application not found" });
    }

    // Fetched as a live document (no .lean()) — mutated and saved below,
    // same pattern as PATCH /documents/:documentId/extracted-fields.
    const application = await VisaApplication.findOne({ _id: applicationId, workspaceId });
    if (!application) return res.status(404).json({ error: "Visa application not found" });

    const incoming = req.body?.bookings;
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return res.status(400).json({ error: "bookings must be a non-empty array" });
    }
    for (const entry of incoming) {
      if (!entry || !mongoose.isValidObjectId(entry.bookingId)) {
        return res.status(400).json({ error: "Each booking must have a valid bookingId" });
      }
      if (entry.service !== "FLIGHT" && entry.service !== "HOTEL") {
        return res.status(400).json({ error: "service must be FLIGHT or HOTEL" });
      }
    }

    const matching = await findMatchingTravelBookings(application, workspaceId);
    const matchingById = new Map(matching.map((b: any) => [String(b._id), b]));

    const invalid = incoming.find((entry: any) => {
      const match = matchingById.get(String(entry.bookingId));
      return !match || match.service !== entry.service;
    });
    if (invalid) {
      return res
        .status(400)
        .json({ error: `Booking '${invalid.bookingId}' is not linkable to this application` });
    }

    const linkedByUserId = actorId(req);
    const linkedAt = new Date();
    const existing: any[] = (application as any).linkedBookings || [];
    const existingIds = new Set(existing.map((lb: any) => String(lb.bookingId)));

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

    res.json({ ok: true, linkedBookings: (application as any).linkedBookings || [] });
  } catch (err: any) {
    console.error("[visa application linked-bookings PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to link bookings" });
  }
});

export default router;
