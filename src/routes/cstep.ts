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
  CstepVendor,
  CstepVendorType,
  CstepSequenceChange,
  CstepChangeRequest,
} from "../models/cstep/index.js";
import {
  CSTEP_CHANGE_KINDS,
  CSTEP_CHANGE_STATUSES,
  type CstepChangeKind,
} from "../models/cstep/CstepChangeRequest.js";
import {
  CSTEP_EVENT_NATURES,
  CSTEP_FORM_TYPES,
  CSTEP_LOCAL_TRAVEL_MODES,
  isClaimFormType,
  type CstepFormType,
} from "../models/cstep/CstepTravelRequest.js";
import {
  CSTEP_SERVICE_TYPES,
  CSTEP_VENDOR_PAYABLE_STATUSES,
  arrangementAmountGap,
  type CstepServiceType,
  type CstepRateSource,
} from "../models/cstep/CstepArrangement.js";
import type { CstepReportDirection, CstepReportPaidBy } from "../models/cstep/CstepReportLeg.js";
import { SERVICE_LABEL } from "./cstep.vendorPayables.js";
import type { CstepDocumentType } from "../models/cstep/CstepAttachment.js";
import type {
  CstepSettlementLineClassification,
  CstepSettlementLineSource,
} from "../models/cstep/CstepSettlementLine.js";
import CstepProject from "../models/cstep/CstepProject.js";
import TravellerProfile from "../models/TravellerProfile.js";
import User from "../models/User.js";
import CstepTravelDeskGrant from "../models/cstep/CstepTravelDeskGrant.js";
import { activeUserFilter } from "../utils/userActiveStatus.js";
import { todayIST } from "../utils/dateIST.js";
import {
  buildDeskDashboard,
  DESK_DASHBOARD_STATUSES,
  DESK_NEAR_DAYS,
  type DeskServiceCounts,
} from "../utils/cstepDeskDashboard.js";
import Counter from "../models/Counter.js";
import {
  ownerId,
  isCstepAdmin,
  holdsTravelDeskGrant,
  resolveOwnTravellerProfile,
  ONLY_ASSIGNED_FINANCE,
  NO_FINANCE_ASSIGNED,
} from "../utils/cstepAccess.js";
import {
  uploadCstepTourProposalPdf,
  type CstepApprovalTrailEntry,
  type CstepSettlementPdfData,
} from "../utils/cstepTourProposalPdf.js";
import { uploadCstepEventRequestPdf } from "../utils/cstepEventRequestPdf.js";
import {
  claimDeclarationHash,
  claimDeclarationItems,
  uploadCstepClaimDeclarationPdf,
  uploadCstepExpenseClaimPdf,
  uploadCstepLocalTravelClaimPdf,
  type CstepClaimSettlementPdfData,
} from "../utils/cstepClaimPdf.js";
import { uploadCstepPacketPdf, type CstepPacketReportLeg } from "../utils/cstepPacketPdf.js";
import { presignGetObject } from "../utils/s3Presign.js";
import { uploadBufferToS3 } from "../utils/s3Upload.js";
import { getLiveRate } from "../utils/exchangeRate.js";
import {
  nextCstepSerial,
  seedCstepSerial,
  peekCstepSerial,
  cstepMMYY,
  cstepFyStartYear,
  formatCstepTin,
  formatCstepClaimReference,
  CSTEP_SERIES,
  isFySeries,
  type CstepSeries,
} from "../utils/cstepSequence.js";
import {
  buildTravelRegisterWorkbook,
  istDate,
  resolveRegisterPeriod,
  type RegisterTrip,
} from "../utils/cstepTravelRegister.js";
import { env } from "../config/env.js";
import { notifyCstep } from "../services/cstepNotifications.js";
import { sendSheet } from "../utils/sheetImport.js";
import {
  CSTEP_EXPENSE_CATEGORY_LABEL,
  categoryOfClaimTravelMode,
  categoryOfExpenseLine,
  categoryOfServiceType,
  isExpenseLineHead,
  type CstepExpenseCategory,
} from "../models/cstep/expenseCategories.js";

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
// Step 1 Polish (Part B) cancelled DRAFT/SUBMITTED/RETURNED. Exit paths
// extend it to an approved trip up to and including REPORT_PENDING (APPROVED/
// ARRANGING/ARRANGED/REPORT_PENDING) — a reason is mandatory there.
// REPORT_PENDING is included because report/start auto-fires just by opening
// the report page, so it doesn't mean the report was filed. Never once the
// report is submitted or money has moved (REPORT_SUBMITTED onwards).
const CANCELLABLE_STATUSES = new Set(["DRAFT", "SUBMITTED", "RETURNED", "APPROVED", "ARRANGING", "ARRANGED", "REPORT_PENDING"]);
const POST_APPROVAL_CANCELLABLE = new Set(["APPROVED", "ARRANGING", "ARRANGED", "REPORT_PENDING"]);
const FORM_TYPES = new Set<string>(CSTEP_FORM_TYPES);

/** Resolves the formType for a create payload. An OMITTED formType still
 * defaults to TOUR_PROPOSAL (existing clients keep behaving exactly as before
 * Event Request existed), but a value that is present and not a known form
 * type resolves to null — the caller refuses it — instead of silently
 * becoming a Tour Proposal (claims addition: a claim sent to a backend that
 * didn't know its type used to be saved/validated as a Tour). Immutable
 * after creation: pickFields() deliberately does NOT include formType, so a
 * PATCH body can never change it. */
function resolveFormType(body: any): CstepFormType | null {
  const raw = body?.formType;
  if (raw === undefined || raw === null || raw === "") return "TOUR_PROPOSAL";
  return FORM_TYPES.has(raw) ? (raw as CstepFormType) : null;
}

/** Statuses at which a claim's settlement is open to the CSTEP Admin. */
const CLAIM_SETTLEMENT_STATUSES = new Set(["APPROVED", "TRANSFERRED_TO_FINANCE", "SETTLED", "REIMBURSED"]);

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
 * The APPROVAL itself — start-review, approve, report/approve. Stricter than
 * callerCanActOnTraveller: when the traveller has a Tour Approver (Manager)
 * assigned, only that User may approve — a CSTEP Admin is refused, never
 * silently let through ahead of the Manager. Only when the traveller has NO
 * approver assigned (the "unassigned" case GET /approvals flags) does a CSTEP
 * Admin approve as the fallback. An Admin who IS the assigned approver
 * approves as that approver. Everything else at the approval stage (return,
 * reject, amend / reduce, report send-back) keeps callerCanActOnTraveller.
 */
const ONLY_ASSIGNED_MANAGER = "Only the assigned manager can approve this";
/** Returns the refusal message, or null when the caller may approve. */
async function callerApprovalRefusal(req: any, travelerProfileId: any): Promise<string | null> {
  const traveller: any = await TravellerProfile.findOne({
    _id: travelerProfileId,
    workspaceId: req.workspaceObjectId,
  })
    .select("tourApproverId")
    .lean();
  if (traveller?.tourApproverId) {
    return String(traveller.tourApproverId) === ownerId(req) ? null : ONLY_ASSIGNED_MANAGER;
  }
  return isCstepAdmin(req) ? null : "This traveller has no approver assigned — only a CSTEP Admin can approve it";
}

/**
 * #12 — the Travel Desk for this traveller: the holder of the workspace
 * Travel Desk grant (every traveller — CstepTravelDeskGrant), or the User
 * this traveller has assigned as their Official (TravellerProfile.
 * officialUserId — that traveller only). Being a CSTEP Admin is NOT enough;
 * an Admin is the Travel Desk only if granted or assigned.
 */
async function callerIsTravelDesk(req: any, travelerProfileId: any): Promise<boolean> {
  if (await holdsTravelDeskGrant(req)) return true;
  const traveller: any = await TravellerProfile.findOne({
    _id: travelerProfileId,
    workspaceId: req.workspaceObjectId,
  })
    .select("officialUserId")
    .lean();
  if (!traveller?.officialUserId) return false;
  return String(traveller.officialUserId) === ownerId(req);
}

/**
 * Step 3 — per-request ARRANGEMENT authority, the gate on every Travel Desk
 * action (arranging, vendor options, change requests, settlement): the
 * traveller's Travel Desk (callerIsTravelDesk), or — #12 — a CSTEP Admin who
 * is not, as an Admin OVERRIDE. The override is never refused (the Admin is
 * top authority) but it is stamped on the request (req.cstepAdminOverride)
 * so the route's audit entry carries adminOverride: true (adminOverrideMark)
 * and reads as an override, not a desk action.
 */
async function callerCanArrangeForTraveller(req: any, travelerProfileId: any): Promise<boolean> {
  if (await callerIsTravelDesk(req, travelerProfileId)) return true;
  if (!isCstepAdmin(req)) return false;
  req.cstepAdminOverride = true;
  return true;
}

/** Spread into a Travel Desk route's CstepApproval entry: { adminOverride:
 * true } when the gate passed only as an Admin override, else nothing. */
function adminOverrideMark(req: any): { adminOverride?: true } {
  return req.cstepAdminOverride ? { adminOverride: true } : {};
}

/**
 * Step 6 — per-request FINANCE authority: a CSTEP Admin (any request), or
 * the specific User this traveller has assigned as their Finance user
 * (TravellerProfile.financeUserId) — only that traveller's requests. Same
 * shape as the Approver/Official checks above; the third slot in the
 * Traveller → Approver → Official → Finance mapping.
 */
async function callerCanFinanceForTraveller(req: any, travelerProfileId: any): Promise<boolean> {
  if (isCstepAdmin(req)) return true;
  const traveller: any = await TravellerProfile.findOne({
    _id: travelerProfileId,
    workspaceId: req.workspaceObjectId,
  })
    .select("financeUserId")
    .lean();
  if (!traveller?.financeUserId) return false;
  return String(traveller.financeUserId) === ownerId(req);
}

/**
 * Recording a PAYMENT — every payment-recording action: the reimbursement
 * (POST /requests/:id/finance/settle, Tour / Event and claim alike), a
 * vendor line marked paid or unpaid (PATCH /arrangements/:lineId/payment)
 * and the vendor-payables import (cstep.vendorPayables.ts, per row). Only
 * the traveller's assigned Finance user (TravellerProfile.financeUserId) —
 * no CSTEP Admin, no Official, and no fallback: with no Finance user
 * assigned the payment is blocked for everyone until an Admin assigns one
 * (a mapping action, workspace.travellers.ts). An Admin who IS the assigned
 * Finance user records it as that user. Setting a missing amount
 * (missing-amount) is not a payment and stays Finance-or-Admin; so does
 * Finance's send-back (finance/return). Returns the refusal, or null.
 */
async function callerPaymentRefusal(req: any, travelerProfileId: any): Promise<string | null> {
  const traveller: any = await TravellerProfile.findOne({
    _id: travelerProfileId,
    workspaceId: req.workspaceObjectId,
  })
    .select("financeUserId")
    .lean();
  if (!traveller?.financeUserId) return NO_FINANCE_ASSIGNED;
  return String(traveller.financeUserId) === ownerId(req) ? null : ONLY_ASSIGNED_FINANCE;
}

/** Who has the vendor ledger past the arrange step (the "What was arranged"
 * section, its payment badges): the traveller's Official, their Finance
 * user, or a CSTEP Admin. Seeing it only — marking a line paid is the
 * assigned Finance user's alone (callerPaymentRefusal). */
async function callerHasVendorLedger(req: any, travelerProfileId: any): Promise<boolean> {
  return (
    (await callerCanArrangeForTraveller(req, travelerProfileId)) ||
    (await callerCanFinanceForTraveller(req, travelerProfileId))
  );
}

/**
 * The traveller's mapped Finance user ONLY — no CSTEP Admin pass. A claim's
 * reimbursement is Finance's act: the Admin's part ends at verify →
 * send-to-Finance (POST /claim/verify). An Admin who is also mapped as this
 * traveller's Finance user still qualifies, as that Finance user.
 */
async function callerIsTravellerFinanceUser(req: any, travelerProfileId: any): Promise<boolean> {
  const traveller: any = await TravellerProfile.findOne({
    _id: travelerProfileId,
    workspaceId: req.workspaceObjectId,
  })
    .select("financeUserId")
    .lean();
  if (!traveller?.financeUserId) return false;
  return String(traveller.financeUserId) === ownerId(req);
}

/**
 * READ authority over a traveller's case for anyone in its pipeline: a
 * CSTEP Admin, the workspace Travel Desk (#12), or the traveller's mapped
 * Approver, Official or Finance user. Used by the read-only routes (activity log, proposal PDF, packet,
 * travel report) — before Step 6 those admitted only owner/approver (+
 * official for report/packet), so a non-admin Finance user opening a case
 * from their own queue was refused the activity log.
 */
async function callerCanViewTraveller(req: any, travelerProfileId: any): Promise<boolean> {
  // #12 — the workspace Travel Desk works every traveller's case, so reads them too.
  if (isCstepAdmin(req) || (await holdsTravelDeskGrant(req))) return true;
  const traveller: any = await TravellerProfile.findOne({
    _id: travelerProfileId,
    workspaceId: req.workspaceObjectId,
  })
    .select("tourApproverId officialUserId financeUserId")
    .lean();
  if (!traveller) return false;
  const uid = ownerId(req);
  return [traveller.tourApproverId, traveller.officialUserId, traveller.financeUserId].some(
    (id) => id && String(id) === uid,
  );
}

/**
 * Claims addition — authority over a request's SETTLEMENT (view / edit
 * lines). A claim has no Official stage: its settlement is verified by a
 * CSTEP Admin, so for LOCAL_TRAVEL_CLAIM / EXPENSE_CLAIM only an Admin
 * qualifies. Every other form type keeps the Official/Admin rule
 * (callerCanArrangeForTraveller), unchanged.
 */
async function callerCanSettleRequest(req: any, doc: any): Promise<boolean> {
  if (isClaimFormType(doc.formType)) return isCstepAdmin(req);
  return callerCanArrangeForTraveller(req, doc.travelerProfileId);
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
 * Reference numbers issued at approval — all from the CSTEP serial counter
 * (utils/cstepSequence.ts), one running series per workspace + financial
 * year (IST):
 *   TOUR_PROPOSAL      → TIN  "0001/1026"
 *   LOCAL_TRAVEL_CLAIM → LTC  "LTC0001/1026"
 *   EXPENSE_CLAIM      → EXP  "EXP0001/1026"
 *   EVENT_REQUEST      → EVR  "EVR0001/1026"
 * The serial and the MMYY are read from the same instant, so a number can
 * never pair one financial year's serial with another year's month. The
 * counter increment runs inside the approve transaction (an abort rolls it
 * back). References issued before this format stay as they were.
 */
const CLAIM_REFERENCE_SERIES: Record<string, "LTC" | "EXP" | "EVR"> = {
  LOCAL_TRAVEL_CLAIM: "LTC",
  EXPENSE_CLAIM: "EXP",
  EVENT_REQUEST: "EVR",
};

async function issueApprovalReference(
  workspaceId: any,
  formType: string,
  session: any,
): Promise<{ ref: string; key: string }> {
  const at = new Date();
  const claimSeries = CLAIM_REFERENCE_SERIES[formType];
  const series = claimSeries || "TIN";
  const { seq, key } = await nextCstepSerial(workspaceId, series, { at, session });
  const mmyy = cstepMMYY(at);
  return {
    ref: claimSeries ? formatCstepClaimReference(claimSeries, seq, mmyy) : formatCstepTin(seq, mmyy),
    key,
  };
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

const LOCAL_TRAVEL_MODES = new Set<string>(CSTEP_LOCAL_TRAVEL_MODES);

/** A non-negative finite number, or undefined/null/"" (not set). */
function isOptionalAmount(v: any): boolean {
  if (v === undefined || v === null || v === "") return true;
  const n = Number(v);
  return isFinite(n) && n >= 0;
}

/**
 * Manual validation for a Local Travel Claim (claims addition). The header
 * reuses the Tour fields (purpose, project, claim period in departureDate/
 * returnDate). Every line must fall inside the claim period. A travel line
 * needs a receipt (attachmentId) or an explicit noBill — noBill lines are
 * what the claim's Declaration lists. Empty rows are filtered client-side
 * before this ever runs, so an incomplete row here is a real error.
 */
function validateLocalTravelClaimPayload(body: any): string | null {
  if (!String(body?.purpose || "").trim()) return "Purpose of the claim is required";

  if (!isValidDateStr(body?.departureDate)) return "Claim period start date is required";
  if (!isValidDateStr(body?.returnDate)) return "Claim period end date is required";
  const start = String(body.departureDate);
  const end = String(body.returnDate);
  if (new Date(end).getTime() < new Date(start).getTime()) {
    return "Claim period end date must be on or after the start date";
  }
  const inPeriod = (d: string) => d >= start && d <= end;

  const travelLines = Array.isArray(body?.travelLines) ? body.travelLines : [];
  const foodLines = Array.isArray(body?.foodLines) ? body.foodLines : [];

  for (let i = 0; i < travelLines.length; i++) {
    const l = travelLines[i] || {};
    const n = `Travel line ${i + 1}`;
    if (!isValidDateStr(l.date)) return `${n}: date is required`;
    if (!inPeriod(String(l.date))) return `${n}: date must fall within the claim period`;
    if (!String(l.from || "").trim()) return `${n}: from is required`;
    if (!String(l.to || "").trim()) return `${n}: to is required`;
    if (!LOCAL_TRAVEL_MODES.has(l.mode)) return `${n}: mode of travel is required`;
    const fare = Number(l.fare);
    if (!isFinite(fare) || fare <= 0) return `${n}: fare must be more than zero`;
    if (!l.attachmentId && l.noBill !== true) return `${n}: attach the bill, or mark it as having no bill`;
  }

  for (let i = 0; i < foodLines.length; i++) {
    const l = foodLines[i] || {};
    const n = `Food line ${i + 1}`;
    if (!isValidDateStr(l.date)) return `${n}: date is required`;
    if (!inPeriod(String(l.date))) return `${n}: date must fall within the claim period`;
    const amount = Number(l.amount);
    if (!isFinite(amount) || amount <= 0) return `${n}: amount must be more than zero`;
  }

  if (!isOptionalAmount(body?.otherExpenses)) return "Other expenses must be a non-negative amount";
  if (!isOptionalAmount(body?.advanceTaken)) return "Advance taken must be a non-negative amount";

  if (travelLines.length === 0 && foodLines.length === 0 && !(Number(body?.otherExpenses) > 0)) {
    return "Add at least one travel or food line, or an other-expenses amount";
  }

  return null;
}

/**
 * Manual validation for an Expense Claim (claims module 2). Same header as the
 * Local Travel Claim (purpose, project = "bill to", claim period). At least
 * one expense line, each inside the claim period with a description and a
 * positive amount. One optional tax amount. No Declaration path: the tax
 * invoice must be attached — on a line, or at claim level — and a line with
 * no invoice of its own is covered only by a claim-level invoice.
 */
function validateExpenseClaimPayload(body: any): string | null {
  if (!String(body?.purpose || "").trim()) return "Purpose of the claim is required";

  if (!isValidDateStr(body?.departureDate)) return "Claim period start date is required";
  if (!isValidDateStr(body?.returnDate)) return "Claim period end date is required";
  const start = String(body.departureDate);
  const end = String(body.returnDate);
  if (new Date(end).getTime() < new Date(start).getTime()) {
    return "Claim period end date must be on or after the start date";
  }

  const lines = Array.isArray(body?.expenseLines) ? body.expenseLines : [];
  if (lines.length === 0) return "Add at least one expense line";
  const hasClaimInvoice = Array.isArray(body?.invoiceAttachmentIds) && body.invoiceAttachmentIds.length > 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] || {};
    const n = `Expense line ${i + 1}`;
    if (!isValidDateStr(l.date)) return `${n}: date is required`;
    if (String(l.date) < start || String(l.date) > end) return `${n}: date must fall within the claim period`;
    if (!String(l.description || "").trim()) return `${n}: description is required`;
    const amount = Number(l.amount);
    if (!isFinite(amount) || amount <= 0) return `${n}: amount must be more than zero`;
    if (!l.attachmentId && !hasClaimInvoice) return `${n}: attach its invoice, or attach the tax invoice for the whole claim`;
    if (l.category !== undefined && l.category !== null && l.category !== "" && !isExpenseLineHead(l.category)) {
      return `${n}: pick an expense head from the list`;
    }
  }

  if (!isOptionalAmount(body?.taxAmount)) return "Tax amount must be a non-negative amount";
  if (!isOptionalAmount(body?.advanceTaken)) return "Advance taken must be a non-negative amount";
  return null;
}

/**
 * Manual validation dispatcher — routes to each form type's own validator.
 * Every lifecycle route (submit/withdraw/cancel/approve/return/amend) calls
 * this ONE function; none of them know or care which formType they're
 * validating. An unknown form type is an error, never a Tour Proposal.
 */
function validatePayload(body: any): string | null {
  const formType = resolveFormType(body);
  let error: string | null;
  switch (formType) {
    case "TOUR_PROPOSAL":
      error = validateTourProposalPayload(body);
      break;
    case "EVENT_REQUEST":
      error = validateEventRequestPayload(body);
      break;
    case "LOCAL_TRAVEL_CLAIM":
      error = validateLocalTravelClaimPayload(body);
      break;
    case "EXPENSE_CLAIM":
      error = validateExpenseClaimPayload(body);
      break;
    default:
      return "Unknown form type";
  }
  if (error) return error;
  // Project Master — every form type needs a project picked from the master.
  // A request made before the master keeps its free-text project, which
  // still counts (it is never rewritten).
  if (!body?.projectId && !String(body?.project || "").trim()) return "Choose a project";
  return null;
}

/**
 * Project Master — resolves a picked projectId (create / edit) into the
 * request's snapshot: projectId, projectCode, projectName, projectTallyCC,
 * and `project` = "CODE — Name" (the display text every existing reader —
 * lists, PDFs, the Travel Register — already shows). The project must be in
 * this workspace and active; an inactive one is accepted only if it is the
 * request's own current project (an edit that leaves it alone). Mutates
 * `fields`; returns an error message or null. No projectId in the body ->
 * nothing changes.
 */
async function applyProjectSelection(req: any, fields: any, current?: any): Promise<string | null> {
  if (fields.projectId === undefined) return null;
  const raw = fields.projectId == null ? "" : String(fields.projectId).trim();
  if (!raw) {
    delete fields.projectId;
    return "Choose a project";
  }
  if (!mongoose.Types.ObjectId.isValid(raw)) return "Unknown project";
  const project: any = await CstepProject.findOne({ _id: raw, workspaceId: req.workspaceObjectId }).lean();
  if (!project) return "Unknown project";
  const unchanged = current?.projectId && String(current.projectId) === raw;
  if (!project.isActive && !unchanged) return `Project ${project.projectCode} is inactive — choose another`;
  fields.projectId = project._id;
  fields.projectCode = project.projectCode;
  fields.projectName = project.projectName;
  fields.projectTallyCC = project.tallyProjectCC || undefined;
  fields.project = `${project.projectCode} — ${project.projectName}`;
  return null;
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
    // Project Master — the picked project's id; the server snapshots it
    // (applyProjectSelection). Free-text `project` is no longer accepted —
    // it survives only, untouched, on requests made before the master.
    projectId,
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
    perDiemEligible,
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
    // Claims addition — per claim type (see scopeFieldsToFormType).
    travelLines,
    foodLines,
    otherExpenses,
    advanceTaken,
    expenseLines,
    taxAmount,
    invoiceAttachmentIds,
  } = body || {};

  return {
    travelerProfileId,
    type,
    purpose,
    projectId,
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
    perDiemEligible,
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
    travelLines,
    foodLines,
    otherExpenses,
    advanceTaken,
    expenseLines,
    taxAmount,
    invoiceAttachmentIds,
  };
}

/** Claims addition — the fields each claim type may carry: the shared header
 * plus its own line/amount fields. Nothing Tour- or Event-specific, and
 * neither claim type carries the other's fields. */
const CLAIM_HEADER_FIELDS = [
  "travelerProfileId",
  "purpose",
  "projectId",
  "projectDebitable",
  "departureDate",
  "returnDate",
  "otherInstructions",
  "advanceTaken",
];
const CLAIM_FIELDS_BY_TYPE: Record<string, Set<string>> = {
  LOCAL_TRAVEL_CLAIM: new Set([...CLAIM_HEADER_FIELDS, "travelLines", "foodLines", "otherExpenses"]),
  EXPENSE_CLAIM: new Set([...CLAIM_HEADER_FIELDS, "expenseLines", "taxAmount", "invoiceAttachmentIds"]),
};
const CLAIM_ONLY_FIELDS = [
  "travelLines",
  "foodLines",
  "otherExpenses",
  "advanceTaken",
  "expenseLines",
  "taxAmount",
  "invoiceAttachmentIds",
];

const asOid = (v: any) => (v && mongoose.Types.ObjectId.isValid(String(v)) ? new mongoose.Types.ObjectId(String(v)) : undefined);
const asAmount = (v: any) => (v === undefined || v === null || v === "" ? undefined : Number(v));

/**
 * Keeps each form type's documents to its own field set: a claim drops every
 * Tour/Event field, and a Tour/Event payload drops the claim fields (so a
 * stray travelLines can never land on a Tour Proposal). Claim lines are
 * normalised here too — only the known keys survive, a line with a receipt
 * is never also noBill, and amounts are numbers. Mutates and returns
 * `fields`.
 */
function scopeFieldsToFormType(fields: any, formType: CstepFormType): any {
  if (isClaimFormType(formType)) {
    const allowed = CLAIM_FIELDS_BY_TYPE[formType];
    for (const k of Object.keys(fields)) if (!allowed.has(k)) delete fields[k];
    if (Array.isArray(fields.travelLines)) {
      fields.travelLines = fields.travelLines.map((l: any) => {
        const attachmentId = asOid(l?.attachmentId);
        return {
          ...(asOid(l?._id) ? { _id: asOid(l._id) } : {}),
          date: l?.date || undefined,
          from: l?.from,
          to: l?.to,
          mode: l?.mode || undefined,
          fare: asAmount(l?.fare),
          remarks: l?.remarks,
          attachmentId,
          noBill: !attachmentId && l?.noBill === true,
        };
      });
    }
    if (Array.isArray(fields.foodLines)) {
      fields.foodLines = fields.foodLines.map((l: any) => ({
        ...(asOid(l?._id) ? { _id: asOid(l._id) } : {}),
        date: l?.date || undefined,
        amount: asAmount(l?.amount),
        remarks: l?.remarks,
        attachmentId: asOid(l?.attachmentId),
      }));
    }
    if (Array.isArray(fields.expenseLines)) {
      fields.expenseLines = fields.expenseLines.map((l: any) => ({
        ...(asOid(l?._id) ? { _id: asOid(l._id) } : {}),
        date: l?.date || undefined,
        description: l?.description,
        amount: asAmount(l?.amount),
        attachmentId: asOid(l?.attachmentId),
        // Passed through as given: validateExpenseClaimPayload refuses an unknown head (400).
        category: l?.category ? String(l.category) : undefined,
      }));
    }
    if (Array.isArray(fields.invoiceAttachmentIds)) {
      fields.invoiceAttachmentIds = [...new Set(fields.invoiceAttachmentIds.map((v: any) => String(v)))]
        .map(asOid)
        .filter(Boolean);
    }
    if ("otherExpenses" in fields) fields.otherExpenses = asAmount(fields.otherExpenses);
    if ("taxAmount" in fields) fields.taxAmount = asAmount(fields.taxAmount);
    if ("advanceTaken" in fields) fields.advanceTaken = asAmount(fields.advanceTaken);
  } else {
    for (const k of CLAIM_ONLY_FIELDS) delete fields[k];
    if (fields.perDiemEligible !== undefined) fields.perDiemEligible = isPerDiemEligible(fields);
  }
  return fields;
}

