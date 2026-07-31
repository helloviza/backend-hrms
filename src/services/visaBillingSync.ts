// apps/backend/src/services/visaBillingSync.ts
//
// Phase 8 — the billing handoff. Bridges a VisaApplication into
// ManualBooking (type "VISA"), the same commercial-booking record every
// other service (Flight, Hotel, ...) already rides to invoicing, exports,
// and travel-spend — models/ManualBooking.ts's own post-save hook mirrors
// it into TravelBooking automatically, so nothing further is wired here.
//
// GRANULARITY — one ManualBooking PER VisaApplication, never per
// VisaRequest. Reasoning (see the Phase 8 investigation this was built
// against): manualBookings.ts hard-blocks editing once status is INVOICED,
// so a shared per-request booking would have no way to add a sixth
// traveller's line after the first five were already invoiced. Per-
// application bookings let each traveller become independently invoice-
// eligible, independently correctable, and independently cancellable
// (withdrawn) — and still read as ONE invoice line when staff want that,
// via the existing per-invoice "Combined" format
// (utils/invoiceLineItems.ts's buildCombinedLineItems groups same-type
// bookings automatically).
//
// Phase 9e — moved creation EARLIER, off the outcome capture and onto the
// transition INTO docs_under_review (routes/admin.visa.ts's PATCH
// /applications/:id/status): a case that's been picked up by a concierge
// should be visible in the booking register and travel-spend from that
// moment, not invisible for weeks until a decision exists.
// createVisaWorkStartBooking() (below) does that half; the original
// outcome-time entry point, syncVisaApplicationBilling(), now has to
// EXPECT the booking may already exist (created at work-start) rather
// than assuming it's always creating fresh, and drives its status
// forward from there — see the "status-aware update" section below.
//
// TWO ENTRY POINTS, ONE STATE MACHINE for ManualBooking.status:
//   createVisaWorkStartBooking  ->  (creates)         WIP
//   syncVisaApplicationBilling  ->  WIP/CONFIRMED      -> CONFIRMED (real cost > 0)
//                                                       -> CANCELLED (cost == 0)
//                                   INVOICED/CANCELLED -> never touched
//                                   anything else       -> never touched, logged
// A booking that predates the outcome (the normal case from Phase 9e on)
// still goes through the exact same idempotency key
// (metadata.visaApplicationId) and update mechanics Phase 8 already had;
// see syncVisaApplicationBilling's own doc comment.
//
// PRICING — gstMode "ON_MARKUP" is the ONLY convention this codebase uses
// for "pass-through cost + taxable margin" (every non-line-item
// ManualBooking type; see utils/invoiceLineItems.ts's ON_MARKUP branch).
// Per the pre-save hook (models/ManualBooking.ts), grandTotal/totalWithGST
// for ON_MARKUP is pricing.quotedPrice VERBATIM — GST is backed OUT of
// (quotedPrice - actualPrice) for the gstAmount/basePrice breakdown, never
// added on top. So whatever numeric value is fed in as quotedPrice IS the
// final GST-inclusive total; embassy/VFS fees carry no GST at all
// (pass-through at actual).
//
// At OUTCOME: actualPrice = actualEmbassyFeeInr + actualVfsFeeInr,
// quotedPrice = actualPrice + actualPlumtripsServiceFeeInr — these are the
// real, already-GST-inclusive-by-convention numbers staff typed in via
// PATCH /applications/:id/costs, assembled here with no GST arithmetic of
// our own (unchanged from Phase 8).
//
// At WORK-START, there ARE no actual* fields yet — only
// VisaApplication.indicativeCostSnapshot (the quote). Its own `totalInr`
// is ALREADY GST-inclusive (computed by utils/visaFee.ts's
// computeVisaFeeBlock, which adds 18% GST on the service-fee component
// only, embassy/VFS pass through untaxed) and must NEVER be fed to
// quotedPrice directly — computeIndicativeMarkupPricing() below
// reconstructs the identical number from the snapshot's raw COMPONENTS
// (embassyFeeInr/vfsFeeInr/plumtripsServiceFeeInr) via that same
// computeVisaFeeBlock function, rather than reading .totalInr — so the
// created booking's totalWithGST lands on the same figure the customer
// was originally quoted, without this file ever depending on a
// downstream-derived total field.
import mongoose from "mongoose";
import ManualBooking from "../models/ManualBooking.js";
import VisaRequest from "../models/VisaRequest.js";
import TravellerProfile from "../models/TravellerProfile.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import logger from "../utils/logger.js";
import { logVisaActivity } from "../models/VisaActivityLog.js";
import { computeVisaFeeBlock } from "../utils/visaFee.js";

