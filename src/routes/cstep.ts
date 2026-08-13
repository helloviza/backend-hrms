// apps/backend/src/routes/cstep.ts
//
// CSTEP Travel & Claim Portal — Phase 3 (pre-trip travel request form) +
// Phase 4 (withdraw/edit/resubmit, approval, TIN issuance, audit log) +
// Phase 5 (self-filing, per-traveller Tour Approver routing, CSTEP Admin
// role).
// Mounted at /api/cstep behind:
//   requireAuth → requireWorkspace → requireFeature("cstepEnabled")
//
// Scoping (NON-NEGOTIABLE): every query stamps workspaceId via
// req.workspaceObjectId — never trusted from the request body.
//
// Access model (Phase 5): two DISTINCT concepts, not one blanket "approver"
// role any more —
//   - CSTEP Admin: a ROLE (SUPERADMIN/ADMIN/HR — see utils/cstepAccess.ts's
//     isCstepAdmin), oversight of everything: sees/acts on every request,
//     can file on behalf of any traveller. NOT a per-person capability grant
//     (unlike the Expense module's per-employee toggles).
//   - Tour Approver: a per-traveller ASSIGNMENT (TravellerProfile.
//     tourApproverId, set by an Admin via workspace.travellers.ts), separate
//     from any Expense reporting-manager. Can only act on requests belonging
//     to travellers who have them set as tourApproverId — see
//     callerCanActOnTraveller below.
//
// Audit trail: CstepApproval (decision/lifecycle events) and CstepAmendment
// (field-level edits) are BOTH append-only — every write here is an insert,
// never an update or delete of an existing entry.
//
// Out of scope for this phase: signature capture and PDF generation will
// follow the existing utils/travelFormPdf.ts pattern in a later phase — do
// not implement them here.

import { Router } from "express";
import multer from "multer";
import mongoose from "mongoose";
import {
  CstepTravelRequest,
  CstepApproval,
  CstepAmendment,
  CstepClaim,
  CstepArrangement,
  CstepReportLeg,
  CstepAttachment,
  CstepSettlement,
  CstepSettlementLine,
  CstepPerDiemPolicy,
} from "../models/cstep/index.js";
import { CSTEP_EVENT_NATURES, type CstepFormType } from "../models/cstep/CstepTravelRequest.js";
import { CSTEP_SERVICE_TYPES, type CstepServiceType, type CstepRateSource } from "../models/cstep/CstepArrangement.js";
import type { CstepReportDirection, CstepReportPaidBy } from "../models/cstep/CstepReportLeg.js";
import type { CstepDocumentType } from "../models/cstep/CstepAttachment.js";
import type {
  CstepSettlementLineClassification,
  CstepSettlementLineSource,
} from "../models/cstep/CstepSettlementLine.js";
import TravellerProfile from "../models/TravellerProfile.js";
import { ownerId, isCstepAdmin, resolveOwnTravellerProfile } from "../utils/cstepAccess.js";
import {
  uploadCstepTourProposalPdf,
  type CstepApprovalTrailEntry,
  type CstepSettlementPdfData,
} from "../utils/cstepTourProposalPdf.js";
import { uploadCstepEventRequestPdf } from "../utils/cstepEventRequestPdf.js";
import { uploadCstepPacketPdf, type CstepPacketReportLeg } from "../utils/cstepPacketPdf.js";
import { presignGetObject } from "../utils/s3Presign.js";
import { uploadBufferToS3 } from "../utils/s3Upload.js";
import { getLiveRate } from "../utils/exchangeRate.js";
import { env } from "../config/env.js";

const router = Router();

// Step 4 — Travel Report leg attachment uploads (receipts/boarding passes).
// Same memoryStorage-then-S3 pattern as manualBookings.ts's attachmentUpload
// — reused verbatim, not reinvented.
const REPORT_ATTACHMENT_ALLOWED_MIME = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
const reportAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (REPORT_ATTACHMENT_ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
    cb(new Error("Only PDF, PNG, JPEG, or WEBP files are allowed."));
  },
});

// Best-effort mapping from a report leg's travelMode to CstepAttachment's
// required documentType — Step 4 has no separate document-type picker in
// the UI (the task only asks for a plain upload button), so this infers a
// reasonable value from the leg it's attached to.
const REPORT_DOCUMENT_TYPE_BY_MODE: Record<CstepServiceType, CstepDocumentType> = {
  FLIGHT: "ETICKET",
  HOTEL: "HOTEL_FOLIO",
  CAB: "CAB_RECEIPT",
  TRAIN: "ETICKET",
  BUS: "ETICKET",
  VISA: "OTHER",
  FOREX: "FOREX_RECEIPT",
  STATIONERY: "TAX_INVOICE",
  OTHER: "OTHER",
};

const TIME_BANDS = ["BEFORE_6AM", "6AM_12PM", "12PM_6PM", "AFTER_6PM"];
const MODES = ["AIR", "RAIL", "ROAD", "OTHER"];
const EDITABLE_STATUSES = new Set(["DRAFT", "RETURNED"]);
// Step 1 Polish (Part B) — an APPROVED trip is never silently cancellable
// here; that's later, separate work. DRAFT/SUBMITTED/RETURNED only.
const CANCELLABLE_STATUSES = new Set(["DRAFT", "SUBMITTED", "RETURNED"]);
const FORM_TYPES = new Set<CstepFormType>(["TOUR_PROPOSAL", "EVENT_REQUEST"]);

/** Resolves the formType for a create payload — defaults to TOUR_PROPOSAL
 * (existing/omitted clients keep behaving exactly as before Event Request
 * existed). Immutable after creation: this is only ever called from
 * POST /requests — pickFields() deliberately does NOT include formType, so
 * a PATCH body can never change it. */
function resolveFormType(body: any): CstepFormType {
  return FORM_TYPES.has(body?.formType) ? body.formType : "TOUR_PROPOSAL";
}

/**
 * Per-request approval authority: a CSTEP Admin (any request), or the
 * specific User this traveller has assigned as their Tour Approver (only
 * that traveller's requests). Replaces Phase 4's blanket
 * requireCstepApprover (any workspace leader could act on anything).
 */
async function callerCanActOnTraveller(req: any, travelerProfileId: any): Promise<boolean> {
  if (isCstepAdmin(req)) return true;
  const traveller: any = await TravellerProfile.findOne({
    _id: travelerProfileId,
    workspaceId: req.workspaceObjectId,
  })
    .select("tourApproverId")
    .lean();
  if (!traveller?.tourApproverId) return false;
  return String(traveller.tourApproverId) === ownerId(req);
}

/**
 * Step 3 — per-request ARRANGEMENT authority: a CSTEP Admin (any request),
 * or the specific User this traveller has assigned as their Official user
 * (TravellerProfile.officialUserId) — only that traveller's requests.
 * Mirrors callerCanActOnTraveller's exact shape, checking officialUserId
 * instead of tourApproverId — the Official's authority to open/edit the
 * arrangement stage is a separate concept from the Tour Approver's
 * authority to approve/return.
 */
async function callerCanArrangeForTraveller(req: any, travelerProfileId: any): Promise<boolean> {
  if (isCstepAdmin(req)) return true;
  const traveller: any = await TravellerProfile.findOne({
    _id: travelerProfileId,
    workspaceId: req.workspaceObjectId,
  })
    .select("officialUserId")
    .lean();
  if (!traveller?.officialUserId) return false;
  return String(traveller.officialUserId) === ownerId(req);
}

/** "<MM><YY>" for the current date, e.g. July 2026 -> "0726". Used only in
 * the TIN (claimReference); does not mint a new id — it reads the
 * traveller's existing TravellerProfile.travelerId code. */
function currentMMYY(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear() % 100).padStart(2, "0");
  return `${mm}${yy}`;
}

/** Thrown from inside an approve transaction to carry a specific HTTP status
 * out to the route handler's catch block, without being mistaken for a
 * retryable duplicate-key collision. */
class CstepHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Picks the TIN for this approval: "<base>" ("<travelerCode>/<MMYY>") if free,
 * else "<base>-2", "-3", ... — the first free suffix. `base` alone covers the
 * common single-trip-per-month case; a suffix only appears once a traveller
 * has a second trip approved in the same month. `attemptFloor` is the 1-based
 * retry-loop counter from the caller: on attempt 1 an unclaimed base is
 * returned as-is, but on any retry (attempt >= 2, meaning a duplicate-key
 * error already happened once) a suffix is always forced, and never below
 * attemptFloor — so each retry proposes a value strictly different from every
 * prior attempt, guaranteeing forward progress under a race even if this
 * transaction's snapshot can't yet see a concurrent winner's commit.
 */
async function nextClaimReference(
  workspaceId: any,
  travelerProfileId: any,
  base: string,
  session: any,
  attemptFloor: number,
): Promise<string> {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existing = await CstepClaim.find({
    workspaceId,
    travelerProfileId,
    claimReference: { $regex: `^${escaped}(-\\d+)?$` },
  })
    .select("claimReference")
    .session(session)
    .lean();

  let maxSuffix = 1;
  let baseTaken = false;
  for (const c of existing as any[]) {
    const ref = String(c.claimReference || "");
    if (ref === base) {
      baseTaken = true;
      continue;
    }
    const m = ref.match(/-(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > maxSuffix) maxSuffix = n;
    }
  }

  if (!baseTaken && attemptFloor <= 1) return base;

  const nextSuffix = Math.max(maxSuffix + 1, attemptFloor);
  return `${base}-${nextSuffix}`;
}

/** Load one request, workspace-scoped. */
async function loadRequest(req: any, id: string) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return CstepTravelRequest.findOne({
    _id: new mongoose.Types.ObjectId(id),
    workspaceId: req.workspaceObjectId,
  });
}

function isValidDateStr(s: any): boolean {
  return typeof s === "string" && s.trim() !== "" && !Number.isNaN(new Date(s).getTime());
}

/**
 * Manual per-field validation for a Tour Proposal create/update payload —
 * UNCHANGED from before Event Request existed. Returns an error string, or
 * null if the payload is valid. `type` and `travelerProfileId` are assumed
 * already resolved by the caller.
 */
function validateTourProposalPayload(body: any): string | null {
  const type = body?.type;
  if (type !== "DOMESTIC" && type !== "INTERNATIONAL") {
    return "type must be DOMESTIC or INTERNATIONAL";
  }

  const purpose = String(body?.purpose || "").trim();
  if (!purpose) return "purpose is required";

  if (!isValidDateStr(body?.departureDate)) return "departureDate is required";
  if (!isValidDateStr(body?.returnDate)) return "returnDate is required";
  if (new Date(body.returnDate).getTime() < new Date(body.departureDate).getTime()) {
    return "returnDate must be on or after departureDate";
  }

  if (body?.departureTimeBand && !TIME_BANDS.includes(body.departureTimeBand)) {
    return "departureTimeBand is invalid";
  }
  if (body?.returnTimeBand && !TIME_BANDS.includes(body.returnTimeBand)) {
    return "returnTimeBand is invalid";
  }

  if (Array.isArray(body?.modesRequested)) {
    for (const m of body.modesRequested) {
      if (!MODES.includes(m)) return "modesRequested contains an invalid mode";
    }
  }

  if (type === "INTERNATIONAL") {
    if (!Array.isArray(body?.countries) || body.countries.length === 0) {
      return "at least one country row is required for INTERNATIONAL requests";
    }
    if (!String(body?.justification || "").trim()) {
      return "justification is required for INTERNATIONAL requests";
    }
  } else {
    if (!Array.isArray(body?.stations) || body.stations.length === 0) {
      return "at least one station row is required for DOMESTIC requests";
    }
  }

  return null;
}

/**
 * Manual per-field validation for an Event Request create/update payload
 * (Event Request addition). Mirrors validateTourProposalPayload's rigor —
 * required-presence checks only, no cross-field "if X then Y required"
 * beyond what Tour Proposal already does (e.g. presentingPaperDetails and
 * eventNatureOther stay optional even when their flag is set, same
 * leniency as Tour Proposal's sponsoredDetails/modeOther).
 */
function validateEventRequestPayload(body: any): string | null {
  const purpose = String(body?.purpose || "").trim(); // "Title of the event"
  if (!purpose) return "Title of the event is required";

  if (!isValidDateStr(body?.departureDate)) return "Event start date is required";
  if (!isValidDateStr(body?.returnDate)) return "Event end date is required";
  if (new Date(body.returnDate).getTime() < new Date(body.departureDate).getTime()) {
    return "Event end date must be on or after the start date";
  }

  if (!String(body?.hostInstitution || "").trim()) {
    return "Host institution / organisation is required";
  }

  if (!CSTEP_EVENT_NATURES.includes(body?.eventNature)) {
    return "Nature of event is required";
  }

  if (!String(body?.eventLocation || "").trim()) return "Location of the event is required";

  const validParticipants = Array.isArray(body?.eventParticipants)
    ? body.eventParticipants.filter((p: any) => String(p?.organisation || "").trim())
    : [];
  if (validParticipants.length === 0) return "Add at least one participant row";

  return null;
}

/**
 * Manual validation dispatcher — routes to the Tour Proposal or Event
 * Request validator by formType. Every lifecycle route (submit/withdraw/
 * cancel/approve/return/amend) calls this ONE function; none of them know
 * or care which formType they're validating.
 */
function validatePayload(body: any): string | null {
  const formType = resolveFormType(body);
  return formType === "EVENT_REQUEST" ? validateEventRequestPayload(body) : validateTourProposalPayload(body);
}

/** Fields the request/update payload may set — everything except workspaceId,
 * createdBy, status, claimReference, formType, fundsConfirmedBy/At
 * (server-controlled). formType is deliberately NOT in this allowlist — it's
 * resolved once at creation (resolveFormType) and immutable thereafter; a
 * PATCH body can never change it since pickFields is a strict destructure. */