/** Every receipt/invoice id a claim references — its lines' and, for an
 * Expense Claim, its claim-level invoices. */
function claimAttachmentIds(doc: any): string[] {
  return [
    ...[...(doc?.travelLines || []), ...(doc?.foodLines || []), ...(doc?.expenseLines || [])].map((l: any) => l?.attachmentId),
    ...(doc?.invoiceAttachmentIds || []),
  ]
    .filter(Boolean)
    .map(String);
}

/**
 * Claims addition — a claim line may only point at a receipt in this
 * workspace that the caller staged themselves, or one already linked to this
 * same request (an unchanged line on edit). Anything else — another user's
 * staged upload, another request's receipt — is refused before the claim is
 * saved. Returns an error string, or null.
 */
async function checkClaimAttachments(req: any, fields: any, requestId?: any): Promise<string | null> {
  const ids = [...new Set(claimAttachmentIds(fields))];
  if (ids.length === 0) return null;
  const found: any[] = await CstepAttachment.find({ _id: { $in: ids }, workspaceId: req.workspaceObjectId })
    .select("_id createdBy travelRequestId")
    .lean();
  const uid = ownerId(req);
  for (const id of ids) {
    const a = found.find((f) => String(f._id) === id);
    if (!a) return "A claim line references a receipt that does not exist";
    const linkedHere = requestId && a.travelRequestId && String(a.travelRequestId) === String(requestId);
    const ownUnlinked = !a.travelRequestId && String(a.createdBy) === uid;
    if (!linkedHere && !ownUnlinked) return "A claim line references a receipt that is not yours to attach";
  }
  return null;
}

/** Links every receipt a saved claim references to the claim (sets its
 * travelRequestId). Staged uploads that ended up unreferenced stay unlinked. */
async function linkClaimAttachments(req: any, doc: any): Promise<void> {
  const ids = claimAttachmentIds(doc);
  if (ids.length === 0) return;
  await CstepAttachment.updateMany(
    { _id: { $in: ids }, workspaceId: req.workspaceObjectId, travelRequestId: { $exists: false } },
    { $set: { travelRequestId: doc._id } },
  );
}

/** Claim line mode -> the settlement's service type (and so its bucket). */
const CLAIM_MODE_TO_SERVICE_TYPE: Record<string, CstepServiceType> = {
  CAB: "CAB",
  LOCAL_TAXI: "CAB",
  METRO: "TRAIN",
  BUS: "BUS",
  OWN_VEHICLE: "OTHER",
};
const CLAIM_MODE_LABEL: Record<string, string> = {
  CAB: "Cab",
  LOCAL_TAXI: "Local taxi",
  METRO: "Metro",
  BUS: "Bus",
  OWN_VEHICLE: "Own vehicle",
};

/**
 * Claims addition — the CLAIM_LINE settlement rows seeded at a claim's
 * approval, one per travel line, one per food line, and one for a non-zero
 * other-expenses amount. All PERSONAL (the claimant paid), all unverified,
 * each carrying its line's receipt. sourceId is the line's own _id (the
 * other-expenses row points at the request itself — it has no line).
 */
function buildClaimSettlementLines(doc: any): Array<{
  source: CstepSettlementLineSource;
  sourceId: any;
  description: string;
  mode: CstepServiceType;
  category: CstepExpenseCategory;
  itemDate?: string;
  amountInr: number;
  classification: CstepSettlementLineClassification;
  classificationOverridden: false;
  verified: false;
  attachmentId?: any;
}> {
  const base = { source: "CLAIM_LINE" as const, classification: "PERSONAL" as const, classificationOverridden: false as const, verified: false as const };
  const rows: any[] = [];
  for (const l of doc.travelLines || []) {
    rows.push({
      ...base,
      sourceId: l._id,
      description: `${CLAIM_MODE_LABEL[l.mode] || "Travel"}: ${[l.from, l.to].filter(Boolean).join(" → ")}${l.noBill ? " (no bill)" : ""}`,
      mode: CLAIM_MODE_TO_SERVICE_TYPE[l.mode] || "OTHER",
      category: categoryOfClaimTravelMode(l.mode),
      itemDate: l.date || undefined,
      amountInr: Math.round((Number(l.fare) || 0) * 100) / 100,
      attachmentId: l.attachmentId || undefined,
    });
  }
  for (const l of doc.foodLines || []) {
    rows.push({
      ...base,
      sourceId: l._id,
      description: `Food${l.remarks ? `: ${l.remarks}` : ""}`,
      mode: "OTHER",
      category: "FOOD",
      itemDate: l.date || undefined,
      amountInr: Math.round((Number(l.amount) || 0) * 100) / 100,
      attachmentId: l.attachmentId || undefined,
    });
  }
  if (Number(doc.otherExpenses) > 0) {
    rows.push({
      ...base,
      sourceId: doc._id,
      description: "Other expenses",
      mode: "OTHER",
      category: "OTHER",
      amountInr: Math.round(Number(doc.otherExpenses) * 100) / 100,
    });
  }
  // Expense Claim (module 2) — one row per expense line (the "other"
  // bucket), then the single tax amount as its own verifiable row, carrying
  // the first claim-level invoice (which is what evidences the tax).
  for (const l of doc.expenseLines || []) {
    rows.push({
      ...base,
      sourceId: l._id,
      description: String(l.description || "Expense"),
      mode: "OTHER",
      category: categoryOfExpenseLine(l),
      itemDate: l.date || undefined,
      amountInr: Math.round((Number(l.amount) || 0) * 100) / 100,
      attachmentId: l.attachmentId || doc.invoiceAttachmentIds?.[0] || undefined,
    });
  }
  if (Number(doc.taxAmount) > 0) {
    rows.push({
      ...base,
      sourceId: doc._id,
      description: "Tax (IGST)",
      mode: "OTHER",
      category: "TAX",
      amountInr: Math.round(Number(doc.taxAmount) * 100) / 100,
      attachmentId: doc.invoiceAttachmentIds?.[0] || undefined,
    });
  }
  return rows;
}

/** Claims addition — net-of-advance split for a claim's settlement. */
function claimDue(amountClaimed: number, advanceTaken: number): { amountDueByCstep: number; amountDueToCstep: number } {
  const net = Math.round((amountClaimed - (advanceTaken || 0)) * 100) / 100;
  return { amountDueByCstep: net > 0 ? net : 0, amountDueToCstep: net < 0 ? Math.round(-net * 100) / 100 : 0 };
}

/** Recomputes a settlement's buckets/totals from its current lines (the
 * existing recomputeSettlementTotals) and, for a claim, its net-of-advance
 * due figures. Assigns onto `settlement`; the caller saves. */
