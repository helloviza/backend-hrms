// apps/backend/src/services/d2cInvoicing.ts
//
// THE D2C MONEY PATH'S OWN DOCUMENT — the consumer receipt.
//
// ══════════════════════════════════════════════════════════════════════
// THIS IS NOT A VARIANT OF services/visaBillingSync.ts.
// ══════════════════════════════════════════════════════════════════════
// visaBillingSync bills a WORKSPACE CUSTOMER in arrears for work done, and
// refuses D2C cases outright (its skipD2C guard, whose TODO(milestone-2)
// reserved exactly this file). This one issues a tax invoice for money a
// consumer ALREADY PAID, triggered by the Razorpay webhook rather than by a
// concierge status transition. Different trigger, different payer,
// different document. The guard over there stays; nothing here weakens it,
// and the two can never both fire for one application.
//
// ── WHY IT REUSES createInvoiceFromBookings ──────────────────────────
// A consumer receipt still has to be a real GST tax invoice: a gapless
// number in a per-GSTIN series, correct CGST/SGST-vs-IGST, a PDF, and a
// credit-note path if it is ever refunded. All of that already exists and
// is exercised daily by B2B. Reimplementing it for D2C would mean a second
// numbering series to keep gapless and a second GST engine to keep correct.
// So this file mints the ONE thing the existing pipeline needs — a
// ManualBooking — and then calls the existing service.
//
// ── THE THREE D2C-SHAPED PROBLEMS AND WHERE EACH IS SOLVED ───────────
//  1. TENANCY. ManualBooking.workspaceId is a Customer._id, and a consumer
//     has no Customer. Solved by ONE house Customer row (seeded, not
//     created here) that owns every D2C booking. Precedent:
//     scripts/seed-intake-system-identities.ts does the same for the
//     travel-intake pipeline.
//  2. BILL-TO. That house row would then address every receipt to
//     "Helloviza D2C". Solved by clientDetailsOverride, the one seam added
//     to the shared service — see its doc comment there.
//  3. THE ISSUING REGISTRATION. D2C bills under a CHOSEN GSTIN with its own
//     number series, not necessarily the global default. Solved by
//     CompanySettings.d2cSellerGstin, passed through as opts.sellerGstin —
//     which drives issuerDetails.gstin, and through it the Counter series
//     (models/Invoice.ts) and the matching credit-note series
//     (models/CreditNote.ts), with no second knob to disagree with.
//
// ── PRICE COMES FROM THE FROZEN SNAPSHOT, NOT FROM A RECOMPUTATION ───
// visaBillingSync's computeIndicativeMarkupPricing() must NOT be reused
// here, and this is not a style preference. It rebuilds the price from
// indicativeCostSnapshot's COMPONENTS via computeVisaFeeBlock at its
// default "B2B" channel — and the snapshot stores the rule's B2B
// plumtripsServiceFeeInr verbatim (300 on Thailand) while the case was
// actually priced from d2cServiceFeeInr (1500 + GST = the 1770 totalInr the
// consumer paid and Razorpay captured). Reusing it would invoice ₹354
// against ₹1,770 collected. See utils/visaSnapshots.ts's own note on this.
//
// The correct D2C derivation reads only frozen fields, and is the same
// two-way split routes/consumer.applications.ts's consumerPrice() already
// shows the consumer on their receipt:
//     actualPrice  = embassyFeeInr + vfsFeeInr      (pass-through, untaxed)
//     quotedPrice  = indicativeCostSnapshot.totalInr (what they actually paid)
// Fed through ManualBooking's ON_MARKUP convention, that yields GST =
// (total − passThrough) × 18/118 and grandTotal = total EXACTLY, because
// embassy/VFS carry no GST and everything above them is service fee + 18%.
import mongoose from "mongoose";
import ManualBooking from "../models/ManualBooking.js";
import VisaApplication from "../models/VisaApplication.js";
import VisaRequest from "../models/VisaRequest.js";
import Consumer from "../models/Consumer.js";
import Customer from "../models/Customer.js";
import User from "../models/User.js";
import Invoice from "../models/Invoice.js";
import { getCompanySettings } from "../models/CompanySettings.js";
import { createInvoiceFromBookings } from "./invoiceGeneration.service.js";
import { VISA_GST_PERCENT } from "../utils/visaFee.js";
import logger from "../utils/logger.js";

const d2cInvoiceLogger = logger.child({ module: "d2cInvoicing" });

/* ── The house identities ────────────────────────────────────────────
 * Resolved by STABLE BUSINESS KEYS, never by a hardcoded ObjectId: the
 * rows are created by scripts/seed-d2c-house-identities.ts and their _ids
 * differ per environment. Exported so that seed (and the proof scripts)
 * cannot drift from what this service looks for. */