const visaBillingLogger = logger.child({ module: "visaBillingSync" });

export type VisaBillingSyncAction =
  | "created"
  | "updated"
  | "cancelled_zero_cost"
  | "skipped_zero_total"
  | "skipped_invoiced"
  | "skipped_cancelled"
  | "skipped_unexpected_status"
  | "skipped_already_exists"
  | "skipped_no_request"
  | "skipped_traveller_erased";

export interface VisaBillingSyncResult {
  action: VisaBillingSyncAction;
  manualBookingId: string | null;
}

function travellerDisplayName(t: any): string {
  return [t?.firstName, t?.middleName, t?.lastName].filter(Boolean).join(" ").trim() || "Traveller";
}

// Reconstructs actualPrice/quotedPrice for a WORK-START booking from
// VisaApplication.indicativeCostSnapshot's raw components — embassy/VFS
// pass through untaxed, the service fee's own 18% GST is folded into
// quotedPrice (not added again downstream: see file header). Reuses
// computeVisaFeeBlock (the SAME function that produced totalInr in the
// first place — routes/visa.ts's buildIndicativeCostSnapshot) rather than
// re-deriving the GST rate/rounding a second time; the result is numerically
// identical to indicativeCostSnapshot.totalInr, just built from components
// instead of reading that field.
//
// A rule quoted in "INDICATIVE" display mode (no itemised components at
// all — just a lump indicativeVisaCostInr) has no embassy/VFS/service
// split to work from here; actualPrice and quotedPrice both land at 0 in
// that case, same limitation any components-only approach would have.
function computeIndicativeMarkupPricing(indicative: any): { actualPrice: number; quotedPrice: number } {
  const fee = computeVisaFeeBlock({
    embassyFeeInr: indicative?.embassyFeeInr,
    vfsFeeInr: indicative?.vfsFeeInr,
    plumtripsServiceFeeInr: indicative?.plumtripsServiceFeeInr,
    indicativeVisaCostInr: indicative?.indicativeVisaCostInr,
  });
  const amountFor = (code: string) => fee.lineItems.find((li) => li.code === code)?.amountInr ?? 0;
  const actualPrice = amountFor("EMBASSY_FEE") + amountFor("VFS_FEE");
  const serviceFeeInclGst = amountFor("SERVICE_FEE") + amountFor("GST");
  return { actualPrice, quotedPrice: actualPrice + serviceFeeInclGst };
}

interface BillingContext {
  request: any;
  passengers: Array<{ name: string; email?: string; phone?: string; passportNo?: string; type: "ADULT" }>;
  itinerary: { destination?: string; visaCountry?: string; visaType?: string };
  customerObjectId: mongoose.Types.ObjectId | null;
}

// Shared lookups both entry points below need — the parent VisaRequest
// (reference number, travel dates), the traveller (for the passenger
// line), and the tenant resolution (ManualBooking.workspaceId IS
// Customer._id, NOT CustomerWorkspace._id — see the comment at its use
// site for why getting this backwards silently scopes the booking to the
// wrong tenant).
async function resolveBillingContext(application: any): Promise<BillingContext | null> {
  const request = await VisaRequest.findById(application.requestId).lean();
  if (!request) return null;

  const [traveller, workspace] = await Promise.all([
    TravellerProfile.findById(application.travellerProfileId).lean(),
    CustomerWorkspace.findById(application.workspaceId).select("customerId").lean(),
  ]);

  const customerObjectId =
    (workspace as any)?.customerId && mongoose.isValidObjectId((workspace as any).customerId)
      ? new mongoose.Types.ObjectId((workspace as any).customerId)
      : null;

  const passengers: BillingContext["passengers"] = [
    {
      name: travellerDisplayName(traveller),
      email: (traveller as any)?.email || undefined,
      phone: (traveller as any)?.mobile || undefined,
      passportNo: (traveller as any)?.passportNo || undefined,
      type: "ADULT",
    },
  ];

  const itinerary: BillingContext["itinerary"] = {
    destination: application.ruleSnapshot?.destinationName || undefined,
    visaCountry: application.ruleSnapshot?.destinationName || undefined,
    // "Visa type" in the ops sense (Tourist / Business / Transit). No
    // ruleSnapshot field is literally named visaType — purpose is the
    // closest fit; visaCategory (STICKER/E_VISA/etc.) describes a delivery
    // format, not "type of visa" in the common travel-desk sense.
    visaType: application.ruleSnapshot?.purpose || undefined,
  };

  return { request, passengers, itinerary, customerObjectId };
}