function applySettlementTotals(settlement: any, lines: any[], doc: any) {
  const { buckets, totalCostOfTour, amountClaimed } = recomputeSettlementTotals(lines, settlement.perDiem?.amountInr || 0);
  settlement.buckets = buckets;
  settlement.totalCostOfTour = totalCostOfTour;
  settlement.amountClaimed = amountClaimed;
  if (isClaimFormType(doc.formType)) {
    const due = claimDue(amountClaimed, Number(settlement.advanceTaken) || 0);
    settlement.amountDueByCstep = due.amountDueByCstep;
    settlement.amountDueToCstep = due.amountDueToCstep;
  }
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
/**
 * F6 — is this arrangement line something the Official actually arranged?
 * The Step 3 seeder puts down one PENDING row per requested mode/service,
 * and a row nobody touches (mode "Road" seeding a BUS beside the Cab that
 * "Transport required" already seeded, say) used to flow all the way down:
 * a Bus leg the traveller had to delete, then a ₹0 "No document"
 * settlement line. Downstream seeders take a line only if it was marked
 * ARRANGED or carries an amount — an amount typed by an Official who
 * forgot the toggle still counts; an untouched PENDING row never does.
 */
function arrangementIsReal(a: any): boolean {
  return a.status === "ARRANGED" || Number(a.amount) > 0;
}

/** F6 — the seed rows an Official never touched at all: still PENDING, no
 * amount, no details of their own (a seeded Cab/Hotel carries the
 * traveller's note as details; a seeded mode row has none). These are
 * dropped at mark-arranged rather than frozen into the case. */
function arrangementIsUntouchedSeed(a: any): boolean {
  return (
    a.source === "REQUESTED" &&
    a.status === "PENDING" &&
    !(Number(a.amount) > 0) &&
    !String(a.details || "").trim() &&
    !a.vendorId // choosing a vendor is a touch — the row survives mark-arranged
  );
}

/**
 * Vendor + payment addition — the vendor chosen on an arrangement line, for
 * PATCH/POST /requests/:id/arrangements. Only touches the line when the body
 * carries `vendorId` at all: null/"" clears it; an id must be an ACTIVE
 * vendor of this workspace, and its code + name are snapshotted onto the
 * line. Re-sending the vendor the line already has is a no-op, so a vendor
 * deactivated after it was chosen doesn't block an unrelated edit.
 */
async function resolveArrangementVendor(
  req: any,
  body: any,
  current?: any,
): Promise<
  | { ok: true; touched: false }
  | { ok: true; touched: true; fields: { vendorId?: any; vendorCode?: string; vendorName?: string } }
  | { ok: false; status: number; error: string }
> {
  if (!("vendorId" in body)) return { ok: true, touched: false };
  const raw = body.vendorId == null ? "" : String(body.vendorId).trim();
  if (!raw) {
    if (!current?.vendorId) return { ok: true, touched: false };
    return { ok: true, touched: true, fields: { vendorId: undefined, vendorCode: undefined, vendorName: undefined } };
  }
  if (current?.vendorId && String(current.vendorId) === raw) return { ok: true, touched: false };
  if (!mongoose.isValidObjectId(raw)) return { ok: false, status: 400, error: "Invalid vendor id" };
  const vendor: any = await CstepVendor.findOne({ _id: raw, workspaceId: req.workspaceObjectId })
    .select("vendorCode name isActive")
    .lean();
  if (!vendor) return { ok: false, status: 404, error: "Vendor not found in this workspace" };
  if (!vendor.isActive) return { ok: false, status: 400, error: `Vendor ${vendor.vendorCode} (${vendor.name}) is inactive` };
  return { ok: true, touched: true, fields: { vendorId: vendor._id, vendorCode: vendor.vendorCode, vendorName: vendor.name } };
}

/** Vendor payment — the request statuses from ARRANGING onwards, where a
 * line's vendor can be marked paid (the Official can record it at the
 * arrange step, alongside choosing the vendor). */
const VENDOR_PAYABLE_STATUSES = new Set<string>(CSTEP_VENDOR_PAYABLE_STATUSES);

function buildSeedReportLegs(arrangements: any[]): Array<{
  direction: "ONWARD";
  travelMode: CstepServiceType;
  fare?: number;
  currency: string;
  paidBy: "CSTEP";
  remarks?: string;
  source: "SEEDED";
}> {
  return arrangements.filter(arrangementIsReal).map((a) => ({
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

/** How many personal / non-CSTEP days the proposer declared — the count
 * field, or the listed dates when no count was typed. */
function personalDayCount(personalDays?: { count?: number; dates?: string[] }): number {
  const count = Number(personalDays?.count);
  if (isFinite(count) && count > 0) return Math.floor(count);
  return Array.isArray(personalDays?.dates) ? personalDays!.dates.filter(Boolean).length : 0;
}

/** Per Diem Eligible — only an explicit No turns it off; a request made
 * before the field existed (missing / null) counts as Yes. */
export function isPerDiemEligible(request: { perDiemEligible?: unknown }): boolean {
  return request?.perDiemEligible !== false && request?.perDiemEligible !== "false";
}

/** Per-diem days for a request: the trip's inclusive day count less the
 * personal days the proposal form labels "excluded from per-diem
 * eligibility", floored at 0. An Event Request uses its event start/end
 * dates the same way. */
export function computePerDiemDays(request: {
  departureDate?: string;
  returnDate?: string;
  personalDays?: { count?: number; dates?: string[] };
}): number {
  return Math.max(0, computeTripDays(request.departureDate, request.returnDate) - personalDayCount(request.personalDays));
}

/** The default per-diem rate for this request, in order:
 *   1. the traveller's own rate for the trip type
 *      (TravellerProfile.perDiemRateDomesticInr / perDiemRateInternationalInr);
 *   2. the workspace's CstepPerDiemPolicy for the trip type (and, for
 *      INTERNATIONAL, its first listed country) — see CstepPerDiemPolicy.ts;
 *   3. null — the caller seeds 0 and the Official keys in a rate manually via
 *      the perdiem PATCH (per the task's "else Admin enters" fallback) rather
 *      than this route inventing a number.
 * The policy step is not date-filtered against effectiveFrom/To beyond
 * preferring the most recent — a full date-effective-range resolver is out
 * of scope for this pass. */
export async function findDefaultPerDiemRate(
  workspaceId: any,
  request: any,
  traveller?: { perDiemRateDomesticInr?: number | null; perDiemRateInternationalInr?: number | null } | null,
): Promise<{ rate: number; currency: string } | null> {
  const tripType = request.type === "INTERNATIONAL" ? "INTERNATIONAL" : "DOMESTIC";
  const ownRate =
    tripType === "INTERNATIONAL" ? traveller?.perDiemRateInternationalInr : traveller?.perDiemRateDomesticInr;
  if (typeof ownRate === "number" && isFinite(ownRate) && ownRate >= 0) return { rate: ownRate, currency: "INR" };

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
    category: CstepExpenseCategory;
    itemDate?: string;
    amountInr: number;
    classification: CstepSettlementLineClassification;
    classificationOverridden: false;
    verified: false;
    attachmentId?: any;
  }>
> {
  const [arrangements, legs] = await Promise.all([
    CstepArrangement.find({ workspaceId, requestId }).sort({ createdAt: 1, _id: 1 }).lean(),
    CstepReportLeg.find({ workspaceId, requestId }).sort({ createdAt: 1, _id: 1 }).lean(),
  ]);

  // Carry the traveller's uploaded document onto ARRANGEMENT-sourced lines.
  // The receipt/boarding pass for a CSTEP-paid service is uploaded on the
  // Step 4 report leg that was SEEDED from that arrangement (report/start
  // creates one SEEDED leg per arrangement, in arrangement order, with
  // travelMode = arrangedType). Those legs are deliberately NOT turned into
  // their own settlement lines below (they would double-count the
  // arrangement), so without this their attachment never reached Step 5 and
  // the Official saw "No document" on every official line. There is no
  // stored back-link from leg to arrangement, so pair them the same way they
  // were seeded: in creation order, matched on travelMode === arrangedType,
  // each leg consumed at most once. A SEEDED leg the traveller has since
  // re-typed, deleted, or flipped to SELF simply does not pair (SELF legs
  // become their own PERSONAL line, attachment included, further down).
  const seededCstepLegsByMode = new Map<string, any[]>();
  for (const leg of legs as any[]) {
    if (leg.source !== "SEEDED" || leg.paidBy !== "CSTEP") continue;
    const bucket = seededCstepLegsByMode.get(leg.travelMode) ?? [];
    bucket.push(leg);
    seededCstepLegsByMode.set(leg.travelMode, bucket);
  }

  const lines: Array<{
    source: CstepSettlementLineSource;
    sourceId: any;
    description?: string;
    mode: CstepServiceType;
    category: CstepExpenseCategory;
    itemDate?: string;
    amountInr: number;
    classification: CstepSettlementLineClassification;
    classificationOverridden: false;
    verified: false;
    attachmentId?: any;
  }> = [];

  for (const a of arrangements as any[]) {
    if (!arrangementIsReal(a)) continue; // F6 — never seeded a leg either, so nothing to pair
    const pairedLeg = seededCstepLegsByMode.get(a.arrangedType)?.shift();
    lines.push({
      source: "ARRANGEMENT",
      sourceId: a._id,
      description: a.details || undefined,
      mode: a.arrangedType,
      category: categoryOfServiceType(a.arrangedType),
      amountInr: a.amountInr || 0,
      classification: "OFFICIAL",
      classificationOverridden: false,
      verified: false,
      attachmentId: pairedLeg?.attachmentId || undefined,
    });
  }

  for (const leg of legs as any[]) {
    if (leg.paidBy === "SELF") {
      lines.push({
        source: "REPORT_LEG",
        sourceId: leg._id,
        description: [leg.fromLocation, leg.toLocation].filter(Boolean).join(" → ") || leg.remarks || undefined,
        mode: leg.travelMode,
        category: categoryOfServiceType(leg.travelMode),
        itemDate: leg.fromDate || undefined,
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
        category: categoryOfServiceType(leg.travelMode),
        itemDate: leg.fromDate || undefined,
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

    // Resolved server-side (an omitted formType defaults to TOUR_PROPOSAL)
    // rather than trusted from pickFields — formType is server-controlled and
    // immutable once set, same discipline as status/claimReference below. A
    // present-but-unknown formType is refused, never coerced to a Tour.
    const formType = resolveFormType(req.body);
    if (!formType) return res.status(400).json({ error: "Unknown form type" });
    const fields: any = scopeFieldsToFormType(pickFields(req.body), formType);
    fields.formType = formType;
    const admin = isCstepAdmin(req);
    const projectError = await applyProjectSelection(req, fields);
    if (projectError) return res.status(400).json({ error: projectError });

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
    const attachmentError = await checkClaimAttachments(req, fields);
    if (attachmentError) return res.status(400).json({ error: attachmentError });

    const status = req.body?.saveDraft === true ? "DRAFT" : "SUBMITTED";

    const doc = new CstepTravelRequest({
      ...fields,
      workspaceId: req.workspaceObjectId,
      createdBy: new mongoose.Types.ObjectId(uid),
      status,
    });
    await doc.save();
    if (isClaimFormType(doc.formType)) await linkClaimAttachments(req, doc);

    // A request created straight as SUBMITTED gets the same SUBMIT entry
    // the explicit draft → POST /submit path writes, so every submitted
    // request carries a complete trail whichever way it got there.
    if (status === "SUBMITTED") {
      const entry = await CstepApproval.create({
        workspaceId: req.workspaceObjectId,
        entityType: "REQUEST",
        entityId: doc._id,
        stage: "TRAVELER",
        actor: new mongoose.Types.ObjectId(uid),
        action: "SUBMIT",
        at: new Date().toISOString(),
      });
      await notifyCstep("SUBMITTED", doc, { logEntryId: entry._id });
      await ensureClaimDeclarationQuietly(req, doc);
    }

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

    // Same read gate as /activity, /pdf, /packet, /report: the owner, a
    // CSTEP Admin, or the traveller's mapped Approver/Official/Finance
    // user. Any other member of the workspace gets a 403 — a plain
    // requester must not be able to read a colleague's proposal by id.
    const uid = ownerId(req);
    if (String(doc.createdBy) !== uid && !(await callerCanViewTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Not authorized to view this travel request" });
    }

    const admin = isCstepAdmin(req);
    const isClaim = isClaimFormType(doc.formType);
    // canDecide / canDecideReport — the approval-stage card: return, reject,
    // reduce amounts, send a report back (the Manager, or any CSTEP Admin).
    // canApprove / canApproveReport — the Approve button itself, and the
    // auto start-review: callerApprovalRefusal (the assigned Manager only; an
    // Admin just when the traveller has no approver). approvalBlockedReason
    // says why an Admin who can decide can't approve.
    const canAct = admin || (await callerCanActOnTraveller(req, doc.travelerProfileId));
    const canDecide = doc.status === "SUBMITTED" && canAct;
    const canDecideReport = doc.status === "REPORT_UNDER_APPROVAL" && canAct;
    const refusal = canDecide || canDecideReport ? await callerApprovalRefusal(req, doc.travelerProfileId) : null;
    const canApprove = canDecide && !refusal;
    const canApproveReport = canDecideReport && !refusal;
    const approvalBlockedReason = refusal || undefined;
    // #12 — the Travel Desk surface (arrange, change requests, settlement):
    // the traveller's Travel Desk (workspace grant or their Official), or a
    // CSTEP Admin who is neither — allowed, but as an Admin override, which
    // travelDeskOverride tells the page so it can say so.
    const isTravelDesk = !isClaim && (await callerIsTravelDesk(req, doc.travelerProfileId));
    const deskAuthority = isTravelDesk || (!isClaim && admin);
    const travelDeskOverride = deskAuthority && !isTravelDesk;
    // A claim is never arranged — it has no arrangement stage at all.
    const canArrange = !isClaim && (doc.status === "APPROVED" || doc.status === "ARRANGING") && deskAuthority;
    // Step 5 — same authority as canArrange (callerCanArrangeForTraveller):
    // the Official who arranges services also settles accounts. Covers both
    // "may open the settlement card" and "may act on it while VERIFYING" —
    // the frontend narrows further using the settlement's own status once
    // it's fetched via GET /settlement, same pattern as canArrange narrowing
    // via request.status === "ARRANGING".
    // Claims addition — a claim's settlement opens at APPROVED (seeded at
    // approve) and belongs to the CSTEP Admin, not the Official.
    const canSettle = isClaim
      ? admin && CLAIM_SETTLEMENT_STATUSES.has(doc.status)
      : (doc.status === "REPORT_SUBMITTED" ||
          doc.status === "TRANSFERRED_TO_FINANCE" ||
          doc.status === "SETTLED" ||
          doc.status === "REIMBURSED") &&
        deskAuthority;
    // Claims addition — may this caller run the Admin verification (APPROVED
    // claim -> TRANSFERRED_TO_FINANCE)?
    const canVerifyClaim = isClaim && admin && doc.status === "APPROVED";
    // Step 6 — the Finance card, while the case is with Finance (the Finance
    // user's own queue is the usual way in, GET /finance-queue).
    // canFinanceDecide is the card and its send-back: the Finance user, or
    // for a Tour also an Admin (a claim's card is the Finance user's only).
    // canFinance — recording the reimbursement — is below.
    const canFinanceDecide =
      doc.status === "TRANSFERRED_TO_FINANCE" &&
      (isClaim
        ? await callerIsTravellerFinanceUser(req, doc.travelerProfileId)
        : await callerCanFinanceForTraveller(req, doc.travelerProfileId));
    // Recording any payment is the assigned Finance user's alone
    // (callerPaymentRefusal) — one answer for the reimbursement and the
    // vendor lines. paymentBlockedReason says why not to a caller who has
    // the Finance card or the vendor ledger but can't pay.
    const vendorStage = !isClaim && VENDOR_PAYABLE_STATUSES.has(doc.status);
    const hasVendorLedger = vendorStage && (await callerHasVendorLedger(req, doc.travelerProfileId));
    const paymentRefusal = canFinanceDecide || hasVendorLedger ? await callerPaymentRefusal(req, doc.travelerProfileId) : null;
    const canFinance = canFinanceDecide && !paymentRefusal;
    // Vendor payment — mark arrangement lines paid / unpaid, from ARRANGING
    // onwards: the assigned Finance user only. hasVendorLedger (Official,
    // Finance, Admin) keeps the ledger on the page past ARRANGED.
    const canPayVendors = hasVendorLedger && !paymentRefusal;
    const paymentBlockedReason = paymentRefusal || undefined;
    // ...and put the amount on a vendor line that has none (PATCH
    // /arrangements/:lineId/missing-amount) — Finance or Admin. Setting an
    // amount, not a payment, so it keeps its own rule.
    const canSetMissingAmounts = vendorStage && (await callerCanFinanceForTraveller(req, doc.travelerProfileId));
    // The figure Finance pays out — read off the finalized settlement so the
    // Finance user's card can show it without needing the Official-only
    // GET /settlement. Present only while the case is with Finance.
    // For a claim, Finance pays (or collects) the NET-of-advance figure, so
    // both directions come back alongside it.
    let financeAmountClaimed: number | undefined;
    let financeClaimDue: { amountDueByCstep: number; amountDueToCstep: number; advanceTaken: number } | undefined;
    if (doc.status === "TRANSFERRED_TO_FINANCE") {
      const fin: any = await CstepSettlement.findOne({ workspaceId: req.workspaceObjectId, requestId: doc._id })
        .select("amountClaimed advanceTaken amountDueByCstep amountDueToCstep")
        .lean();
      if (fin) {
        financeAmountClaimed = Number(fin.amountClaimed || 0);
        if (isClaim) {
          financeClaimDue = {
            amountDueByCstep: Number(fin.amountDueByCstep || 0),
            amountDueToCstep: Number(fin.amountDueToCstep || 0),
            advanceTaken: Number(fin.advanceTaken || 0),
          };
        }
      }
    }
    // Once Finance has closed the case, what it paid (or received), when and
    // against which reference — so the case keeps its Finance record after
    // it leaves TRANSFERRED_TO_FINANCE. Same readers as the rest of this
    // route; absent when Finance never paid (a nothing-owed SETTLED case).
    let financePaid: ReturnType<typeof financePaidRecord> | undefined;
    if (FINANCE_CLOSED_STATUSES.includes(doc.status)) {
      const paid: any = await CstepSettlement.findOne({ workspaceId: req.workspaceObjectId, requestId: doc._id })
        .select("amountClaimed amountDueByCstep amountDueToCstep advanceTaken paidOn paymentRef paymentSource financeClosedAt")
        .lean();
      financePaid = financePaidRecord(doc.formType, paid) || undefined;
    }
    // Finance-c — the settlement's lines and per diem for the Finance card:
    // the Finance user cannot read GET /settlement (the Desk's view), so the
    // case carries them while it is with Finance — and after Finance closed
    // it, so a disallowed line stays visible. canFinanceAdjust (reduce /
    // disallow) is the payment gate, same as canFinance.
    const canFinanceAdjust = canFinance;
    let financeSettlement: Awaited<ReturnType<typeof financeSettlementView>> | undefined;
    if (canFinanceDecide || (financePaid && (await callerCanFinanceForTraveller(req, doc.travelerProfileId)))) {
      financeSettlement = await financeSettlementView(req.workspaceObjectId, doc);
    }

    const arrangements = isClaim
      ? []
      : await CstepArrangement.find({
          workspaceId: req.workspaceObjectId,
          requestId: doc._id,
        })
          .sort({ createdAt: 1 })
          .lean();

    // Change requests — this trip's cancel / rebook requests (newest first),
    // whether the caller may raise one now, and whether they handle them
    // (the Official / Admin: resolve, and edit the lines an OPEN one reopens).
    const canHandleChanges = deskAuthority;
    const canRequestChange =
      !isClaim &&
      CHANGEABLE_STATUSES.has(doc.status) &&
      arrangements.some((a: any) => CHANGEABLE_SERVICE_TYPES.has(a.arrangedType)) &&
      (canHandleChanges || (await callerIsRequestTraveller(req, doc)));
    const changeRequests = isClaim
      ? []
      : await CstepChangeRequest.find({ workspaceId: req.workspaceObjectId, travelRequestId: doc._id })
          .sort({ raisedAt: -1 })
          .lean();

    // Claims addition — the claim lines' receipts, presigned for viewing,
    // keyed by attachment id (the intake form shows the file name on edit;
    // the detail view links each one).
    const claimAttachments: Record<string, { _id: any; originalName?: string; mime?: string; url: string }> = {};
    if (isClaim) {
      const ids = claimAttachmentIds(doc);
      const atts: any[] = ids.length
        ? await CstepAttachment.find({ workspaceId: req.workspaceObjectId, _id: { $in: ids } }).lean()
        : [];
      for (const a of atts) {
        claimAttachments[String(a._id)] = {
          _id: a._id,
          originalName: a.originalName,
          mime: a.mime,
          url: await presignGetObject({ bucket: env.S3_BUCKET, key: a.s3Key, filename: a.originalName, view: true, contentType: a.mime }),
        };
      }
    }

    res.json({
      ok: true,
      request: doc.toObject(),
      canApprove,
      canApproveReport,
      canDecide,
      canDecideReport,
      approvalBlockedReason,
      isAdmin: admin,
      isTravelDesk,
      travelDeskOverride,
      canArrange,
      canSettle,
      canFinance,
      canFinanceDecide,
      paymentBlockedReason,
      canPayVendors,
      hasVendorLedger,
      canSetMissingAmounts,
      canVerifyClaim,
      financeAmountClaimed,
      financeClaimDue,
      financePaid,
      canFinanceAdjust,
      financeSettlement,
      arrangements,
      changeRequests,
      canRequestChange,
      canHandleChanges,
      claimAttachments,
      // The Declaration — every claim item with no bill (claimDeclarationItems,
      // the same derivation as both PDFs) — and whether its standalone
      // Declaration form is available (once submitted: GET /declaration-pdf).
      claimDeclaration: isClaim ? claimDeclarationItems(doc) : undefined,
      hasDeclarationForm: isClaim && doc.status !== "DRAFT" && claimDeclarationItems(doc).length > 0,
    });
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

    const fields: any = scopeFieldsToFormType(pickFields(req.body), doc.formType);

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
    const projectError = await applyProjectSelection(req, fields, before);
    if (projectError) return res.status(400).json({ error: projectError });

    // Merge onto the existing doc so validation sees the full, post-update
    // shape. Keys the body left out (undefined) keep their stored value —
    // the same rule as the assignment just below — rather than validating
    // as blank.
    const merged: any = { ...before };
    Object.keys(fields).forEach((k) => {
      if ((fields as any)[k] !== undefined) merged[k] = (fields as any)[k];
    });
    Object.keys(fields).forEach((k) => {
      if ((fields as any)[k] !== undefined) (doc as any)[k] = (fields as any)[k];
    });

    const validationError = validatePayload(merged);
    if (validationError) return res.status(400).json({ error: validationError });
    const attachmentError = await checkClaimAttachments(req, merged, doc._id);
    if (attachmentError) return res.status(400).json({ error: attachmentError });

    await doc.save();
    if (isClaimFormType(doc.formType)) await linkClaimAttachments(req, doc);

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
 * SUBMITTED, or RETURNED (reason optional), and from APPROVED, ARRANGING,
 * ARRANGED or REPORT_PENDING (reason mandatory). Never from REPORT_SUBMITTED
 * onwards — the report is with the Office, or money has moved. A
 * post-approval cancel is a status
 * + audit change only: arrangements are booked outside this app, so there
 * is nothing to unwind here; the TOUR_PROPOSAL's claim (opened at approve)
 * goes to CANCELLED alongside. The proposal is NOT deleted — it stays
 * visible in My Tours with a CANCELLED status for the record. Logs a CANCEL
 * entry (append-only).
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
      return res.status(409).json({
        error: "This travel request can no longer be cancelled — its travel report has started or it is with settlement",
      });
    }

    const reason = String(req.body?.reason || "").trim();
    const postApproval = POST_APPROVAL_CANCELLABLE.has(doc.status);
    if (postApproval && !reason) return res.status(400).json({ error: "reason is required" });

    doc.status = "CANCELLED";
    await doc.save();

    if (postApproval) {
      await CstepClaim.updateMany(
        { workspaceId: req.workspaceObjectId, travelRequestId: doc._id },
        { $set: { status: "CANCELLED" } },
      );
    }

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

    const entry = await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "TRAVELER",
      actor: new mongoose.Types.ObjectId(uid),
      action: hasPriorSubmit ? "RESUBMIT" : "SUBMIT",
      at: new Date().toISOString(),
    });
    await notifyCstep("SUBMITTED", doc, { logEntryId: entry._id });
    await ensureClaimDeclarationQuietly(req, doc);

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
/** Queue-list addition — each row gets `travellerName` (the referenced
 * TravellerProfile's first + last name, same format as the PDF routes) so
 * the queue cards can say whose request it is. Additive to the response,
 * no schema change; the lookup is workspace-scoped like every other read
 * here, so a profile outside the caller's workspace never resolves. */
async function withTravellerNames(req: any, docs: any[]): Promise<any[]> {
  if (docs.length === 0) return docs;
  const ids = [...new Set(docs.map((d) => String(d.travelerProfileId)))];
  const travellers = await TravellerProfile.find({ _id: { $in: ids }, workspaceId: req.workspaceObjectId })
    .select("_id firstName lastName")
    .lean();
  const names = new Map(
    (travellers as any[]).map((t) => [String(t._id), [t.firstName, t.lastName].filter(Boolean).join(" ").trim()]),
  );
  return docs.map((d) => ({ ...d, travellerName: names.get(String(d.travelerProfileId)) || undefined }));
}

// What waits on the Manager: a submitted request, and (report approval) a
// submitted travel report, which the frontend tells apart by status.
const APPROVER_QUEUE_STATUSES = ["SUBMITTED", "REPORT_UNDER_APPROVAL"];

router.get("/approvals", async (req: any, res: any) => {
  try {
    const admin = isCstepAdmin(req);
    const filter: any = { workspaceId: req.workspaceObjectId, status: { $in: APPROVER_QUEUE_STATUSES } };

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

    const docs = await withTravellerNames(req, await CstepTravelRequest.find(filter).sort({ createdAt: 1 }).lean());

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
    const uid = new mongoose.Types.ObjectId(ownerId(req));
    // isFinanceUser — actually mapped as some traveller's Finance user. Unlike
    // isFinance (true for every Admin, for the queues), it gates what only
    // the Finance user may do, e.g. bulk reimbursement. isTourApprover is the
    // same idea for the Approver slot — actually named as some traveller's
    // approver — and gates the My Team report (GET /approver-report), which
    // is about the caller's own team, so an Admin with no team doesn't get it.
    //
    // #12 — isTravelDesk (and isOfficial, its older name) is true only for a
    // real Travel Desk: the workspace Travel Desk grant (hasTravelDeskGrant)
    // or the Official assigned to some traveller — never just for being an
    // Admin. An Admin still gets the all-cases Processing / Changes views
    // (the frontend shows them on isAdmin), but isn't labelled the desk.
    const [isApprover, isMappedOfficial, isFinance, hasTravelDeskGrant] = await Promise.all([
      TravellerProfile.exists({ workspaceId: req.workspaceObjectId, tourApproverId: uid }),
      TravellerProfile.exists({ workspaceId: req.workspaceObjectId, officialUserId: uid }),
      TravellerProfile.exists({ workspaceId: req.workspaceObjectId, financeUserId: uid }),
      holdsTravelDeskGrant(req),
    ]);
    const isTravelDesk = hasTravelDeskGrant || !!isMappedOfficial;

    if (isCstepAdmin(req)) {
      return res.json({
        ok: true,
        isAdmin: true,
        isApprover: true,
        isOfficial: isTravelDesk,
        isTravelDesk,
        hasTravelDeskGrant,
        isFinance: true,
        isFinanceUser: !!isFinance,
        isTourApprover: !!isApprover,
      });
    }

    res.json({
      ok: true,
      isAdmin: false,
      isApprover: !!isApprover,
      isOfficial: isTravelDesk,
      isTravelDesk,
      hasTravelDeskGrant,
      isFinance: !!isFinance,
      isFinanceUser: !!isFinance,
      isTourApprover: !!isApprover,
    });
  } catch (err: any) {
    console.error("[CSTEP my-roles GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load your CSTEP roles" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * #12 — the workspace Travel Desk role (CstepTravelDeskGrant). CSTEP Admin
 * only, like the per-traveller mapping it sits beside (workspace.travellers
 * PATCH /:id/tour-approver). Any active user of this workspace may hold it,
 * an Admin included.
 *
 *   GET    /travel-desk          — the current holders
 *   POST   /travel-desk          — { userId } grants it (again, if revoked)
 *   DELETE /travel-desk/:userId  — revokes it; the row stays, stamped
 * ───────────────────────────────────────────────────────────────────── */
const userNameOf = (u: any): string =>
  u?.name || [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() || u?.email || "Unnamed";

router.get("/travel-desk", async (req: any, res: any) => {
  try {
    if (!isCstepAdmin(req)) return res.status(403).json({ error: "Only a CSTEP Admin can view the Travel Desk role" });
    const grants: any[] = await CstepTravelDeskGrant.find({
      workspaceId: req.workspaceObjectId,
      revokedAt: { $exists: false },
    })
      .sort({ grantedAt: 1 })
      .lean();
    const users: any[] = grants.length
      ? await User.find({ _id: { $in: grants.flatMap((g) => [g.userId, g.grantedBy]) } })
          .select("firstName lastName name email")
          .lean()
      : [];
    const byId = new Map(users.map((u) => [String(u._id), u]));
    res.json({
      ok: true,
      grants: grants.map((g) => ({
        userId: String(g.userId),
        name: userNameOf(byId.get(String(g.userId))),
        email: byId.get(String(g.userId))?.email || "",
        grantedAt: g.grantedAt,
        grantedByName: userNameOf(byId.get(String(g.grantedBy))),
      })),
    });
  } catch (err: any) {
    console.error("[CSTEP travel-desk GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load the Travel Desk role" });
  }
});

router.post("/travel-desk", async (req: any, res: any) => {
  try {
    if (!isCstepAdmin(req)) return res.status(403).json({ error: "Only a CSTEP Admin can grant the Travel Desk role" });
    const raw = String(req.body?.userId || "");
    if (!mongoose.isValidObjectId(raw)) return res.status(400).json({ error: "userId must be a user id" });
    const user: any = await User.findOne({ _id: raw, workspaceId: req.workspaceObjectId, ...activeUserFilter() })
      .select("_id")
      .lean();
    if (!user) return res.status(400).json({ error: "userId does not resolve to an active user in this workspace" });

    const now = new Date();
    const grant: any = await CstepTravelDeskGrant.findOneAndUpdate(
      { workspaceId: req.workspaceObjectId, userId: user._id },
      {
        $set: { grantedBy: new mongoose.Types.ObjectId(ownerId(req)), grantedAt: now },
        $unset: { revokedAt: 1, revokedBy: 1 },
      },
      { upsert: true, new: true },
    ).lean();
    res.json({ ok: true, grant: { userId: String(grant.userId), grantedAt: grant.grantedAt } });
  } catch (err: any) {
    console.error("[CSTEP travel-desk POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to grant the Travel Desk role" });
  }
});

router.delete("/travel-desk/:userId", async (req: any, res: any) => {
  try {
    if (!isCstepAdmin(req)) return res.status(403).json({ error: "Only a CSTEP Admin can revoke the Travel Desk role" });
    if (!mongoose.isValidObjectId(req.params.userId)) return res.status(404).json({ error: "No Travel Desk grant for this user" });
    const revoked = await CstepTravelDeskGrant.findOneAndUpdate(
      {
        workspaceId: req.workspaceObjectId,
        userId: new mongoose.Types.ObjectId(req.params.userId),
        revokedAt: { $exists: false },
      },
      { $set: { revokedAt: new Date(), revokedBy: new mongoose.Types.ObjectId(ownerId(req)) } },
      { new: true },
    ).lean();
    if (!revoked) return res.status(404).json({ error: "No Travel Desk grant for this user" });
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[CSTEP travel-desk DELETE]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to revoke the Travel Desk role" });
  }
});

// Processing-queue 6-stage addition — every status the Official/Admin's
// Processing board can show a case at, in pipeline order. A case is in
// exactly one of these at any time, so nothing "vanishes" between them —
// widened from the old APPROVED/ARRANGING-only filter, which dropped a
// case the moment it reached ARRANGED (Step 3 done) or REPORT_SUBMITTED
// (Step 4 done), even though the Official/Admin still needed to see it.
// REPORT_UNDER_APPROVAL (report approval) is the Manager's step, listed here
// for the record so a report the Manager holds never drops off the board.
const OFFICIAL_QUEUE_STAGES = [
  "APPROVED",
  "ARRANGING",
  "ARRANGED",
  "REPORT_PENDING",
  "REPORT_UNDER_APPROVAL",
  "REPORT_SUBMITTED",
  "TRANSFERRED_TO_FINANCE",
  "SETTLED",
  "REIMBURSED",
] as const;

/** Which travellers' cases the Processing board (and the #13 desk dashboard)
 * shows the caller: {} for a CSTEP Admin or the workspace Travel Desk (#12,
 * every traveller's desk), the travellers they are the Official for, or null
 * when they are neither — an empty board, not a 403. */
async function officialQueueScope(req: any): Promise<Record<string, unknown> | null> {
  if (isCstepAdmin(req) || (await holdsTravelDeskGrant(req))) return {};
  const myTravellers = await TravellerProfile.find({
    workspaceId: req.workspaceObjectId,
    officialUserId: new mongoose.Types.ObjectId(ownerId(req)),
  })
    .select("_id")
    .lean();
  if (myTravellers.length === 0) return null;
  return { travelerProfileId: { $in: myTravellers.map((t: any) => t._id) } };
}

/* ─────────────────────────────────────────────────────────────────────
 * GET /official-queue — the Official user's queue (CSTEP mapping addition):
 * requests for travellers who have this caller set as officialUserId,
 * across all 6 Processing-board stages (see OFFICIAL_QUEUE_STAGES) — every
 * case from "Tour Request" (APPROVED) through "Transferred to Finance".
 * The frontend groups `requests` into its 6 sub-tabs by `status`;
 * `stageCounts` gives it the per-tab count directly without recomputing it
 * from the full list. Same tenant-scoped shape as GET /approvals
 * (mapped-user field + status set), just a different slot. A CSTEP Admin
 * (oversight) and the workspace Travel Desk (#12, every traveller's desk)
 * see every request at any of these 6 statuses, unchanged from how Admin
 * already sees everything elsewhere in this module. Anyone else with no
 * travellers mapped to them gets an empty queue, not a 403 — same posture
 * as /approvals.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/official-queue", async (req: any, res: any) => {
  try {
    // Claims never reach the Official — they go to the Admin's claim
    // verification queue (GET /claim-verification-queue) instead.
    const filter: any = {
      workspaceId: req.workspaceObjectId,
      status: { $in: OFFICIAL_QUEUE_STAGES },
      formType: { $nin: ["LOCAL_TRAVEL_CLAIM", "EXPENSE_CLAIM"] },
    };
    const emptyStageCounts = Object.fromEntries(OFFICIAL_QUEUE_STAGES.map((s) => [s, 0]));

    const scope = await officialQueueScope(req);
    if (!scope) return res.json({ ok: true, requests: [], stageCounts: emptyStageCounts });

    const docs = await withTravellerNames(req, await CstepTravelRequest.find({ ...filter, ...scope }).sort({ updatedAt: -1 }).lean());
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
 * GET /desk-dashboard — #13, the Travel Desk dashboard: upcoming travels
 * and the pending-bookings reminder (see utils/cstepDeskDashboard.ts).
 * Read-only. Same scoping as GET /official-queue (officialQueueScope):
 * Admin / Travel Desk grant -> every traveller, an Official -> their
 * travellers, anyone else -> empty lists. Claims never reach the desk.
 * Rows are the same request docs the queue returns (with travellerName),
 * plus daysToDeparture, pendingServices / totalServices and, on pending,
 * deskAction (AWAITING_ARRANGEMENT | PENDING_SERVICES |
 * READY_TO_MARK_ARRANGED) and urgency (OVERDUE | DUE_SOON | null).
 * ───────────────────────────────────────────────────────────────────── */
router.get("/desk-dashboard", async (req: any, res: any) => {
  try {
    const today = todayIST();
    const scope = await officialQueueScope(req);
    if (!scope) return res.json({ ok: true, today, nearDays: DESK_NEAR_DAYS, upcoming: [], pending: [] });

    const docs = await withTravellerNames(
      req,
      await CstepTravelRequest.find({
        workspaceId: req.workspaceObjectId,
        status: { $in: DESK_DASHBOARD_STATUSES },
        formType: { $nin: ["LOCAL_TRAVEL_CLAIM", "EXPENSE_CLAIM"] },
        ...scope,
      }).lean(),
    );

    // Arrangement lines only matter while ARRANGING (APPROVED has none yet,
    // ARRANGED is done). A line with no status reads as the schema default.
    const arrangingIds = docs.filter((d: any) => d.status === "ARRANGING").map((d: any) => d._id);
    const lines: any[] = arrangingIds.length
      ? await CstepArrangement.find({ workspaceId: req.workspaceObjectId, requestId: { $in: arrangingIds } })
          .select("requestId status")
          .lean()
      : [];
    const services = new Map<string, DeskServiceCounts>();
    for (const l of lines) {
      const c = services.get(String(l.requestId)) ?? { pending: 0, total: 0 };
      c.total++;
      if ((l.status ?? "PENDING") === "PENDING") c.pending++;
      services.set(String(l.requestId), c);
    }

    res.json({ ok: true, today, nearDays: DESK_NEAR_DAYS, ...buildDeskDashboard(docs, services, today) });
  } catch (err: any) {
    console.error("[CSTEP desk-dashboard GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load the Travel Desk dashboard" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /claim-verification-queue — claims addition. The CSTEP Admin's
 * verification board for approved claims (LOCAL_TRAVEL_CLAIM /
 * EXPENSE_CLAIM): APPROVED (awaiting the Admin's verification — the
 * actionable stage), then With Finance / Settled / Reimbursed for the
 * record. Same { requests, stageCounts } shape as GET /official-queue.
 * Admin-only by role; anyone else gets an empty queue, not a 403 — same
 * posture as the other queues.
 * ───────────────────────────────────────────────────────────────────── */
const CLAIM_VERIFICATION_STAGES = ["APPROVED", "TRANSFERRED_TO_FINANCE", "SETTLED", "REIMBURSED"] as const;

router.get("/claim-verification-queue", async (req: any, res: any) => {
  try {
    const emptyStageCounts = Object.fromEntries(CLAIM_VERIFICATION_STAGES.map((s) => [s, 0]));
    if (!isCstepAdmin(req)) return res.json({ ok: true, requests: [], stageCounts: emptyStageCounts });

    const docs = await withTravellerNames(
      req,
      await CstepTravelRequest.find({
        workspaceId: req.workspaceObjectId,
        formType: { $in: ["LOCAL_TRAVEL_CLAIM", "EXPENSE_CLAIM"] },
        status: { $in: CLAIM_VERIFICATION_STAGES },
      })
        .sort({ updatedAt: -1 })
        .lean(),
    );
    const stageCounts: Record<string, number> = { ...emptyStageCounts };
    for (const d of docs as any[]) {
      if (stageCounts[d.status] !== undefined) stageCounts[d.status]++;
    }
    res.json({ ok: true, requests: docs, stageCounts });
  } catch (err: any) {
    console.error("[CSTEP claim-verification-queue GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to list the claim verification queue" });
  }
});

/** Where Finance closes a case: paid out (REIMBURSED), or a claimant's
 * repayment received (SETTLED). */
const FINANCE_CLOSED_STATUSES = ["REIMBURSED", "SETTLED"];

/** What Finance recorded when it closed a case, read off the settlement
 * (settleFinanceCase writes paidOn / paymentRef / paymentSource there).
 * null when Finance never paid — e.g. a nothing-owed SETTLED case. A case
 * Finance itself closed at ₹0 by reducing / disallowing (financeClosedAt)
 * is Finance's record too: ₹0, closedAtZero, dated the day it closed. */
function financePaidRecord(
  formType: string,
  settlement: any,
): { amountInr: number; direction: "PAY_OUT" | "COLLECT"; paidOn: Date; reference: string; source: string; closedAtZero?: true } | null {
  if (!settlement?.paidOn) {
    if (!settlement?.financeClosedAt) return null;
    return { amountInr: 0, direction: "PAY_OUT", paidOn: settlement.financeClosedAt, reference: "", source: "MANUAL", closedAtZero: true };
  }
  const { direction, amount } = financeCaseAmount(formType, settlement);
  return {
    amountInr: amount,
    direction,
    paidOn: settlement.paidOn,
    reference: settlement.paymentRef || "",
    source: settlement.paymentSource || "MANUAL",
  };
}

/** Finance-c — the settlement as the Finance card shows it: every line
 * (traveller-paid ones are the ones Finance may reduce / disallow), the per
 * diem and the totals. undefined when there is no settlement. */
async function financeSettlementView(workspaceId: any, doc: any) {
  const s: any = await CstepSettlement.findOne({ workspaceId, requestId: doc._id }).lean();
  if (!s) return undefined;
  const lines: any[] = await CstepSettlementLine.find({ workspaceId, settlementId: s._id }).sort({ createdAt: 1, _id: 1 }).lean();
  return {
    lines: lines.map((l) => ({
      _id: l._id,
      source: l.source,
      mode: l.mode,
      description: l.description,
      classification: l.classification,
      amountInr: Number(l.amountInr || 0),
      claimedAmountInr: l.claimedAmountInr,
      financeRejected: !!l.financeRejected,
      financeRejectedFromInr: l.financeRejectedFromInr,
      financeRejectedReason: l.financeRejectedReason,
      financeRejectedAt: l.financeRejectedAt,
    })),
    perDiem: isClaimFormType(doc.formType)
      ? undefined
      : {
          days: Number(s.perDiem?.days || 0),
          rate: Number(s.perDiem?.rate || 0),
          deductionInr: Number(s.perDiem?.deductionInr || 0),
          deductionReason: s.perDiem?.deductionReason,
          amountInr: Number(s.perDiem?.amountInr || 0),
        },
    totalCostOfTour: Number(s.totalCostOfTour || 0),
    amountClaimed: Number(s.amountClaimed || 0),
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * GET /finance-queue — the Finance user's queue (CSTEP mapping addition):
 * same shape as GET /official-queue, financeUserId slot instead. Lists
 * the cases actually waiting on Finance — TRANSFERRED_TO_FINANCE, i.e.
 * settlement finalized with money owed to the traveller — scoped to the
 * caller's own mapped travellers (a CSTEP Admin sees every one). The
 * Finance user closes a case from here with
 * POST /requests/:id/finance/settle (→ REIMBURSED). (Before Step 6 this
 * filtered on APPROVED, a leftover from when no finance stage existed,
 * so a case at the finance stage could never appear in the Finance tab.)
 * `requests` is still only that to-do list. `closed` adds the cases Finance
 * has closed (REIMBURSED / repayment SETTLED, each with its financePaid
 * record) — without it a case vanished from Finance the moment it was paid,
 * leaving only its vendor lines on Vendor payments. `stageCounts` counts
 * all three.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/finance-queue", async (req: any, res: any) => {
  try {
    const admin = isCstepAdmin(req);
    const filter: any = { workspaceId: req.workspaceObjectId, status: "TRANSFERRED_TO_FINANCE" };

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

    const docs = await withTravellerNames(req, await CstepTravelRequest.find(filter).sort({ updatedAt: -1 }).lean());

    // Closed by Finance — REIMBURSED, or SETTLED by a repayment Finance
    // recorded — kept on the board for the record so a case never vanishes
    // once it is paid. A SETTLED case with no payment on its settlement
    // (nothing owed, closed by the Official/Admin) never reached Finance and
    // stays off. `requests` is still only what waits on Finance, so every
    // existing count of it is unchanged.
    const closedCandidates: any[] = await CstepTravelRequest.find({
      ...filter,
      status: { $in: FINANCE_CLOSED_STATUSES },
    })
      .sort({ updatedAt: -1 })
      .lean();
    // Finance-c — a case Finance closed at ₹0 itself (every item disallowed
    // or reduced away) has no payment date but is Finance's: financeClosedAt.
    const paidSettlements: any[] = closedCandidates.length
      ? await CstepSettlement.find({
          workspaceId: req.workspaceObjectId,
          requestId: { $in: closedCandidates.map((d) => d._id) },
          $or: [{ paidOn: { $exists: true, $ne: null } }, { financeClosedAt: { $exists: true, $ne: null } }],
        }).lean()
      : [];
    const paidBy = new Map(paidSettlements.map((s) => [String(s.requestId), s]));
    const closed = (await withTravellerNames(req, closedCandidates.filter((d) => paidBy.has(String(d._id))))).map((d: any) => ({
      ...d,
      financePaid: financePaidRecord(d.formType, paidBy.get(String(d._id))),
    }));
    const stageCounts: Record<string, number> = { TRANSFERRED_TO_FINANCE: docs.length, REIMBURSED: 0, SETTLED: 0 };
    for (const d of closed) stageCounts[d.status] = (stageCounts[d.status] || 0) + 1;

    res.json({ ok: true, requests: docs, closed, stageCounts });
  } catch (err: any) {
    console.error("[CSTEP finance-queue GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to list the finance queue" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * Finance a+b — GET /finance-expenses — "Traveller-paid expenses": one row
 * per item a traveller paid themselves and is claiming back, across Tours,
 * Local Travel and Expense Claims, plus each Tour's per diem. The vendor
 * side (what CSTEP paid suppliers) stays on Vendor payments.
 *
 * Scope, as GET /finance-queue: a CSTEP Admin sees every traveller; anyone
 * else sees the travellers they are the Finance user of
 * (TravellerProfile.financeUserId). Nobody else — 403.
 *
 * An item exists once its case has a settlement (a claim at approval, a
 * Tour once the Desk opens its settlement after the report is approved),
 * so its amounts are the ones Finance pays from. Items: the settlement's
 * traveller-paid (PERSONAL) lines, and the per diem when it has a gross.
 * A cancelled case is left out. Amount claimed = the figure the item came
 * with (claimedAmountInr; the per diem's days × rate); amount now = after
 * any Desk / Finance reduction or disallow.
 *
 * Status, first match:
 *   DISALLOWED            Finance disallowed it (Finance-c) — with the reason
 *   REIMBURSED            the case was paid — with the date and reference
 *   WITH_FINANCE          the case is TRANSFERRED_TO_FINANCE
 *   CLOSED                closed with nothing paid (nothing owed / covered by
 *                         the advance / Finance closed it at ₹0)
 *   DESK_VERIFIED         still being settled; the Desk has verified the line
 *   IN_VERIFICATION       still being settled; not verified yet (and the per diem)
 *
 * Query: status, traveller (TravellerProfile id), from / to (YYYY-MM-DD, on
 * the item's date — its own date, else the case's start). format=csv sends
 * the same rows as a UTF-8 (BOM) CSV.
 * ───────────────────────────────────────────────────────────────────── */
export const FINANCE_EXPENSE_STATUSES = [
  "IN_VERIFICATION",
  "DESK_VERIFIED",
  "WITH_FINANCE",
  "REIMBURSED",
  "CLOSED",
  "DISALLOWED",
] as const;
export type FinanceExpenseStatus = (typeof FINANCE_EXPENSE_STATUSES)[number];
const FINANCE_EXPENSE_STATUS_LABEL: Record<FinanceExpenseStatus, string> = {
  IN_VERIFICATION: "In verification",
  DESK_VERIFIED: "Desk-verified",
  WITH_FINANCE: "With Finance",
  REIMBURSED: "Reimbursed",
  CLOSED: "Closed (nothing paid)",
  DISALLOWED: "Disallowed",
};

type FinanceExpenseItem = {
  requestId: string;
  reference: string;
  formType: string;
  travelerProfileId: string;
  traveller: string;
  date: string;
  category: CstepExpenseCategory | null;
  description: string;
  amountClaimedInr: number;
  amountNowInr: number;
  status: FinanceExpenseStatus;
  paidOn?: string;
  paymentRef?: string;
  reason?: string;
};

/** The case-level part of an item's status (anything but DISALLOWED, which is the item's own). */
function financeExpenseCaseStatus(doc: any, settlement: any, verified: boolean): Pick<FinanceExpenseItem, "status" | "paidOn" | "paymentRef"> {
  if (doc.status === "REIMBURSED" || (doc.status === "SETTLED" && settlement?.paidOn)) {
    return {
      status: "REIMBURSED",
      paidOn: settlement?.paidOn ? istDate(new Date(settlement.paidOn)) : undefined,
      paymentRef: settlement?.paymentRef || undefined,
    };
  }
  if (doc.status === "TRANSFERRED_TO_FINANCE") return { status: "WITH_FINANCE" };
  if (doc.status === "SETTLED") return { status: "CLOSED" };
  return { status: verified ? "DESK_VERIFIED" : "IN_VERIFICATION" };
}

async function financeExpenseItems(req: any): Promise<{ items: FinanceExpenseItem[] } | null> {
  const workspaceId = req.workspaceObjectId;
  const requestFilter: any = { workspaceId, status: { $ne: "CANCELLED" } };
  if (!isCstepAdmin(req)) {
    const uid = ownerId(req);
    const mine = mongoose.isValidObjectId(uid)
      ? await TravellerProfile.find({ workspaceId, financeUserId: new mongoose.Types.ObjectId(uid) }).select("_id").lean()
      : [];
    if (!mine.length) return null;
    requestFilter.travelerProfileId = { $in: mine.map((t: any) => t._id) };
  }

  const settlements: any[] = await CstepSettlement.find({ workspaceId })
    .select("requestId status perDiem paidOn paymentRef")
    .lean();
  if (!settlements.length) return { items: [] };
  const docs: any[] = await CstepTravelRequest.find({ ...requestFilter, _id: { $in: settlements.map((s) => s.requestId) } })
    .select("_id claimReference formType status travelerProfileId departureDate")
    .lean();
  if (!docs.length) return { items: [] };
  const docById = new Map(docs.map((d) => [String(d._id), d]));
  const inScope = settlements.filter((s) => docById.has(String(s.requestId)));

  const [lines, travellers] = await Promise.all([
    CstepSettlementLine.find({ workspaceId, settlementId: { $in: inScope.map((s) => s._id) }, classification: "PERSONAL" })
      .sort({ createdAt: 1, _id: 1 })
      .lean(),
    TravellerProfile.find({ workspaceId, _id: { $in: [...new Set(docs.map((d) => String(d.travelerProfileId)))] } })
      .select("_id firstName lastName")
      .lean(),
  ]);
  const nameOf = new Map(
    (travellers as any[]).map((t) => [String(t._id), [t.firstName, t.lastName].filter(Boolean).join(" ").trim()]),
  );
  const settlementById = new Map(inScope.map((s) => [String(s._id), s]));

  const items: FinanceExpenseItem[] = [];
  const base = (doc: any) => ({
    requestId: String(doc._id),
    reference: doc.claimReference || "",
    formType: doc.formType,
    travelerProfileId: String(doc.travelerProfileId),
    traveller: nameOf.get(String(doc.travelerProfileId)) || "",
  });

  for (const l of lines as any[]) {
    const s = settlementById.get(String(l.settlementId));
    const doc = s && docById.get(String(s.requestId));
    if (!doc) continue;
    const status = l.financeRejected
      ? { status: "DISALLOWED" as const, reason: l.financeRejectedReason || undefined }
      : financeExpenseCaseStatus(doc, s, !!l.verified);
    items.push({
      ...base(doc),
      date: l.itemDate || doc.departureDate || "",
      category: l.category || null,
      description: l.description || "",
      amountClaimedInr: Number(l.claimedAmountInr ?? l.amountInr ?? 0),
      amountNowInr: Number(l.amountInr || 0),
      ...status,
    });
  }

  // The per diem — a Tour's, when it has a gross (days × rate) at all.
  for (const s of inScope) {
    const doc = docById.get(String(s.requestId))!;
    if (isClaimFormType(doc.formType)) continue;
    const gross = Math.round(Number(s.perDiem?.days || 0) * Number(s.perDiem?.rate || 0) * 100) / 100;
    if (!(gross > 0)) continue;
    const status = s.perDiem?.financeRejected
      ? { status: "DISALLOWED" as const, reason: s.perDiem?.deductionReason || undefined }
      : financeExpenseCaseStatus(doc, s, false);
    items.push({
      ...base(doc),
      date: doc.departureDate || "",
      category: "PER_DIEM",
      description: `Per diem — ${s.perDiem.days} day${s.perDiem.days === 1 ? "" : "s"} × ${inrText(s.perDiem.rate)}` +
        (Number(s.perDiem?.deductionInr) > 0 ? `, less ${inrText(s.perDiem.deductionInr)}` : ""),
      amountClaimedInr: gross,
      amountNowInr: Number(s.perDiem?.amountInr || 0),
      ...status,
    });
  }

  items.sort((a, b) => (a.date === b.date ? a.reference.localeCompare(b.reference) : a.date < b.date ? 1 : -1));
  return { items };
}

router.get("/finance-expenses", async (req: any, res: any) => {
  try {
    const status = String(req.query.status || "").trim();
    const traveller = String(req.query.traveller || "").trim();
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    if (status && !(FINANCE_EXPENSE_STATUSES as readonly string[]).includes(status)) {
      return res.status(400).json({ error: "Unknown status" });
    }
    for (const d of [from, to]) {
      if (d && !isValidDateStr(d)) return res.status(400).json({ error: "from / to must be dates (YYYY-MM-DD)" });
    }

    const all = await financeExpenseItems(req);
    if (!all) return res.status(403).json({ error: "Traveller-paid expenses are open to CSTEP Admin and Finance users" });

    // The traveller filter's choices come from everything in scope, before filtering.
    const travellers = [...new Map(all.items.map((i) => [i.travelerProfileId, i.traveller])).entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const items = all.items.filter(
      (i) =>
        (!status || i.status === status) &&
        (!traveller || i.travelerProfileId === traveller) &&
        (!from || i.date >= from) &&
        (!to || i.date <= to),
    );

    if (String(req.query.format || "") === "csv") {
      await sendSheet(res, {
        format: "csv",
        filename: `cstep-traveller-paid-expenses-${istDate(new Date())}`,
        sheetName: "Traveller-paid expenses",
        columns: [
          "Reference", "Traveller", "Date", "Category", "Description", "Amount claimed (INR)", "Amount now (INR)",
          "Status", "Paid on", "Payment ref", "Reason",
        ],
        rows: items.map((i) => [
          i.reference, i.traveller, i.date, i.category ? CSTEP_EXPENSE_CATEGORY_LABEL[i.category] : "Not categorised yet",
          i.description, i.amountClaimedInr, i.amountNowInr, FINANCE_EXPENSE_STATUS_LABEL[i.status],
          i.paidOn || "", i.paymentRef || "", i.reason || "",
        ]),
      });
      return;
    }
    res.json({ ok: true, items, travellers });
  } catch (err: any) {
    console.error("[CSTEP finance-expenses GET]", err?.message);
    if (!res.headersSent) res.status(500).json({ error: err?.message || "Failed to list the traveller-paid expenses" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /approver-report — the manager's My Team report. Same
 * { rows, counts } shape as GET /official-queue, scoped to the Approver
 * slot instead, and read-only.
 *
 * "My team" = travellers whose profile names the caller as approver
 * (TravellerProfile.tourApproverId), the same filter as GET /approvals. This
 * holds for a CSTEP Admin too: the report is about the caller's own team,
 * not the whole workspace.
 * Known caveat: the mapping is current, not historical. If a traveller's
 * approver changes, that traveller's whole history moves to the new
 * approver's Pending / Planned / Closed buckets. "Approved by me" is the
 * exception: it reads the approval log, so it stays with whoever approved.
 *
 * Buckets:
 *   pending      — APPROVER_PENDING_STATUSES (the caller's live to-do list:
 *                  requests and travel reports), never period-filtered
 *   approvedByMe — APPROVE / APPROVE_REPORT log entries whose actor is the
 *                  caller (latest one per request), by the
 *                  date of the approval. A row's status is its status now,
 *                  and it stays even if the traveller has left the team
 *   planned      — APPROVER_PLANNED_STATUSES, with the proposal's estimated
 *                  cost (a claim carries its stored totals instead)
 *   closed       — APPROVER_CLOSED_STATUSES, with the settlement's cost of
 *                  tour and amount claimed; a claim uses its stored totals
 *   rejected / cancelled
 * The team buckets other than pending are filtered by trip date, the same
 * rule as the Travel Register: departureDate, or the IST creation date when
 * there is none. Query: the Travel Register's period / anchor / from / to
 * (resolveRegisterPeriod), default the current FY. DRAFT and RETURNED are
 * with the traveller and belong to no bucket.
 * ───────────────────────────────────────────────────────────────────── */
// Pending = what waits on the Manager: a submitted request, or a submitted
// travel report (report approval). The same set as GET /approvals.
// A report approval counts as an approval too, so a report the Manager
// approves this period lists the trip under Approved by me.
const APPROVER_PENDING_STATUSES = APPROVER_QUEUE_STATUSES;
const APPROVER_REPORT_APPROVE_ACTIONS = ["APPROVE", "APPROVE_REPORT"];
const APPROVER_PLANNED_STATUSES = ["APPROVED", "ARRANGING", "ARRANGED", "REPORT_PENDING", "REPORT_SUBMITTED"];
// TRANSFERRED_TO_FINANCE counts as closed. The trip's settlement is final
// and only the payout is left. Leaving it out would hide the case from the
// manager for as long as it sits with Finance.
const APPROVER_CLOSED_STATUSES = ["TRANSFERRED_TO_FINANCE", "SETTLED", "REIMBURSED"];

/** The money columns of a My Team row. A claim's figures are its own stored
 * totals. A trip's come from its settlement (a settlement still VERIFYING
 * is provisional; settlementStatus says which). */
function approverReportAmounts(doc: any, settlement: any) {
  if (isClaimFormType(doc.formType)) {
    return {
      estimatedCost: null,
      costOfTour: null,
      amountClaimed: doc.claimTotals?.gross ?? null,
      claimNet: doc.claimTotals?.net ?? null,
      settlementStatus: settlement?.status ?? null,
    };
  }
  return {
    estimatedCost: doc.estimatedCost ?? null,
    costOfTour: settlement?.totalCostOfTour ?? null,
    amountClaimed: settlement?.amountClaimed ?? null,
    claimNet: null,
    settlementStatus: settlement?.status ?? null,
  };
}

router.get("/approver-report", async (req: any, res: any) => {
  try {
    const uid = ownerId(req);
    if (!req.workspaceObjectId || !mongoose.isValidObjectId(uid)) {
      return res.status(400).json({ error: "Missing workspace or user context" });
    }
    const me = new mongoose.Types.ObjectId(uid);
    const period = resolveRegisterPeriod(req.query, new Date());
    if ("error" in period) return res.status(400).json({ error: period.error });

    const team = await TravellerProfile.find({ workspaceId: req.workspaceObjectId, tourApproverId: me })
      .select("_id")
      .lean();
    const teamIds = (team as any[]).map((t) => t._id);

    const inPeriod = {
      $or: [
        { departureDate: { $gte: period.from, $lte: period.to } },
        {
          departureDate: { $in: [null, ""] },
          createdAt: {
            $gte: new Date(`${period.from}T00:00:00.000+05:30`),
            $lte: new Date(`${period.to}T23:59:59.999+05:30`),
          },
        },
      ],
    };
    const [pendingDocs, periodDocs, myApprovals] = await Promise.all([
      teamIds.length
        ? CstepTravelRequest.find({
            workspaceId: req.workspaceObjectId,
            travelerProfileId: { $in: teamIds },
            status: { $in: APPROVER_PENDING_STATUSES },
          })
            .sort({ createdAt: 1 })
            .lean()
        : [],
      teamIds.length
        ? CstepTravelRequest.find({
            workspaceId: req.workspaceObjectId,
            travelerProfileId: { $in: teamIds },
            status: { $in: [...APPROVER_PLANNED_STATUSES, ...APPROVER_CLOSED_STATUSES, "REJECTED", "CANCELLED"] },
            ...inPeriod,
          })
            .sort({ updatedAt: -1 })
            .lean()
        : [],
      CstepApproval.find({
        workspaceId: req.workspaceObjectId,
        entityType: "REQUEST",
        actor: me,
        action: { $in: APPROVER_REPORT_APPROVE_ACTIONS },
        at: {
          $gte: new Date(`${period.from}T00:00:00.000+05:30`).toISOString(),
          $lte: new Date(`${period.to}T23:59:59.999+05:30`).toISOString(),
        },
      })
        .select("entityId at")
        .lean(),
    ]);

    // The latest approval per request (a request returned and resubmitted
    // can be approved once only, but a later report approval would add one).
    const approvedAt = new Map<string, string>();
    for (const a of myApprovals as any[]) {
      const id = String(a.entityId);
      if (!approvedAt.has(id) || String(a.at) > approvedAt.get(id)!) approvedAt.set(id, String(a.at));
    }
    const loadedIds = new Set([...pendingDocs, ...periodDocs].map((d: any) => String(d._id)));
    const missingApproved = [...approvedAt.keys()].filter((id) => !loadedIds.has(id));
    const approvedOnlyDocs = missingApproved.length
      ? await CstepTravelRequest.find({ workspaceId: req.workspaceObjectId, _id: { $in: missingApproved } }).lean()
      : [];

    const allDocs = [...pendingDocs, ...periodDocs, ...approvedOnlyDocs] as any[];
    const byId = new Map(allDocs.map((d) => [String(d._id), d]));
    const settlements = byId.size
      ? await CstepSettlement.find({ workspaceId: req.workspaceObjectId, requestId: { $in: [...byId.keys()] } })
          .select("requestId status totalCostOfTour amountClaimed")
          .lean()
      : [];
    const settlementBy = new Map((settlements as any[]).map((s) => [String(s.requestId), s]));
    const named = new Map(
      (await withTravellerNames(req, [...byId.values()])).map((d: any) => [String(d._id), d]),
    );
    const row = (d: any) => {
      const id = String(d._id);
      return { ...named.get(id), amounts: approverReportAmounts(d, settlementBy.get(id)) };
    };

    const buckets = {
      pending: (pendingDocs as any[]).map(row),
      approvedByMe: [...approvedAt.entries()]
        .filter(([id]) => byId.has(id))
        .sort((a, b) => (a[1] < b[1] ? 1 : -1))
        .map(([id, at]) => ({ ...row(byId.get(id)), approvedAt: at })),
      planned: (periodDocs as any[]).filter((d) => APPROVER_PLANNED_STATUSES.includes(d.status)).map(row),
      closed: (periodDocs as any[]).filter((d) => APPROVER_CLOSED_STATUSES.includes(d.status)).map(row),
      rejected: (periodDocs as any[]).filter((d) => d.status === "REJECTED").map(row),
      cancelled: (periodDocs as any[]).filter((d) => d.status === "CANCELLED").map(row),
    };
    const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));

    res.json({
      ok: true,
      period: { kind: period.kind, from: period.from, to: period.to },
      teamSize: teamIds.length,
      buckets,
      counts,
    });
  } catch (err: any) {
    console.error("[CSTEP approver-report GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to build the team report" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /reports/travel-register — the finance team's Travel Register as an
 * .xlsx (layout + row rules: utils/cstepTravelRegister.ts). Read-only — every
 * query here is a find; nothing is opened, started or stamped.
 *
 * Who: a CSTEP Admin gets the whole workspace; a Finance user (financeUserId
 * on at least one traveller) gets only those travellers' trips — the same
 * scoping as GET /finance-queue — and an Approver (tourApproverId) gets their
 * team's, the same scoping as GET /approver-report. Anyone else is refused.
 *
 * Query: period=week|month|quarter|fy|custom (default fy), anchor=YYYY-MM-DD
 * (any day inside the wanted period; default today IST), from/to for custom
 * (max 24 months), includeDrafts=1 to add DRAFT trips (left out by default).
 * A trip falls in the period by its departureDate — or, if it has none yet,
 * by the IST date it was created.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/reports/travel-register", async (req: any, res: any) => {
  try {
    const admin = isCstepAdmin(req);
    let scopedTravellerIds: mongoose.Types.ObjectId[] | null = null;
    if (!admin) {
      // A Finance user gets the travellers they pay; an Approver gets the
      // travellers they approve for (their team). Someone in both slots
      // gets both sets.
      const uid = new mongoose.Types.ObjectId(ownerId(req));
      const mine = await TravellerProfile.find({
        workspaceId: req.workspaceObjectId,
        $or: [{ financeUserId: uid }, { tourApproverId: uid }],
      })
        .select("_id")
        .lean();
      if (mine.length === 0) {
        return res
          .status(403)
          .json({ error: "Only a CSTEP Admin, Finance user or Approver can export the Travel Register" });
      }
      scopedTravellerIds = (mine as any[]).map((t) => t._id);
    }

    const generatedAt = new Date();
    const period = resolveRegisterPeriod(req.query, generatedAt);
    if ("error" in period) return res.status(400).json({ error: period.error });
    const includeDrafts = ["1", "true"].includes(String(req.query.includeDrafts || "").toLowerCase());

    const filter: any = {
      workspaceId: req.workspaceObjectId,
      $or: [
        { departureDate: { $gte: period.from, $lte: period.to } },
        {
          departureDate: { $in: [null, ""] },
          createdAt: {
            $gte: new Date(`${period.from}T00:00:00.000+05:30`),
            $lte: new Date(`${period.to}T23:59:59.999+05:30`),
          },
        },
      ],
    };
    if (!includeDrafts) filter.status = { $ne: "DRAFT" };
    if (scopedTravellerIds) filter.travelerProfileId = { $in: scopedTravellerIds };
    // Claims addition — Local Travel Claims are travel and belong in the
    // register; Expense Claims are not travel and stay out of it.
    filter.formType = { $ne: "EXPENSE_CLAIM" };

    const requests: any[] = await CstepTravelRequest.find(filter).lean();
    const requestIds = requests.map((r) => r._id);

    const [travellers, arrangements, settlements, lines, trail] = await Promise.all([
      TravellerProfile.find({
        _id: { $in: [...new Set(requests.map((r) => String(r.travelerProfileId)))] },
        workspaceId: req.workspaceObjectId,
      })
        .select("_id firstName lastName")
        .lean(),
      CstepArrangement.find({ workspaceId: req.workspaceObjectId, requestId: { $in: requestIds } })
        .sort({ createdAt: 1 })
        .lean(),
      CstepSettlement.find({ workspaceId: req.workspaceObjectId, requestId: { $in: requestIds } }).lean(),
      CstepSettlementLine.find({ workspaceId: req.workspaceObjectId, requestId: { $in: requestIds } })
        .sort({ createdAt: 1 })
        .lean(),
      CstepApproval.find({
        workspaceId: req.workspaceObjectId,
        entityType: "REQUEST",
        entityId: { $in: requestIds },
        action: { $in: ["SUBMIT", "RESUBMIT", "SUBMIT_REPORT"] },
      })
        .select("entityId action at")
        .lean(),
    ]);

    const legIds = (lines as any[]).filter((l) => l.source === "REPORT_LEG").map((l) => l.sourceId);
    const legs: any[] = legIds.length
      ? await CstepReportLeg.find({ workspaceId: req.workspaceObjectId, _id: { $in: legIds } })
          .select("_id fromLocation toLocation fromDate toDate")
          .lean()
      : [];

    const nameOf = new Map(
      (travellers as any[]).map((t) => [String(t._id), [t.firstName, t.lastName].filter(Boolean).join(" ").trim()]),
    );
    const legById = new Map(legs.map((l) => [String(l._id), l]));
    // Claims addition — a CLAIM_LINE settlement row's from/to/date come from
    // the claim line it was seeded from (travel line: route + date; food
    // line: date only), keyed by the line's own _id.
    const claimLegById = new Map<string, any>();
    for (const r of requests) {
      for (const l of r.travelLines || []) {
        claimLegById.set(String(l._id), { fromLocation: l.from, toLocation: l.to, fromDate: l.date, toDate: l.date });
      }
      for (const l of r.foodLines || []) claimLegById.set(String(l._id), { fromDate: l.date, toDate: l.date });
    }
    const group = <T,>(rows: T[], key: (r: T) => string) => {
      const m = new Map<string, T[]>();
      for (const r of rows) m.set(key(r), [...(m.get(key(r)) || []), r]);
      return m;
    };
    const arrangementsBy = group(arrangements as any[], (a) => String(a.requestId));
    const arrangementById = new Map((arrangements as any[]).map((a) => [String(a._id), a]));
    const linesBy = group(lines as any[], (l) => String(l.requestId));
    const settlementBy = new Map((settlements as any[]).map((s) => [String(s.requestId), s]));
    const latest = (entityId: string, actions: string[]) =>
      (trail as any[])
        .filter((t) => String(t.entityId) === entityId && actions.includes(t.action))
        .map((t) => String(t.at))
        .sort()
        .pop();

    const trips: RegisterTrip[] = requests.map((r) => {
      const id = String(r._id);
      const settlement = settlementBy.get(id);
      return {
        request: r,
        travellerName: nameOf.get(String(r.travelerProfileId)) || "",
        submittedAt: latest(id, ["SUBMIT", "RESUBMIT"]),
        reportSubmittedAt: latest(id, ["SUBMIT_REPORT"]),
        arrangements: (arrangementsBy.get(id) || []).filter(arrangementIsReal),
        settlement: settlement
          ? { status: settlement.status, perDiem: settlement.perDiem, totalCostOfTour: settlement.totalCostOfTour }
          : undefined,
        settlementLines: settlement
          ? (linesBy.get(id) || []).map((l: any) => ({
              source: l.source,
              mode: l.mode,
              description: l.description,
              amountInr: l.amountInr,
              classification: l.classification,
              arrangement: l.source === "ARRANGEMENT" ? arrangementById.get(String(l.sourceId)) : undefined,
              leg:
                l.source === "REPORT_LEG"
                  ? legById.get(String(l.sourceId))
                  : l.source === "CLAIM_LINE"
                    ? claimLegById.get(String(l.sourceId))
                    : undefined,
            }))
          : [],
      };
    });

    const { workbook } = buildTravelRegisterWorkbook(trips, period, generatedAt);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="cstep-travel-register-${period.fileTag}.xlsx"`);
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err: any) {
    console.error("[CSTEP travel-register GET]", err?.message);
    if (!res.headersSent) res.status(500).json({ error: err?.message || "Failed to build the Travel Register" });
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
    // Same gate as approve: an Admin can't pull a managed request into review.
    const refusal = await callerApprovalRefusal(req, doc.travelerProfileId);
    if (refusal) return res.status(403).json({ error: refusal });
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
 * TOUR_PROPOSAL: issues the TIN (claimReference = "NNNN/MMYY" from the
 * workspace's TIN series — see issueApprovalReference) and opens the claim
 * file (CstepClaim, status CLAIM_IN_PROGRESS).
 *
 * EVENT_REQUEST (Event Request addition): its own EVR reference
 * ("EVR0001/1026", the EVR series) and no CstepClaim. An approved event goes
 * to fulfilment, not personal settlement, so there's nothing to claim
 * against — the reference is what the Travel Register's TIN column and the
 * vendor-payment import match it by. Everything else (permission check,
 * audit entry, response shape) is identical.
 *
 * The serial is taken inside the transaction: two approvals racing on the
 * same counter surface as a write conflict that withTransaction retries,
 * so each gets its own number. The unique {workspaceId, claimReference}
 * indexes stay as the backstop — a duplicate-key error (a reference that
 * already exists although the counter never issued it) burns that number
 * outside the transaction and the outer loop retries with the next one.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests/:id/approve", async (req: any, res: any) => {
  const session = await mongoose.startSession();
  const MAX_ATTEMPTS = 10;
  let responseRequest: any = null;
  let responseClaim: any = null;
  let claimReference = "";
  let approveEntryId: any = null;
  let issuedKey = "";

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        issuedKey = "";
        await session.withTransaction(async () => {
          const doc = await CstepTravelRequest.findOne({
            _id: new mongoose.Types.ObjectId(req.params.id),
            workspaceId: req.workspaceObjectId,
          }).session(session);
          if (!doc) throw new CstepHttpError(404, "Travel request not found");
          const refusal = await callerApprovalRefusal(req, doc.travelerProfileId);
          if (refusal) throw new CstepHttpError(403, refusal);
          if (doc.status !== "SUBMITTED") {
            throw new CstepHttpError(409, "Only a submitted travel request can be approved");
          }

          const uid = ownerId(req);

          if (doc.formType === "EVENT_REQUEST") {
            const { ref, key } = await issueApprovalReference(req.workspaceObjectId, doc.formType, session);
            issuedKey = key;

            doc.status = "APPROVED";
            doc.claimReference = ref;
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
            approveEntryId = approval._id;

            responseRequest = doc.toObject();
            responseClaim = null;
            claimReference = ref;
            return;
          }

          // Claims addition — no TIN and no CstepClaim. The claim gets its own
          // reference on the request, and its settlement is seeded right here
          // (VERIFYING, per diem 0) from the claim's own lines, for the CSTEP
          // Admin to verify — there is no arrangement or report in between.
          if (isClaimFormType(doc.formType)) {
            const { ref, key } = await issueApprovalReference(req.workspaceObjectId, doc.formType, session);
            issuedKey = key;

            doc.status = "APPROVED";
            doc.claimReference = ref;
            await doc.save({ session });

            const settlement = new CstepSettlement({
              workspaceId: req.workspaceObjectId,
              requestId: doc._id,
              status: "VERIFYING",
              perDiem: { days: 0, rate: 0, currency: "INR", amountInr: 0, computedDays: 0 },
              buckets: { airRailBus: 0, perDiem: 0, boardingLodging: 0, cab: 0, other: 0 },
              totalCostOfTour: 0,
              amountClaimed: 0,
              advanceTaken: Number(doc.advanceTaken) || 0,
              startedBy: new mongoose.Types.ObjectId(uid),
              startedAt: new Date(),
            });
            const seedRows = buildClaimSettlementLines(doc).map((row) => ({
              ...row,
              // Reduce-only ceiling: the figure the line arrives with.
              claimedAmountInr: row.amountInr,
              workspaceId: req.workspaceObjectId,
              settlementId: settlement._id,
              requestId: doc._id,
              createdBy: new mongoose.Types.ObjectId(uid),
            }));
            applySettlementTotals(settlement, seedRows, doc);
            await settlement.save({ session });
            if (seedRows.length > 0) await CstepSettlementLine.insertMany(seedRows, { session });

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
            approveEntryId = approval._id;

            claimReference = ref;
            responseRequest = doc.toObject();
            responseClaim = null;
            return;
          }

          const { ref, key } = await issueApprovalReference(req.workspaceObjectId, doc.formType, session);
          issuedKey = key;

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
          approveEntryId = approval._id;

          claimReference = ref;
          responseRequest = doc.toObject();
          responseClaim = claim.toObject();
        });

        break; // transaction committed — done
      } catch (err: any) {
        if (err instanceof CstepHttpError) throw err;
        const isDupKey = err?.code === 11000 || /E11000/.test(String(err?.message || ""));
        if (!isDupKey || attempt === MAX_ATTEMPTS) throw err;
        // The reference already exists although the counter never issued
        // it. The aborted transaction rolled the increment back, so burn
        // that number outside it — the next attempt proposes the one after.
        if (issuedKey) await Counter.findByIdAndUpdate(issuedKey, { $inc: { seq: 1 } });
      }
    }

    // After the commit, never inside the transaction: a retried attempt's
    // entry was rolled back, so only the committed attempt's entry notifies.
    // A claim's APPROVED email does not go to the Official, who has no part
    // in a claim: its next step is the CSTEP Admin's verification, so the
    // Admin addresses (notification settings) hear CLAIM_APPROVED instead.
    if (!isClaimFormType(responseRequest?.formType)) {
      await notifyCstep("APPROVED", responseRequest, { logEntryId: approveEntryId });
    } else {
      await notifyCstep("CLAIM_APPROVED", responseRequest, { logEntryId: approveEntryId });
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
 * Reference series — CSTEP Admin only. utils/cstepSequence.ts owns the
 * counters; these two routes only read them and seed a starting number.
 * The Numbering settings screen (pages/cstep/NumberingSettings.tsx) drives
 * both.
 *
 * GET /sequences — the next number each series will issue: TIN / LTC / EXP / EVR
 * for the current IST financial year (or ?fy=<startYear>), VENDOR and
 * TALLY (continuous). Each FY series also carries `upcoming` — the next
 * number of the following financial year — and the response carries the
 * 20 most recent changes (CstepSequenceChange).
 *
 * PUT /sequences/:series — { startNumber, fyStartYear? } makes startNumber
 * the series' NEXT number. Forward-only: it can raise the next number,
 * never lower it — a start below what the series would already issue is
 * refused 409 with nothing changed; the exact current next number is a
 * no-op success. fyStartYear (TIN/LTC/EXP/EVR only) defaults to the
 * current IST financial year and may be a later one, so a year's start can
 * be set before that year begins. A change that moved the counter writes
 * one CstepSequenceChange row (who, when, series, FY, old next → new).
 * ───────────────────────────────────────────────────────────────────── */
const SEQUENCE_CHANGES_SHOWN = 20;

router.get("/sequences", async (req: any, res: any) => {
  try {
    if (!isCstepAdmin(req)) return res.status(403).json({ error: "Only a CSTEP Admin can view reference series" });
    const fyRaw = req.query?.fy;
    const currentFy = cstepFyStartYear();
    const fyStartYear = fyRaw === undefined ? currentFy : Number(fyRaw);
    if (!Number.isInteger(fyStartYear) || fyStartYear < 2000 || fyStartYear > 2100) {
      return res.status(400).json({ error: "fy must be a financial-year start year, e.g. 2026" });
    }
    const series = await Promise.all(
      CSTEP_SERIES.map(async (s) => {
        const { next } = await peekCstepSerial(req.workspaceObjectId, s, { fyStartYear });
        if (!isFySeries(s)) return { series: s, next, fyStartYear: null };
        const upcoming = await peekCstepSerial(req.workspaceObjectId, s, { fyStartYear: fyStartYear + 1 });
        return { series: s, next, fyStartYear, upcoming: { fyStartYear: fyStartYear + 1, next: upcoming.next } };
      }),
    );
    const changes = await CstepSequenceChange.find({ workspaceId: req.workspaceObjectId })
      .sort({ changedAt: -1 })
      .limit(SEQUENCE_CHANGES_SHOWN)
      .populate("changedBy", "firstName lastName name email")
      .lean();
    const nameOf = (u: any): string | undefined =>
      u && typeof u === "object"
        ? u.name || [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || undefined
        : undefined;
    res.json({
      ok: true,
      currentFyStartYear: currentFy,
      series,
      changes: changes.map((c: any) => ({
        _id: String(c._id),
        series: c.series,
        fyStartYear: c.fyStartYear ?? null,
        oldNext: c.oldNext,
        newNext: c.newNext,
        changedBy: String(c.changedBy?._id || c.changedBy),
        changedByName: nameOf(c.changedBy),
        changedAt: c.changedAt,
      })),
    });
  } catch (err: any) {
    console.error("[CSTEP sequences GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to read reference series" });
  }
});

router.put("/sequences/:series", async (req: any, res: any) => {
  try {
    if (!isCstepAdmin(req)) return res.status(403).json({ error: "Only a CSTEP Admin can set a reference series" });
    const series = String(req.params.series || "").toUpperCase() as CstepSeries;
    if (!CSTEP_SERIES.includes(series)) {
      return res.status(400).json({ error: `series must be one of ${CSTEP_SERIES.join(", ")}` });
    }
    const startNumber = Number(req.body?.startNumber);
    if (!Number.isInteger(startNumber) || startNumber < 1) {
      return res.status(400).json({ error: "startNumber must be a whole number, 1 or more" });
    }
    let fyStartYear: number | undefined;
    if (isFySeries(series)) {
      const current = cstepFyStartYear();
      fyStartYear = req.body?.fyStartYear === undefined ? current : Number(req.body.fyStartYear);
      if (!Number.isInteger(fyStartYear) || fyStartYear < current) {
        return res.status(400).json({ error: "fyStartYear must be the current financial year or a later one" });
      }
    } else if (req.body?.fyStartYear !== undefined) {
      return res.status(400).json({ error: `The ${series} series does not reset by financial year` });
    }

    const result = await seedCstepSerial(req.workspaceObjectId, series, startNumber, { fyStartYear });
    if (!result.ok) {
      return res.status(409).json({
        error: `The ${series} series already issues ${result.next} next — a start can only raise it, never lower it`,
        next: result.next,
      });
    }

    const changed = result.prevNext !== result.next;
    if (changed) {
      await CstepSequenceChange.create({
        workspaceId: req.workspaceObjectId,
        series,
        fyStartYear: fyStartYear ?? null,
        oldNext: result.prevNext,
        newNext: result.next,
        changedBy: ownerId(req),
      });
      console.info(
        `[CSTEP sequences PUT] ws=${String(req.workspaceObjectId)} by=${ownerId(req)} ` +
          `${series}${fyStartYear !== undefined ? ` FY${fyStartYear}` : ""} next ${result.prevNext}→${result.next}`,
      );
    }

    res.json({ ok: true, series, next: result.next, previousNext: result.prevNext, changed, fyStartYear: fyStartYear ?? null });
  } catch (err: any) {
    console.error("[CSTEP sequences PUT]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to set the reference series" });
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

    const entry = await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "APPROVER",
      actor: new mongoose.Types.ObjectId(ownerId(req)),
      action: "RETURN",
      comment: reason,
      at: new Date().toISOString(),
    });
    await notifyCstep("RETURN", doc, { logEntryId: entry._id, reason });

    res.json({ ok: true, request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests return]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to return travel request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/reject — approver-only, SUBMITTED → REJECTED
 * (terminal). Distinct from /return: return = "fix and resubmit", reject =
 * "denied, closed" — nothing reopens a rejected request. reason is
 * mandatory. No TIN or claim exists yet at SUBMITTED, so there is nothing
 * else to close.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests/:id/reject", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!(await callerCanActOnTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Tour Approver or a CSTEP Admin can perform this action" });
    }
    if (doc.status !== "SUBMITTED") {
      return res.status(409).json({ error: "Only a submitted travel request can be rejected" });
    }

    const reason = String(req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({ error: "reason is required" });

    doc.status = "REJECTED";
    await doc.save();

    const entry = await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "APPROVER",
      actor: new mongoose.Types.ObjectId(ownerId(req)),
      action: "REJECT",
      comment: reason,
      at: new Date().toISOString(),
    });
    await notifyCstep("REJECTED", doc, { logEntryId: entry._id, reason });

    res.json({ ok: true, request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests reject]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to reject travel request" });
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
      return res.status(403).json({ error: "Only this traveller's Travel Desk or a CSTEP Admin can perform this action" });
    }
    if (isClaimFormType(doc.formType)) {
      return res.status(409).json({ error: "A claim has no arrangement stage" });
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
        ...adminOverrideMark(req),
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
      return res.status(403).json({ error: "Only this traveller's Travel Desk or a CSTEP Admin can perform this action" });
    }
    // Past ARRANGING, a line an OPEN change request names is reopened for
    // the Official to record the cancel / rebook (see Change requests below).
    const reopenedForChange = doc.status !== "ARRANGING" && (await lineOpenForChange(req, doc, req.params.lineId));
    if (doc.status !== "ARRANGING" && !reopenedForChange) {
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

    const vendorResult = await resolveArrangementVendor(req, body, line);
    if ("error" in vendorResult) return res.status(vendorResult.status).json({ error: vendorResult.error });
    // A paid line is locked to the vendor and amount it was paid on — the
    // payables, Travel Register and Tally export all read them — so changing
    // either means marking it unpaid first.
    const paidLocked = line.paymentStatus === "PAID";
    if (paidLocked && vendorResult.touched) {
      return res.status(409).json({ error: "This line's vendor is marked paid — mark it unpaid before changing the vendor" });
    }
    if (vendorResult.touched) {
      line.vendorId = vendorResult.fields.vendorId;
      line.vendorCode = vendorResult.fields.vendorCode;
      line.vendorName = vendorResult.fields.vendorName;
    }

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
    if (
      paidLocked &&
      amountResult.touched &&
      (amountResult.fields.amount !== line.amount || (amountResult.fields.currency || "INR") !== (line.currency || "INR"))
    ) {
      return res.status(409).json({ error: "This line's vendor is marked paid — mark it unpaid before changing the amount" });
    }
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
      ...adminOverrideMark(req),
      comment:
        (reopenedForChange ? "Change request — " : "") +
        `Requested: ${requestedLabel} -> Arranged: ${before.arrangedType} => ${line.arrangedType}` +
        (line.details ? ` — ${line.details}` : "") +
        ` [${line.status}]` +
        amountLabel +
        (vendorResult.touched
          ? line.vendorId
            ? ` | Vendor: ${line.vendorCode} ${line.vendorName}`
            : " | Vendor: cleared"
          : ""),
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
      return res.status(403).json({ error: "Only this traveller's Travel Desk or a CSTEP Admin can perform this action" });
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
    const vendorResult = await resolveArrangementVendor(req, req.body || {});
    if ("error" in vendorResult) return res.status(vendorResult.status).json({ error: vendorResult.error });
    const vendorFields = vendorResult.touched && vendorResult.fields.vendorId ? vendorResult.fields : {};

    const line = await CstepArrangement.create({
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
      source: "ADDED",
      arrangedType,
      details: details || undefined,
      status: "PENDING",
      createdBy: new mongoose.Types.ObjectId(uid),
      ...(amountResult.touched ? amountResult.fields : {}),
      ...vendorFields,
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
      ...adminOverrideMark(req),
      comment:
        `Added ${arrangedType}${details ? ` — ${details}` : ""}` +
        amountLabel +
        (line.vendorId ? ` | Vendor: ${line.vendorCode} ${line.vendorName}` : ""),
      at: new Date().toISOString(),
    });

    res.status(201).json({ ok: true, line: line.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests arrangements POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to add arrangement line" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /requests/:id/vendor-options — the active vendors an arrangement line
 * can be booked with, for the vendor select on the ledger. Same authority as
 * the arrangement edits themselves (this traveller's Official user or a
 * CSTEP Admin) — the Vendor Master page itself stays Admin/Finance only,
 * this is just the pick-list. Only while ARRANGING.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/requests/:id/vendor-options", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!(await callerCanArrangeForTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Travel Desk or a CSTEP Admin can perform this action" });
    }
    const reopened =
      CHANGEABLE_STATUSES.has(doc.status) &&
      !!(await CstepChangeRequest.exists({ workspaceId: req.workspaceObjectId, travelRequestId: doc._id, status: "OPEN" }));
    if (doc.status !== "ARRANGING" && !reopened) {
      return res.status(409).json({ error: "Vendors are chosen while the request is being arranged" });
    }
    const [vendors, types] = await Promise.all([
      CstepVendor.find({ workspaceId: req.workspaceObjectId, isActive: true })
        .select("_id vendorCode name city vendorTypeId")
        .sort({ name: 1 })
        .lean(),
      CstepVendorType.find({ workspaceId: req.workspaceObjectId }).select("_id name").lean(),
    ]);
    const typeName = new Map((types as any[]).map((t) => [String(t._id), t.name]));
    res.json({
      ok: true,
      vendors: (vendors as any[]).map((v) => ({
        _id: v._id,
        vendorCode: v.vendorCode,
        name: v.name,
        city: v.city || "",
        vendorTypeName: typeName.get(String(v.vendorTypeId)) || "",
      })),
    });
  } catch (err: any) {
    console.error("[CSTEP requests vendor-options]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load vendors" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /requests/:id/arrangements/:lineId/payment — this traveller's
 * Official or Finance user, or a CSTEP Admin, marks an arrangement line's
 * vendor paid (or back to unpaid). From ARRANGING onwards — the Official
 * records it at the arrange step — and only on a line that already has a
 * vendor. Body: { paymentStatus: "PAID" | "UNPAID",
 * paymentRef?, vendorInvoiceNo?, paidAt? ("YYYY-MM-DD", defaults to today;
 * never in the future) }. PAID stamps paidAt/paidBy/paymentRef/
 * vendorInvoiceNo with paymentSource MANUAL; UNPAID clears them. Every change is logged as VENDOR_PAYMENT,
 * the way ARRANGE_SERVICE logs a line edit.
 * ───────────────────────────────────────────────────────────────────── */
router.patch("/requests/:id/arrangements/:lineId/payment", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    const refusal = await callerPaymentRefusal(req, doc.travelerProfileId);
    if (refusal) return res.status(403).json({ error: refusal });
    if (isClaimFormType(doc.formType) || !VENDOR_PAYABLE_STATUSES.has(doc.status)) {
      return res.status(409).json({ error: "A vendor payment can be recorded once the request is being arranged" });
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
    if (!line.vendorId) {
      return res.status(409).json({ error: "Choose a vendor for this line before recording a payment" });
    }

    const body = req.body || {};
    const next = body.paymentStatus;
    if (next !== "PAID" && next !== "UNPAID") {
      return res.status(400).json({ error: "paymentStatus must be PAID or UNPAID" });
    }
    // A payment is recorded against a real figure — the payables, Travel
    // Register and Tally export all read amountInr off the line.
    const amountGap = next === "PAID" ? arrangementAmountGap(line) : null;
    if (amountGap) {
      return res.status(409).json({
        error: `${SERVICE_LABEL[line.arrangedType] || line.arrangedType} — ${line.vendorName || line.vendorCode} on ${
          doc.claimReference || "this request"
        } ${amountGap} — enter the amount before marking it paid`,
      });
    }
    const paymentRef = String(body.paymentRef ?? "").trim();
    if (paymentRef.length > 100) return res.status(400).json({ error: "Payment reference is too long (100 characters max)" });
    const vendorInvoiceNo = String(body.vendorInvoiceNo ?? "").trim();
    if (vendorInvoiceNo.length > 100) return res.status(400).json({ error: "Vendor invoice no. is too long (100 characters max)" });

    let paidAt = new Date();
    if (next === "PAID" && body.paidAt) {
      const s = String(body.paidAt).trim();
      // Midday IST, so the calendar date never slips across a timezone.
      const parsed = new Date(`${s}T12:00:00+05:30`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ error: "paidAt must be a date (YYYY-MM-DD)" });
      }
      if (s > istDate(new Date())) {
        return res.status(400).json({ error: "The payment date can't be in the future" });
      }
      paidAt = parsed;
    }

    const before = line.paymentStatus || "UNPAID";
    if (next === "PAID") {
      line.paymentStatus = "PAID";
      line.paidAt = paidAt;
      line.paidBy = new mongoose.Types.ObjectId(ownerId(req));
      line.paymentRef = paymentRef || undefined;
      line.vendorInvoiceNo = vendorInvoiceNo || undefined;
    } else {
      line.paymentStatus = "UNPAID";
      line.paidAt = undefined;
      line.paidBy = undefined;
      line.paymentRef = undefined;
      line.vendorInvoiceNo = undefined;
    }
    line.paymentSource = "MANUAL";
    line.paymentBatchId = undefined;
    await line.save();

    await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "FINANCE",
      actor: new mongoose.Types.ObjectId(ownerId(req)),
      action: "VENDOR_PAYMENT",
      comment:
        `${line.arrangedType} — ${line.vendorCode} ${line.vendorName}: ${before} => ${line.paymentStatus}` +
        (line.paymentStatus === "PAID"
          ? (line.paymentRef ? ` | Ref: ${line.paymentRef}` : "") +
            (line.vendorInvoiceNo ? ` | Invoice: ${line.vendorInvoiceNo}` : "") +
            ` | Paid on ${istDate(line.paidAt as Date)}`
          : ""),
      at: new Date().toISOString(),
    });

    res.json({ ok: true, line: line.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests arrangements payment PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to record the vendor payment" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /requests/:id/arrangements/:lineId/missing-amount — this
 * traveller's Finance user or a CSTEP Admin puts the amount on a
 * vendor-bearing line that has none, from ARRANGING onwards and whether or
 * not it is paid yet. The arrangement PATCH only works while ARRANGING and
 * refuses a paid line, so without this a line paid (or left unpaid past
 * the arrange step) with no amount could never get one — and can't be paid
 * or exported to Tally without it. Narrow on purpose: a line that already
 * has an amount is refused (correct it the normal way, unpaid while
 * ARRANGING). Body: the arrangement PATCH's amount fields (currency,
 * amount, exchangeRate, rateDate, rateSource); the result must be a
 * positive INR amount. Logged as VENDOR_PAYMENT.
 * ───────────────────────────────────────────────────────────────────── */
router.patch("/requests/:id/arrangements/:lineId/missing-amount", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!(await callerCanFinanceForTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Finance user or a CSTEP Admin can set a missing amount" });
    }
    if (isClaimFormType(doc.formType) || !VENDOR_PAYABLE_STATUSES.has(doc.status)) {
      return res.status(409).json({ error: "A missing amount can be set once the request is being arranged" });
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
    if (!line.vendorId) return res.status(409).json({ error: "Choose a vendor for this line first" });
    if (!arrangementAmountGap(line)) {
      return res.status(409).json({ error: "This line already has an amount — only a missing amount can be set here" });
    }

    const amountResult = computeArrangementAmountFields(req.body || {});
    if (!amountResult.ok) return res.status(400).json({ error: amountResult.error });
    if (!amountResult.touched || !(Number(amountResult.fields.amountInr) > 0)) {
      return res.status(400).json({ error: "Enter an amount above zero (and an exchange rate for a foreign currency)" });
    }
    line.currency = amountResult.fields.currency;
    line.amount = amountResult.fields.amount;
    line.exchangeRate = amountResult.fields.exchangeRate;
    line.rateDate = amountResult.fields.rateDate;
    line.rateSource = amountResult.fields.rateSource;
    line.amountInr = amountResult.fields.amountInr;
    await line.save();

    await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "FINANCE",
      actor: new mongoose.Types.ObjectId(ownerId(req)),
      action: "VENDOR_PAYMENT",
      comment:
        `${line.arrangedType} — ${line.vendorCode} ${line.vendorName}: missing amount set` +
        ` | Amount: ${line.amount} ${line.currency}${line.currency !== "INR" ? ` (₹${line.amountInr})` : ""}` +
        ` | ${line.paymentStatus === "PAID" ? "already paid" : "unpaid"}`,
      at: new Date().toISOString(),
    });

    res.json({ ok: true, line: line.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests arrangements missing-amount PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to set the amount" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/mark-arranged — Official/Admin marks the whole
 * request arranged: ARRANGING -> ARRANGED. Logs MARK_ARRANGED. Does NOT
 * hard-block on incomplete lines (still PENDING) — the Official's
 * judgement call, matching the spec. F6: seed rows the Official never
 * touched (PENDING, no amount, no details) are removed here instead of
 * being frozen into the case, and the entry says what was dropped; a
 * PENDING row they DID touch is kept as their call (it still only reaches
 * the report/settlement if it carries an amount — see arrangementIsReal).
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests/:id/mark-arranged", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!(await callerCanArrangeForTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Travel Desk or a CSTEP Admin can perform this action" });
    }
    if (doc.status !== "ARRANGING") {
      return res.status(409).json({ error: "Only a request currently being arranged can be marked arranged" });
    }

    const untouched: any[] = (
      await CstepArrangement.find({ workspaceId: req.workspaceObjectId, requestId: doc._id }).lean()
    ).filter(arrangementIsUntouchedSeed);
    if (untouched.length > 0) {
      await CstepArrangement.deleteMany({
        workspaceId: req.workspaceObjectId,
        requestId: doc._id,
        _id: { $in: untouched.map((a) => a._id) },
      });
    }

    doc.status = "ARRANGED";
    await doc.save();

    const entry = await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "OFFICIAL",
      actor: new mongoose.Types.ObjectId(ownerId(req)),
      action: "MARK_ARRANGED",
      ...adminOverrideMark(req),
      comment:
        untouched.length > 0
          ? `Dropped ${untouched.length} untouched seed line(s): ${untouched.map((a) => a.arrangedType).join(", ")}`
          : undefined,
      at: new Date().toISOString(),
    });
    await notifyCstep("ARRANGED", doc, { logEntryId: entry._id });

    res.json({ ok: true, request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests mark-arranged]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to mark travel request arranged" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * Change requests — a cancel / rebook against one arranged service on an
 * arranged trip (models/cstep/CstepChangeRequest.ts). Tracks and routes the
 * change only: the Travel Desk makes the booking change by hand — nothing
 * here calls TBO or any supplier.
 *
 *   raise    the traveller (request creator / claimed profile), or this
 *            traveller's Official user / a CSTEP Admin — while ARRANGED or
 *            REPORT_PENDING (report/start auto-fires on open, so a trip that
 *            hasn't happened yet is often REPORT_PENDING already), on a
 *            Flight or Cab line. One OPEN change per line.
 *   list     GET /requests/:id/change-requests — anyone who can read the
 *            request; GET /change-requests — the Official's / Admin's queue.
 *   resolve  the Official / a CSTEP Admin: DONE or DECLINED, note required.
 *
 * While a change is OPEN its line is reopened for the Official: PATCH
 * /arrangements/:lineId and GET /vendor-options admit it outside ARRANGING
 * (lineOpenForChange). Notifications: CHANGE_RAISED → the Official,
 * CHANGE_RESOLVED → the traveller, each keyed on its own CstepApproval entry.
 * ───────────────────────────────────────────────────────────────────── */
const CHANGEABLE_STATUSES = new Set(["ARRANGED", "REPORT_PENDING"]);
const CHANGEABLE_SERVICE_TYPES = new Set<string>(["FLIGHT", "CAB"]);
const CHANGE_KIND_LABEL: Record<CstepChangeKind, string> = { CANCEL: "Cancel", REBOOK: "Rebook" };

/** The traveller themself: the request's creator, or the User who claimed
 * its TravellerProfile (an Admin may have filed on their behalf). */
async function callerIsRequestTraveller(req: any, doc: any): Promise<boolean> {
  const uid = ownerId(req);
  if (String(doc.createdBy) === uid) return true;
  const traveller: any = await TravellerProfile.findOne({ _id: doc.travelerProfileId, workspaceId: req.workspaceObjectId })
    .select("claimedBy")
    .lean();
  return !!traveller?.claimedBy && String(traveller.claimedBy) === uid;
}

/** Is this arrangement line reopened by an OPEN change request? Only while
 * the trip is still at a changeable status — once the report is in, the
 * line feeds the settlement and stays as it is. */
async function lineOpenForChange(req: any, doc: any, lineId: any): Promise<boolean> {
  if (!CHANGEABLE_STATUSES.has(doc.status) || !mongoose.Types.ObjectId.isValid(String(lineId))) return false;
  return !!(await CstepChangeRequest.exists({
    workspaceId: req.workspaceObjectId,
    travelRequestId: doc._id,
    arrangementId: new mongoose.Types.ObjectId(String(lineId)),
    status: "OPEN",
  }));
}

function changeNotifyCtx(cr: any) {
  return {
    kind: cr.kind as CstepChangeKind,
    serviceLabel: SERVICE_LABEL[cr.serviceType] || cr.serviceType,
    details: cr.details,
  };
}

/* POST /requests/:id/change-requests — body { arrangementId, kind, details, reason }. */
router.post("/requests/:id/change-requests", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    const isTraveller = await callerIsRequestTraveller(req, doc);
    if (!isTraveller && !(await callerCanArrangeForTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only the traveller, their Travel Desk or a CSTEP Admin can request a change" });
    }
    if (isClaimFormType(doc.formType) || !CHANGEABLE_STATUSES.has(doc.status)) {
      return res.status(409).json({ error: "A change can be requested only on an arranged trip, before its travel report is submitted" });
    }

    const body = req.body || {};
    if (!CSTEP_CHANGE_KINDS.includes(body.kind)) return res.status(400).json({ error: "kind must be CANCEL or REBOOK" });
    const details = String(body.details || "").trim();
    const reason = String(body.reason || "").trim();
    if (!details) return res.status(400).json({ error: "Details are required — what to cancel, or the new dates / route" });
    if (!reason) return res.status(400).json({ error: "A reason is required" });
    if (!mongoose.Types.ObjectId.isValid(String(body.arrangementId || ""))) {
      return res.status(400).json({ error: "Pick the arranged service to change" });
    }
    const line: any = await CstepArrangement.findOne({
      _id: new mongoose.Types.ObjectId(String(body.arrangementId)),
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
    }).lean();
    if (!line) return res.status(404).json({ error: "Arranged service not found on this request" });
    if (!CHANGEABLE_SERVICE_TYPES.has(line.arrangedType)) {
      return res.status(400).json({ error: "Changes can be requested for flights and cabs only" });
    }

    const uid = new mongoose.Types.ObjectId(ownerId(req));
    let cr: any;
    try {
      cr = await CstepChangeRequest.create({
        workspaceId: req.workspaceObjectId,
        travelRequestId: doc._id,
        arrangementId: line._id,
        serviceType: line.arrangedType,
        kind: body.kind,
        details,
        reason,
        status: "OPEN",
        raisedBy: uid,
        raisedAt: new Date(),
      });
    } catch (err: any) {
      if (err?.code === 11000) return res.status(409).json({ error: "This service already has an open change request" });
      throw err;
    }

    const service = SERVICE_LABEL[line.arrangedType] || line.arrangedType;
    const entry = await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: isTraveller ? "TRAVELLER" : "OFFICIAL",
      actor: uid,
      action: "CHANGE_REQUEST",
      ...adminOverrideMark(req),
      comment: `${CHANGE_KIND_LABEL[cr.kind as CstepChangeKind]} ${service}: ${details} — Reason: ${reason}`,
      at: new Date().toISOString(),
    });
    cr.raisedLogId = entry._id;
    await cr.save();
    await notifyCstep("CHANGE_RAISED", doc, { logEntryId: entry._id, reason, change: changeNotifyCtx(cr) });

    res.status(201).json({ ok: true, changeRequest: cr.toObject() });
  } catch (err: any) {
    console.error("[CSTEP change-requests POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to request the change" });
  }
});

/* GET /requests/:id/change-requests — this request's changes, newest first. */
router.get("/requests/:id/change-requests", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!(await callerIsRequestTraveller(req, doc)) && !(await callerCanViewTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Not authorized to view this travel request" });
    }
    const changeRequests = await CstepChangeRequest.find({ workspaceId: req.workspaceObjectId, travelRequestId: doc._id })
      .sort({ raisedAt: -1 })
      .lean();
    res.json({ ok: true, changeRequests });
  } catch (err: any) {
    console.error("[CSTEP change-requests GET one]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load change requests" });
  }
});

/* GET /change-requests?status=OPEN|DONE|DECLINED|ALL — the Official's queue
 * (their travellers' changes), or the workspace Travel Desk's / a CSTEP
 * Admin's (all). Anyone else gets an
 * empty list, same posture as the other queues. Default OPEN. Each row
 * carries the trip's purpose / reference / status and the traveller's name. */
router.get("/change-requests", async (req: any, res: any) => {
  try {
    const status = String(req.query.status || "OPEN").toUpperCase();
    const filter: any = { workspaceId: req.workspaceObjectId };
    if (status !== "ALL") {
      if (!CSTEP_CHANGE_STATUSES.includes(status as any)) return res.status(400).json({ error: "Unknown status" });
      filter.status = status;
    }

    if (!isCstepAdmin(req) && !(await holdsTravelDeskGrant(req))) {
      const mine = await TravellerProfile.find({
        workspaceId: req.workspaceObjectId,
        officialUserId: new mongoose.Types.ObjectId(ownerId(req)),
      })
        .select("_id")
        .lean();
      if (mine.length === 0) return res.json({ ok: true, changeRequests: [] });
      // The traveller lives on the request, so scope by the requests first.
      const theirs = await CstepTravelRequest.find({
        workspaceId: req.workspaceObjectId,
        travelerProfileId: { $in: mine.map((t: any) => t._id) },
      })
        .select("_id")
        .lean();
      filter.travelRequestId = { $in: theirs.map((r: any) => r._id) };
    }

    const crs: any[] = await CstepChangeRequest.find(filter).sort({ raisedAt: -1 }).limit(500).lean();
    const requests: any[] = crs.length
      ? await CstepTravelRequest.find({
          workspaceId: req.workspaceObjectId,
          _id: { $in: [...new Set(crs.map((c) => String(c.travelRequestId)))] },
        })
          .select("_id purpose claimReference status travelerProfileId departureDate returnDate")
          .lean()
      : [];
    const named = new Map((await withTravellerNames(req, requests)).map((r: any) => [String(r._id), r]));
    const rows = crs
      .filter((c) => named.has(String(c.travelRequestId)))
      .map((c) => {
        const r: any = named.get(String(c.travelRequestId));
        return {
          ...c,
          request: {
            _id: r._id,
            purpose: r.purpose,
            claimReference: r.claimReference,
            status: r.status,
            departureDate: r.departureDate,
            returnDate: r.returnDate,
            travellerName: r.travellerName,
          },
        };
      });
    res.json({ ok: true, changeRequests: rows });
  } catch (err: any) {
    console.error("[CSTEP change-requests GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to list change requests" });
  }
});

/* POST /change-requests/:id/resolve — body { status: DONE | DECLINED, note }.
 * Resolvable at any request status (a change left open when the trip moved
 * on can still be closed); only the reopened-line editing is status-bound. */
router.post("/change-requests/:id/resolve", async (req: any, res: any) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ error: "Change request not found" });
    const cr: any = await CstepChangeRequest.findOne({
      _id: new mongoose.Types.ObjectId(req.params.id),
      workspaceId: req.workspaceObjectId,
    });
    if (!cr) return res.status(404).json({ error: "Change request not found" });
    const doc = await loadRequest(req, String(cr.travelRequestId));
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!(await callerCanArrangeForTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Travel Desk or a CSTEP Admin can resolve a change request" });
    }

    const body = req.body || {};
    if (body.status !== "DONE" && body.status !== "DECLINED") {
      return res.status(400).json({ error: "status must be DONE or DECLINED" });
    }
    const note = String(body.note || "").trim();
    if (!note) return res.status(400).json({ error: "A note is required" });

    const uid = new mongoose.Types.ObjectId(ownerId(req));
    const now = new Date();
    // Conditional on OPEN, so two resolvers racing can't both close it.
    const resolved: any = await CstepChangeRequest.findOneAndUpdate(
      { _id: cr._id, workspaceId: req.workspaceObjectId, status: "OPEN" },
      { $set: { status: body.status, handledBy: uid, handledAt: now, resolutionNote: note } },
      { new: true },
    );
    if (!resolved) return res.status(409).json({ error: "This change request is already resolved" });

    const service = SERVICE_LABEL[resolved.serviceType] || resolved.serviceType;
    const entry = await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "OFFICIAL",
      actor: uid,
      action: "CHANGE_RESOLVE",
      ...adminOverrideMark(req),
      comment: `${CHANGE_KIND_LABEL[resolved.kind as CstepChangeKind]} ${service} — ${body.status === "DONE" ? "Done" : "Declined"}: ${note}`,
      at: now.toISOString(),
    });
    await CstepChangeRequest.updateOne(
      { _id: resolved._id, workspaceId: req.workspaceObjectId },
      { $set: { resolvedLogId: entry._id } },
    );
    await notifyCstep("CHANGE_RESOLVED", doc, {
      logEntryId: entry._id,
      change: { ...changeNotifyCtx(resolved), outcome: body.status, resolutionNote: note },
    });

    res.json({ ok: true, changeRequest: { ...resolved.toObject(), resolvedLogId: entry._id } });
  } catch (err: any) {
    console.error("[CSTEP change-requests resolve]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to resolve the change request" });
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
    if (!isOwner && !(await callerCanViewTraveller(req, doc.travelerProfileId))) {
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
 * POST /attachments/staging — claims addition. Uploads a claim receipt
 * BEFORE the claim exists, so a line can carry it during intake: stores the
 * file in S3 and creates a CstepAttachment with neither claimId nor
 * travelRequestId. The returned _id goes on the line as attachmentId; the
 * claim's create/PATCH checks the caller staged it (checkClaimAttachments)
 * and links it to the claim (linkClaimAttachments). Any CSTEP user may
 * stage their own receipt; it is useless to anyone else — nobody else may
 * attach it. No OCR in this pass — attachment only.
 * Body (multipart): file, documentType? (CstepAttachment's enum, default
 * OTHER).
 * ───────────────────────────────────────────────────────────────────── */
const STAGING_DOCUMENT_TYPES = new Set<string>([
  "BOARDING_PASS",
  "ETICKET",
  "HOTEL_FOLIO",
  "CAB_RECEIPT",
  "TAX_INVOICE",
  "FOREX_RECEIPT",
  "OTHER",
]);

router.post("/attachments/staging", reportAttachmentUpload.single("file"), async (req: any, res: any) => {
  try {
    const uid = ownerId(req);
    if (!req.workspaceObjectId || !uid) {
      return res.status(400).json({ error: "Missing workspace or user context" });
    }
    const file = req.file;
    if (!file || !file.buffer) return res.status(400).json({ error: "File is required" });

    const documentType = STAGING_DOCUMENT_TYPES.has(req.body?.documentType) ? req.body.documentType : "OTHER";
    const uploaded = await uploadBufferToS3({
      buffer: file.buffer,
      mime: file.mimetype,
      originalName: file.originalname,
      customerId: String(req.workspaceObjectId),
      createdBy: uid,
      keyPrefix: `cstep/claim-receipts/${req.workspaceObjectId}/${uid}`,
    });

    const attachment = await CstepAttachment.create({
      workspaceId: req.workspaceObjectId,
      s3Key: uploaded.key,
      originalName: file.originalname,
      mime: file.mimetype,
      documentType,
      createdBy: new mongoose.Types.ObjectId(uid),
    });

    const url = await presignGetObject({
      bucket: env.S3_BUCKET,
      key: attachment.s3Key,
      filename: attachment.originalName,
      view: true,
      contentType: attachment.mime,
    });

    res.status(201).json({
      ok: true,
      attachment: { _id: attachment._id, originalName: attachment.originalName, mime: attachment.mime, url },
    });
  } catch (err: any) {
    console.error("[CSTEP attachments staging]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to upload the receipt" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/report/submit — creator-only, REPORT_PENDING →
 * REPORT_UNDER_APPROVAL. Logs SUBMIT_REPORT and emails the Manager (the
 * traveller's Approver), whose approval (POST /report/approve) is what
 * hands the report to the Official at REPORT_SUBMITTED. Builds no
 * settlement — that still starts from REPORT_SUBMITTED.
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

    // Every leg's fare as submitted is the ceiling for the Manager's
    // reduce-only correction (PATCH /report/legs/:legId/reduce). A
    // resubmit stamps it afresh.
    await CstepReportLeg.updateMany({ workspaceId: req.workspaceObjectId, requestId: doc._id }, [
      { $set: { claimedFare: "$fare" } },
    ]);

    doc.status = "REPORT_UNDER_APPROVAL";
    await doc.save();

    const entry = await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "TRAVELER",
      actor: new mongoose.Types.ObjectId(uid),
      action: "SUBMIT_REPORT",
      at: new Date().toISOString(),
    });
    // REPORT_SUBMITTED is the email event's name: it goes to the Manager.
    await notifyCstep("REPORT_SUBMITTED", doc, { logEntryId: entry._id });

    res.json({ ok: true, request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests report submit]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to submit the travel report" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /requests/:id/report/legs/:legId/reduce — the Manager (or a CSTEP
 * Admin) reduces a leg's fare while the travel report awaits their approval
 * (REPORT_UNDER_APPROVAL). Body { fare, reason }. Reduce-only: never above
 * the fare as submitted (claimedFare, stamped at report/submit); reason
 * mandatory. Logs REDUCE_AMOUNT (stage APPROVER). The settlement later
 * seeds from the reduced fare.
 * ───────────────────────────────────────────────────────────────────── */
router.patch("/requests/:id/report/legs/:legId/reduce", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!(await callerCanActOnTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Approver or a CSTEP Admin can reduce a fare" });
    }
    if (doc.status !== "REPORT_UNDER_APPROVAL") {
      return res.status(409).json({ error: "A fare can be reduced only while the travel report awaits approval" });
    }
    if (!mongoose.Types.ObjectId.isValid(req.params.legId)) {
      return res.status(400).json({ error: "Invalid report leg id" });
    }
    const leg = await CstepReportLeg.findOne({ _id: req.params.legId, workspaceId: req.workspaceObjectId, requestId: doc._id });
    if (!leg) return res.status(404).json({ error: "Report leg not found" });

    const n = Number(req.body?.fare);
    if (req.body?.fare === undefined || req.body?.fare === null || !isFinite(n) || n < 0) {
      return res.status(400).json({ error: "fare must be a non-negative number" });
    }
    const next = Math.round(n * 100) / 100;
    const was = Number(leg.fare) || 0;
    const ceiling = leg.claimedFare ?? was;
    const money = (v: number) => (leg.currency && leg.currency !== "INR" ? `${leg.currency} ${v}` : inrText(v));
    if (next > ceiling) {
      return res.status(400).json({ error: `A fare can only be reduced — this leg was claimed at ${money(ceiling)}`, claimedFare: ceiling });
    }
    if (next === was) return res.status(400).json({ error: "The fare is unchanged" });
    const reason = String(req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({ error: "reason is required" });

    leg.claimedFare = ceiling;
    leg.fare = next;
    await leg.save();

    await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "APPROVER",
      actor: new mongoose.Types.ObjectId(ownerId(req)),
      action: "REDUCE_AMOUNT",
      comment:
        `${leg.direction === "ONWARD" ? "Onward" : "Return"} ${leg.travelMode} leg: ${money(was)} → ${money(next)}` +
        ` (claimed ${money(ceiling)}) — ${reason}`,
      at: new Date().toISOString(),
    });

    res.json({ ok: true, leg: leg.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests report leg reduce]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to reduce the fare" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/report/approve — report approval. The Manager (the
 * traveller's Approver), or a CSTEP Admin as the fallback, approves the
 * submitted travel report: REPORT_UNDER_APPROVAL → REPORT_SUBMITTED, logs
 * APPROVE_REPORT (stage APPROVER, with the optional comment) and emails the
 * Official, whose settlement path from REPORT_SUBMITTED is unchanged. To
 * send the report back instead, the Manager uses POST /report/return.
 * (Admin-as-fallback is deliberate for now; CSTEP's "Admin shouldn't
 * approve before the Manager" is a separate, deferred change.)
 * ───────────────────────────────────────────────────────────────────── */
router.post("/requests/:id/report/approve", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    const refusal = await callerApprovalRefusal(req, doc.travelerProfileId);
    if (refusal) return res.status(403).json({ error: refusal });
    if (doc.status !== "REPORT_UNDER_APPROVAL") {
      return res.status(409).json({ error: "Only a travel report awaiting approval can be approved" });
    }

    doc.status = "REPORT_SUBMITTED";
    await doc.save();

    const comment = String(req.body?.comment || "").trim();
    const entry = await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "APPROVER",
      actor: new mongoose.Types.ObjectId(ownerId(req)),
      action: "APPROVE_REPORT",
      ...(comment ? { comment } : {}),
      at: new Date().toISOString(),
    });
    await notifyCstep("REPORT_APPROVED", doc, { logEntryId: entry._id });

    res.json({ ok: true, request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests report approve]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to approve the travel report" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /requests/:id/amend — approver-only, amends a single field while a
 * request is SUBMITTED (under review). reason is mandatory. Logged as a
 * CstepAmendment (field, oldValue, newValue, actor, timestamp, reason).
 * ───────────────────────────────────────────────────────────────────── */
const AMENDABLE_FIELDS = new Set(Object.keys(pickFields({})));
// The project is a snapshot of a Project Master entry — set by the
// traveller's create / edit (applyProjectSelection), not amended raw.
AMENDABLE_FIELDS.delete("projectId");

/* Reduce-only claim amounts — the Manager corrects a claim at approval
 * through /amend, and its amount fields may only go down. The ceiling is
 * what the traveller submitted: the field's value at the last SUBMIT /
 * RESUBMIT, read off the first approver amendment since then (the traveller
 * can't edit while it is SUBMITTED, so that amendment's oldValue is the
 * submitted figure), or the current value if there is none. A line can't be
 * added; dropping one is a reduction to ₹0 (claim lines must be above zero). */
const CLAIM_AMOUNT_LINE_FIELDS: Record<string, "fare" | "amount"> = {
  travelLines: "fare",
  foodLines: "amount",
  expenseLines: "amount",
};
const CLAIM_AMOUNT_SCALAR_FIELDS: Record<string, string> = {
  otherExpenses: "Other expenses",
  taxAmount: "Tax (IGST)",
};

async function claimAmountBaseline(req: any, doc: any, field: string, current: any): Promise<any> {
  const lastSubmit: any = await CstepApproval.findOne({
    workspaceId: req.workspaceObjectId,
    entityType: "REQUEST",
    entityId: doc._id,
    action: { $in: ["SUBMIT", "RESUBMIT"] },
  })
    .sort({ at: -1 })
    .select("at")
    .lean();
  if (!lastSubmit) return current;
  const first: any = await CstepAmendment.findOne({
    workspaceId: req.workspaceObjectId,
    requestId: doc._id,
    field,
    changedAt: { $gt: lastSubmit.at },
  })
    .sort({ changedAt: 1 })
    .select("oldValue")
    .lean();
  return first ? first.oldValue : current;
}

function claimLineLabel(field: string, l: any): string {
  if (field === "travelLines") return `Travel ${l?.date || ""}: ${[l?.from, l?.to].filter(Boolean).join(" → ")}`.trim();
  if (field === "foodLines") return `Food ${l?.date || ""}`.trim();
  return String(l?.description || "Expense");
}

/** The amount changes an amend makes, or the reason it is refused. */
function checkClaimReduction(field: string, baseline: any, current: any, next: any): { error: string } | { changes: string[] } {
  const key = CLAIM_AMOUNT_LINE_FIELDS[field];
  if (key) {
    if (!Array.isArray(next)) return { error: `${field} must be a list` };
    const base = new Map(((baseline || []) as any[]).map((l) => [String(l._id), l]));
    const cur = new Map(((current || []) as any[]).map((l) => [String(l._id), l]));
    const seen = new Set<string>();
    const changes: string[] = [];
    for (const l of next) {
      const id = l?._id ? String(l._id) : "";
      if (!id || !base.has(id)) return { error: "A line can't be added at approval — only the claimed lines' amounts can be reduced" };
      if (seen.has(id)) return { error: "A line appears twice" };
      seen.add(id);
      const label = claimLineLabel(field, base.get(id));
      const ceiling = Number(base.get(id)[key]) || 0;
      const was = Number(cur.get(id)?.[key]) || 0;
      const now = Number(l[key]);
      if (!isFinite(now) || now < 0) return { error: `${label}: the amount must be a non-negative number` };
      if (now > ceiling) return { error: `An amount can only be reduced — ${label} was claimed at ${inrText(ceiling)}` };
      if (now !== was) changes.push(`${label}: ${inrText(was)} → ${inrText(now)} (claimed ${inrText(ceiling)})`);
    }
    for (const [id, l] of cur) {
      if (seen.has(id)) continue;
      const ceiling = Number(base.get(id)?.[key] ?? l[key]) || 0;
      changes.push(`${claimLineLabel(field, l)}: ${inrText(Number(l[key]) || 0)} → ${inrText(0)}, line dropped (claimed ${inrText(ceiling)})`);
    }
    return { changes };
  }
  const label = CLAIM_AMOUNT_SCALAR_FIELDS[field];
  const ceiling = Number(baseline) || 0;
  const was = Number(current) || 0;
  const now = Number(next ?? 0);
  if (!isFinite(now) || now < 0) return { error: `${label} must be a non-negative amount` };
  if (now > ceiling) return { error: `An amount can only be reduced — ${label} was claimed at ${inrText(ceiling)}` };
  return { changes: now !== was ? [`${label}: ${inrText(was)} → ${inrText(now)} (claimed ${inrText(ceiling)})`] : [] };
}

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
    if (!AMENDABLE_FIELDS.has(field) || !(field in scopeFieldsToFormType({ [field]: true }, doc.formType))) {
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

    // Claim amounts are reduce-only (see checkClaimReduction).
    let reductions: string[] = [];
    if (CLAIM_AMOUNT_LINE_FIELDS[field] || CLAIM_AMOUNT_SCALAR_FIELDS[field]) {
      const baseline = await claimAmountBaseline(req, doc, field, oldValue);
      const check = checkClaimReduction(field, baseline, oldValue, newValue);
      if ("error" in check) return res.status(400).json({ error: check.error });
      reductions = check.changes;
    }

    const merged: any = { ...before, [field]: newValue };
    const validationError = validatePayload(merged);
    if (validationError) return res.status(400).json({ error: validationError });

    (doc as any)[field] = newValue;
    await doc.save();

    const actor = new mongoose.Types.ObjectId(ownerId(req));
    const changedAt = new Date().toISOString();
    await CstepAmendment.create({
      workspaceId: req.workspaceObjectId,
      requestId: doc._id,
      field,
      oldValue,
      newValue,
      changedBy: actor,
      changedAt,
      reason,
    });
    if (reductions.length > 0) {
      await CstepApproval.create({
        workspaceId: req.workspaceObjectId,
        entityType: "REQUEST",
        entityId: doc._id,
        stage: "APPROVER",
        actor,
        action: "REDUCE_AMOUNT",
        comment: `${reductions.join("; ")} — ${reason}`,
        at: changedAt,
      });
    }

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
    if (String(doc.createdBy) !== uid && !(await callerCanViewTraveller(req, doc.travelerProfileId))) {
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
        // #12 — a Travel Desk action by an Admin who isn't the Travel Desk
        ...(a.adminOverride ? { adminOverride: true } : {}),
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
    if (!isOwner && !(await callerCanViewTraveller(req, doc.travelerProfileId))) {
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

      let key: string;
      switch (doc.formType) {
        case "EVENT_REQUEST":
          ({ key } = await uploadCstepEventRequestPdf(doc.toObject(), travellerInfo, trail));
          break;
        case "LOCAL_TRAVEL_CLAIM":
        case "EXPENSE_CLAIM": {
          const claimSettlement: CstepClaimSettlementPdfData | undefined = settlement
            ? {
                status: settlement.status,
                amountClaimed: settlement.amountClaimed,
                advanceTaken: settlement.advanceTaken,
                amountDueByCstep: settlement.amountDueByCstep,
                amountDueToCstep: settlement.amountDueToCstep,
              }
            : undefined;
          ({ key } =
            doc.formType === "EXPENSE_CLAIM"
              ? await uploadCstepExpenseClaimPdf(doc.toObject(), travellerInfo, trail, claimSettlement)
              : await uploadCstepLocalTravelClaimPdf(doc.toObject(), travellerInfo, trail, claimSettlement));
          break;
        }
        case "TOUR_PROPOSAL":
          ({ key } = await uploadCstepTourProposalPdf(doc.toObject(), travellerInfo, trail, settlementPdfData));
          break;
        default:
          return res.status(409).json({ error: "No PDF is available for this form type" });
      }
      doc.pdfS3Key = key;
      doc.pdfGeneratedAt = new Date();
      await doc.save();
    }

    const mode = req.query?.mode === "download" ? "download" : "view";
    const PDF_FILENAME_PREFIX: Record<string, string> = {
      TOUR_PROPOSAL: "Tour-Proposal",
      EVENT_REQUEST: "Event-Request",
      LOCAL_TRAVEL_CLAIM: "Local-Travel-Claim",
      EXPENSE_CLAIM: "Expense-Claim",
    };
    const filenamePrefix = PDF_FILENAME_PREFIX[doc.formType] || "CSTEP-Request";
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
 * Claim Declaration form (#8) — the standalone self-declaration PDF for a
 * claim's items with no bill or invoice (utils/cstepClaimPdf.ts
 * claimDeclarationItems / generateCstepClaimDeclarationPdf).
 *
 * Generated at submission (POST /requests created as SUBMITTED, POST
 * /:id/submit — first submit and every resubmit), and regenerated by GET
 * /declaration-pdf whenever what it shows has changed since: cached on
 * declarationS3Key / declarationHash, keyed on the hash of its content (the
 * items, claimant, reference, submission) rather than updatedAt, so an
 * unrelated edit never re-renders it. A claim whose every item has a bill
 * gets none (an earlier one is cleared). Its cache is written without
 * touching updatedAt, so it never makes the claim PDF look stale.
 * ───────────────────────────────────────────────────────────────────── */
async function ensureClaimDeclaration(req: any, doc: any): Promise<string | null> {
  if (!isClaimFormType(doc.formType) || doc.status === "DRAFT") return null;
  const scope = { _id: doc._id, workspaceId: req.workspaceObjectId };
  const items = claimDeclarationItems(doc);
  if (items.length === 0) {
    if (doc.declarationS3Key) {
      await CstepTravelRequest.updateOne(scope, { $unset: { declarationS3Key: 1, declarationHash: 1, declarationGeneratedAt: 1 } }, { timestamps: false });
      doc.declarationS3Key = undefined;
      doc.declarationHash = undefined;
    }
    return null;
  }

  const traveller: any = await TravellerProfile.findOne({ _id: doc.travelerProfileId, workspaceId: req.workspaceObjectId })
    .select("firstName lastName gender travelerId")
    .lean();
  const approvals = await CstepApproval.find({ workspaceId: req.workspaceObjectId, entityType: "REQUEST", entityId: doc._id })
    .populate("actor", "firstName lastName name email")
    .sort({ at: 1 })
    .lean();
  const trail: CstepApprovalTrailEntry[] = (approvals as any[]).map((a) => ({
    action: a.action,
    actorName: a.actor?.name || [a.actor?.firstName, a.actor?.lastName].filter(Boolean).join(" ").trim() || a.actor?.email || "—",
    at: a.at,
    comment: a.comment,
  }));
  const claimant = {
    name: traveller ? [traveller.firstName, traveller.lastName].filter(Boolean).join(" ") : "—",
    gender: traveller?.gender,
    travelerId: traveller?.travelerId,
  };
  const submits = trail.filter((e) => e.action === "SUBMIT" || e.action === "RESUBMIT");
  const hash = claimDeclarationHash({
    items,
    claimantName: claimant.name,
    claimReference: doc.claimReference,
    formType: doc.formType,
    submittedAt: submits.length ? String(submits[submits.length - 1].at) : undefined,
  });
  if (doc.declarationS3Key && doc.declarationHash === hash) return doc.declarationS3Key;

  const { key } = await uploadCstepClaimDeclarationPdf(doc.toObject ? doc.toObject() : doc, claimant, items, trail);
  const generatedAt = new Date();
  await CstepTravelRequest.updateOne(
    scope,
    { $set: { declarationS3Key: key, declarationHash: hash, declarationGeneratedAt: generatedAt } },
    { timestamps: false },
  );
  doc.declarationS3Key = key;
  doc.declarationHash = hash;
  doc.declarationGeneratedAt = generatedAt;
  return key;
}

/** At submission: a failed render must not fail the submit — the form is
 * regenerated on its first download instead. */
async function ensureClaimDeclarationQuietly(req: any, doc: any): Promise<void> {
  try {
    await ensureClaimDeclaration(req, doc);
  } catch (err: any) {
    console.error("[CSTEP claim declaration]", err?.message);
  }
}

/* GET /requests/:id/declaration-pdf?mode=view|download — the claim's
 * Declaration form. Same readers as GET /pdf: the claimant (creator), a
 * CSTEP Admin, or the traveller's mapped Approver / Official / Finance user.
 * 409 before submission or on a non-claim; 404 when every item has a bill. */
router.get("/requests/:id/declaration-pdf", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (String(doc.createdBy) !== ownerId(req) && !(await callerCanViewTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Not authorized to view this claim" });
    }
    if (!isClaimFormType(doc.formType)) return res.status(409).json({ error: "Only a claim has a Declaration form" });
    if (doc.status === "DRAFT") return res.status(409).json({ error: "The Declaration form is generated once the claim is submitted" });

    const key = await ensureClaimDeclaration(req, doc);
    if (!key) return res.status(404).json({ error: "Every item on this claim has a bill — no Declaration form is needed" });

    const mode = req.query?.mode === "download" ? "download" : "view";
    const url = await presignGetObject({
      bucket: env.S3_BUCKET,
      key,
      filename: `Declaration-${doc.claimReference || doc._id}.pdf`,
      expiresInSeconds: 3600,
      forceDownload: mode === "download",
    });
    res.json({ ok: true, url });
  } catch (err: any) {
    console.error("[CSTEP requests declaration-pdf]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to generate the Declaration form" });
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
    const authorized = isOwner || (await callerCanViewTraveller(req, doc.travelerProfileId));
    if (!authorized) {
      return res.status(403).json({ error: "Not authorized to view this packet" });
    }
    // The packet is built from a filed travel report — a claim has none
    // (its receipts are on its own lines, shown on the claim PDF/detail).
    if (isClaimFormType(doc.formType)) {
      return res.status(409).json({ error: "The travel packet applies to tour proposals and event requests only" });
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
    if (isClaimFormType(doc.formType)) {
      // A claim's settlement is seeded once, at approve — never opened here.
      return res.status(409).json({ error: "A claim's settlement is opened when it is approved" });
    }
    if (!(await callerCanArrangeForTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Travel Desk or a CSTEP Admin can perform this action" });
    }
    if (doc.status !== "REPORT_SUBMITTED") {
      return res.status(409).json({ error: "Only a request with a submitted travel report can start settlement" });
    }

    const uid = ownerId(req);
    let settlement: any = await CstepSettlement.findOne({ workspaceId: req.workspaceObjectId, requestId: doc._id });

    if (!settlement) {
      // Per Diem Eligible = No: a zero per diem, no rate/day lookup at all.
      const eligible = isPerDiemEligible(doc);
      const computedDays = eligible ? computePerDiemDays(doc) : 0;
      const traveller: any = eligible
        ? await TravellerProfile.findOne({ _id: doc.travelerProfileId, workspaceId: req.workspaceObjectId })
            .select("perDiemRateDomesticInr perDiemRateInternationalInr")
            .lean()
        : null;
      const defaultRate = eligible ? await findDefaultPerDiemRate(req.workspaceObjectId, doc, traveller) : null;

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
            // Reduce-only ceiling: the figure the line arrives with.
            claimedAmountInr: row.amountInr,
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
        ...adminOverrideMark(req),
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
    if (!(await callerCanSettleRequest(req, doc))) {
      return res.status(403).json({
        error: isClaimFormType(doc.formType)
          ? "Only a CSTEP Admin can view a claim's settlement"
          : "Only this traveller's Travel Desk or a CSTEP Admin can view the settlement",
      });
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
 * line: correct amountInr, flip classification (reason mandatory on
 * override), mark verified. Only touches fields present in the body (same
 * "only touch what was sent" discipline as Step 3/4's PATCH routes).
 * Recomputes the settlement's buckets/totals (so amount claimed / due, and
 * what Finance pays, follow) on every change. Only while VERIFYING.
 *
 * Amounts are reduce-only: amountInr may never go above the line's
 * claimedAmountInr (the figure it was seeded with), and any change needs
 * amountReason. Logged as REDUCE_AMOUNT (before → after, reason); a
 * classification or verified change is logged as VERIFY_LINE. Finance has
 * no edit here — once the case is with Finance, Finance reduces / disallows
 * through its own routes (PATCH /finance/lines/:lineId and the rest).
 */
function inrText(n: number | undefined | null): string {
  return `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

type LineReduction = { before: number; after: number; ceiling: number; reason: string };

/**
 * #11 — the reduce-only rule for one settlement line's amount, shared by the
 * Travel Desk's line PATCH (ceiling: the claimed figure) and Finance's
 * reduce (ceiling: the finalized figure). Checks only; the caller writes.
 * change is null when the amount is unchanged (no reason needed). A refusal
 * above the ceiling carries the ceiling.
 */
function planLineReduction(
  line: { amountInr?: number },
  rawAmount: any,
  rawReason: any,
  ceiling: number,
  ceilingText: (ceiling: number) => string,
): { ok: true; change: LineReduction | null } | { ok: false; error: string; ceiling?: number } {
  const n = Number(rawAmount);
  if (!isFinite(n) || n < 0) return { ok: false, error: "amountInr must be a non-negative number" };
  const next = Math.round(n * 100) / 100;
  if (next === line.amountInr) return { ok: true, change: null };
  if (next > ceiling) return { ok: false, error: `An amount can only be reduced — ${ceilingText(ceiling)}`, ceiling };
  const reason = String(rawReason || "").trim();
  if (!reason) return { ok: false, error: "amountReason is required to change a line's amount" };
  return { ok: true, change: { before: line.amountInr ?? 0, after: next, ceiling, reason } };
}

/** The REDUCE_AMOUNT comment: before → after, the ceiling, the reason. */
function reductionComment(label: string, c: LineReduction, ceilingWord: string): string {
  return `${label}: ${inrText(c.before)} → ${inrText(c.after)} (${ceilingWord} ${inrText(c.ceiling)}) — ${c.reason}`;
}

router.patch("/requests/:id/settlement/lines/:lineId", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    const isClaim = isClaimFormType(doc.formType);
    if (!(await callerCanSettleRequest(req, doc))) {
      return res.status(403).json({
        error: isClaim
          ? "Only a CSTEP Admin can verify a claim's lines"
          : "Only this traveller's Travel Desk or a CSTEP Admin can perform this action",
      });
    }
    // A claim's lines are editable only while it awaits the Admin's
    // verification — once it is with Finance they are frozen.
    if (isClaim && doc.status !== "APPROVED") {
      return res.status(409).json({ error: "This claim has already been verified" });
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

    let amountChange: LineReduction | null = null;
    if ("amountInr" in body) {
      // A line seeded before reduce-only has no ceiling yet: the amount it
      // carries now becomes it.
      const ceiling = line.claimedAmountInr ?? line.amountInr ?? 0;
      const plan = planLineReduction(line, body.amountInr, body.amountReason, ceiling, (c) => `this line was claimed at ${inrText(c)}`);
      if ("error" in plan) {
        return res.status(400).json({ error: plan.error, ...(plan.ceiling !== undefined ? { claimedAmountInr: plan.ceiling } : {}) });
      }
      if (plan.change) {
        amountChange = plan.change;
        line.claimedAmountInr = ceiling;
        line.amountInr = plan.change.after;
      }
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
    applySettlementTotals(settlement, allLines as any[], doc);
    await settlement.save();

    const stage = isClaim ? "ADMIN" : "OFFICIAL";
    const actor = new mongoose.Types.ObjectId(ownerId(req));
    const label = line.description || line.mode;
    if (amountChange) {
      await CstepApproval.create({
        workspaceId: req.workspaceObjectId,
        entityType: "REQUEST",
        entityId: doc._id,
        stage,
        actor,
        action: "REDUCE_AMOUNT",
        ...adminOverrideMark(req),
        comment: reductionComment(label, amountChange, "claimed"),
        at: new Date().toISOString(),
      });
    }
    const otherChanges = [
      before.classification !== line.classification
        ? `classification ${before.classification} => ${line.classification} (${line.classificationOverrideReason})`
        : "",
      before.verified !== line.verified ? `verified ${before.verified} => ${line.verified}` : "",
    ].filter(Boolean);
    if (otherChanges.length > 0 || !amountChange) {
      await CstepApproval.create({
        workspaceId: req.workspaceObjectId,
        entityType: "REQUEST",
        entityId: doc._id,
        stage,
        actor,
        action: "VERIFY_LINE",
        ...adminOverrideMark(req),
        comment: `Line ${label}: ${otherChanges.length ? otherChanges.join(", ") : "no change"}`,
        at: new Date().toISOString(),
      });
    }

    res.json({ ok: true, line: line.toObject(), settlement: settlement.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests settlement line PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update the settlement line" });
  }
});

/**
 * PATCH /requests/:id/settlement/perdiem — Official/Admin sets/overrides the
 * per-diem rate, days and/or a meal / provided-benefit deduction. Every
 * change needs its reason: rate → rateReason, overrideDays → overrideReason,
 * deductionInr → deductionReason (resending the stored value is a no-op and
 * needs none; null clears an override / deduction, no reason). Recomputes
 * amountInr = max(0, days * rate - deductionInr) — days * rate stays the
 * gross — and the settlement's buckets/totals. Logs PERDIEM_ADJUST with each
 * figure's before → after. Only while the settlement is VERIFYING.
 */
router.patch("/requests/:id/settlement/perdiem", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (isClaimFormType(doc.formType)) return res.status(409).json({ error: "A claim has no per diem" });
    if (!(await callerCanArrangeForTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Travel Desk or a CSTEP Admin can perform this action" });
    }

    const settlement: any = await CstepSettlement.findOne({ workspaceId: req.workspaceObjectId, requestId: doc._id });
    if (!settlement) return res.status(404).json({ error: "Settlement not started yet" });
    if (settlement.status !== "VERIFYING") {
      return res.status(409).json({ error: "This settlement has already been finalized" });
    }

    const body = req.body || {};
    const before = {
      days: settlement.perDiem.days,
      rate: settlement.perDiem.rate,
      deductionInr: settlement.perDiem.deductionInr || 0,
      amountInr: settlement.perDiem.amountInr,
    };
    // Every check runs before any field is written, so a refused call leaves
    // the settlement untouched.
    const reasons: string[] = [];
    let nextRate: number | undefined;
    let nextOverride: { days?: number; reason?: string } | undefined;
    let nextDeduction: { amount?: number; reason?: string } | undefined;

    if ("rate" in body) {
      const n = Number(body.rate);
      if (!isFinite(n) || n < 0) return res.status(400).json({ error: "rate must be a non-negative number" });
      if (n !== settlement.perDiem.rate) {
        const reason = String(body.rateReason || "").trim();
        if (!reason) return res.status(400).json({ error: "rateReason is required when changing the per-diem rate" });
        nextRate = n;
        reasons.push(`rate: ${reason}`);
      }
    }

    if ("overrideDays" in body) {
      if (body.overrideDays === null) {
        nextOverride = {};
      } else {
        const n = Number(body.overrideDays);
        if (!isFinite(n) || n < 0) return res.status(400).json({ error: "overrideDays must be a non-negative number" });
        const reason = String(body.overrideReason || "").trim();
        if (n !== settlement.perDiem.overrideDays || reason) {
          if (!reason) return res.status(400).json({ error: "overrideReason is required when overriding per-diem days" });
          nextOverride = { days: n, reason };
          reasons.push(`days: ${reason}`);
        }
      }
    }

    if ("deductionInr" in body) {
      if (body.deductionInr === null) {
        nextDeduction = {};
      } else {
        const n = Number(body.deductionInr);
        if (!isFinite(n) || n < 0) return res.status(400).json({ error: "deductionInr must be a non-negative number" });
        const reason = String(body.deductionReason || "").trim();
        if (n !== settlement.perDiem.deductionInr || reason) {
          if (!reason) return res.status(400).json({ error: "deductionReason is required for a per-diem deduction" });
          nextDeduction = { amount: Math.round(n * 100) / 100, reason };
          reasons.push(`deduction: ${reason}`);
        }
      }
    }

    if (nextRate !== undefined) settlement.perDiem.rate = nextRate;
    if (nextOverride) {
      settlement.perDiem.overrideDays = nextOverride.days;
      settlement.perDiem.overrideReason = nextOverride.reason;
    }
    if (nextDeduction) {
      settlement.perDiem.deductionInr = nextDeduction.amount;
      settlement.perDiem.deductionReason = nextDeduction.reason;
    }

    const days = settlement.perDiem.overrideDays ?? settlement.perDiem.computedDays;
    settlement.perDiem.days = days;
    const grossInr = days * settlement.perDiem.rate;
    settlement.perDiem.amountInr = Math.round(Math.max(0, grossInr - (settlement.perDiem.deductionInr || 0)) * 100) / 100;

    const lines = await CstepSettlementLine.find({ workspaceId: req.workspaceObjectId, settlementId: settlement._id }).lean();
    const { buckets, totalCostOfTour, amountClaimed } = recomputeSettlementTotals(
      lines as any[],
      settlement.perDiem.amountInr,
    );
    settlement.buckets = buckets;
    settlement.totalCostOfTour = totalCostOfTour;
    settlement.amountClaimed = amountClaimed;
    await settlement.save();

    const after = {
      days,
      rate: settlement.perDiem.rate,
      deductionInr: settlement.perDiem.deductionInr || 0,
      amountInr: settlement.perDiem.amountInr,
    };
    const changed = (Object.keys(after) as Array<keyof typeof after>).some((k) => after[k] !== before[k]);
    if (changed || reasons.length > 0) {
      await CstepApproval.create({
        workspaceId: req.workspaceObjectId,
        entityType: "REQUEST",
        entityId: doc._id,
        stage: "OFFICIAL",
        actor: new mongoose.Types.ObjectId(ownerId(req)),
        action: "PERDIEM_ADJUST",
        ...adminOverrideMark(req),
        comment:
          `Per diem: days ${before.days} => ${after.days}, rate ${before.rate} => ${after.rate}, ` +
          `deduction ${before.deductionInr} => ${after.deductionInr}, net ${before.amountInr} => ${after.amountInr}` +
          (reasons.length > 0 ? ` (${reasons.join("; ")})` : ""),
        at: new Date().toISOString(),
      });
    }

    res.json({ ok: true, settlement: settlement.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests settlement perdiem PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update per diem" });
  }
});

/**
 * POST /requests/:id/report/return — sends a submitted Travel Report back
 * to the traveller for a fix, → REPORT_PENDING, reason mandatory, logs
 * RETURN_REPORT. Who, by status:
 *   REPORT_UNDER_APPROVAL — the Manager (traveller's Approver) or a CSTEP
 *                           Admin; stage APPROVER (report approval)
 *   REPORT_SUBMITTED      — the Official or a CSTEP Admin; stage OFFICIAL
 * The report legs become editable again and the owner resubmits via
 * POST /report/submit, which goes back to the Manager.
 *
 * Any settlement still VERIFYING is discarded with its lines: its lines are
 * seeded once, from the report legs, at /settlement/start — after the
 * traveller's fix they'd be stale, so verification starts afresh (the next
 * /settlement/start re-seeds) once the report comes back. A FINALIZED
 * settlement can't be sitting under REPORT_SUBMITTED (finalize moves the
 * request on; a Finance send-back reopens it to VERIFYING), so that is
 * refused rather than discarded.
 */
router.post("/requests/:id/report/return", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    // With the Manager the Manager returns it; at every other status the
    // Official's rule applies, unchanged.
    const withManager = doc.status === "REPORT_UNDER_APPROVAL";
    if (withManager) {
      if (!(await callerCanActOnTraveller(req, doc.travelerProfileId))) {
        return res.status(403).json({ error: "Only this traveller's Approver or a CSTEP Admin can send this travel report back" });
      }
    } else {
      if (!(await callerCanArrangeForTraveller(req, doc.travelerProfileId))) {
        return res.status(403).json({ error: "Only this traveller's Travel Desk or a CSTEP Admin can perform this action" });
      }
      if (doc.status !== "REPORT_SUBMITTED") {
        return res.status(409).json({ error: "Only a submitted travel report can be sent back to the traveller" });
      }
    }

    const reason = String(req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({ error: "reason is required" });

    const settlement: any = await CstepSettlement.findOne({ workspaceId: req.workspaceObjectId, requestId: doc._id })
      .select("status")
      .lean();
    if (settlement && settlement.status !== "VERIFYING") {
      return res.status(409).json({ error: "This settlement has already been finalized" });
    }
    if (settlement) {
      await CstepSettlementLine.deleteMany({ workspaceId: req.workspaceObjectId, settlementId: settlement._id });
      await CstepSettlement.deleteMany({ workspaceId: req.workspaceObjectId, _id: settlement._id });
    }

    doc.status = "REPORT_PENDING";
    await doc.save();

    const entry = await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: withManager ? "APPROVER" : "OFFICIAL",
      actor: new mongoose.Types.ObjectId(ownerId(req)),
      action: "RETURN_REPORT",
      ...adminOverrideMark(req),
      comment: reason,
      at: new Date().toISOString(),
    });
    await notifyCstep("RETURN_REPORT", doc, { logEntryId: entry._id, reason });

    res.json({ ok: true, request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests report return]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to send the travel report back" });
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
    if (isClaimFormType(doc.formType)) {
      return res.status(409).json({ error: "A claim is verified with POST /requests/:id/claim/verify, not finalized here" });
    }
    if (!(await callerCanArrangeForTraveller(req, doc.travelerProfileId))) {
      return res.status(403).json({ error: "Only this traveller's Travel Desk or a CSTEP Admin can perform this action" });
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

    // The claim (what the TIN points at, opened at approve time) mirrors the
    // finalized figures — it is the record anything outside this settlement
    // reads (claim status, totals). Without this it stayed CLAIM_IN_PROGRESS
    // at ₹0 forever. ADMIN_VERIFIED = the Official/Admin has verified and the
    // money is now with Finance; SETTLED = nothing owed, closed here.
    // amountDueByCstep is what CSTEP owes the traveller — the claimed
    // (reimbursable) figure; advances are not modelled in this flow, so
    // nothing is due back to CSTEP. TOUR_PROPOSAL only: an EVENT_REQUEST
    // never opens a claim, so this matches nothing there — by design.
    const claimStatus = outcome === "TO_FINANCE" ? "ADMIN_VERIFIED" : "SETTLED";
    const claim: any = await CstepClaim.findOneAndUpdate(
      { workspaceId: req.workspaceObjectId, travelRequestId: doc._id },
      {
        $set: {
          status: claimStatus,
          totalCostOfTour,
          amountClaimed,
          amountDueByCstep: amountClaimed,
          amountDueToCstep: 0,
        },
      },
      { new: true },
    )
      .select("claimReference status")
      .lean();

    const now = new Date().toISOString();
    const settleEntry = await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "OFFICIAL",
      actor: new mongoose.Types.ObjectId(uid),
      action: "SETTLE",
      ...adminOverrideMark(req),
      comment:
        `Total cost of tour: ₹${totalCostOfTour} | Amount claimed: ₹${amountClaimed} | Outcome: ${outcome}` +
        (claim ? ` | Claim ${claim.claimReference}: ${claim.status}` : ""),
      at: now,
    });
    if (outcome === "TO_FINANCE") {
      const entry = await CstepApproval.create({
        workspaceId: req.workspaceObjectId,
        entityType: "REQUEST",
        entityId: doc._id,
        stage: "OFFICIAL",
        actor: new mongoose.Types.ObjectId(uid),
        action: "TRANSFER_TO_FINANCE",
        ...adminOverrideMark(req),
        comment: `₹${amountClaimed} owed to the traveller`,
        at: now,
      });
      await notifyCstep("TRANSFERRED_TO_FINANCE", doc, { logEntryId: entry._id, amountInr: amountClaimed });
    } else {
      await notifyCstep("SETTLED", doc, { logEntryId: settleEntry._id });
    }

    res.json({ ok: true, settlement: settlement.toObject(), request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests settlement finalize]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to finalize the settlement" });
  }
});

/**
 * Claims addition — POST /requests/:id/claim/verify — the CSTEP Admin
 * verifies an APPROVED claim's settlement (seeded at approve) and hands it
 * on. Every line must be verified first (body { force: true } overrides,
 * same as /settlement/finalize). Totals are recomputed from the lines, net
 * of the advance:
 *   - money moves either way (owed to the claimant, or the claimant owes
 *     CSTEP back) -> TRANSFERRED_TO_FINANCE; the settlement stays VERIFYING
 *     and Finance finalizes it when it pays (POST /finance/settle). Logs
 *     ADMIN_VERIFY + TRANSFER_TO_FINANCE.
 *   - net exactly zero (the advance covered it) -> nothing for Finance to
 *     do: the settlement is FINALIZED (outcome CLOSE) and the claim SETTLED.
 * The lines are frozen from here on (PATCH /settlement/lines refuses once
 * the claim is no longer APPROVED).
 */
router.post("/requests/:id/claim/verify", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    if (!isClaimFormType(doc.formType)) return res.status(409).json({ error: "Only a claim can be verified here" });
    if (!isCstepAdmin(req)) return res.status(403).json({ error: "Only a CSTEP Admin can verify a claim" });
    if (doc.status !== "APPROVED") return res.status(409).json({ error: "Only an approved claim can be verified" });

    const settlement: any = await CstepSettlement.findOne({ workspaceId: req.workspaceObjectId, requestId: doc._id });
    if (!settlement || settlement.status !== "VERIFYING") {
      return res.status(409).json({ error: "This claim has no settlement awaiting verification" });
    }

    const lines = await CstepSettlementLine.find({ workspaceId: req.workspaceObjectId, settlementId: settlement._id }).lean();
    const unverified = (lines as any[]).filter((l) => !l.verified);
    if (unverified.length > 0 && !req.body?.force) {
      return res.status(409).json({
        error: `${unverified.length} line(s) are not yet verified. Verify anyway to proceed.`,
        unverifiedCount: unverified.length,
      });
    }

    applySettlementTotals(settlement, lines as any[], doc);
    const uid = ownerId(req);
    const now = new Date().toISOString();
    const toFinance = settlement.amountDueByCstep > 0 || settlement.amountDueToCstep > 0;
    const dueLine =
      settlement.amountDueByCstep > 0
        ? `₹${settlement.amountDueByCstep} due by CSTEP to the claimant`
        : settlement.amountDueToCstep > 0
          ? `₹${settlement.amountDueToCstep} due to CSTEP from the claimant`
          : "Nothing due either way";

    if (!toFinance) {
      settlement.outcome = "CLOSE";
      settlement.status = "FINALIZED";
      settlement.finalizedBy = new mongoose.Types.ObjectId(uid);
      settlement.finalizedAt = new Date();
    }
    await settlement.save();

    doc.status = toFinance ? "TRANSFERRED_TO_FINANCE" : "SETTLED";
    await doc.save();

    const verifyEntry = await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "ADMIN",
      actor: new mongoose.Types.ObjectId(uid),
      action: "ADMIN_VERIFY",
      comment: `Claimed: ₹${settlement.amountClaimed} | Advance: ₹${settlement.advanceTaken || 0} | ${dueLine}`,
      at: now,
    });
    if (toFinance) {
      const entry = await CstepApproval.create({
        workspaceId: req.workspaceObjectId,
        entityType: "REQUEST",
        entityId: doc._id,
        stage: "ADMIN",
        actor: new mongoose.Types.ObjectId(uid),
        action: "TRANSFER_TO_FINANCE",
        comment: dueLine,
        at: now,
      });
      // Which way the money moves decides the wording: payable to the
      // claimant, or to be recovered from them (an unspent advance).
      const { direction, amount } = financeCaseAmount(doc.formType, settlement);
      await notifyCstep("TRANSFERRED_TO_FINANCE", doc, { logEntryId: entry._id, amountInr: amount, direction });
    } else {
      await notifyCstep("SETTLED", doc, { logEntryId: verifyEntry._id });
    }

    res.json({ ok: true, settlement: settlement.toObject(), request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests claim verify]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to verify the claim" });
  }
});

/**
 * Step 6 — POST /requests/:id/finance/settle — the traveller's assigned
 * Finance user (financeUserId) marks the reimbursement paid out:
 * TRANSFERRED_TO_FINANCE → REIMBURSED (terminal). Tour and claim alike, no
 * CSTEP Admin (callerPaymentRefusal — #5). The settlement, as it stands at
 * the moment of payment (after any Finance reduction), is the source of the
 * amount; nothing on it is recomputed or edited here. Optional body: { reference, note } — a payment/UTR
 * reference and a remark, both folded into the FINANCE_SETTLE audit
 * comment. The linked CstepClaim goes to SETTLED (its own terminal "paid"
 * state — mirrors finalize keeping the claim in step with reality).
 */
router.post("/requests/:id/finance/settle", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    const refusal = await callerPaymentRefusal(req, doc.travelerProfileId);
    if (refusal) return res.status(403).json({ error: refusal });
    const result = await settleFinanceCase(req, doc, {
      reference: String(req.body?.reference || "").trim(),
      note: String(req.body?.note || "").trim(),
      source: "MANUAL",
    });
    if ("error" in result) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true, request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests finance settle]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to mark the reimbursement" });
  }
});

/** What Finance pays (or collects) on a case at TRANSFERRED_TO_FINANCE —
 * read off its settlement, never recomputed here. A claim is net of its
 * advance (either direction); a Tour is the finalized amountClaimed. */
export function financeCaseAmount(
  formType: string,
  settlement: any,
): { direction: "PAY_OUT" | "COLLECT"; amount: number; advance: number } {
  if (isClaimFormType(formType)) {
    const dueBy = Number(settlement?.amountDueByCstep || 0);
    const dueTo = Number(settlement?.amountDueToCstep || 0);
    const advance = Number(settlement?.advanceTaken || 0);
    return dueBy > 0 || dueTo <= 0 ? { direction: "PAY_OUT", amount: dueBy, advance } : { direction: "COLLECT", amount: dueTo, advance };
  }
  return { direction: "PAY_OUT", amount: Number(settlement?.amountClaimed || 0), advance: 0 };
}

export type FinanceSettleResult =
  | { ok: true; endStatus: "REIMBURSED" | "SETTLED"; direction: "PAY_OUT" | "COLLECT"; amount: number }
  | { ok: false; status: number; error: string; code: "NOT_WITH_FINANCE" | "SETTLEMENT_NOT_READY" | "ALREADY_SETTLED" };

/**
 * Step 6 core — Finance closes a case at TRANSFERRED_TO_FINANCE. Shared by
 * POST /requests/:id/finance/settle and the bulk reimbursement import
 * (routes/cstep.reimbursements.ts); the CALLER checks who may. The amount
 * comes from the settlement, never from the caller.
 *
 * Claim: its Admin-verified, still-VERIFYING settlement is finalized here
 * (outcome TO_FINANCE) and the money's direction decides the end state —
 * paid out to the claimant → REIMBURSED, the claimant's repayment of an
 * unspent advance received → SETTLED. Tour: the Official already finalized
 * the settlement; the case goes REIMBURSED and its CstepClaim SETTLED.
 *
 * The settlement records paidOn (default now) / paymentRef / source /
 * batch id. Every write is conditional on the case still being with
 * Finance and runs in one transaction, so a second attempt (a re-import, a
 * double click) settles nothing and reports ALREADY_SETTLED. Logs
 * FINANCE_SETTLE; notifies after the commit.
 */
export async function settleFinanceCase(
  req: any,
  doc: any,
  opts: {
    reference?: string;
    note?: string;
    paidOn?: Date;
    source: "MANUAL" | "IMPORT";
    batchId?: mongoose.Types.ObjectId;
  },
): Promise<FinanceSettleResult> {
  if (doc.status !== "TRANSFERRED_TO_FINANCE") {
    return doc.status === "REIMBURSED" || doc.status === "SETTLED"
      ? { ok: false, status: 409, code: "ALREADY_SETTLED", error: "Already reimbursed" }
      : { ok: false, status: 409, code: "NOT_WITH_FINANCE", error: "Only a request transferred to Finance can be marked reimbursed" };
  }
  const workspaceId = req.workspaceObjectId;
  const isClaim = isClaimFormType(doc.formType);
  const uid = new mongoose.Types.ObjectId(ownerId(req));
  const reference = opts.reference || "";
  const note = opts.note || "";
  const now = new Date();
  const payment = {
    paidOn: opts.paidOn || now,
    paymentRef: reference || undefined,
    paymentSource: opts.source,
    paymentBatchId: opts.batchId,
  };

  let entryId: any = null;
  let claim: any = null;
  let direction: "PAY_OUT" | "COLLECT" = "PAY_OUT";
  let amount = 0;
  let endStatus: "REIMBURSED" | "SETTLED" = "REIMBURSED";
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // The amount is read INSIDE the transaction, before anything is
      // written: a Finance reduction committed first is what gets paid, and
      // one landing mid-payment conflicts on the settlement write below, so
      // the payment retries on the new figure instead of a stale one.
      const settlement: any = await CstepSettlement.findOne({ workspaceId, requestId: doc._id }).session(session).lean();
      const ready = isClaim ? settlement?.status === "VERIFYING" : settlement?.status === "FINALIZED";
      if (!ready) throw new Error("SETTLEMENT_NOT_READY");
      ({ direction, amount } = financeCaseAmount(doc.formType, settlement));
      endStatus = isClaim && direction === "COLLECT" ? "SETTLED" : "REIMBURSED";

      const flipped = await CstepTravelRequest.updateOne(
        { _id: doc._id, workspaceId, status: "TRANSFERRED_TO_FINANCE" },
        { $set: { status: endStatus } },
        { session },
      );
      if (flipped.modifiedCount !== 1) throw new Error("ALREADY_SETTLED");

      const setSettlement = isClaim
        ? { ...payment, outcome: "TO_FINANCE", status: "FINALIZED", finalizedBy: uid, finalizedAt: now }
        : payment;
      const s = await CstepSettlement.updateOne(
        { _id: settlement._id, workspaceId, status: isClaim ? "VERIFYING" : "FINALIZED" },
        { $set: setSettlement },
        { session },
      );
      if (s.matchedCount !== 1) throw new Error("ALREADY_SETTLED");

      if (!isClaim) {
        claim = await CstepClaim.findOneAndUpdate(
          { workspaceId, travelRequestId: doc._id },
          { $set: { status: "SETTLED" } },
          { new: true, session },
        )
          .select("claimReference status")
          .lean();
      }

      const paidOnLabel = opts.paidOn ? ` | Paid on ${istDate(opts.paidOn)}` : "";
      const batchLabel = opts.batchId ? ` | Import batch ${String(opts.batchId)}` : "";
      const [entry] = await CstepApproval.create(
        [
          {
            workspaceId,
            entityType: "REQUEST",
            entityId: doc._id,
            stage: "FINANCE",
            actor: uid,
            action: "FINANCE_SETTLE",
            comment:
              (isClaim
                ? direction === "PAY_OUT"
                  ? `₹${amount} reimbursed to the claimant`
                  : `₹${amount} received back from the claimant`
                : `₹${amount} reimbursed to the traveller`) +
              (reference ? ` | Ref: ${reference}` : "") +
              paidOnLabel +
              (note ? ` | ${note}` : "") +
              batchLabel +
              (claim ? ` | Claim ${claim.claimReference}: ${claim.status}` : ""),
            at: now.toISOString(),
          },
        ],
        { session },
      );
      entryId = entry._id;
    });
  } catch (err: any) {
    if (err?.message === "ALREADY_SETTLED") {
      return { ok: false, status: 409, code: "ALREADY_SETTLED", error: "Already reimbursed" };
    }
    if (err?.message === "SETTLEMENT_NOT_READY") {
      return {
        ok: false,
        status: 409,
        code: "SETTLEMENT_NOT_READY",
        error: isClaim ? "This claim's settlement is not awaiting Finance" : "The settlement has not been finalized yet",
      };
    }
    throw err;
  } finally {
    session.endSession();
  }

  doc.status = endStatus;
  if (endStatus === "REIMBURSED") {
    await notifyCstep("REIMBURSED", doc, { logEntryId: entryId, amountInr: amount, reference });
  } else {
    // SETTLED here is a claimant's repayment received (COLLECT), never
    // "nothing owed" — the copy says so from the direction.
    await notifyCstep("SETTLED", doc, { logEntryId: entryId, amountInr: amount, direction, reference });
  }
  return { ok: true, endStatus, direction, amount };
}

/**
 * POST /requests/:id/finance/return — the Finance user (or a CSTEP Admin)
 * sends a case back to the Official when the claim looks wrong:
 * TRANSFERRED_TO_FINANCE → REPORT_SUBMITTED, reason mandatory, logs
 * RETURN_TO_OFFICIAL (stage FINANCE). It goes to the Official, not the
 * traveller — the Official can send it on to the traveller themselves
 * (POST /report/return) if the fix is theirs.
 *
 * Undoes what finalize froze, so the Official can correct and re-finalize:
 * the settlement reopens to VERIFYING (outcome/finalizedBy/finalizedAt
 * cleared; lines and per diem kept as they were), and the claim goes from
 * ADMIN_VERIFIED back to CLAIM_IN_PROGRESS. The next finalize rewrites both.
 *
 * Finance-c — the send-back stays open to a CSTEP Admin, but an Admin who
 * is not this traveller's Finance user sends it back as an OVERRIDE: the
 * entry carries adminOverride: true. The Finance user's own carries no flag.
 */
router.post("/requests/:id/finance/return", async (req: any, res: any) => {
  try {
    const doc = await loadRequest(req, req.params.id);
    if (!doc) return res.status(404).json({ error: "Travel request not found" });
    const isFinanceUser = await callerIsTravellerFinanceUser(req, doc.travelerProfileId);
    if (!isFinanceUser && !isCstepAdmin(req)) {
      return res.status(403).json({ error: "Only this traveller's Finance user or a CSTEP Admin can perform this action" });
    }
    const overrideMark: { adminOverride?: true } = isFinanceUser ? {} : { adminOverride: true };
    if (doc.status !== "TRANSFERRED_TO_FINANCE") {
      return res.status(409).json({ error: "Only a request transferred to Finance can be sent back to the Official" });
    }

    const reason = String(req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({ error: "reason is required" });

    // Claims addition — a claim goes back to the CSTEP Admin's verification
    // (TRANSFERRED_TO_FINANCE -> APPROVED), not to an Official. Its
    // settlement was never finalized (Finance finalizes it when it pays), so
    // there is nothing to reopen; the lines become editable again simply
    // because the claim is APPROVED again.
    if (isClaimFormType(doc.formType)) {
      doc.status = "APPROVED";
      await doc.save();
      const entry = await CstepApproval.create({
        workspaceId: req.workspaceObjectId,
        entityType: "REQUEST",
        entityId: doc._id,
        stage: "FINANCE",
        actor: new mongoose.Types.ObjectId(ownerId(req)),
        action: "RETURN_TO_ADMIN",
        ...overrideMark,
        comment: reason,
        at: new Date().toISOString(),
      });
      await notifyCstep("RETURN_TO_ADMIN", doc, { logEntryId: entry._id, reason });
      return res.json({ ok: true, request: doc.toObject() });
    }

    const settlement: any = await CstepSettlement.findOne({ workspaceId: req.workspaceObjectId, requestId: doc._id });
    if (!settlement || settlement.status !== "FINALIZED") {
      return res.status(409).json({ error: "The settlement has not been finalized yet" });
    }

    settlement.status = "VERIFYING";
    settlement.outcome = undefined;
    settlement.finalizedBy = undefined;
    settlement.finalizedAt = undefined;
    await settlement.save();

    doc.status = "REPORT_SUBMITTED";
    await doc.save();

    await CstepClaim.updateMany(
      { workspaceId: req.workspaceObjectId, travelRequestId: doc._id },
      { $set: { status: "CLAIM_IN_PROGRESS" } },
    );

    const entry = await CstepApproval.create({
      workspaceId: req.workspaceObjectId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: "FINANCE",
      actor: new mongoose.Types.ObjectId(ownerId(req)),
      action: "RETURN_TO_OFFICIAL",
      ...overrideMark,
      comment: reason,
      at: new Date().toISOString(),
    });
    await notifyCstep("RETURN_TO_OFFICIAL", doc, { logEntryId: entry._id, reason });

    res.json({ ok: true, request: doc.toObject() });
  } catch (err: any) {
    console.error("[CSTEP requests finance return]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to send the case back to the Official" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * Finance-c — Finance reduces and disallows at the Finance stage, while
 * the case is TRANSFERRED_TO_FINANCE. The money levers are the assigned
 * Finance user's alone, the same gate as recording a payment
 * (callerPaymentRefusal — #5): no CSTEP Admin, no Travel Desk, and nobody
 * while no Finance user is mapped. An Admin who IS the mapped Finance user
 * acts as that Finance user.
 *
 *   PATCH /requests/:id/finance/lines/:lineId         { amountInr, amountReason }
 *         reduce one traveller-paid line; the ceiling is its current
 *         (finalized) amount, so a Desk reduction can never be undone to
 *         raise the payout. Logs REDUCE_AMOUNT.
 *   POST  /requests/:id/finance/lines/:lineId/reject  { reason }
 *         disallow one traveller-paid line: → ₹0, marked "Disallowed by
 *         Finance" (reason, who, when). Logs FINANCE_REJECT_LINE.
 *   PATCH /requests/:id/finance/perdiem               { deductionInr, deductionReason }
 *         per diem is deduction-only: add or raise a deduction, never the
 *         rate or days. Logs PERDIEM_ADJUST. Not on a claim.
 *   POST  /requests/:id/finance/reject-all            { reason }
 *         disallow every payable line and zero the per diem with a
 *         deduction, one shared reason. Logs FINANCE_REJECT.
 *
 * Company-paid (OFFICIAL) lines are the cost of the tour, not the payout,
 * and stay as the Desk finalized them. Every entry is stage FINANCE.
 *
 * Each change runs in one transaction, only while the case is still with
 * Finance: the settlement is edited in place (a Tour's stays FINALIZED, a
 * claim's VERIFYING), its totals recomputed (applySettlementTotals) and a
 * Tour's CstepClaim figures rewritten the way finalize writes them. When
 * nothing is owed either way afterwards the case closes SETTLED at ₹0
 * (finalize's rule), marked financeClosedAt so it stays on Finance's
 * "Reimbursed & settled" list; a claim still owed back (an advance) stays
 * with Finance to record the repayment. The traveller is emailed the new
 * payout (FINANCE_ADJUSTED) after the commit.
 * ───────────────────────────────────────────────────────────────────── */

type FinanceEntry = {
  action: "REDUCE_AMOUNT" | "PERDIEM_ADJUST" | "FINANCE_REJECT_LINE" | "FINANCE_REJECT" | "SETTLE";
  comment: string;
};
type FinanceChange = {
  kind: "REDUCED" | "DISALLOWED" | "ALL_DISALLOWED" | "PERDIEM_DEDUCTION";
  /** What changed, for the traveller's email. */
  item: string;
  reason: string;
  entries: FinanceEntry[];
};
type FinancePlanCtx = { settlement: any; lines: any[]; isClaim: boolean; uid: mongoose.Types.ObjectId; now: Date };

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The traveller-paid line Finance may change, or a refusal (thrown). */
function financeLine(lines: any[], lineId: string): any {
  if (!mongoose.Types.ObjectId.isValid(lineId)) throw new CstepHttpError(400, "Invalid settlement line id");
  const line = lines.find((l) => String(l._id) === String(lineId));
  if (!line) throw new CstepHttpError(404, "Settlement line not found");
  if (line.classification !== "PERSONAL") {
    throw new CstepHttpError(409, "Finance can only change a traveller-paid line — this one was paid by CSTEP");
  }
  if (line.financeRejected) throw new CstepHttpError(409, "This line is already disallowed by Finance");
  return line;
}

/** Disallow one line: → ₹0, with the reason, who and when. The ceiling
 * (claimedAmountInr) keeps the figure it was claimed at. Returns the
 * amount it had. */
function disallowLine(line: any, reason: string, uid: mongoose.Types.ObjectId, now: Date): number {
  const from = line.amountInr ?? 0;
  if (line.claimedAmountInr == null) line.claimedAmountInr = from;
  line.amountInr = 0;
  line.financeRejected = true;
  line.financeRejectedFromInr = from;
  line.financeRejectedReason = reason;
  line.financeRejectedBy = uid;
  line.financeRejectedAt = now;
  return from;
}

const lineLabel = (line: any) => line.description || line.mode;

async function runFinanceAdjustment(req: any, res: any, plan: (ctx: FinancePlanCtx) => FinanceChange | null) {
  const doc = await loadRequest(req, req.params.id);
  if (!doc) return res.status(404).json({ error: "Travel request not found" });
  const refusal = await callerPaymentRefusal(req, doc.travelerProfileId);
  if (refusal) return res.status(403).json({ error: refusal });
  if (doc.status !== "TRANSFERRED_TO_FINANCE") {
    return res.status(409).json({ error: "Only a case with Finance can be changed by Finance" });
  }

  const workspaceId = req.workspaceObjectId;
  const isClaim = isClaimFormType(doc.formType);
  const uid = new mongoose.Types.ObjectId(ownerId(req));
  // Filled by the transaction's last (committed) attempt.
  const out: {
    change?: FinanceChange | null;
    closed?: boolean;
    before?: ReturnType<typeof financeCaseAmount>;
    after?: ReturnType<typeof financeCaseAmount>;
    entryIds?: any[];
    settlement?: any;
    lines?: any[];
  } = {};

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const now = new Date();
      out.change = null;
      const live = await CstepTravelRequest.findOne({ _id: doc._id, workspaceId, status: "TRANSFERRED_TO_FINANCE" })
        .session(session)
        .select("_id")
        .lean();
      if (!live) throw new CstepHttpError(409, "This case is no longer with Finance");
      const settlement: any = await CstepSettlement.findOne({
        workspaceId,
        requestId: doc._id,
        status: isClaim ? "VERIFYING" : "FINALIZED",
      }).session(session);
      if (!settlement) throw new CstepHttpError(409, "This case's settlement is not awaiting Finance");
      const lines: any[] = await CstepSettlementLine.find({ workspaceId, settlementId: settlement._id }).session(session);

      const before = financeCaseAmount(doc.formType, settlement);
      const change = plan({ settlement, lines, isClaim, uid, now });
      if (!change) return;

      for (const line of lines) if (line.isModified()) await line.save({ session });
      applySettlementTotals(settlement, lines.map((l) => l.toObject()), doc);
      // Always a write to this document, so a payment racing this change
      // conflicts with it (settleFinanceCase) instead of paying the old figure.
      settlement.financeRevision = (settlement.financeRevision || 0) + 1;
      const after = financeCaseAmount(doc.formType, settlement);
      const closed = isClaim
        ? !(Number(settlement.amountDueByCstep) > 0) && !(Number(settlement.amountDueToCstep) > 0)
        : !(Number(settlement.amountClaimed) > 0);
      if (closed) {
        settlement.outcome = "CLOSE";
        if (isClaim) {
          settlement.status = "FINALIZED";
          settlement.finalizedBy = uid;
          settlement.finalizedAt = now;
        }
        settlement.financeClosedAt = now;
        settlement.financeClosedBy = uid;
        const flipped = await CstepTravelRequest.updateOne(
          { _id: doc._id, workspaceId, status: "TRANSFERRED_TO_FINANCE" },
          { $set: { status: "SETTLED" } },
          { session },
        );
        if (flipped.modifiedCount !== 1) throw new CstepHttpError(409, "This case is no longer with Finance");
      }
      await settlement.save({ session });

      // A Tour's CstepClaim mirrors the settlement (finalize writes it the
      // same way); an Event Request has none, so this matches nothing there.
      if (!isClaim) {
        await CstepClaim.updateOne(
          { workspaceId, travelRequestId: doc._id },
          {
            $set: {
              totalCostOfTour: settlement.totalCostOfTour,
              amountClaimed: settlement.amountClaimed,
              amountDueByCstep: settlement.amountClaimed,
              amountDueToCstep: 0,
              ...(closed ? { status: "SETTLED" } : {}),
            },
          },
          { session },
        );
      }

      const entries: FinanceEntry[] = [...change.entries];
      if (closed) {
        entries.push({
          action: "SETTLE",
          comment: `Nothing owed after Finance's changes — closed at ₹0 | Total cost of tour: ${inrText(settlement.totalCostOfTour)}`,
        });
      }
      const created = await CstepApproval.create(
        entries.map((e) => ({
          workspaceId,
          entityType: "REQUEST",
          entityId: doc._id,
          stage: "FINANCE",
          actor: uid,
          action: e.action,
          comment: e.comment,
          at: now.toISOString(),
        })),
        { session, ordered: true },
      );

      out.change = change;
      out.closed = closed;
      out.before = before;
      out.after = after;
      out.entryIds = created.map((c: any) => c._id);
      out.settlement = settlement.toObject();
      out.lines = lines.map((l) => l.toObject());
    });
  } catch (err: any) {
    if (err instanceof CstepHttpError) return res.status(err.status).json({ error: err.message });
    throw err;
  } finally {
    session.endSession();
  }

  if (!out.change) return res.json({ ok: true, changed: false, request: doc.toObject() });
  if (out.closed) doc.status = "SETTLED";
  await notifyCstep("FINANCE_ADJUSTED", doc, {
    logEntryId: out.entryIds![0],
    reason: out.change.reason,
    amountInr: out.after!.amount,
    direction: out.after!.direction,
    adjustment: {
      kind: out.change.kind,
      item: out.change.item,
      beforeInr: out.before!.amount,
      beforeDirection: out.before!.direction,
      closed: !!out.closed,
    },
  });
  res.json({ ok: true, changed: true, closed: !!out.closed, request: doc.toObject(), settlement: out.settlement, lines: out.lines });
}

router.patch("/requests/:id/finance/lines/:lineId", async (req: any, res: any) => {
  try {
    await runFinanceAdjustment(req, res, ({ lines }) => {
      const line = financeLine(lines, req.params.lineId);
      const plan = planLineReduction(
        line,
        req.body?.amountInr,
        req.body?.amountReason,
        line.amountInr ?? 0,
        (c) => `this line stands at ${inrText(c)} as finalized`,
      );
      if ("error" in plan) throw new CstepHttpError(400, plan.error);
      if (!plan.change) return null;
      if (line.claimedAmountInr == null) line.claimedAmountInr = plan.change.before;
      line.amountInr = plan.change.after;
      const label = lineLabel(line);
      return {
        kind: "REDUCED",
        item: `${label}: ${inrText(plan.change.before)} → ${inrText(plan.change.after)}`,
        reason: plan.change.reason,
        entries: [{ action: "REDUCE_AMOUNT", comment: reductionComment(label, plan.change, "finalized") }],
      };
    });
  } catch (err: any) {
    console.error("[CSTEP requests finance line reduce]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to reduce the line" });
  }
});

router.post("/requests/:id/finance/lines/:lineId/reject", async (req: any, res: any) => {
  try {
    const reason = String(req.body?.reason || "").trim();
    await runFinanceAdjustment(req, res, ({ lines, uid, now }) => {
      if (!reason) throw new CstepHttpError(400, "reason is required");
      const line = financeLine(lines, req.params.lineId);
      const from = disallowLine(line, reason, uid, now);
      const label = lineLabel(line);
      return {
        kind: "DISALLOWED",
        item: `${label}: ${inrText(from)} → ₹0`,
        reason,
        entries: [{ action: "FINANCE_REJECT_LINE", comment: `${label}: ${inrText(from)} → ₹0, disallowed by Finance — ${reason}` }],
      };
    });
  } catch (err: any) {
    console.error("[CSTEP requests finance line reject]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to disallow the line" });
  }
});

router.patch("/requests/:id/finance/perdiem", async (req: any, res: any) => {
  try {
    const body = req.body || {};
    await runFinanceAdjustment(req, res, ({ settlement, isClaim }) => {
      if (isClaim) throw new CstepHttpError(409, "A claim has no per diem");
      if ("rate" in body || "overrideDays" in body) {
        throw new CstepHttpError(400, "Finance can only add or raise a per-diem deduction — not change the rate or days");
      }
      const n = Number(body.deductionInr);
      if (body.deductionInr === null || !isFinite(n) || n < 0) {
        throw new CstepHttpError(400, "deductionInr must be a non-negative number");
      }
      const next = round2(n);
      const current = settlement.perDiem?.deductionInr || 0;
      if (next === current) return null;
      if (next < current) {
        throw new CstepHttpError(400, `Finance can only add or raise a deduction — it stands at ${inrText(current)}`);
      }
      const reason = String(body.deductionReason || "").trim();
      if (!reason) throw new CstepHttpError(400, "deductionReason is required for a per-diem deduction");
      const netBefore = settlement.perDiem.amountInr || 0;
      const days = settlement.perDiem.days || 0;
      const rate = settlement.perDiem.rate || 0;
      settlement.perDiem.deductionInr = next;
      settlement.perDiem.deductionReason = reason;
      settlement.perDiem.amountInr = round2(Math.max(0, days * rate - next));
      const netAfter = settlement.perDiem.amountInr;
      return {
        kind: "PERDIEM_DEDUCTION",
        item: `Per diem: ${inrText(netBefore)} → ${inrText(netAfter)}`,
        reason,
        entries: [
          {
            action: "PERDIEM_ADJUST",
            comment:
              `Per diem: days ${days} => ${days}, rate ${rate} => ${rate}, ` +
              `deduction ${current} => ${next}, net ${netBefore} => ${netAfter} (deduction: ${reason})`,
          },
        ],
      };
    });
  } catch (err: any) {
    console.error("[CSTEP requests finance perdiem]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update per diem" });
  }
});

router.post("/requests/:id/finance/reject-all", async (req: any, res: any) => {
  try {
    const reason = String(req.body?.reason || "").trim();
    await runFinanceAdjustment(req, res, ({ settlement, lines, isClaim, uid, now }) => {
      if (!reason) throw new CstepHttpError(400, "reason is required");
      const payable = lines.filter((l) => l.classification === "PERSONAL" && !l.financeRejected);
      const perDiemNet = isClaim ? 0 : Number(settlement.perDiem?.amountInr || 0);
      if (!payable.length && !(perDiemNet > 0)) throw new CstepHttpError(409, "Nothing payable is left to disallow");

      const items = payable.map((line) => `${lineLabel(line)} ${inrText(disallowLine(line, reason, uid, now))}`);
      if (perDiemNet > 0) {
        // The per diem goes to ₹0 the only way Finance may move it: a
        // deduction of its whole gross.
        settlement.perDiem.deductionInr = round2((settlement.perDiem.days || 0) * (settlement.perDiem.rate || 0));
        settlement.perDiem.deductionReason = `Disallowed by Finance — ${reason}`;
        settlement.perDiem.financeRejected = true;
        settlement.perDiem.amountInr = 0;
        items.push(`Per diem ${inrText(perDiemNet)}`);
      }
      return {
        kind: "ALL_DISALLOWED",
        item: "Every claimed item",
        reason,
        entries: [{ action: "FINANCE_REJECT", comment: `All claimed items disallowed by Finance (${items.join(", ")}) — ${reason}` }],
      };
    });
  } catch (err: any) {
    console.error("[CSTEP requests finance reject all]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to disallow the claim" });
  }
});

export default router;