export const D2C_HOUSE_CUSTOMER_CODE = "HOUSE-D2C";
export const D2C_HOUSE_CUSTOMER_NAME = "Helloviza D2C";
export const D2C_SYSTEM_USER_EMAIL = "system-d2c@plumtrips.com";

export type D2CInvoiceAction =
  | "created"
  // A replayed webhook, or a second call for any other reason. The booking
  // AND its invoice already exist; nothing is written.
  | "skipped_already_invoiced"
  // Every reason this cannot proceed. Each is a distinct operational
  // problem with a distinct fix, so none of them collapse into one code.
  | "skipped_not_d2c"
  | "skipped_not_paid"
  | "skipped_zero_total"
  | "skipped_house_identities_missing"
  | "skipped_consumer_missing";

export interface D2CInvoiceResult {
  action: D2CInvoiceAction;
  manualBookingId: string | null;
  invoiceId: string | null;
  invoiceNo: string | null;
  detail?: string;
}

interface HouseIdentities {
  customerId: mongoose.Types.ObjectId;
  systemUserId: mongoose.Types.ObjectId;
}

/**
 * Looks up the seeded house Customer + system User.
 *
 * DELIBERATELY READ-ONLY — it returns null rather than creating them. A
 * payment webhook that can conjure a Customer row into the CRM on first
 * use is a webhook that can conjure a WRONG one after a bad deploy, and
 * nobody would notice until it appeared in a customer list. Seeding is an
 * explicit operator step; a missing identity is a loud skip.
 */
async function resolveHouseIdentities(): Promise<HouseIdentities | null> {
  const [customer, systemUser] = await Promise.all([
    Customer.findOne({ customerCode: D2C_HOUSE_CUSTOMER_CODE }).select("_id").lean(),
    User.findOne({ email: D2C_SYSTEM_USER_EMAIL }).select("_id").lean(),
  ]);
  if (!customer || !systemUser) return null;
  return {
    customerId: new mongoose.Types.ObjectId(String((customer as any)._id)),
    systemUserId: new mongoose.Types.ObjectId(String((systemUser as any)._id)),
  };
}

/** actualPrice/quotedPrice straight off the frozen snapshot — see the file
 *  header for why this is not computeIndicativeMarkupPricing. */
export function computeD2CPricing(indicative: any): { actualPrice: number; quotedPrice: number } {
  const embassy = Number(indicative?.embassyFeeInr);
  const vfs = Number(indicative?.vfsFeeInr);
  const total = Number(indicative?.totalInr);
  const actualPrice =
    (Number.isFinite(embassy) ? embassy : 0) + (Number.isFinite(vfs) ? vfs : 0);
  return {
    actualPrice,
    quotedPrice: Number.isFinite(total) ? total : 0,
  };
}

/**
 * Issue the consumer receipt for a PAID D2C visa application.
 *
 * IDEMPOTENT ON ManualBooking.metadata.visaApplicationId — the same key
 * services/visaBillingSync.ts uses, so the two can never each mint their own
 * booking for one application even if the D2C guard over there were ever
 * removed by accident.
 *
 * Three arrival shapes, all handled:
 *   - no booking          -> mint one, invoice it
 *   - booking, no invoice -> do NOT mint a second; invoice the existing one
 *                            (this is the recovery path after a create that
 *                            succeeded and an invoice that then threw)
 *   - booking + invoice   -> no-op, and say so
 *
 * NEVER throws for an ordinary "cannot proceed" condition — those are named
 * skips. It CAN throw if the invoice pipeline itself fails, and the caller
 * (routes/razorpay.webhook.ts) is required to swallow that: the money is
 * already collected and the case is already PAID, so a failed receipt must
 * never un-pay a case. See the call site.
 */