function pickFields(body: any) {
  const {
    travelerProfileId,
    type,
    purpose,
    project,
    projectDebitable,
    stations,
    countries,
    departureDate,
    departureTimeBand,
    returnDate,
    returnTimeBand,
    eventDates,
    modesRequested,
    modeOther,
    transportRequired,
    transportRequiredNote,
    accommodationRequired,
    accommodationRequiredNote,
    mealPreference,
    sponsored,
    sponsoredDetails,
    daysAbsent,
    advanceForex,
    sponsorshipInvitationAttached,
    justification,
    expectedOutcome,
    extendedBeyondDates,
    personalDays,
    contactWhileTravelling,
    otherInstructions,
    estimatedCost,
    roamingApproved,
    // Event Request addition — additive, undefined/ignored for Tour Proposal payloads.
    eventParticipants,
    hostInstitution,
    eventNature,
    eventNatureOther,
    eventLocation,
    eventVenue,
    registrationFee,
    presentingPaper,
    presentingPaperDetails,
    eventFundsAvailability,
    participantMeals,
  } = body || {};

  return {
    travelerProfileId,
    type,
    purpose,
    project,
    projectDebitable,
    stations,
    countries,
    departureDate,
    departureTimeBand,
    returnDate,
    returnTimeBand,
    eventDates,
    modesRequested,
    modeOther,
    transportRequired,
    transportRequiredNote,
    accommodationRequired,
    accommodationRequiredNote,
    mealPreference,
    sponsored,
    sponsoredDetails,
    daysAbsent,
    advanceForex,
    sponsorshipInvitationAttached,
    justification,
    expectedOutcome,
    extendedBeyondDates,
    personalDays,
    contactWhileTravelling,
    otherInstructions,
    estimatedCost,
    roamingApproved,
    eventParticipants,
    hostInstitution,
    eventNature,
    eventNatureOther,
    eventLocation,
    eventVenue,
    registrationFee,
    presentingPaper,
    presentingPaperDetails,
    eventFundsAvailability,
    participantMeals,
  };
}

/**
 * Step 3 — builds the REQUESTED CstepArrangement rows to seed when the
 * Official first opens a request for arranging. Purely a read-only mapping
 * off the traveller's own already-submitted fields — never mutates the
 * request. modesRequested/transportRequired/accommodationRequired are
 * shared fields present on BOTH Tour Proposal and Event Request documents,
 * so this needs no formType branching: Event Request's own form simply
 * never populates modesRequested/transportRequired, so those naturally
 * produce no rows for it, while accommodationRequired ("Travel &
 * accommodation support required" there) still seeds a Hotel row exactly
 * the same way.
 *
 * Mapping: modesRequested AIR -> Flight, RAIL -> Train, ROAD -> Bus,
 * OTHER -> Other (carrying modeOther as the detail); transportRequired
 * (a separate local-transport flag, not the main travel mode) -> Cab;
 * accommodationRequired -> Hotel. Each seeded row starts PENDING with
 * arrangedType defaulting to the same value as requestedType — the
 * Official can still change it (e.g. Flight requested, Train arranged).
 */
const MODE_TO_SERVICE_TYPE: Record<string, CstepServiceType> = {
  AIR: "FLIGHT",
  RAIL: "TRAIN",
  ROAD: "BUS",
  OTHER: "OTHER",
};

function buildSeedArrangementRows(doc: any): Array<{
  source: "REQUESTED";
  requestedType: CstepServiceType;
  arrangedType: CstepServiceType;
  details?: string;
  status: "PENDING";
}> {
  const rows: Array<{
    source: "REQUESTED";
    requestedType: CstepServiceType;
    arrangedType: CstepServiceType;
    details?: string;
    status: "PENDING";
  }> = [];

  for (const mode of doc.modesRequested || []) {
    const serviceType = MODE_TO_SERVICE_TYPE[mode];
    if (!serviceType) continue;
    rows.push({
      source: "REQUESTED",
      requestedType: serviceType,
      arrangedType: serviceType,
      details: mode === "OTHER" && doc.modeOther ? doc.modeOther : undefined,
      status: "PENDING",
    });
  }

  if (doc.transportRequired) {
    rows.push({
      source: "REQUESTED",
      requestedType: "CAB",
      arrangedType: "CAB",
      details: doc.transportRequiredNote || undefined,
      status: "PENDING",
    });
  }

  if (doc.accommodationRequired) {
    rows.push({
      source: "REQUESTED",
      requestedType: "HOTEL",
      arrangedType: "HOTEL",
      details: doc.accommodationRequiredNote || undefined,
      status: "PENDING",
    });
  }

  return rows;
}

/**
 * Step 4 — seeds ONWARD CstepReportLeg rows from the request's Step 3
 * CstepArrangement rows, when the traveller first starts their Travel
 * Report. Carries the arranged type/amount over as travelMode/fare;
 * paidBy defaults to "CSTEP" since the Official arranged (and CSTEP paid
 * for) these — the traveller can still edit every field afterwards, and
 * this never touches the CstepArrangement rows themselves. Only ever
 * called when no CstepReportLeg rows exist yet for this request (see
 * POST /requests/:id/report/start) — re-opening an in-progress report
 * never re-seeds and never duplicates rows.
 */
function buildSeedReportLegs(arrangements: any[]): Array<{
  direction: "ONWARD";
  travelMode: CstepServiceType;
  fare?: number;
  currency: string;
  paidBy: "CSTEP";
  remarks?: string;
  source: "SEEDED";
}> {
  return arrangements.map((a) => ({
    direction: "ONWARD" as const,
    travelMode: a.arrangedType,
    fare: a.amount,
    currency: a.currency || "INR",
    paidBy: "CSTEP" as const,
    remarks: a.details || undefined,
    source: "SEEDED" as const,
  }));
}

/**
 * Amount + currency addition — manual validation for an arrangement line's
 * money fields, shared by PATCH /requests/:id/arrangements/:lineId and
 * POST /requests/:id/arrangements. Only touches these fields at all when
 * the caller's body actually includes at least one of them (matching the
 * PATCH route's existing "only touch what was sent" discipline for
 * arrangedType/details/status) — so a plain type/details edit never
 * disturbs a previously-saved amount.
 *
 * For INR: rate is FORCED to 1 and amountInr = amount, regardless of what
 * (if anything) the client sent for exchangeRate/rateDate/rateSource —
 * those aren't meaningful for INR and are cleared.
 *
 * For a foreign currency: exchangeRate/rateDate/rateSource are taken as
 * sent. rateSource defaults to "MANUAL" if an exchangeRate is present but
 * no explicit source was given — this endpoint never assumes "LIVE" on its
 * own; only the frontend, after a successful GET /fx-rate call, tags a
 * rate LIVE. amountInr = amount × exchangeRate, computed HERE, once — this
 * is the freeze point; it is never recomputed on read even if live rates
 * move later.
 */
