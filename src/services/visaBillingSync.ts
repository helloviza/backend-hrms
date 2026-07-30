// apps/backend/src/services/visaBillingSync.ts
//
// Phase 8 — the billing handoff. Bridges a decided VisaApplication into
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
// TRIGGER — called from routes/admin.visa.ts's PATCH /applications/:id/
// outcome, i.e. on the transition INTO decision_received. Fires for every
// outcome alike (APPROVED, REJECTED, WITHDRAWN): the embassy keeps its fee
// regardless of the mission's decision, so whatever actual costs were
// captured decide the bill, not the outcome. The one exception is a
// computed total of ₹0 (no costs were ever captured) — nothing to bill,
// nothing created.
//
// PRICING — gstMode "ON_MARKUP" is the ONLY convention this codebase uses
// for "pass-through cost + taxable margin" (every non-line-item
// ManualBooking type; see utils/invoiceLineItems.ts's ON_MARKUP branch).
// actualPrice = actualEmbassyFeeInr + actualVfsFeeInr (the genuine
// third-party pass-through — embassy/VFS fees carry no GST). quotedPrice =
// actualPrice + actualPlumtripsServiceFeeInr, assembled here with NO gst
// arithmetic of our own — the ManualBooking pre-save hook treats
// (quotedPrice - actualPrice) as the tax-INCLUSIVE markup and derives
// gstAmount/grandTotal/totalWithGST from it. Feeding this an
// already-GST-laden number (e.g. VisaApplication.indicativeCostSnapshot.
// totalInr, or any UI-computed grand total) would make the hook tax the
// markup a second time.
import mongoose from "mongoose";
import ManualBooking from "../models/ManualBooking.js";
import VisaRequest from "../models/VisaRequest.js";
import TravellerProfile from "../models/TravellerProfile.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import logger from "../utils/logger.js";

const visaBillingLogger = logger.child({ module: "visaBillingSync" });

export type VisaBillingSyncAction =
  | "created"
  | "updated"
  | "skipped_zero_total"
  | "skipped_invoiced"
  | "skipped_no_request";

export interface VisaBillingSyncResult {
  action: VisaBillingSyncAction;
  manualBookingId: string | null;
}

function travellerDisplayName(t: any): string {
  return [t?.firstName, t?.middleName, t?.lastName].filter(Boolean).join(" ").trim() || "Traveller";
}

/**
 * Syncs one VisaApplication's billing into ManualBooking. Idempotent on
 * metadata.visaApplicationId — safe to call more than once for the same
 * application (a repeated outcome-capture call, a retry, whatever) without
 * ever creating a duplicate booking.
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

  const actualPrice = (application.actualEmbassyFeeInr || 0) + (application.actualVfsFeeInr || 0);
  const serviceFee = application.actualPlumtripsServiceFeeInr || 0;
  const quotedPrice = actualPrice + serviceFee;

  const existing = await ManualBooking.findOne({ "metadata.visaApplicationId": applicationId });

  if (!existing && quotedPrice <= 0) {
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

  const request = await VisaRequest.findById(application.requestId).lean();
  if (!request) {
    // Should not happen — VisaApplication.requestId is required and never
    // reassigned after creation. Defensive only.
    visaBillingLogger.error("parent VisaRequest not found", {
      applicationId,
      requestId: String(application.requestId),
    });
    return { action: "skipped_no_request", manualBookingId: null };
  }

  const [traveller, workspace] = await Promise.all([
    TravellerProfile.findById(application.travellerProfileId).lean(),
    CustomerWorkspace.findById(application.workspaceId).select("customerId").lean(),
  ]);

  // ManualBooking.workspaceId IS Customer._id, NOT CustomerWorkspace._id.
  // CustomerWorkspace.customerId (a plain string field) holds
  // String(Customer._id) — see routes/superadmin.workspaces.ts's own
  // "Link: CustomerWorkspace.customerId === String(Customer._id)" comment.
  // Getting this backwards silently scopes the booking to the wrong tenant.
  const customerObjectId =
    (workspace as any)?.customerId && mongoose.isValidObjectId((workspace as any).customerId)
      ? new mongoose.Types.ObjectId((workspace as any).customerId)
      : null;

  const passengers = [
    {
      name: travellerDisplayName(traveller),
      email: (traveller as any)?.email || undefined,
      phone: (traveller as any)?.mobile || undefined,
      passportNo: (traveller as any)?.passportNo || undefined,
      type: "ADULT" as const,
    },
  ];

  const itinerary = {
    destination: application.ruleSnapshot?.destinationName || undefined,
    visaCountry: application.ruleSnapshot?.destinationName || undefined,
    // "Visa type" in the ops sense (Tourist / Business / Transit). No
    // ruleSnapshot field is literally named visaType — purpose is the
    // closest fit; visaCategory (STICKER/E_VISA/etc.) describes a delivery
    // format, not "type of visa" in the common travel-desk sense.
    visaType: application.ruleSnapshot?.purpose || undefined,
  };

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
    return { action: "created", manualBookingId: String(created._id) };
  }

  // Update — status is left exactly as it is (never reset to CONFIRMED,
  // never touched at all here); we already confirmed above it isn't
  // INVOICED. workspaceId/bookedBy are also left untouched — a cost
  // correction doesn't change who booked it or re-scope its tenant.
  Object.assign(existing, commonFields);
  await existing.save();
  visaBillingLogger.info("booking updated", {
    applicationId,
    manualBookingId: String(existing._id),
    bookingRef: existing.bookingRef,
    quotedPrice,
  });
  return { action: "updated", manualBookingId: String(existing._id) };
}