/**
 * Creates the ManualBooking for a VisaApplication the moment a concierge
 * starts working it (routes/admin.visa.ts's PATCH /applications/:id/status,
 * on the transition INTO "docs_under_review") — status "WIP", priced off
 * the indicative quote's components (computeIndicativeMarkupPricing above).
 * WIP deliberately does NOT satisfy the invoicing-eligible query
 * (routes/invoices.ts's GET /:id/eligible-bookings filters status:
 * "CONFIRMED" exactly) or the travel-spend $ totals (routes/
 * admin.unified.billing.ts filters TravelBooking.status: "CONFIRMED" too) —
 * both intentionally still wait for syncVisaApplicationBilling to flip it
 * at outcome time.
 *
 * Idempotent on metadata.visaApplicationId, same key as
 * syncVisaApplicationBilling — defensive only: the docs_under_review
 * transition is a one-way state-machine edge, so this should never
 * actually run twice for the same application, but a retry/race must
 * never create a duplicate.
 */
export async function createVisaWorkStartBooking(
  application: any,
  actorUserId: any,
): Promise<VisaBillingSyncResult> {
  const applicationId = String(application._id);

  // Defense-in-depth — the only route that calls this
  // (admin.visa.ts's PATCH /applications/:id/status) already rejects a
  // status transition on an erased application before reaching here, so
  // this should never actually fire in practice. Checked anyway: continuing
  // to bill/process someone who exercised their erasure right is the
  // problem this guard exists for, not just "don't create an empty
  // ManualBooking" — this function must never create one for an erased
  // application even if a future caller forgets the route-level check.
  if (application.travellerErasedAt) {
    visaBillingLogger.warn("skipped work-start booking — traveller erased", { applicationId });
    return { action: "skipped_traveller_erased", manualBookingId: null };
  }

  const existing = await ManualBooking.findOne({ "metadata.visaApplicationId": applicationId });
  if (existing) {
    visaBillingLogger.warn("work-start booking already exists — not recreated", {
      applicationId,
      manualBookingId: String(existing._id),
    });
    return { action: "skipped_already_exists", manualBookingId: String(existing._id) };
  }

  const context = await resolveBillingContext(application);
  if (!context) {
    // Should not happen — VisaApplication.requestId is required and never
    // reassigned after creation. Defensive only.
    visaBillingLogger.error("parent VisaRequest not found at work-start", {
      applicationId,
      requestId: String(application.requestId),
    });
    return { action: "skipped_no_request", manualBookingId: null };
  }
  const { request, passengers, itinerary, customerObjectId } = context;

  if (!customerObjectId) {
    throw new Error(
      `visa billing sync: could not resolve Customer._id for workspace ${application.workspaceId} — refusing to create a ManualBooking with no tenant`,
    );
  }

  const { actualPrice, quotedPrice } = computeIndicativeMarkupPricing(application.indicativeCostSnapshot);

  const created = await ManualBooking.create({
    type: "VISA",
    travelDate: request.travelDateFrom || application.submittedAt || new Date(),
    returnDate: request.travelDateTo || undefined,
    itinerary,
    passengers,
    pricing: { actualPrice, quotedPrice, gstMode: "ON_MARKUP", gstPercent: 18 },
    notes: `Visa application — ${passengers[0].name} — ${request.referenceNumber}`,
    sourceBookingRef: request.referenceNumber,
    metadata: {
      visaApplicationId: applicationId,
      visaRequestId: String(application.requestId),
      visaRequestReferenceNumber: request.referenceNumber,
      visaOutcome: application.outcome,
    },
    workspaceId: customerObjectId,
    status: "WIP",
    source: "MANUAL",
    bookedBy: actorUserId,
  });

  visaBillingLogger.info("work-start booking created (WIP)", {
    applicationId,
    manualBookingId: String(created._id),
    bookingRef: (created as any).bookingRef,
    quotedPrice,
  });
  await logVisaActivity({
    applicationId,
    requestId: request._id,
    workspaceId: application.workspaceId,
    eventType: "MANUAL_BOOKING_CREATED",
    actorUserId: null,
    actorType: "SYSTEM",
    detail: { manualBookingId: String(created._id), status: "WIP" },
  });

  return { action: "created", manualBookingId: String(created._id) };
}