function computeArrangementAmountFields(body: any): {
  ok: boolean;
  error?: string;
  touched: boolean;
  fields: {
    currency?: string;
    amount?: number;
    exchangeRate?: number;
    rateDate?: string;
    rateSource?: CstepRateSource;
    amountInr?: number;
  };
} {
  const touched = ["currency", "amount", "exchangeRate", "rateDate", "rateSource"].some((k) => k in (body || {}));
  if (!touched) return { ok: true, touched: false, fields: {} };

  const currency = String(body.currency || "INR").trim().toUpperCase() || "INR";
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, error: "currency must be a 3-letter ISO code", touched: true, fields: {} };
  }

  let amount: number | undefined;
  if (body.amount !== undefined && body.amount !== null && body.amount !== "") {
    const n = Number(body.amount);
    if (!isFinite(n) || n < 0) {
      return { ok: false, error: "amount must be a non-negative number", touched: true, fields: {} };
    }
    amount = n;
  }

  if (currency === "INR") {
    return {
      ok: true,
      touched: true,
      fields: {
        currency: "INR",
        amount,
        exchangeRate: amount !== undefined ? 1 : undefined,
        rateDate: undefined,
        rateSource: undefined,
        amountInr: amount,
      },
    };
  }

  let exchangeRate: number | undefined;
  if (body.exchangeRate !== undefined && body.exchangeRate !== null && body.exchangeRate !== "") {
    const r = Number(body.exchangeRate);
    if (!isFinite(r) || r <= 0) {
      return { ok: false, error: "exchangeRate must be a positive number", touched: true, fields: {} };
    }
    exchangeRate = r;
  }

  let rateSource: CstepRateSource | undefined;
  if (body.rateSource !== undefined && body.rateSource !== null) {
    if (body.rateSource !== "LIVE" && body.rateSource !== "MANUAL") {
      return { ok: false, error: "rateSource must be LIVE or MANUAL", touched: true, fields: {} };
    }
    rateSource = body.rateSource;
  } else if (exchangeRate !== undefined) {
    rateSource = "MANUAL";
  }

  const rateDate =
    body.rateDate !== undefined && body.rateDate !== null
      ? String(body.rateDate).trim() || undefined
      : exchangeRate !== undefined
        ? new Date().toISOString().slice(0, 10)
        : undefined;

  const amountInr =
    amount !== undefined && exchangeRate !== undefined ? Math.round(amount * exchangeRate * 100) / 100 : undefined;

  return {
    ok: true,
    touched: true,
    fields: { currency, amount, exchangeRate, rateDate, rateSource, amountInr },
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * Step 5 — Office/Accounts settlement helpers. See CstepSettlement.ts /
 * CstepSettlementLine.ts for the data shape; the routes themselves are
 * further down (search "Step 5 — Office/Accounts settlement").
 * ───────────────────────────────────────────────────────────────────── */

/** Coarser grouping than CSTEP_SERVICE_TYPES — the five buckets the paper
 * form's "For Office (Accounts/Admin) purposes only" table has always had
 * (see utils/cstepTourProposalPdf.ts's drawOfficeExpenseTable). Per Diem has
 * no CstepServiceType equivalent — its bucket is populated directly from
 * settlement.perDiem.amountInr, never from a line's mode. */
const SETTLEMENT_BUCKET_BY_MODE: Record<CstepServiceType, "airRailBus" | "boardingLodging" | "cab" | "other"> = {
  FLIGHT: "airRailBus",
  TRAIN: "airRailBus",
  BUS: "airRailBus",
  HOTEL: "boardingLodging",
  CAB: "cab",
  VISA: "other",
  FOREX: "other",
  STATIONERY: "other",
  OTHER: "other",
};

/** Inclusive day count between two "YYYY-MM-DD" trip dates — e.g. departure
 * and return on the same day is 1 day, back-to-back days is 2. Returns 0 if
 * either date is missing/invalid (Event Requests / malformed data) — the
 * Official then enters days manually via the overrideDays perdiem PATCH. */
function computeTripDays(departureDate?: string, returnDate?: string): number {
  if (!departureDate || !returnDate) return 0;
  const d1 = new Date(departureDate).getTime();
  const d2 = new Date(returnDate).getTime();
  if (isNaN(d1) || isNaN(d2) || d2 < d1) return 0;
  return Math.round((d2 - d1) / 86400000) + 1;
}

/** Workspace's default per-diem rate for this request's trip type (and, for
 * INTERNATIONAL, its first listed country) — see CstepPerDiemPolicy.ts.
 * Returns null when no policy row exists; the Official then keys in a rate
 * manually via the perdiem PATCH (per the task's "else Admin enters"
 * fallback) rather than this route inventing a number. Not date-filtered
 * against effectiveFrom/To beyond preferring the most recent — a full
 * date-effective-range resolver is out of scope for this pass. */
async function findDefaultPerDiemRate(
  workspaceId: any,
  request: any,
): Promise<{ rate: number; currency: string } | null> {
  const tripType = request.type === "INTERNATIONAL" ? "INTERNATIONAL" : "DOMESTIC";
  const country = tripType === "INTERNATIONAL" ? request.countries?.[0]?.country : undefined;

  const query: any = { workspaceId, tripType };
  if (country) query.country = country;
  let policy: any = await CstepPerDiemPolicy.findOne(query).sort({ effectiveFrom: -1 }).lean();
  if (!policy && country) {
    policy = await CstepPerDiemPolicy.findOne({ workspaceId, tripType, country: { $exists: false } })
      .sort({ effectiveFrom: -1 })
      .lean();
  }
  return policy ? { rate: policy.rate, currency: policy.currency || "INR" } : null;
}

/** Buckets + totals are ALWAYS derived from the current CstepSettlementLine
 * rows + the per-diem amount — never free-typed — recomputed on every
 * settlement write (seed, line verify, per-diem change, finalize).
 * totalCostOfTour = every line (both classifications) + per diem.
 * amountClaimed = PERSONAL (reimbursable) lines + per diem owed to the
 * traveller. */
function recomputeSettlementTotals(
  lines: Array<{ mode: CstepServiceType; amountInr?: number; classification: CstepSettlementLineClassification }>,
  perDiemAmountInr: number,
): { buckets: { airRailBus: number; perDiem: number; boardingLodging: number; cab: number; other: number }; totalCostOfTour: number; amountClaimed: number } {
  const buckets = { airRailBus: 0, perDiem: Math.round(perDiemAmountInr * 100) / 100, boardingLodging: 0, cab: 0, other: 0 };
  let personalTotal = 0;
  for (const line of lines) {
    const bucket = SETTLEMENT_BUCKET_BY_MODE[line.mode] || "other";
    buckets[bucket] += line.amountInr || 0;
    if (line.classification === "PERSONAL") personalTotal += line.amountInr || 0;
  }
  buckets.airRailBus = Math.round(buckets.airRailBus * 100) / 100;
  buckets.boardingLodging = Math.round(buckets.boardingLodging * 100) / 100;
  buckets.cab = Math.round(buckets.cab * 100) / 100;
  buckets.other = Math.round(buckets.other * 100) / 100;

  const totalCostOfTour =
    Math.round((buckets.airRailBus + buckets.perDiem + buckets.boardingLodging + buckets.cab + buckets.other) * 100) / 100;
  const amountClaimed = Math.round((personalTotal + perDiemAmountInr) * 100) / 100;

  return { buckets, totalCostOfTour, amountClaimed };
}

/** Seeds CstepSettlementLine rows from BOTH streams, once, at
 * /settlement/start:
 *   - every Step 3 CstepArrangement row (CSTEP arranged/paid) -> OFFICIAL.
 *   - every Step 4 CstepReportLeg marked Self-paid -> PERSONAL (reimbursable).
 *   - a CSTEP-paid CstepReportLeg that the traveller ADDED themselves (no
 *     corresponding arrangement) -> OFFICIAL. A CSTEP-paid leg with
 *     source "SEEDED" is already represented by the arrangement it was
 *     seeded from, so it is deliberately NOT seeded again here — doing so
 *     would double-count the same expense under both streams.
 */
async function buildSeedSettlementLines(
  workspaceId: any,
  requestId: any,
): Promise<
  Array<{
    source: CstepSettlementLineSource;
    sourceId: any;
    description?: string;
    mode: CstepServiceType;
    amountInr: number;
    classification: CstepSettlementLineClassification;
    classificationOverridden: false;
    verified: false;
    attachmentId?: any;
  }>
> {
  const [arrangements, legs] = await Promise.all([
    CstepArrangement.find({ workspaceId, requestId }).lean(),
    CstepReportLeg.find({ workspaceId, requestId }).lean(),
  ]);

  const lines: Array<{
    source: CstepSettlementLineSource;
    sourceId: any;
    description?: string;
    mode: CstepServiceType;
    amountInr: number;
    classification: CstepSettlementLineClassification;
    classificationOverridden: false;
    verified: false;
    attachmentId?: any;
  }> = [];

  for (const a of arrangements as any[]) {
    lines.push({
      source: "ARRANGEMENT",
      sourceId: a._id,
      description: a.details || undefined,
      mode: a.arrangedType,
      amountInr: a.amountInr || 0,
      classification: "OFFICIAL",
      classificationOverridden: false,
      verified: false,
    });
  }

  for (const leg of legs as any[]) {
    if (leg.paidBy === "SELF") {
      lines.push({
        source: "REPORT_LEG",
        sourceId: leg._id,
        description: [leg.fromLocation, leg.toLocation].filter(Boolean).join(" → ") || leg.remarks || undefined,
        mode: leg.travelMode,
        amountInr: leg.fare || 0,
        classification: "PERSONAL",
        classificationOverridden: false,
        verified: false,
        attachmentId: leg.attachmentId,
      });
    } else if (leg.paidBy === "CSTEP" && leg.source === "ADDED") {
      lines.push({
        source: "REPORT_LEG",
        sourceId: leg._id,
        description: [leg.fromLocation, leg.toLocation].filter(Boolean).join(" → ") || leg.remarks || undefined,
        mode: leg.travelMode,
        amountInr: leg.fare || 0,
        classification: "OFFICIAL",
        classificationOverridden: false,
        verified: false,
        attachmentId: leg.attachmentId,
      });
    }
  }

  return lines;
}

/**
 * Self-filing "no traveller resolved" error, shared by POST /requests and
 * GET /my-traveller — distinguishes the ambiguous-email case (manual claim
 * needed to disambiguate) from the plain no-match case (not set up yet).
 */
function ownTravellerErrorMessage(status: "none" | "ambiguous"): string {
  return status === "ambiguous"
    ? "Your email matches more than one traveller profile in this workspace — ask an admin to resolve this, or claim your profile manually from My Tours."
    : "You don't have a linked traveller profile yet. Ask an admin to add you as a traveller, then claim it.";
}

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests — create a DRAFT or SUBMITTED CstepTravelRequest.
 *
 * Self-filing (Phase 5, server-enforced — NOT just a hidden UI field): a
 * normal (non-Admin) caller can only ever file for themselves. Any
 * travelerProfileId they send is IGNORED; the traveller is resolved via
 * resolveOwnTravellerProfile (Phase 6 — utils/cstepAccess.ts): an existing
 * claim first, else an unambiguous exact-email auto-link. Only a CSTEP
 * Admin may set travelerProfileId from the body, to file on behalf of
 * another traveller.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests", async (req: any, res: any) => {
  try {
    const uid = ownerId(req);
    if (!req.workspaceObjectId || !uid) {
      return res.status(400).json({ error: "Missing workspace or user context" });
    }

    const fields: any = pickFields(req.body);
    // Resolved server-side (defaults to TOUR_PROPOSAL) rather than trusted
    // from pickFields — formType is server-controlled and immutable once
    // set, same discipline as status/claimReference below.
    fields.formType = resolveFormType(req.body);
    const admin = isCstepAdmin(req);

    if (!admin) {
      const own = await resolveOwnTravellerProfile(req.workspaceObjectId, req.user);
      if (own.status !== "linked") {
        return res.status(400).json({ error: ownTravellerErrorMessage(own.status) });
      }
      fields.travelerProfileId = String(own.traveller._id);
    }

    if (!fields.travelerProfileId || !mongoose.Types.ObjectId.isValid(String(fields.travelerProfileId))) {
      return res.status(400).json({ error: "travelerProfileId is required" });
    }
    const traveller = await TravellerProfile.findOne({
      _id: new mongoose.Types.ObjectId(String(fields.travelerProfileId)),
      workspaceId: req.workspaceObjectId,
    });
    if (!traveller) {
      return res.status(400).json({ error: "travelerProfileId does not resolve to a traveller in this workspace" });
    }

    const validationError = validatePayload(fields);
    if (validationError) return res.status(400).json({ error: validationError });

    const status = req.body?.saveDraft === true ? "DRAFT" : "SUBMITTED";

    const doc = new CstepTravelRequest({
      ...fields,
      workspaceId: req.workspaceObjectId,
      createdBy: new mongoose.Types.ObjectId(uid),
      status,
    });
    await doc.save();

    res.status(201).json({ ok: true, request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to create travel request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /requests — the caller's own requests, most recent first.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/requests", async (req: any, res: any) => {
  try {
    const uid = ownerId(req);
    if (!req.workspaceObjectId || !uid) {
      return res.status(400).json({ error: "Missing workspace or user context" });
    }

    const docs = await CstepTravelRequest.find({
      workspaceId: req.workspaceObjectId,
      createdBy: new mongoose.Types.ObjectId(uid),
    })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ ok: true, requests: docs });
  } catch (err: any) {
    console.error("[CSTEP requests GET list]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to list travel requests" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /my-traveller — the caller's own TravellerProfile, resolved via
 * resolveOwnTravellerProfile (Phase 6): an existing claim first, else an
 * unambiguous exact-email auto-link (which this call may itself persist —
 * see that function's doc comment; a GET with an idempotent, one-time write
 * is intentional here, not a bug). Feeds the read-only self-filing identity
 * shown in NewTravelRequest.tsx for non-Admin callers.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/my-traveller", async (req: any, res: any) => {
  try {
    const uid = ownerId(req);
    if (!req.workspaceObjectId || !uid) {
      return res.status(400).json({ error: "Missing workspace or user context" });
    }
    const own = await resolveOwnTravellerProfile(req.workspaceObjectId, req.user);
    if (own.status !== "linked") {
      return res.json({ ok: true, traveller: null, ambiguous: own.status === "ambiguous" });
    }
    res.json({ ok: true, traveller: own.traveller.toObject(), ambiguous: false });
  } catch (err: any) {
    console.error("[CSTEP my-traveller GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load your traveller profile" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /requests/:id — one, workspace-scoped. Includes canApprove/isAdmin so
 * the frontend detail view can gate Approve/Return without re-deriving the
 * Tour-Approver-assignment lookup itself. Step 3 addition: also includes
 * canArrange (this caller's authority over the arrangement stage right
 * now — true for APPROVED, so the frontend's auto-open effect knows it may
 * fire start-arranging, same as canApprove/SUBMITTED already does for
 * start-review; ALSO true for ARRANGING, so it can gate the actual line-
 * editing controls once opened) and the request's own CstepArrangement
 * rows — a SEPARATE record, never merged into or overwriting the request
 * document itself. Readable by anyone who can already load this request
 * (same posture as before — this route has never restricted reads to the
 * owner/approver only), so the traveller sees their own arrangements here
 * too, once made.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/requests/:id", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });

    const admin = isCstepAdmin(req);
    const canApprove =
      doc.status === "SUBMITTED" && (admin || (await callerCanActOnTraveller(req, doc.travelerProfileId)));
    const canArrange =
      (doc.status === "APPROVED" || doc.status === "ARRANGING") &&
      (admin || (await callerCanArrangeForTraveller(req, doc.travelerProfileId)));
    // Step 5 — same authority as canArrange (callerCanArrangeForTraveller):
    // the Official who arranges services also settles accounts. Covers both
    // "may open the settlement card" and "may act on it while VERIFYING" —
    // the frontend narrows further using the settlement's own status once
    // it's fetched via GET /settlement, same pattern as canArrange narrowing
    // via request.status === "ARRANGING".
    const canSettle =
      (doc.status === "REPORT_SUBMITTED" || doc.status === "TRANSFERRED_TO_FINANCE" || doc.status === "SETTLED") &&
      (admin || (await callerCanArrangeForTraveller(req, doc.travelerProfileId)));

    const arrangements = await CstepArrangement.find({
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
    })
      .sort({ createdAt: 1 })
      .lean();

    res.json({ ok: true, request: doc.toObject(), canApprove, isAdmin: admin, canArrange, canSettle, arrangements });
  } catch (err: any) {
    console.error("[CSTEP requests GET one]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load travel request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /requests/:id — update, only while DRAFT or RETURNED, owner-only.
 * Field edits ONLY — does not change status. To submit, call
 * POST /requests/:id/submit. Every successful edit is logged as one
 * CstepAmendment per changed field (append-only; "at minimum a record that
 * an edit occurred, with actor + timestamp").
 * ───────────────────────────────────────────────────────────────────── */
router.patch("/requests/:id", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });

    const uid = ownerId(req);
    if (String(doc.createdBy) !== uid) {
      return res.status(403).json({ error: "Only the creator can edit this travel request" });
    }
    if (!EDITABLE_STATUSES.has(doc.status)) {
      return res.status(409).json({ error: "Only draft or returned travel requests can be edited" });
    }

    const fields = pickFields(req.body);

    // Self-filing (Phase 5): a normal caller cannot redirect their own
    // request onto a different traveller by editing it, any more than they
    // could at create time — only a CSTEP Admin may change travelerProfileId.
    if (!isCstepAdmin(req)) {
      delete (fields as any).travelerProfileId;
    } else if (fields.travelerProfileId !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(String(fields.travelerProfileId))) {
        return res.status(400).json({ error: "travelerProfileId is invalid" });
      }
      const traveller = await TravellerProfile.findOne({
        _id: new mongoose.Types.ObjectId(String(fields.travelerProfileId)),
        workspaceId: req.workspaceObjectId,
      });
      if (!traveller) {
        return res.status(400).json({ error: "travelerProfileId does not resolve to a traveller in this workspace" });
      }
    }

    const before: any = doc.toObject();

    // Merge onto the existing doc so validation sees the full, post-update shape.
    const merged: any = { ...before, ...fields };
    Object.keys(fields).forEach((k) => {
      if ((fields as any)[k] !== undefined) (doc as any)[k] = (fields as any)[k];
    });

    const validationError = validatePayload(merged);
    if (validationError) return res.status(400).json({ error: validationError });

    await doc.save();

    const changedFields = Object.keys(fields).filter((k) => {
      if ((fields as any)[k] === undefined) return false;
      return JSON.stringify(before[k]) !== JSON.stringify((fields as any)[k]);
    });
    if (changedFields.length > 0) {
      const changedAt = new Date().toISOString();
      await CstepAmendment.insertMany(
        changedFields.map((field) => ({
          workspaceId: req.workspaceObjectId,
          requestId: doc._id,
          field,
          oldValue: before[field],
          newValue: (fields as any)[field],
          changedBy: new mongoose.Types.ObjectId(uid),
          changedAt,
          reason: "Traveller edit",
        })),
      );
    }

    res.json({ ok: true, request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update travel request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/withdraw — owner-only, SUBMITTED → DRAFT. Blocked once
 * an approver has started reviewing (a logged START_REVIEW entry exists for
 * this request — see /requests/:id/start-review below).
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests/:id/withdraw", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });

    const uid = ownerId(req);
    if (String(doc.createdBy) !== uid) {
      return res.status(403).json({ error: "Only the creator can withdraw this travel request" });
    }
    if (doc.status !== "SUBMITTED") {
      return res.status(409).json({ error: "Only a submitted travel request can be withdrawn" });
    }

    const started = await CstepApproval.exists({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      action: "START_REVIEW",
    });
    if (started) {
      return res
        .status(409)
        .json({ error: "An approver has already started reviewing this request — it can no longer be withdrawn" });
    }

    doc.status = "DRAFT";
    await doc.save();

    await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "TRAVELER",
      actor: new mongoose.Types.ObjectId(uid),
      action: "WITHDRAW",
      at: new Date().toISOString(),
    });

    res.json({ ok: true, request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests withdraw]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to withdraw travel request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/cancel — owner-only or CSTEP Admin. Allowed from DRAFT,
 * SUBMITTED, or RETURNED — never from APPROVED (an approved trip can't be
 * silently cancelled here; that's later, separate work). The proposal is
 * NOT deleted — it stays visible in My Tours with a CANCELLED status for
 * the record. Logs a CANCEL entry (append-only), reason optional.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests/:id/cancel", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });

    const uid = ownerId(req);
    const isOwner = String(doc.createdBy) === uid;
    const admin = isCstepAdmin(req);
    if (!isOwner && !admin) {
      return res.status(403).json({ error: "Only the creator or a CSTEP Admin can cancel this travel request" });
    }
    if (!CANCELLABLE_STATUSES.has(doc.status)) {
      return res.status(409).json({ error: "Only a draft, submitted, or returned travel request can be cancelled" });
    }

    doc.status = "CANCELLED";
    await doc.save();

    const reason = String(req.body?.reason || "").trim();
    await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: isOwner ? "TRAVELER" : "APPROVER",
      actor: new mongoose.Types.ObjectId(uid),
      action: "CANCEL",
      ...(reason ? { comment: reason } : {}),
      at: new Date().toISOString(),
    });

    res.json({ ok: true, request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests cancel]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to cancel travel request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/submit — owner-only, DRAFT/RETURNED → SUBMITTED. Logs
 * SUBMIT on first submission, RESUBMIT on every submission thereafter.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests/:id/submit", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });

    const uid = ownerId(req);
    if (String(doc.createdBy) !== uid) {
      return res.status(403).json({ error: "Only the creator can submit this travel request" });
    }
    if (!EDITABLE_STATUSES.has(doc.status)) {
      return res.status(409).json({ error: "Only a draft or returned travel request can be submitted" });
    }

    const validationError = validatePayload(doc.toObject());
    if (validationError) return res.status(400).json({ error: validationError });

    const hasPriorSubmit = await CstepApproval.exists({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      action: { $in: ["SUBMIT", "RESUBMIT"] },
    });

    doc.status = "SUBMITTED";
    await doc.save();

    await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "TRAVELER",
      actor: new mongoose.Types.ObjectId(uid),
      action: hasPriorSubmit ? "RESUBMIT" : "SUBMIT",
      at: new Date().toISOString(),
    });

    res.json({ ok: true, request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests submit]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to submit travel request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /approvals — the approver queue: SUBMITTED requests in this
 * workspace, tenant-scoped. A CSTEP Admin sees every submitted request; a
 * Tour Approver sees only requests for travellers who have them set as
 * tourApproverId. Anyone else gets an empty queue (not a 403 — the same
 * route works for "am I anyone's approver right now", answer: no).
 *
 * A traveller with no tourApproverId is NEVER blocked from submitting (see
 * POST /requests/:id/submit — no approver check there at all); their
 * proposal just doesn't route to any specific Tour Approver's queue. For an
 * Admin caller, each such row is flagged unassigned: true so the queue can
 * group/highlight it (mirrors the Expense module's "no manager set"
 * warning — see ApprovalsQueue.tsx). Non-Admin approvers never see this
 * flag — their query is already scoped to only their own assigned
 * travellers, so "unassigned" isn't a concept that applies to their view.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/approvals", async (req: any, res: any) => {
  try {
    const admin = isCstepAdmin(req);
    const filter: any = { workspaceId: req.workspaceObjectId, status: "SUBMITTED" };

    if (!admin) {
      const uid = ownerId(req);
      const myTravellers = await TravellerProfile.find({
        workspaceId: req.workspaceObjectId,
        tourApproverId: new mongoose.Types.ObjectId(uid),
      })
        .select("_id")
        .lean();
      if (myTravellers.length === 0) {
        return res.json({ ok: true, requests: [], unassignedCount: 0 });
      }
      filter.travelerProfileId = { $in: myTravellers.map((t: any) => t._id) };
    }

    const docs = await CstepTravelRequest.find(filter).sort({ createdAt: 1 }).lean();

    if (!admin) {
      return res.json({ ok: true, requests: docs, unassignedCount: 0 });
    }

    const travelerIds = [...new Set(docs.map((d: any) => String(d.travelerProfileId)))];
    const travellers = await TravellerProfile.find({
      _id: { $in: travelerIds },
      workspaceId: req.workspaceObjectId,
    })
      .select("_id tourApproverId")
      .lean();
    const withApprover = new Set(
      (travellers as any[]).filter((t) => t.tourApproverId).map((t) => String(t._id)),
    );
    const flagged = docs.map((d: any) => ({
      ...d,
      unassigned: !withApprover.has(String(d.travelerProfileId)),
    }));

    res.json({
      ok: true,
      requests: flagged,
      unassignedCount: flagged.filter((d: any) => d.unassigned).length,
    });
  } catch (err: any) {
    console.error("[CSTEP approvals GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to list approvals" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /my-roles — lightweight role summary for the CSTEP mapping addition
 * (Traveller → Approver → Official user → Finance user). Tells the
 * frontend which of the Approvals/Processing/Finance queue tabs to show,
 * and whether to surface a "go to your queue" link from My Tours — never
 * used for actual authorization; GET /approvals, /official-queue, and
 * /finance-queue each independently re-derive their own tenant-scoped
 * filter regardless of what this route reports.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/my-roles", async (req: any, res: any) => {
  try {
    if (isCstepAdmin(req)) {
      return res.json({ ok: true, isAdmin: true, isApprover: true, isOfficial: true, isFinance: true });
    }

    const uid = new mongoose.Types.ObjectId(ownerId(req));
    const [isApprover, isOfficial, isFinance] = await Promise.all([
      TravellerProfile.exists({ workspaceId: req.workspaceObjectId, tourApproverId: uid }),
      TravellerProfile.exists({ workspaceId: req.workspaceObjectId, officialUserId: uid }),
      TravellerProfile.exists({ workspaceId: req.workspaceObjectId, financeUserId: uid }),
    ]);

    res.json({
      ok: true,
      isAdmin: false,
      isApprover: !!isApprover,
      isOfficial: !!isOfficial,
      isFinance: !!isFinance,
    });
  } catch (err: any) {
    console.error("[CSTEP my-roles GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load your CSTEP roles" });
  }
});

// Processing-queue 6-stage addition — every status the Official/Admin's
// Processing board can show a case at, in pipeline order. A case is in
// exactly one of these at any time, so nothing "vanishes" between them —
// widened from the old APPROVED/ARRANGING-only filter, which dropped a
// case the moment it reached ARRANGED (Step 3 done) or REPORT_SUBMITTED
// (Step 4 done), even though the Official/Admin still needed to see it.
const OFFICIAL_QUEUE_STAGES = [
  "APPROVED",
  "ARRANGING",
  "ARRANGED",
  "REPORT_PENDING",
  "REPORT_SUBMITTED",
  "TRANSFERRED_TO_FINANCE",
  "SETTLED",
] as const;

/* ─────────────────────────────────────────────────────────────────────
 * GET /official-queue — the Official user's queue (CSTEP mapping addition):
 * requests for travellers who have this caller set as officialUserId,
 * across all 6 Processing-board stages (see OFFICIAL_QUEUE_STAGES) — every
 * case from "Tour Request" (APPROVED) through "Transferred to Finance".
 * The frontend groups `requests` into its 6 sub-tabs by `status`;
 * `stageCounts` gives it the per-tab count directly without recomputing it
 * from the full list. Same tenant-scoped shape as GET /approvals
 * (mapped-user field + status set), just a different slot. A CSTEP Admin
 * sees every request at any of these 6 statuses, unchanged from how Admin
 * already sees everything elsewhere in this module. Anyone else with no
 * travellers mapped to them gets an empty queue, not a 403 — same posture
 * as /approvals.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/official-queue", async (req: any, res: any) => {
  try {
    const admin = isCstepAdmin(req);
    const filter: any = { workspaceId: req.workspaceObjectId, status: { $in: OFFICIAL_QUEUE_STAGES } };
    const emptyStageCounts = Object.fromEntries(OFFICIAL_QUEUE_STAGES.map((s) => [s, 0]));

    if (!admin) {
      const uid = ownerId(req);
      const myTravellers = await TravellerProfile.find({
        workspaceId: req.workspaceObjectId,
        officialUserId: new mongoose.Types.ObjectId(uid),
      })
        .select("_id")
        .lean();
      if (myTravellers.length === 0) {
        return res.json({ ok: true, requests: [], stageCounts: emptyStageCounts });
      }
      filter.travelerProfileId = { $in: myTravellers.map((t: any) => t._id) };
    }

    const docs = await CstepTravelRequest.find(filter).sort({ updatedAt: -1 }).lean();
    const stageCounts: Record<string, number> = { ...emptyStageCounts };
    for (const d of docs as any[]) {
      if (stageCounts[d.status] !== undefined) stageCounts[d.status]++;
    }

    res.json({ ok: true, requests: docs, stageCounts });
  } catch (err: any) {
    console.error("[CSTEP official-queue GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to list the processing queue" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /finance-queue — the Finance user's queue (CSTEP mapping addition):
 * same shape as GET /official-queue, financeUserId slot instead. The
 * request-status schema has no separate "processing"/"finance" pipeline
 * stage yet (see module note) — both Official and Finance queues currently
 * filter on the same APPROVED status, scoped to each caller's own mapped
 * travellers; they're two different people's views into the same event,
 * not two different statuses. Splitting APPROVED into finer stages is
 * later, separate work — this route only adds a read filter, it does not
 * change status/approve/audit logic.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/finance-queue", async (req: any, res: any) => {
  try {
    const admin = isCstepAdmin(req);
    const filter: any = { workspaceId: req.workspaceObjectId, status: "APPROVED" };

    if (!admin) {
      const uid = ownerId(req);
      const myTravellers = await TravellerProfile.find({
        workspaceId: req.workspaceObjectId,
        financeUserId: new mongoose.Types.ObjectId(uid),
      })
        .select("_id")
        .lean();
      if (myTravellers.length === 0) {
        return res.json({ ok: true, requests: [] });
      }
      filter.travelerProfileId = { $in: myTravellers.map((t: any) => t._id) };
    }

    const docs = await CstepTravelRequest.find(filter).sort({ updatedAt: -1 }).lean();
    res.json({ ok: true, requests: docs });
  } catch (err: any) {
    console.error("[CSTEP finance-queue GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to list the finance queue" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/start-review — marks that an approver has opened this
 * request. Idempotent: the first call logs START_REVIEW, later calls are a
 * no-op success. This log entry IS the "approver has started" signal that
 * disables traveller Withdraw above.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests/:id/start-review", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!(await callerCanActOnTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Tour Approver or a CSTEP Admin can perform this action" });
    }
    if (doc.status !== "SUBMITTED") {
      return res.status(409).json({ error: "Only a submitted travel request can be reviewed" });
    }

    const already = await CstepApproval.exists({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      action: "START_REVIEW",
    });

    if (!already) {
      await CstepApproval.create({
        workspaceId: req.workspaceObjectId,
        entityType: "REQUEST",
        entityId: doc._id,
        stage: "APPROVER",
        actor: new mongoose.Types.ObjectId(ownerId(req)),
        action: "START_REVIEW",
        at: new Date().toISOString(),
      });
    }

    res.json({ ok: true, alreadyStarted: !!already });
  } catch (err: any) {
    console.error("[CSTEP requests start-review]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to start review" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/approve — approver-only, SUBMITTED → APPROVED.
 *
 * TOUR_PROPOSAL: issues the TIN (claimReference = "<travelerCode>/<MMYY>",
 * reading the traveller's EXISTING TravellerProfile.travelerId — no new id
 * minted) and opens the claim file (CstepClaim, status CLAIM_IN_PROGRESS).
 *
 * EVENT_REQUEST (Event Request addition): status transition ONLY — no TIN,
 * no CstepClaim. An approved event goes to fulfilment, not personal
 * settlement, so there's nothing to claim against. Everything else
 * (permission check, audit entry, response shape) is identical.
 *
 * The base TIN is per traveller+month, so a traveller with a SECOND trip
 * approved in the same month would collide on CstepClaim's unique
 * {workspaceId, claimReference} index. Handled by nextClaimReference (a
 * "-2", "-3", ... suffix on collision) computed and written inside one
 * transaction, with an outer retry loop that catches a duplicate-key error
 * from a near-simultaneous approval and retries with the next suffix instead
 * of failing the request. (Event Request never hits this path — no unique
 * key involved — so its single pass through the loop always breaks on
 * attempt 1.)
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests/:id/approve", async (req: any, res: any) => {
  const session = await mongoose.startSession();
  const MAX_ATTEMPTS = 10;
  let responseRequest: any = null;
  let responseClaim: any = null;
  let claimReference = "";

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await session.withTransaction(async () => {
          const doc = await CstepTravelRequest.findOne({
            _id: new mongoose.Types.ObjectId(req.params.id),
            workspaceId: req.workspaceObjectId,
          }).session(session);
          if (!doc) throw new CstepHttpError(404, "Travel request not found");
          if (!(await callerCanActOnTraveller(req, doc.travelerProfileId))) {
            throw new CstepHttpError(403, "Only this traveller's Tour Approver or a CSTEP Admin can perform this action");
          }
          if (doc.status !== "SUBMITTED") {
            throw new CstepHttpError(409, "Only a submitted travel request can be approved");
          }

          const uid = ownerId(req);

          if (doc.formType === "EVENT_REQUEST") {
            doc.status = "APPROVED";
            await doc.save({ session });

            const approval = new CstepApproval({
              workspaceId: req.workspaceObjectId,
              entityType: "REQUEST",
              entityId: doc._id,
              stage: "APPROVER",
              actor: new mongoose.Types.ObjectId(uid),
              action: "APPROVE",
              at: new Date().toISOString(),
            });
            await approval.save({ session });

            responseRequest = doc.toObject();
            responseClaim = null;
            claimReference = "";
            return;
          }

          const traveller: any = await TravellerProfile.findOne({
            _id: doc.travelerProfileId,
            workspaceId: req.workspaceObjectId,
          })
            .session(session)
            .lean();
          if (!traveller || !traveller.travelerId) {
            throw new CstepHttpError(400, "Traveller code could not be resolved for this request");
          }

          const base = `${traveller.travelerId}/${currentMMYY()}`;
          const ref = await nextClaimReference(req.workspaceObjectId, doc.travelerProfileId, base, session, attempt);

          doc.status = "APPROVED";
          doc.claimReference = ref;
          await doc.save({ session });

          const claim = new CstepClaim({
            workspaceId: req.workspaceObjectId,
            travelerProfileId: doc.travelerProfileId,
            travelRequestId: doc._id,
            claimReference: ref,
            type: doc.type,
            status: "CLAIM_IN_PROGRESS",
            createdBy: new mongoose.Types.ObjectId(uid),
          });
          await claim.save({ session });

          const approval = new CstepApproval({
            workspaceId: req.workspaceObjectId,
            entityType: "REQUEST",
            entityId: doc._id,
            stage: "APPROVER",
            actor: new mongoose.Types.ObjectId(uid),
            action: "APPROVE",
            at: new Date().toISOString(),
          });
          await approval.save({ session });

          claimReference = ref;
          responseRequest = doc.toObject();
          responseClaim = claim.toObject();
        });

        break; // transaction committed — done
      } catch (err: any) {
        if (err instanceof CstepHttpError) throw err;
        const isDupKey = err?.code === 11000 || /E11000/.test(String(err?.message || ""));
        if (!isDupKey || attempt === MAX_ATTEMPTS) throw err;
        // Another approval just took this reference — loop again;
        // nextClaimReference will see it and propose the next suffix.
      }
    }

    res.json({ ok: true, request: responseRequest, claim: responseClaim, claimReference });
  } catch (err: any) {
    if (err instanceof CstepHttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("[CSTEP requests approve]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to approve travel request" });
  } finally {
    session.endSession();
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/return — approver-only, SUBMITTED → RETURNED. reason
 * is mandatory.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests/:id/return", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!(await callerCanActOnTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Tour Approver or a CSTEP Admin can perform this action" });
    }
    if (doc.status !== "SUBMITTED") {
      return res.status(409).json({ error: "Only a submitted travel request can be returned" });
    }

    const reason = String(req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({ error: "reason is required" });

    doc.status = "RETURNED";
    await doc.save();

    await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "APPROVER",
      actor: new mongoose.Types.ObjectId(ownerId(req)),
      action: "RETURN",
      comment: reason,
      at: new Date().toISOString(),
    });

    res.json({ ok: true, request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests return]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to return travel request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * Step 3 — Arrangement stage. After APPROVED, the request moves through
 * ARRANGING (Official arranging requirements) to ARRANGED (done, awaiting
 * the traveller's post-trip report — Step 4, later). The traveller's
 * original CstepTravelRequest is NEVER overwritten by any of this — every
 * route below only ever reads it and writes to the separate
 * CstepArrangement collection alongside it.
 * ───────────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────────
 * GET /fx-rate?base=USD&quote=INR — live exchange-rate PRE-FILL for the
 * arrangement Amount column. Auth + workspace scoped (mounted under the
 * same authenticated router as the rest of this file) but not otherwise
 * gated to CSTEP Admin/Official — any signed-in caller editing an
 * arrangement row may look up a rate. Never fails hard: on any error
 * (missing key, network, rate-limit, malformed response) responds with
 * { ok: true, rate: null } so the frontend always falls back to manual
 * entry instead of blocking arranging.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/fx-rate", async (req: any, res: any) => {
  try {
    const base = String(req.query?.base || "").trim().toUpperCase();
    const quote = String(req.query?.quote || "INR").trim().toUpperCase();
    if (!base) return res.status(400).json({ error: "base is required" });

    const result = await getLiveRate(base, quote);
    if (!result) return res.json({ ok: true, rate: null });

    res.json({ ok: true, rate: result.rate, date: result.date, source: "LIVE" });
  } catch (err: any) {
    console.error("[CSTEP fx-rate GET]", err?.message);
    res.json({ ok: true, rate: null });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/start-arranging — Official/Admin opens an APPROVED
 * request for arranging: APPROVED -> ARRANGING, seeds the REQUESTED
 * arrangement rows if not already seeded, logs START_ARRANGING. Idempotent
 * like start-review: re-opening an already-ARRANGING request is a no-op on
 * both the status transition and the audit log (seeding is checked
 * separately and also never repeats), so this can be folded into "first
 * open" the same way start-review is.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests/:id/start-arranging", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!(await callerCanArrangeForTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Official user or a CSTEP Admin can perform this action" });
    }
    if (doc.status !== "APPROVED" && doc.status !== "ARRANGING") {
      return res.status(409).json({ error: "Only an approved (or already-arranging) travel request can be opened for arranging" });
    }

    const uid = ownerId(req);

    if (doc.status === "APPROVED") {
      doc.status = "ARRANGING";
      await doc.save();

      await CstepApproval.create({
        workspaceId: req.workspaceObjectId,
        entityType: "REQUEST",
        entityId: doc._id,
        stage: "OFFICIAL",
        actor: new mongoose.Types.ObjectId(uid),
        action: "START_ARRANGING",
        at: new Date().toISOString(),
      });
    }

    const alreadySeeded = await CstepArrangement.exists({
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
    });
    if (!alreadySeeded) {
      const seedRows = buildSeedArrangementRows(doc);
      if (seedRows.length > 0) {
        await CstepArrangement.insertMany(
          seedRows.map((row) => ({
            ...row,
            workspaceId: req.workspaceObjectId,
            requestId: doc._id,
            createdBy: new mongoose.Types.ObjectId(uid),
          })),
        );
      }
    }

    const arrangements = await CstepArrangement.find({
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
    })
      .sort({ createdAt: 1 })
      .lean();

    res.json({ ok: true, request: doc.toObject(), arrangements });
  } catch (err: any) {
    console.error("[CSTEP requests start-arranging]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to start arranging travel request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /requests/:id/arrangements/:lineId — Official/Admin sets a service
 * line's arrangedType (may differ from requestedType — that original value
 * is never changed) and/or details, and/or marks it ARRANGED/PENDING. Logs
 * ARRANGE_SERVICE with the before/after (requested vs arranged) so the
 * change is auditable. Only while the request is ARRANGING.
 * ───────────────────────────────────────────────────────────────────── */
router.patch("/requests/:id/arrangements/:lineId", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!(await callerCanArrangeForTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Official user or a CSTEP Admin can perform this action" });
    }
    if (doc.status !== "ARRANGING") {
      return res.status(409).json({ error: "Only a request currently being arranged can have its service lines updated" });
    }

    if (!mongoose.Types.ObjectId.isValid(req.params.lineId)) {
      return res.status(400).json({ error: "Invalid arrangement line id" });
    }
    const line = await CstepArrangement.findOne({
      _id: req.params.lineId,
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
    });
    if (!line) return res.status(404).json({ error: "Arrangement line not found" });

    const before = { arrangedType: line.arrangedType, details: line.details, status: line.status };
    const body = req.body || {};

    if ("arrangedType" in body) {
      if (!CSTEP_SERVICE_TYPES.includes(body.arrangedType)) {
        return res.status(400).json({ error: "arrangedType is not a recognized service type" });
      }
      line.arrangedType = body.arrangedType;
    }
    if ("details" in body) {
      line.details = String(body.details || "").trim() || undefined;
    }
    if ("status" in body) {
      if (body.status !== "PENDING" && body.status !== "ARRANGED") {
        return res.status(400).json({ error: "status must be PENDING or ARRANGED" });
      }
      line.status = body.status;
      if (body.status === "ARRANGED") {
        line.arrangedBy = new mongoose.Types.ObjectId(ownerId(req));
        line.arrangedAt = new Date();
      } else {
        line.arrangedBy = undefined;
        line.arrangedAt = undefined;
      }
    }

    // Amount + currency addition — only touches these fields when the
    // caller's body actually included at least one of them; frozen here,
    // never recomputed on read.
    const amountResult = computeArrangementAmountFields(body);
    if (!amountResult.ok) return res.status(400).json({ error: amountResult.error });
    if (amountResult.touched) {
      line.currency = amountResult.fields.currency;
      line.amount = amountResult.fields.amount;
      line.exchangeRate = amountResult.fields.exchangeRate;
      line.rateDate = amountResult.fields.rateDate;
      line.rateSource = amountResult.fields.rateSource;
      line.amountInr = amountResult.fields.amountInr;
    }

    await line.save();

    const requestedLabel = line.requestedType || "(added, no original request)";
    const amountLabel = amountResult.touched
      ? line.amount !== undefined
        ? ` | Amount: ${line.amount} ${line.currency}${line.amountInr !== undefined ? ` (₹${line.amountInr})` : ""}`
        : " | Amount: cleared"
      : "";
    await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "OFFICIAL",
      actor: new mongoose.Types.ObjectId(ownerId(req)),
      action: "ARRANGE_SERVICE",
      comment:
        `Requested: ${requestedLabel} -> Arranged: ${before.arrangedType} => ${line.arrangedType}` +
        (line.details ? ` — ${line.details}` : "") +
        ` [${line.status}]` +
        amountLabel,
      at: new Date().toISOString(),
    });

    res.json({ ok: true, line: line.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests arrangements PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update arrangement line" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/arrangements — Official/Admin adds a new ADDED
 * service line (not on the traveller's original form — Forex, Stationery,
 * etc.). Logs ADD_SERVICE. Only while the request is ARRANGING.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests/:id/arrangements", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!(await callerCanArrangeForTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Official user or a CSTEP Admin can perform this action" });
    }
    if (doc.status !== "ARRANGING") {
      return res.status(409).json({ error: "Only a request currently being arranged can have services added" });
    }

    const arrangedType = req.body?.arrangedType;
    if (!CSTEP_SERVICE_TYPES.includes(arrangedType)) {
      return res.status(400).json({ error: "arrangedType is required and must be a recognized service type" });
    }
    const details = String(req.body?.details || "").trim();
    const uid = ownerId(req);

    const amountResult = computeArrangementAmountFields(req.body || {});
    if (!amountResult.ok) return res.status(400).json({ error: amountResult.error });

    const line = await CstepArrangement.create({
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
      source: "ADDED",
      arrangedType,
      details: details || undefined,
      status: "PENDING",
      createdBy: new mongoose.Types.ObjectId(uid),
      ...(amountResult.touched ? amountResult.fields : {}),
    });

    const amountLabel =
      amountResult.touched && amountResult.fields.amount !== undefined
        ? ` | Amount: ${amountResult.fields.amount} ${amountResult.fields.currency}${
            amountResult.fields.amountInr !== undefined ? ` (₹${amountResult.fields.amountInr})` : ""
          }`
        : "";
    await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "OFFICIAL",
      actor: new mongoose.Types.ObjectId(uid),
      action: "ADD_SERVICE",
      comment: `Added ${arrangedType}${details ? ` — ${details}` : ""}` + amountLabel,
      at: new Date().toISOString(),
    });

    res.status(201).json({ ok: true, line: line.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests arrangements POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to add arrangement line" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/mark-arranged — Official/Admin marks the whole
 * request arranged: ARRANGING -> ARRANGED. Logs MARK_ARRANGED. Does NOT
 * hard-block on incomplete lines (still PENDING) — the Official's
 * judgement call, matching the spec.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests/:id/mark-arranged", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!(await callerCanArrangeForTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Official user or a CSTEP Admin can perform this action" });
    }
    if (doc.status !== "ARRANGING") {
      return res.status(409).json({ error: "Only a request currently being arranged can be marked arranged" });
    }

    doc.status = "ARRANGED";
    await doc.save();

    await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "OFFICIAL",
      actor: new mongoose.Types.ObjectId(ownerId(req)),
      action: "MARK_ARRANGED",
      at: new Date().toISOString(),
    });

    res.json({ ok: true, request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests mark-arranged]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to mark travel request arranged" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * Step 4 — Travel Report. After ARRANGED, the traveller (the request's
 * creator) files their own post-trip itinerary: an Onward and a Return
 * journey table of legs, seeded once from the Step 3 CstepArrangement rows
 * and freely editable while REPORT_PENDING. Every route below is gated to
 * the request's creator only — this is the traveller's own report, not a
 * CSTEP Admin/Official/Approver action (unlike every route above). Once
 * submitted (REPORT_SUBMITTED), it is visible to the Admin for Step 5
 * verification — not built here.
 * ───────────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/report/start — creator-only, ARRANGED → REPORT_PENDING,
 * seeds ONWARD legs from Step 3's arrangement rows if not already seeded.
 * Idempotent like start-arranging/start-review: re-opening an
 * already-REPORT_PENDING request is a no-op on the status transition and
 * the audit log, and seeding is separately guarded so it never repeats.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests/:id/report/start", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });

    const uid = ownerId(req);
    if (String(doc.createdBy) !== uid) {
      return res.status(403).json({ error: "Only the creator can file this travel report" });
    }
    if (doc.status !== "ARRANGED" && doc.status !== "REPORT_PENDING") {
      return res.status(409).json({ error: "Only an arranged travel request can start its travel report" });
    }

    if (doc.status === "ARRANGED") {
      doc.status = "REPORT_PENDING";
      await doc.save();

      await CstepApproval.create({
        workspaceId: req.workspaceObjectId,
        entityType: "REQUEST",
        entityId: doc._id,
        stage: "TRAVELER",
        actor: new mongoose.Types.ObjectId(uid),
        action: "START_REPORT",
        at: new Date().toISOString(),
      });
    }

    const alreadySeeded = await CstepReportLeg.exists({
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
    });
    if (!alreadySeeded) {
      const arrangements = await CstepArrangement.find({
        workspaceId: req.workspaceObjectId,
        requestId: doc._id,
      }).lean();
      const seedRows = buildSeedReportLegs(arrangements);
      if (seedRows.length > 0) {
        await CstepReportLeg.insertMany(
          seedRows.map((row) => ({
            ...row,
            workspaceId: req.workspaceObjectId,
            requestId: doc._id,
            createdBy: new mongoose.Types.ObjectId(uid),
          })),
        );
      }
    }

    const legs = await CstepReportLeg.find({
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
    })
      .sort({ createdAt: 1 })
      .lean();

    res.json({ ok: true, request: doc.toObject(), legs });
  } catch (err: any) {
    console.error("[CSTEP requests report start]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to start the travel report" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /requests/:id/report — the creator, a CSTEP Admin, or this
 * traveller's Official user may VIEW (mutations below stay creator-only).
 * Widened from creator-only (Step 4) so the Processing board's "Report
 * Submitted" tab can actually open into a readable report — Step 5
 * verification actions aren't built yet, but viewing must work now.
 * Returns every leg (onward + return), with a presigned view URL for any
 * leg that has an uploaded attachment. Display-only — never writes.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/requests/:id/report", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });

    const uid = ownerId(req);
    const isOwner = String(doc.createdBy) === uid;
    if (!isOwner && !isCstepAdmin(req) && !(await callerCanArrangeForTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Not authorized to view this travel report" });
    }

    const legs = await CstepReportLeg.find({
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
    })
      .sort({ createdAt: 1 })
      .lean();

    const attachmentIds = legs.map((l: any) => l.attachmentId).filter(Boolean);
    const attachments = attachmentIds.length
      ? await CstepAttachment.find({
          workspaceId: req.workspaceObjectId,
          _id: { $in: attachmentIds },
        }).lean()
      : [];
    const attachmentById = new Map(attachments.map((a: any) => [String(a._id), a]));

    const legsWithAttachments = await Promise.all(
      legs.map(async (leg: any) => {
        if (!leg.attachmentId) return leg;
        const att: any = attachmentById.get(String(leg.attachmentId));
        if (!att) return leg;
        const url = await presignGetObject({
          bucket: env.S3_BUCKET,
          key: att.s3Key,
          filename: att.originalName,
          view: true,
          contentType: att.mime,
        });
        return { ...leg, attachment: { _id: att._id, originalName: att.originalName, mime: att.mime, url } };
      }),
    );

    res.json({ ok: true, legs: legsWithAttachments });
  } catch (err: any) {
    console.error("[CSTEP requests report GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load the travel report" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/report/legs — creator-only, adds a leg (SEEDED rows
 * are added at start; this is for the traveller's own additions). Only
 * while REPORT_PENDING.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests/:id/report/legs", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });

    const uid = ownerId(req);
    if (String(doc.createdBy) !== uid) {
      return res.status(403).json({ error: "Only the creator can edit this travel report" });
    }
    if (doc.status !== "REPORT_PENDING") {
      return res.status(409).json({ error: "The travel report can only be edited while it is in progress" });
    }

    const body = req.body || {};
    const direction: CstepReportDirection | null =
      body.direction === "ONWARD" || body.direction === "RETURN" ? body.direction : null;
    if (!direction) return res.status(400).json({ error: "direction must be ONWARD or RETURN" });
    if (!CSTEP_SERVICE_TYPES.includes(body.travelMode)) {
      return res.status(400).json({ error: "travelMode is required and must be a recognized service type" });
    }
    if (body.fromDate && !isValidDateStr(body.fromDate)) {
      return res.status(400).json({ error: "fromDate is not a valid date" });
    }
    if (body.toDate && !isValidDateStr(body.toDate)) {
      return res.status(400).json({ error: "toDate is not a valid date" });
    }

    let fare: number | undefined;
    if (body.fare !== undefined && body.fare !== null && body.fare !== "") {
      const n = Number(body.fare);
      if (!isFinite(n) || n < 0) return res.status(400).json({ error: "fare must be a non-negative number" });
      fare = n;
    }

    const currency = String(body.currency || "INR").trim().toUpperCase() || "INR";
    if (!/^[A-Z]{3}$/.test(currency)) {
      return res.status(400).json({ error: "currency must be a 3-letter ISO code" });
    }

    let paidBy: CstepReportPaidBy = "SELF";
    if (body.paidBy !== undefined) {
      if (body.paidBy !== "CSTEP" && body.paidBy !== "SELF") {
        return res.status(400).json({ error: "paidBy must be CSTEP or SELF" });
      }
      paidBy = body.paidBy;
    }

    const leg = await CstepReportLeg.create({
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
      direction,
      fromLocation: body.fromLocation ? String(body.fromLocation).trim() : undefined,
      fromDate: body.fromDate || undefined,
      toLocation: body.toLocation ? String(body.toLocation).trim() : undefined,
      toDate: body.toDate || undefined,
      travelMode: body.travelMode,
      fare,
      currency,
      paidBy,
      remarks: body.remarks ? String(body.remarks).trim() : undefined,
      source: "ADDED",
      createdBy: new mongoose.Types.ObjectId(uid),
    });

    res.status(201).json({ ok: true, leg: leg.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests report legs POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to add the report leg" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /requests/:id/report/legs/:legId — creator-only, edits one leg
 * (any field, including a SEEDED row's carried-over values). Only touches
 * fields present in the body — matches the Step 3 arrangement PATCH's
 * "only touch what was sent" discipline. Only while REPORT_PENDING.
 * ───────────────────────────────────────────────────────────────────── */
router.patch("/requests/:id/report/legs/:legId", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });

    const uid = ownerId(req);
    if (String(doc.createdBy) !== uid) {
      return res.status(403).json({ error: "Only the creator can edit this travel report" });
    }
    if (doc.status !== "REPORT_PENDING") {
      return res.status(409).json({ error: "The travel report can only be edited while it is in progress" });
    }
    if (!mongoose.Types.ObjectId.isValid(req.params.legId)) {
      return res.status(400).json({ error: "Invalid report leg id" });
    }
    const leg = await CstepReportLeg.findOne({
      _id: req.params.legId,
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
    });
    if (!leg) return res.status(404).json({ error: "Report leg not found" });

    const body = req.body || {};

    if ("direction" in body) {
      if (body.direction !== "ONWARD" && body.direction !== "RETURN") {
        return res.status(400).json({ error: "direction must be ONWARD or RETURN" });
      }
      leg.direction = body.direction;
    }
    if ("fromLocation" in body) leg.fromLocation = String(body.fromLocation || "").trim() || undefined;
    if ("fromDate" in body) {
      if (body.fromDate && !isValidDateStr(body.fromDate)) {
        return res.status(400).json({ error: "fromDate is not a valid date" });
      }
      leg.fromDate = body.fromDate || undefined;
    }
    if ("toLocation" in body) leg.toLocation = String(body.toLocation || "").trim() || undefined;
    if ("toDate" in body) {
      if (body.toDate && !isValidDateStr(body.toDate)) {
        return res.status(400).json({ error: "toDate is not a valid date" });
      }
      leg.toDate = body.toDate || undefined;
    }
    if ("travelMode" in body) {
      if (!CSTEP_SERVICE_TYPES.includes(body.travelMode)) {
        return res.status(400).json({ error: "travelMode is not a recognized service type" });
      }
      leg.travelMode = body.travelMode;
    }
    if ("fare" in body) {
      if (body.fare === null || body.fare === "") {
        leg.fare = undefined;
      } else {
        const n = Number(body.fare);
        if (!isFinite(n) || n < 0) return res.status(400).json({ error: "fare must be a non-negative number" });
        leg.fare = n;
      }
    }
    if ("currency" in body) {
      const cur = String(body.currency || "INR").trim().toUpperCase() || "INR";
      if (!/^[A-Z]{3}$/.test(cur)) return res.status(400).json({ error: "currency must be a 3-letter ISO code" });
      leg.currency = cur;
    }
    if ("paidBy" in body) {
      if (body.paidBy !== "CSTEP" && body.paidBy !== "SELF") {
        return res.status(400).json({ error: "paidBy must be CSTEP or SELF" });
      }
      leg.paidBy = body.paidBy;
    }
    if ("remarks" in body) leg.remarks = String(body.remarks || "").trim() || undefined;

    await leg.save();
    res.json({ ok: true, leg: leg.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests report legs PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update the report leg" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * DELETE /requests/:id/report/legs/:legId — creator-only, removes a leg
 * (SEEDED or ADDED — both are freely removable while in progress; only the
 * underlying CstepArrangement row that seeded it, if any, is untouched).
 * Only while REPORT_PENDING.
 * ───────────────────────────────────────────────────────────────────── */
router.delete("/requests/:id/report/legs/:legId", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });

    const uid = ownerId(req);
    if (String(doc.createdBy) !== uid) {
      return res.status(403).json({ error: "Only the creator can edit this travel report" });
    }
    if (doc.status !== "REPORT_PENDING") {
      return res.status(409).json({ error: "The travel report can only be edited while it is in progress" });
    }
    if (!mongoose.Types.ObjectId.isValid(req.params.legId)) {
      return res.status(400).json({ error: "Invalid report leg id" });
    }

    const leg = await CstepReportLeg.findOneAndDelete({
      _id: req.params.legId,
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
    });
    if (!leg) return res.status(404).json({ error: "Report leg not found" });

    res.json({ ok: true });
  } catch (err: any) {
    console.error("[CSTEP requests report legs DELETE]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to remove the report leg" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/report/legs/:legId/attachment — creator-only, uploads
 * one document (receipt/boarding pass) for a leg via the SAME S3 mechanism
 * used elsewhere in this codebase (multer memory storage → uploadBufferToS3
 * → CstepAttachment record → presigned view URL on read) — no new upload
 * path. Links the CstepClaim if one exists for this request (TOUR_PROPOSAL
 * only — an EVENT_REQUEST never has one; travelRequestId always links
 * regardless). Only while REPORT_PENDING.
 * ───────────────────────────────────────────────────────────────────── */
router.post(
  "/requests/:id/report/legs/:legId/attachment",
  reportAttachmentUpload.single("file"),
  async (req: any, res: any) => {
    try {
      const doc = await loadRequest(req, req.params.id);
      if (!doc) return res.status(404).json({ error: "Travel request not found" });

      const uid = ownerId(req);
      if (String(doc.createdBy) !== uid) {
        return res.status(403).json({ error: "Only the creator can edit this travel report" });
      }
      if (doc.status !== "REPORT_PENDING") {
        return res.status(409).json({ error: "The travel report can only be edited while it is in progress" });
      }
      if (!mongoose.Types.ObjectId.isValid(req.params.legId)) {
        return res.status(400).json({ error: "Invalid report leg id" });
      }
      const leg = await CstepReportLeg.findOne({
        _id: req.params.legId,
        workspaceId: req.workspaceObjectId,
        requestId: doc._id,
      });
      if (!leg) return res.status(404).json({ error: "Report leg not found" });

      const file = req.file;
      if (!file || !file.buffer) return res.status(400).json({ error: "File is required" });

      const uploaded = await uploadBufferToS3({
        buffer: file.buffer,
        mime: file.mimetype,
        originalName: file.originalname,
        customerId: String(req.workspaceObjectId),
        createdBy: uid,
        keyPrefix: `cstep/report-legs/${req.workspaceObjectId}/${doc._id}`,
      });

      const claim: any = await CstepClaim.findOne({
        workspaceId: req.workspaceObjectId,
        travelRequestId: doc._id,
      })
        .select("_id")
        .lean();

      const attachment = await CstepAttachment.create({
        workspaceId: req.workspaceObjectId,
        ...(claim ? { claimId: claim._id } : {}),
        travelRequestId: doc._id,
        s3Key: uploaded.key,
        originalName: file.originalname,
        mime: file.mimetype,
        documentType: REPORT_DOCUMENT_TYPE_BY_MODE[leg.travelMode as CstepServiceType] || "OTHER",
        createdBy: new mongoose.Types.ObjectId(uid),
      });

      leg.attachmentId = attachment._id;
      await leg.save();

      const url = await presignGetObject({
        bucket: env.S3_BUCKET,
        key: attachment.s3Key,
        filename: attachment.originalName,
        view: true,
        contentType: attachment.mime,
      });

      res.status(201).json({
        ok: true,
        leg: leg.toObject(),
        attachment: { _id: attachment._id, originalName: attachment.originalName, mime: attachment.mime, url },
      });
    } catch (err: any) {
      console.error("[CSTEP requests report legs attachment]", err?.message);
      res.status(500).json({ error: err?.message || "Failed to upload the attachment" });
    }
  },
);

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/report/submit — creator-only, REPORT_PENDING →
 * REPORT_SUBMITTED. Logs SUBMIT_REPORT. Does not build any Step 5
 * verification — the request just becomes visible to the Admin at this
 * status for that later work.
 *
 * Per CSTEP's rule, EVERY leg needs a supporting document — even a
 * "Booked by CSTEP" leg (boarding pass/hotel voucher/cab receipt) — so this
 * validates server-side that every CstepReportLeg for this request has an
 * attachmentId before allowing the transition; the frontend blocks Submit
 * the same way, but this is the real enforcement point, never trusted from
 * the client alone. No "declaration instead of receipt" fallback — that's
 * explicitly deferred; a missing document always blocks submission for now.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests/:id/report/submit", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });

    const uid = ownerId(req);
    if (String(doc.createdBy) !== uid) {
      return res.status(403).json({ error: "Only the creator can submit this travel report" });
    }
    if (doc.status !== "REPORT_PENDING") {
      return res.status(409).json({ error: "Only a travel report in progress can be submitted" });
    }

    const legsWithoutDocument = await CstepReportLeg.find({
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
      attachmentId: { $exists: false },
    })
      .select("direction travelMode")
      .lean();
    if (legsWithoutDocument.length > 0) {
      return res.status(400).json({
        error:
          "Every leg needs a supporting document before the report can be submitted. Missing on: " +
          legsWithoutDocument
            .map((l: any) => `${l.direction === "ONWARD" ? "Onward" : "Return"} ${l.travelMode}`)
            .join(", "),
        missingLegs: legsWithoutDocument.map((l: any) => ({ direction: l.direction, travelMode: l.travelMode })),
      });
    }

    doc.status = "REPORT_SUBMITTED";
    await doc.save();

    await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "TRAVELER",
      actor: new mongoose.Types.ObjectId(uid),
      action: "SUBMIT_REPORT",
      at: new Date().toISOString(),
    });

    res.json({ ok: true, request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests report submit]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to submit the travel report" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/amend — approver-only, amends a single field while a
 * request is SUBMITTED (under review). reason is mandatory. Logged as a
 * CstepAmendment (field, oldValue, newValue, actor, timestamp, reason).
 * ───────────────────────────────────────────────────────────────────── */
const AMENDABLE_FIELDS = new Set(Object.keys(pickFields({})));

router.post("/requests/:id/amend", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!(await callerCanActOnTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Tour Approver or a CSTEP Admin can perform this action" });
    }
    if (doc.status !== "SUBMITTED") {
      return res.status(409).json({ error: "Only a submitted travel request can be amended" });
    }

    const field = String(req.body?.field || "");
    if (!AMENDABLE_FIELDS.has(field)) {
      return res.status(400).json({ error: "field is not a recognized, amendable field" });
    }
    if (!("newValue" in (req.body || {}))) {
      return res.status(400).json({ error: "newValue is required" });
    }
    const reason = String(req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({ error: "reason is required" });

    const before: any = doc.toObject();
    const oldValue = before[field];
    const newValue = req.body.newValue;

    const merged: any = { ...before, [field]: newValue };
    const validationError = validatePayload(merged);
    if (validationError) return res.status(400).json({ error: validationError });

    (doc as any)[field] = newValue;
    await doc.save();

    await CstepAmendment.create({
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
      field,
      oldValue,
      newValue,
      changedBy: new mongoose.Types.ObjectId(ownerId(req)),
      changedAt: new Date().toISOString(),
      reason,
    });

    res.json({ ok: true, request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests amend]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to amend travel request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /requests/:id/activity — combined, chronological CstepApproval +
 * CstepAmendment history for this request. Readable by the owning
 * traveller or an approver. Display-only data — this route never writes.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/requests/:id/activity", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });

    const uid = ownerId(req);
    if (String(doc.createdBy) !== uid && !(await callerCanActOnTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Not authorized to view this activity log" });
    }

    const [approvals, amendments] = await Promise.all([
      CstepApproval.find({
        workspaceId: req.workspaceObjectId,
        entityType: "REQUEST",
        entityId: doc._id,
      })
        .populate("actor", "firstName lastName name email")
        .lean(),
      CstepAmendment.find({
        workspaceId: req.workspaceObjectId,
        requestId: doc._id,
      })
        .populate("changedBy", "firstName lastName name email")
        .lean(),
    ]);

    const actorNameOf = (u: any): string | undefined => {
      if (!u || typeof u !== "object") return undefined;
      return u.name || [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || undefined;
    };

    const activity = [
      ...approvals.map((a: any) => ({
        kind: "APPROVAL" as const,
        action: a.action,
        stage: a.stage,
        actor: String(a.actor?._id || a.actor),
        actorName: actorNameOf(a.actor),
        at: a.at,
        comment: a.comment,
      })),
      ...amendments.map((a: any) => ({
        kind: "AMENDMENT" as const,
        field: a.field,
        oldValue: a.oldValue,
        newValue: a.newValue,
        actor: String(a.changedBy?._id || a.changedBy),
        actorName: actorNameOf(a.changedBy),
        at: a.changedAt,
        reason: a.reason,
      })),
    ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    res.json({ ok: true, activity });
  } catch (err: any) {
    console.error("[CSTEP requests activity]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load activity" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /requests/:id/pdf?mode=view|download — the Tour Proposal PDF (Step 1
 * Polish, Part C). Pre-trip only — traveller details, trip details, status,
 * and the approval trail so far; no claim/expense/settlement tables (that's
 * post-trip, separate work). Readable by the owning traveller, this
 * traveller's Tour Approver, or a CSTEP Admin — same authority as
 * GET /requests/:id/activity.
 *
 * Cached on the request doc (pdfS3Key/pdfGeneratedAt) and regenerated only
 * when stale (no cached key yet, or the request has been edited/acted on
 * since the last generation) — avoids re-rendering on every click while
 * still reflecting the latest status/TIN/activity after it changes.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/requests/:id/pdf", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });

    const uid = ownerId(req);
    const isOwner = String(doc.createdBy) === uid;
    if (!isOwner && !isCstepAdmin(req) && !(await callerCanActOnTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Not authorized to view this proposal" });
    }

    // Step 5 addition — the settlement (if one has been started) feeds the
    // Office table; its own updatedAt also has to be checked for staleness,
    // same as the request's own updatedAt, so a settlement edit after the
    // PDF was cached actually regenerates it.
    const settlement: any = await CstepSettlement.findOne({
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
    }).lean();

    const stale =
      !doc.pdfS3Key ||
      !doc.pdfGeneratedAt ||
      doc.pdfGeneratedAt < doc.updatedAt ||
      (settlement && doc.pdfGeneratedAt < settlement.updatedAt);
    if (stale) {
      const traveller: any = await TravellerProfile.findOne({
        _id: doc.travelerProfileId,
        workspaceId: req.workspaceObjectId,
      })
        .select("firstName lastName gender travelerId")
        .lean();

      const approvals = await CstepApproval.find({
        workspaceId: req.workspaceObjectId,
        entityType: "REQUEST",
        entityId: doc._id,
      })
        .populate("actor", "firstName lastName name email")
        .sort({ at: 1 })
        .lean();

      const trail: CstepApprovalTrailEntry[] = (approvals as any[]).map((a) => ({
        action: a.action,
        actorName:
          a.actor?.name || [a.actor?.firstName, a.actor?.lastName].filter(Boolean).join(" ").trim() || a.actor?.email || "—",
        at: a.at,
        comment: a.comment,
      }));

      const travellerInfo = {
        name: traveller ? [traveller.firstName, traveller.lastName].filter(Boolean).join(" ") : "—",
        gender: traveller?.gender,
        travelerId: traveller?.travelerId,
      };

      const settlementPdfData: CstepSettlementPdfData | undefined = settlement
        ? { buckets: settlement.buckets, totalCostOfTour: settlement.totalCostOfTour, amountClaimed: settlement.amountClaimed }
        : undefined;

      const { key } =
        doc.formType === "EVENT_REQUEST"
          ? await uploadCstepEventRequestPdf(doc.toObject(), travellerInfo, trail)
          : await uploadCstepTourProposalPdf(doc.toObject(), travellerInfo, trail, settlementPdfData);
      doc.pdfS3Key = key;
      doc.pdfGeneratedAt = new Date();
      await doc.save();
    }

    const mode = req.query?.mode === "download" ? "download" : "view";
    const filenamePrefix = doc.formType === "EVENT_REQUEST" ? "Event-Request" : "Tour-Proposal";
    const filename = `${filenamePrefix}-${doc.claimReference || doc._id}.pdf`;
    const url = await presignGetObject({
      bucket: env.S3_BUCKET,
      key: doc.pdfS3Key as string,
      filename,
      expiresInSeconds: 3600,
      forceDownload: mode === "download",
    });

    res.json({ ok: true, url });
  } catch (err: any) {
    console.error("[CSTEP requests pdf]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to generate PDF" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /requests/:id/packet?mode=view|download — the combined "packet" PDF:
 * itinerary (from the Step 4 Travel Report legs) + every leg's supporting
 * document, in leg order (Onward then Return) + the approval-form PDF
 * (same generator/dispatch as GET /requests/:id/pdf) as the final page(s).
 * See utils/cstepPacketPdf.ts for the assembly.
 *
 * Authority: the owning traveller, a CSTEP Admin, this traveller's Tour
 * Approver (callerCanActOnTraveller), OR this traveller's Official user
 * (callerCanArrangeForTraveller) — the packet is meant for whoever can act
 * on this traveller's request, not just the Tour Approver alone.
 *
 * Cached on the request doc (packetS3Key/packetGeneratedAt), regenerated
 * when stale — no cached key yet, the request has been edited since, or
 * any report leg has changed since (legs are only mutable while
 * REPORT_PENDING, i.e. before a packet would ever be requested, so this
 * only ever fires once per submitted report in practice).
 * ───────────────────────────────────────────────────────────────────── */
router.get("/requests/:id/packet", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });

    const uid = ownerId(req);
    const isOwner = String(doc.createdBy) === uid;
    const authorized =
      isOwner ||
      isCstepAdmin(req) ||
      (await callerCanActOnTraveller(req, doc.travelerProfileId)) ||
      (await callerCanArrangeForTraveller(req, doc.travelerProfileId));
    if (!authorized) {
      return res.status(403).json({ error: "Not authorized to view this packet" });
    }

    const legs = await CstepReportLeg.find({
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
    })
      .sort({ createdAt: 1 })
      .lean();

    const latestLegUpdate = (legs as any[]).reduce<Date | null>((max, l) => {
      const t = l.updatedAt ? new Date(l.updatedAt) : null;
      if (!t) return max;
      return !max || t > max ? t : max;
    }, null);

    // Step 5 addition — same settlement lookup + staleness check as GET /pdf.
    const settlement: any = await CstepSettlement.findOne({
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
    }).lean();

    const stale =
      !doc.packetS3Key ||
      !doc.packetGeneratedAt ||
      doc.packetGeneratedAt < doc.updatedAt ||
      (latestLegUpdate ? doc.packetGeneratedAt < latestLegUpdate : false) ||
      (settlement && doc.packetGeneratedAt < settlement.updatedAt);

    if (stale) {
      const traveller: any = await TravellerProfile.findOne({
        _id: doc.travelerProfileId,
        workspaceId: req.workspaceObjectId,
      })
        .select("firstName lastName gender travelerId")
        .lean();

      const approvals = await CstepApproval.find({
        workspaceId: req.workspaceObjectId,
        entityType: "REQUEST",
        entityId: doc._id,
      })
        .populate("actor", "firstName lastName name email")
        .sort({ at: 1 })
        .lean();

      const trail: CstepApprovalTrailEntry[] = (approvals as any[]).map((a) => ({
        action: a.action,
        actorName:
          a.actor?.name || [a.actor?.firstName, a.actor?.lastName].filter(Boolean).join(" ").trim() || a.actor?.email || "—",
        at: a.at,
        comment: a.comment,
      }));

      const travellerInfo = {
        name: traveller ? [traveller.firstName, traveller.lastName].filter(Boolean).join(" ") : "—",
        gender: traveller?.gender,
        travelerId: traveller?.travelerId,
      };

      const attachmentIds = (legs as any[]).map((l) => l.attachmentId).filter(Boolean);
      const attachments = attachmentIds.length
        ? await CstepAttachment.find({ _id: { $in: attachmentIds }, workspaceId: req.workspaceObjectId }).lean()
        : [];
      const attachmentById = new Map((attachments as any[]).map((a) => [String(a._id), a]));

      const packetLegs: CstepPacketReportLeg[] = (legs as any[]).map((l) => ({
        leg: l,
        attachment: l.attachmentId ? attachmentById.get(String(l.attachmentId)) || null : null,
      }));

      const settlementPdfData: CstepSettlementPdfData | undefined = settlement
        ? { buckets: settlement.buckets, totalCostOfTour: settlement.totalCostOfTour, amountClaimed: settlement.amountClaimed }
        : undefined;

      const { key } = await uploadCstepPacketPdf(doc.toObject(), travellerInfo, trail, packetLegs, settlementPdfData);
      doc.packetS3Key = key;
      doc.packetGeneratedAt = new Date();
      await doc.save();
    }

    const mode = req.query?.mode === "download" ? "download" : "view";
    const filename = `Travel-Packet-${doc.claimReference || doc._id}.pdf`;
    const url = await presignGetObject({
      bucket: env.S3_BUCKET,
      key: doc.packetS3Key as string,
      filename,
      expiresInSeconds: 3600,
      forceDownload: mode === "download",
    });

    res.json({ ok: true, url });
  } catch (err: any) {
    console.error("[CSTEP requests packet]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to generate the travel packet" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * Step 5 — Office/Accounts settlement. Official/Admin-gated the same way
 * as Step 3's arrangement stage (callerCanArrangeForTraveller) — the
 * Official who arranges services also settles accounts once the
 * traveller's report is in. Every route below only ever touches
 * CstepSettlement/CstepSettlementLine — Steps 1-4's own records
 * (CstepTravelRequest fields, CstepArrangement, CstepReportLeg) are read
 * from but never written by this stage.
 * ───────────────────────────────────────────────────────────────────── */

/**
 * POST /requests/:id/settlement/start — Official/Admin, REPORT_SUBMITTED
 * only. Opens (or, if already open, just returns) this request's
 * CstepSettlement: seeds lines from both streams (see
 * buildSeedSettlementLines) and the per-diem's computed days/default rate,
 * recomputes buckets/totals, logs START_VERIFICATION. Idempotent — a
 * settlement already existing for this request is a no-op on every one of
 * those (matches start-arranging/report-start's own idempotency pattern).
 * Does NOT change the request's own status — REPORT_SUBMITTED stays the
 * status throughout verification; only /settlement/finalize moves it on.
 */
router.post("/requests/:id/settlement/start", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!(await callerCanArrangeForTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Official user or a CSTEP Admin can perform this action" });
    }
    if (doc.status !== "REPORT_SUBMITTED") {
      return res.status(409).json({ error: "Only a request with a submitted travel report can start settlement" });
    }

    const uid = ownerId(req);
    let settlement: any = await CstepSettlement.findOne({ workspaceId: req.workspaceObjectId, requestId: doc._id });

    if (!settlement) {
      const computedDays = computeTripDays(doc.departureDate, doc.returnDate);
      const defaultRate = await findDefaultPerDiemRate(req.workspaceObjectId, doc);

      settlement = await CstepSettlement.create({
        workspaceId: req.workspaceObjectId,
        requestId: doc._id,
        status: "VERIFYING",
        perDiem: {
          days: computedDays,
          rate: defaultRate?.rate || 0,
          currency: defaultRate?.currency || "INR",
          amountInr: computedDays * (defaultRate?.rate || 0),
          computedDays,
        },
        buckets: { airRailBus: 0, perDiem: 0, boardingLodging: 0, cab: 0, other: 0 },
        totalCostOfTour: 0,
        amountClaimed: 0,
        startedBy: new mongoose.Types.ObjectId(uid),
        startedAt: new Date(),
      });

      const seedRows = await buildSeedSettlementLines(req.workspaceObjectId, doc._id);
      if (seedRows.length > 0) {
        await CstepSettlementLine.insertMany(
          seedRows.map((row) => ({
            ...row,
            workspaceId: req.workspaceObjectId,
            settlementId: settlement._id,
            requestId: doc._id,
            createdBy: new mongoose.Types.ObjectId(uid),
          })),
        );
      }

      const lines = await CstepSettlementLine.find({
        workspaceId: req.workspaceObjectId,
        settlementId: settlement._id,
      }).lean();
      const { buckets, totalCostOfTour, amountClaimed } = recomputeSettlementTotals(
        lines as any[],
        settlement.perDiem.amountInr,
      );
      settlement.buckets = buckets;
      settlement.totalCostOfTour = totalCostOfTour;
      settlement.amountClaimed = amountClaimed;
      await settlement.save();

      await CstepApproval.create({
        workspaceId: req.workspaceObjectId,
        entityType: "REQUEST",
        entityId: doc._id,
        stage: "OFFICIAL",
        actor: new mongoose.Types.ObjectId(uid),
        action: "START_VERIFICATION",
        at: new Date().toISOString(),
      });
    }

    const lines = await CstepSettlementLine.find({ workspaceId: req.workspaceObjectId, settlementId: settlement._id })
      .sort({ createdAt: 1 })
      .lean();

    res.json({ ok: true, settlement: settlement.toObject(), lines });
  } catch (err: any) {
    console.error("[CSTEP requests settlement start]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to start settlement" });
  }
});

/**
 * GET /requests/:id/settlement — Official/Admin, view. Returns the
 * settlement (null if /settlement/start hasn't run yet) and its lines, each
 * with a presigned view URL for any attachment carried over from a Step 4
 * report leg (ARRANGEMENT-sourced lines have none — arrangements carry no
 * attachment of their own, see CstepArrangement.ts). Display-only — never
 * writes.
 */
router.get("/requests/:id/settlement", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!(await callerCanArrangeForTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Official user or a CSTEP Admin can view the settlement" });
    }

    const settlement: any = await CstepSettlement.findOne({
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
    }).lean();
    if (!settlement) return res.json({ ok: true, settlement: null, lines: [] });

    const lines = await CstepSettlementLine.find({ workspaceId: req.workspaceObjectId, settlementId: settlement._id })
      .sort({ createdAt: 1 })
      .lean();

    const attachmentIds = (lines as any[]).map((l) => l.attachmentId).filter(Boolean);
    const attachments = attachmentIds.length
      ? await CstepAttachment.find({ workspaceId: req.workspaceObjectId, _id: { $in: attachmentIds } }).lean()
      : [];
    const attachmentById = new Map((attachments as any[]).map((a) => [String(a._id), a]));

    const linesWithAttachments = await Promise.all(
      (lines as any[]).map(async (line) => {
        if (!line.attachmentId) return line;
        const att: any = attachmentById.get(String(line.attachmentId));
        if (!att) return line;
        const url = await presignGetObject({
          bucket: env.S3_BUCKET,
          key: att.s3Key,
          filename: att.originalName,
          view: true,
          contentType: att.mime,
        });
        return { ...line, attachment: { _id: att._id, originalName: att.originalName, mime: att.mime, url } };
      }),
    );

    res.json({ ok: true, settlement, lines: linesWithAttachments });
  } catch (err: any) {
    console.error("[CSTEP requests settlement GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load the settlement" });
  }
});

/**
 * PATCH /requests/:id/settlement/lines/:lineId — Official/Admin verifies one
 * line: confirm/correct amountInr, flip classification (reason mandatory on
 * override), mark verified. Only touches fields present in the body (same
 * "only touch what was sent" discipline as Step 3/4's PATCH routes). Logs
 * VERIFY_LINE with a before/after comment. Recomputes the settlement's
 * buckets/totals on every change. Only while the settlement is VERIFYING.
 */
router.patch("/requests/:id/settlement/lines/:lineId", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!(await callerCanArrangeForTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Official user or a CSTEP Admin can perform this action" });
    }

    const settlement: any = await CstepSettlement.findOne({ workspaceId: req.workspaceObjectId, requestId: doc._id });
    if (!settlement) return res.status(404).json({ error: "Settlement not started yet" });
    if (settlement.status !== "VERIFYING") {
      return res.status(409).json({ error: "This settlement has already been finalized" });
    }

    if (!mongoose.Types.ObjectId.isValid(req.params.lineId)) {
      return res.status(400).json({ error: "Invalid settlement line id" });
    }
    const line = await CstepSettlementLine.findOne({
      _id: req.params.lineId,
      workspaceId: req.workspaceObjectId,
      settlementId: settlement._id,
    });
    if (!line) return res.status(404).json({ error: "Settlement line not found" });

    const before = { amountInr: line.amountInr, classification: line.classification, verified: line.verified };
    const body = req.body || {};

    if ("amountInr" in body) {
      const n = Number(body.amountInr);
      if (!isFinite(n) || n < 0) return res.status(400).json({ error: "amountInr must be a non-negative number" });
      line.amountInr = Math.round(n * 100) / 100;
    }

    if ("classification" in body) {
      if (body.classification !== "OFFICIAL" && body.classification !== "PERSONAL") {
        return res.status(400).json({ error: "classification must be OFFICIAL or PERSONAL" });
      }
      if (body.classification !== line.classification) {
        const reason = String(body.classificationOverrideReason || "").trim();
        if (!reason) {
          return res
            .status(400)
            .json({ error: "classificationOverrideReason is required when changing a line's classification" });
        }
        line.classification = body.classification;
        line.classificationOverridden = true;
        line.classificationOverrideReason = reason;
      }
    }

    if ("verified" in body) {
      line.verified = !!body.verified;
      if (line.verified) {
        line.verifiedBy = new mongoose.Types.ObjectId(ownerId(req));
        line.verifiedAt = new Date();
      } else {
        line.verifiedBy = undefined;
        line.verifiedAt = undefined;
      }
    }

    await line.save();

    const allLines = await CstepSettlementLine.find({
      workspaceId: req.workspaceObjectId,
      settlementId: settlement._id,
    }).lean();
    const { buckets, totalCostOfTour, amountClaimed } = recomputeSettlementTotals(
      allLines as any[],
      settlement.perDiem.amountInr,
    );
    settlement.buckets = buckets;
    settlement.totalCostOfTour = totalCostOfTour;
    settlement.amountClaimed = amountClaimed;
    await settlement.save();

    await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "OFFICIAL",
      actor: new mongoose.Types.ObjectId(ownerId(req)),
      action: "VERIFY_LINE",
      comment:
        `Line ${line.description || line.mode}: amount ${before.amountInr ?? 0} => ${line.amountInr ?? 0}` +
        (before.classification !== line.classification
          ? `, classification ${before.classification} => ${line.classification} (${line.classificationOverrideReason})`
          : "") +
        (before.verified !== line.verified ? `, verified ${before.verified} => ${line.verified}` : ""),
      at: new Date().toISOString(),
    });

    res.json({ ok: true, line: line.toObject(), settlement: settlement.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests settlement line PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update the settlement line" });
  }
});

/**
 * PATCH /requests/:id/settlement/perdiem — Official/Admin sets/overrides the
 * per-diem rate and/or days. overrideDays requires overrideReason (days are
 * otherwise fixed at computedDays, from the trip's own dates). Recomputes
 * amountInr = days * rate and the settlement's buckets/totals. Only while
 * the settlement is VERIFYING.
 */
router.patch("/requests/:id/settlement/perdiem", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!(await callerCanArrangeForTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Official user or a CSTEP Admin can perform this action" });
    }

    const settlement: any = await CstepSettlement.findOne({ workspaceId: req.workspaceObjectId, requestId: doc._id });
    if (!settlement) return res.status(404).json({ error: "Settlement not started yet" });
    if (settlement.status !== "VERIFYING") {
      return res.status(409).json({ error: "This settlement has already been finalized" });
    }

    const body = req.body || {};
    const before = { rate: settlement.perDiem.rate, overrideDays: settlement.perDiem.overrideDays };

    if ("rate" in body) {
      const n = Number(body.rate);
      if (!isFinite(n) || n < 0) return res.status(400).json({ error: "rate must be a non-negative number" });
      settlement.perDiem.rate = n;
    }

    if ("overrideDays" in body) {
      if (body.overrideDays === null) {
        settlement.perDiem.overrideDays = undefined;
        settlement.perDiem.overrideReason = undefined;
      } else {
        const n = Number(body.overrideDays);
        if (!isFinite(n) || n < 0) return res.status(400).json({ error: "overrideDays must be a non-negative number" });
        const reason = String(body.overrideReason || "").trim();
        if (!reason) return res.status(400).json({ error: "overrideReason is required when overriding per-diem days" });
        settlement.perDiem.overrideDays = n;
        settlement.perDiem.overrideReason = reason;
      }
    }

    const days = settlement.perDiem.overrideDays ?? settlement.perDiem.computedDays;
    settlement.perDiem.days = days;
    settlement.perDiem.amountInr = Math.round(days * settlement.perDiem.rate * 100) / 100;

    const lines = await CstepSettlementLine.find({ workspaceId: req.workspaceObjectId, settlementId: settlement._id }).lean();
    const { buckets, totalCostOfTour, amountClaimed } = recomputeSettlementTotals(
      lines as any[],
      settlement.perDiem.amountInr,
    );
    settlement.buckets = buckets;
    settlement.totalCostOfTour = totalCostOfTour;
    settlement.amountClaimed = amountClaimed;
    await settlement.save();

    await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "OFFICIAL",
      actor: new mongoose.Types.ObjectId(ownerId(req)),
      action: "VERIFY_LINE",
      comment:
        `Per diem: days ${before.overrideDays ?? settlement.perDiem.computedDays} => ${days}, rate ${before.rate} => ${settlement.perDiem.rate}` +
        (settlement.perDiem.overrideReason ? ` (${settlement.perDiem.overrideReason})` : ""),
      at: new Date().toISOString(),
    });

    res.json({ ok: true, settlement: settlement.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests settlement perdiem PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update per diem" });
  }
});

/**
 * POST /requests/:id/settlement/finalize — Official/Admin finalizes: a
 * final recompute from the current lines/per-diem, sets outcome
 * (TO_FINANCE if amountClaimed > 0, else CLOSE), settlement -> FINALIZED,
 * request status -> TRANSFERRED_TO_FINANCE or SETTLED. Logs SETTLE (+
 * TRANSFER_TO_FINANCE when going to Finance). Blocks on unverified lines
 * unless the caller passes { force: true } — the Official's judgement call,
 * same "block by default, allow with confirmation" posture as
 * mark-arranged's incomplete-lines note.
 */
router.post("/requests/:id/settlement/finalize", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!(await callerCanArrangeForTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Official user or a CSTEP Admin can perform this action" });
    }
    if (doc.status !== "REPORT_SUBMITTED") {
      return res.status(409).json({ error: "Only a request awaiting settlement can be finalized" });
    }

    const settlement: any = await CstepSettlement.findOne({ workspaceId: req.workspaceObjectId, requestId: doc._id });
    if (!settlement) return res.status(404).json({ error: "Settlement not started yet" });
    if (settlement.status !== "VERIFYING") {
      return res.status(409).json({ error: "This settlement has already been finalized" });
    }

    const lines = await CstepSettlementLine.find({ workspaceId: req.workspaceObjectId, settlementId: settlement._id }).lean();
    const unverified = (lines as any[]).filter((l) => !l.verified);
    if (unverified.length > 0 && !req.body?.force) {
      return res.status(409).json({
        error: `${unverified.length} line(s) are not yet verified. Finalize anyway to proceed.`,
        unverifiedCount: unverified.length,
      });
    }

    const { buckets, totalCostOfTour, amountClaimed } = recomputeSettlementTotals(
      lines as any[],
      settlement.perDiem.amountInr,
    );
    const outcome: "CLOSE" | "TO_FINANCE" = amountClaimed > 0 ? "TO_FINANCE" : "CLOSE";
    const uid = ownerId(req);

    settlement.buckets = buckets;
    settlement.totalCostOfTour = totalCostOfTour;
    settlement.amountClaimed = amountClaimed;
    settlement.outcome = outcome;
    settlement.status = "FINALIZED";
    settlement.finalizedBy = new mongoose.Types.ObjectId(uid);
    settlement.finalizedAt = new Date();
    await settlement.save();

    doc.status = outcome === "TO_FINANCE" ? "TRANSFERRED_TO_FINANCE" : "SETTLED";
    await doc.save();

    const now = new Date().toISOString();
    await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "OFFICIAL",
      actor: new mongoose.Types.ObjectId(uid),
      action: "SETTLE",
      comment: `Total cost of tour: ₹${totalCostOfTour} | Amount claimed: ₹${amountClaimed} | Outcome: ${outcome}`,
      at: now,
    });
    if (outcome === "TO_FINANCE") {
      await CstepApproval.create({
        workspaceId: req.workspaceObjectId,
        entityType: "REQUEST",
        entityId: doc._id,
        stage: "OFFICIAL",
        actor: new mongoose.Types.ObjectId(uid),
        action: "TRANSFER_TO_FINANCE",
        comment: `₹${amountClaimed} owed to the traveller`,
        at: now,
      });
    }

    res.json({ ok: true, settlement: settlement.toObject(), request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests settlement finalize]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to finalize the settlement" });
  }
});

export default router;