export async function issueD2CInvoiceForApplication(application: any): Promise<D2CInvoiceResult> {
  const applicationId = String(application._id);
  const none = { manualBookingId: null, invoiceId: null, invoiceNo: null };

  if (application?.source !== "D2C") {
    return { action: "skipped_not_d2c", ...none };
  }
  // Invoicing is for money ALREADY RECEIVED. Anything else would be an
  // arrears bill, which is exactly the thing the D2C channel does not do.
  if (application?.d2cPaymentStatus !== "PAID") {
    return { action: "skipped_not_paid", ...none };
  }

  /* ── Already done? The replay path, checked before any write. ────── */
  const existingBooking = await ManualBooking.findOne({
    "metadata.visaApplicationId": applicationId,
  });
  if (existingBooking?.invoiceId) {
    const existingInvoice = await Invoice.findById(existingBooking.invoiceId).select("invoiceNo").lean();
    d2cInvoiceLogger.info("D2C invoice already exists — replay ignored", {
      applicationId,
      manualBookingId: String(existingBooking._id),
      invoiceNo: (existingInvoice as any)?.invoiceNo ?? null,
    });
    return {
      action: "skipped_already_invoiced",
      manualBookingId: String(existingBooking._id),
      invoiceId: String(existingBooking.invoiceId),
      invoiceNo: (existingInvoice as any)?.invoiceNo ?? null,
    };
  }

  const { actualPrice, quotedPrice } = computeD2CPricing(application.indicativeCostSnapshot);
  if (!(quotedPrice > 0)) {
    d2cInvoiceLogger.error("D2C invoice skipped — frozen snapshot has no usable total", {
      applicationId,
      totalInr: application?.indicativeCostSnapshot?.totalInr,
    });
    return { action: "skipped_zero_total", ...none };
  }

  const house = await resolveHouseIdentities();
  if (!house) {
    d2cInvoiceLogger.error(
      "D2C invoice skipped — house identities missing; run scripts/seed-d2c-house-identities.ts",
      { applicationId, customerCode: D2C_HOUSE_CUSTOMER_CODE, systemUserEmail: D2C_SYSTEM_USER_EMAIL },
    );
    return { action: "skipped_house_identities_missing", ...none };
  }

  // The consumer IS the bill-to. Without them there is no one to address the
  // receipt to, and falling back to the house row's name would produce a
  // document addressed to Plumtrips for a payment a person made.
  const consumer = application.consumerId
    ? await Consumer.findById(application.consumerId).select("name email phone").lean()
    : null;
  if (!consumer) {
    d2cInvoiceLogger.error("D2C invoice skipped — consumer not found", {
      applicationId,
      consumerId: String(application.consumerId ?? ""),
    });
    return { action: "skipped_consumer_missing", ...none };
  }
  const consumerName = String((consumer as any).name || "").trim() || "Consumer";
  const consumerEmail = String((consumer as any).email || "").trim();

  // The parent request supplies the reference number and travel dates. D2C
  // still mints a lightweight one (the A-prime decision) but the model now
  // permits its absence, so this must not assume it exists.
  const request = application.requestId
    ? await VisaRequest.findById(application.requestId).lean()
    : null;

  /* ── Mint the booking (or reuse a stranded one) ──────────────────── */
  let booking = existingBooking;
  if (!booking) {
    booking = await ManualBooking.create({
      type: "VISA",
      workspaceId: house.customerId,
      bookedBy: house.systemUserId,
      status: "CONFIRMED",
      source: "MANUAL",
      travelDate:
        (request as any)?.travelDateFrom || application.travelDateFrom || application.submittedAt || new Date(),
      returnDate: (request as any)?.travelDateTo || undefined,
      itinerary: {
        destination: application.ruleSnapshot?.destinationName || undefined,
        visaCountry: application.ruleSnapshot?.destinationName || undefined,
        visaType: application.ruleSnapshot?.purpose || undefined,
      },
      passengers: [
        {
          name: consumerName,
          email: consumerEmail || undefined,
          phone: (consumer as any).phone || undefined,
          type: "ADULT",
        },
      ],
      pricing: {
        actualPrice,
        quotedPrice,
        gstMode: "ON_MARKUP",
        gstPercent: VISA_GST_PERCENT,
      },
      notes: `Helloviza D2C visa — ${consumerName}${(request as any)?.referenceNumber ? ` — ${(request as any).referenceNumber}` : ""}`,
      // A STRING reference, never sourceBookingId: that field means "this
      // mirrors an SBT booking" and would make ManualBooking's own post-save
      // hook skip the TravelBooking mirror entirely.
      sourceBookingRef: (request as any)?.referenceNumber || undefined,
      metadata: {
        visaApplicationId: applicationId,
        channel: "D2C",
        consumerId: String(application.consumerId),
        razorpayOrderId: application.razorpayOrderId ?? null,
        razorpayPaymentId: application.razorpayPaymentId ?? null,
        visaRequestId: application.requestId ? String(application.requestId) : null,
        visaRequestReferenceNumber: (request as any)?.referenceNumber ?? null,
      },
    });
    d2cInvoiceLogger.info("D2C manual booking created", {
      applicationId,
      manualBookingId: String(booking._id),
      bookingRef: (booking as any).bookingRef,
      quotedPrice,
    });
  } else {
    d2cInvoiceLogger.warn("D2C manual booking already existed without an invoice — invoicing it rather than minting a second", {
      applicationId,
      manualBookingId: String(booking._id),
    });
  }

  /* ── Issue under the chosen registration ─────────────────────────── */
  // Blank = no opinion. OMITTED rather than passed as "", so the resolver
  // takes its ordinary global-isDefault path.
  const companySettings = await getCompanySettings();
  const d2cSellerGstin = String((companySettings as any).d2cSellerGstin || "").trim();

  const invoices = await createInvoiceFromBookings([String(booking._id)], {
    format: "COMBINED",
    createdBy: String(house.systemUserId),
    sellerGstin: d2cSellerGstin || undefined,
    // The bill-to is the person, not the house tenant. state is deliberately
    // absent from this shape — see CreateInvoiceOpts.clientDetailsOverride.
    clientDetailsOverride: {
      companyName: consumerName,
      email: consumerEmail,
      contactPerson: consumerName,
    },
    notes: `Helloviza visa service — paid online${application.razorpayPaymentId ? ` (${application.razorpayPaymentId})` : ""}`,
    terms: "Paid in full",
  });

  const invoice = invoices[0];
  if (!invoice) {
    // createInvoiceFromBookings throws on batch-level failure, so a
    // COMBINED call returning nothing should be impossible. Treated as a
    // throw rather than a silent success — the booking exists and is now
    // stranded, and the recovery path above is what picks it back up.
    throw new Error(`D2C invoice generation returned no invoice for application ${applicationId}`);
  }

  /* ── Born settled ─────────────────────────────────────────────────
   * This function only runs downstream of a CAPTURED Razorpay payment
   * whose amount cross-check has already passed, so the money is in
   * before the invoice exists. Leaving it at the schema default (DRAFT)
   * made a receipt masquerade as an unsent draft: it printed "BALANCE
   * DUE" through the admin PDF route, sat in the EOD digest's
   * drafts-to-send queue, counted toward outstanding on the invoice
   * stats, and — because creditNotes.ts only credits SENT or PAID — a
   * refund could not be raised against it at all.
   *
   * Same two fields the staff route sets when finance confirms receipt
   * (PUT /admin/invoices/:id/status), plus the same editHistory entry,
   * so a D2C receipt is auditable exactly like a B2B one. There is no
   * shared mark-paid service to call — that route does the work inline
   * behind requirePermission and reads req.user, neither of which a
   * webhook has. `source` stays absent: it marks a customer-portal
   * claim, and this is a confirmed capture, not a claim.
   *
   * The DRAFT->PAID rejection on that route does not apply here — it
   * guards the human transition ("mark as SENT first"), and nothing
   * moves this invoice through it. */
  const paidAt = new Date();
  await Invoice.updateOne(
    { _id: invoice._id },
    {
      $set: { status: "PAID", paidAt, editedAt: paidAt, editedBy: house.systemUserId },
      $push: {
        editHistory: {
          editedAt: paidAt,
          editedBy: house.systemUserId,
          fieldsChanged: ["status"],
          oldValues: { status: invoice.status },
          newValues: {
            status: "PAID",
            paidAt,
            paymentRef: application.razorpayPaymentId || undefined,
          },
        },
      },
    },
  );
  // The returned doc was read before that write — keep it honest for
  // anything downstream of this call.
  invoice.status = "PAID";
  invoice.paidAt = paidAt;

  /* ── Link it back onto the case ──────────────────────────────────── */
  // updateOne, not application.save(): the caller holds this same document
  // and has already saved its own payment writes to it. A second full save
  // from here would re-write those fields from a snapshot taken before
  // them. $set without `source` also stays clear of the channel
  // immutability guard (models/visaCaseSource.ts).
  await VisaApplication.updateOne(
    { _id: application._id },
    {
      $set: {
        d2cManualBookingId: booking._id,
        d2cInvoiceId: invoice._id,
        d2cInvoiceNo: invoice.invoiceNo,
        d2cInvoicedAt: new Date(),
      },
    },
  );

  d2cInvoiceLogger.info("D2C invoice raised", {
    applicationId,
    manualBookingId: String(booking._id),
    invoiceId: String(invoice._id),
    invoiceNo: invoice.invoiceNo,
    grandTotal: invoice.grandTotal,
    supplyType: invoice.supplyType,
    issuerGstin: invoice.issuerDetails?.gstin,
  });

  return {
    action: "created",
    manualBookingId: String(booking._id),
    invoiceId: String(invoice._id),
    invoiceNo: invoice.invoiceNo,
  };
}