/**
 * Syncs one VisaApplication's billing into ManualBooking at OUTCOME time.
 * Idempotent on metadata.visaApplicationId — safe to call more than once
 * for the same application (a repeated outcome-capture call, a retry,
 * whatever) without ever creating a duplicate booking.
 *
 * Since Phase 9e, `existing` is the common case (created at work-start by
 * createVisaWorkStartBooking, above) rather than the exception — this
 * function drives it forward:
 *   - WIP/CONFIRMED with quotedPrice > 0  -> CONFIRMED, actual pricing
 *   - WIP/CONFIRMED with quotedPrice <= 0 -> CANCELLED (by COST, not by
 *     outcome value — a WITHDRAWN case with real incurred fees still
 *     confirms normally; an APPROVED case that somehow totals zero still
 *     cancels. See the file's own build-report discussion.)
 *   - INVOICED or CANCELLED               -> never touched, either way
 *   - anything else (e.g. a booking a staff member manually reset to
 *     PENDING)                            -> never touched, just logged
 *
 * `application` must already be the saved, post-outcome document (status
 * "decision_received", outcome set, actual* cost fields whatever they are)
 * — this function only reads it, never writes back to VisaApplication.
 */
export async function syncVisaApplicationBilling(
  application: any,
  actorUserId: any,
): Promise<VisaBillingSyncResult> {
  const applicationId = String(application._id);

  // Defense-in-depth — see createVisaWorkStartBooking's identical guard
  // above for why this is checked here too, not just at the calling route.
  if (application.travellerErasedAt) {
    visaBillingLogger.warn("skipped outcome billing sync — traveller erased", { applicationId });
    return { action: "skipped_traveller_erased", manualBookingId: null };
  }

  const actualPrice = (application.actualEmbassyFeeInr || 0) + (application.actualVfsFeeInr || 0);
  const serviceFee = application.actualPlumtripsServiceFeeInr || 0;
  const quotedPrice = actualPrice + serviceFee;

  const existing = await ManualBooking.findOne({ "metadata.visaApplicationId": applicationId });

  if (!existing && quotedPrice <= 0) {
    // No work-start booking exists (e.g. withdrawn straight from
    // "submitted", before docs_under_review ever fired) and there's
    // nothing to bill — nothing created, same as Phase 8.
    visaBillingLogger.info("skipped — computed total is zero", { applicationId });
    return { action: "skipped_zero_total", manualBookingId: null };
  }

  if (existing && existing.status === "INVOICED") {
    // Never touch an invoiced booking — manualBookings.ts's own route-level
    // edit lock would reject a save() here anyway, but checking here first
    // gives the caller a clean signal instead of a thrown error surfacing
    // from deep inside this function. A cost correction after invoicing is
    // the existing manual-booking-correction / credit-note path's job, not
    // this sync's — logged at warn so it's visible to staff.
    visaBillingLogger.warn("booking already INVOICED — not updated, needs manual correction", {
      applicationId,
      manualBookingId: String(existing._id),
      bookingRef: existing.bookingRef,
    });
    return { action: "skipped_invoiced", manualBookingId: String(existing._id) };
  }

  if (existing && existing.status === "CANCELLED") {
    // Symmetric with INVOICED above — once cancelled (whether by a staff
    // member via the manual /cancel route, or by this same function on an
    // earlier zero-cost outcome), it never gets resurrected here.
    visaBillingLogger.warn("booking already CANCELLED — not updated", {
      applicationId,
      manualBookingId: String(existing._id),
      bookingRef: existing.bookingRef,
    });
    return { action: "skipped_cancelled", manualBookingId: String(existing._id) };
  }

  if (existing && existing.status !== "WIP" && existing.status !== "CONFIRMED") {
    // PENDING, or any value this sync never itself sets — a staff member
    // must have touched it by hand. Left entirely alone rather than
    // guessing what they intended; logged so it's visible, not silent.
    visaBillingLogger.warn("booking has an unexpected status — left untouched", {
      applicationId,
      manualBookingId: String(existing._id),
      bookingRef: existing.bookingRef,
      status: existing.status,
    });
    return { action: "skipped_unexpected_status", manualBookingId: String(existing._id) };
  }

  const context = await resolveBillingContext(application);
  if (!context) {
    // Should not happen — VisaApplication.requestId is required and never
    // reassigned after creation. Defensive only.
    visaBillingLogger.error("parent VisaRequest not found", {
      applicationId,
      requestId: String(application.requestId),
    });
    return { action: "skipped_no_request", manualBookingId: null };
  }
  const { request, passengers, itinerary, customerObjectId } = context;

  const commonFields: Record<string, any> = {
    type: "VISA",
    travelDate: request.travelDateFrom || application.submittedAt || new Date(),
    returnDate: request.travelDateTo || undefined,
    itinerary,
    passengers,
    pricing: {
      actualPrice,
      quotedPrice,
      gstMode: "ON_MARKUP",
      gstPercent: 18,
    },
    notes: `Visa application — ${passengers[0].name} — ${request.referenceNumber}`,
    // Traceability: a string field (unlike sourceBookingId, which is
    // treated as "this booking mirrors an SBT/SBT_AUTO source" and would
    // make ManualBooking's own post-save hook SKIP the TravelBooking
    // mirror sync entirely — see syncManualBookingToMirror's file header).
    // Never set sourceBookingId here.
    sourceBookingRef: request.referenceNumber,
    metadata: {
      visaApplicationId: applicationId,
      visaRequestId: String(application.requestId),
      visaRequestReferenceNumber: request.referenceNumber,
      visaOutcome: application.outcome,
    },
  };

  if (!existing) {
    if (!customerObjectId) {
      throw new Error(
        `visa billing sync: could not resolve Customer._id for workspace ${application.workspaceId} — refusing to create a ManualBooking with no tenant`,
      );
    }
    const created = await ManualBooking.create({
      ...commonFields,
      workspaceId: customerObjectId,
      status: "CONFIRMED",
      source: "MANUAL",
      bookedBy: actorUserId,
    });
    visaBillingLogger.info("booking created", {
      applicationId,
      manualBookingId: String(created._id),
      bookingRef: (created as any).bookingRef,
      quotedPrice,
    });
    // actorType SYSTEM — this is a billing-sync side effect of recording an
    // outcome, not a direct staff edit to ManualBooking itself (task brief:
    // "extraction and billing sync SYSTEM").
    await logVisaActivity({
      applicationId,
      requestId: request._id,
      workspaceId: application.workspaceId,
      eventType: "MANUAL_BOOKING_CREATED",
      actorUserId: null,
      actorType: "SYSTEM",
      detail: { manualBookingId: String(created._id), status: "CONFIRMED" },
    });
    return { action: "created", manualBookingId: String(created._id) };
  }

  // existing.status is WIP or CONFIRMED here (every other value already
  // returned above) — apply the actuals, then drive status forward by
  // COST: zero real cost cancels, anything else confirms. workspaceId/
  // bookedBy are left untouched either way — a cost correction/outcome
  // doesn't change who booked it or re-scope its tenant.
  Object.assign(existing, commonFields);

  if (quotedPrice <= 0) {
    existing.status = "CANCELLED";
    await existing.save();
    visaBillingLogger.info("booking cancelled — zero cost at outcome", {
      applicationId,
      manualBookingId: String(existing._id),
      bookingRef: existing.bookingRef,
      outcome: application.outcome,
    });
    await logVisaActivity({
      applicationId,
      requestId: request._id,
      workspaceId: application.workspaceId,
      eventType: "MANUAL_BOOKING_CANCELLED",
      actorUserId: null,
      actorType: "SYSTEM",
      detail: { manualBookingId: String(existing._id), reason: "zero_cost_at_outcome" },
    });
    return { action: "cancelled_zero_cost", manualBookingId: String(existing._id) };
  }

  existing.status = "CONFIRMED";
  await existing.save();
  visaBillingLogger.info("booking updated", {
    applicationId,
    manualBookingId: String(existing._id),
    bookingRef: existing.bookingRef,
    quotedPrice,
  });
  await logVisaActivity({
    applicationId,
    requestId: request._id,
    workspaceId: application.workspaceId,
    eventType: "MANUAL_BOOKING_UPDATED",
    actorUserId: null,
    actorType: "SYSTEM",
    detail: { manualBookingId: String(existing._id), status: "CONFIRMED" },
  });
  return { action: "updated", manualBookingId: String(existing._id) };
}
