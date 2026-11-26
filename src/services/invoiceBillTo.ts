// apps/backend/src/services/invoiceBillTo.ts
//
// Invoicing a booking that carries a bill-to snapshot (ManualBooking.billTo —
// docs/specs/sbt-to-manual-booking-spec.md §3.7, P4). Pure helpers used by
// services/invoiceGeneration.service.ts and the add-bookings route.
//
//   Place of supply  billTo.state → the context's customerStateOverride, so
//                    detectGSTType splits CGST/SGST (same state as the issuer)
//                    vs IGST exactly as for the operator's popup override.
//   Client block     legal name, GSTIN, address and email from the snapshot.
//                    An INDIVIDUAL without a GSTIN = B2C: the GSTIN line is
//                    BLANK even if the company has one on file (the generic
//                    clientDetailsOverride ignores empty values, so it can't
//                    express that — this overlay sets it explicitly).
//   One invoice, one bill-to  (D-9) bookings with different bill-tos (or a
//                    bill-to mixed with none) never share an invoice:
//                    409 MIXED_BILL_TO. A one-invoice-per-booking run (SEPARATE,
//                    /bulk-generate) applies each booking's own bill-to.
//
// A booking without a bill-to is invoiced exactly as before.
import { buildAddressStr } from "../utils/invoiceClient.js";

type AnyObj = Record<string, any>;

export const MIXED_BILL_TO = "MIXED_BILL_TO";
export const MIXED_BILL_TO_MESSAGE =
  "These bookings are invoiced to different parties (a company GSTIN, a person, or the company default). Invoice them separately — one invoice per bill-to.";

/** Bookings with equal keys can share one invoice. "" = no bill-to (the company, as before). */
export function billToKey(b: AnyObj | null | undefined): string {
  const t = b?.billTo;
  if (!t || typeof t !== "object" || !t.kind) return "";
  return [t.kind, t.registrationId || "", String(t.gstin || "").toUpperCase(), t.state || "", String(t.legalName || "").trim().toLowerCase()].join("|");
}

export function hasMixedBillTo(bookings: AnyObj[]): boolean {
  return new Set(bookings.map(billToKey)).size > 1;
}

/** The bill-to every booking in the batch shares (call after hasMixedBillTo). */
export function sharedBillTo(bookings: AnyObj[]): AnyObj | null {
  const t = bookings[0]?.billTo;
  return t && typeof t === "object" && t.kind ? t : null;
}

/** Replace the context's client block with the snapshot's party. The state
 *  stays the context's (it was resolved FROM billTo.state via customerStateOverride). */
export function applyBillToClient<T extends { clientDetails: AnyObj }>(ctx: T, billTo: AnyObj): T {
  const a: AnyObj = billTo.address || {};
  const state = ctx.clientDetails?.state || billTo.state || "";
  return {
    ...ctx,
    clientDetails: {
      ...ctx.clientDetails,
      companyName: String(billTo.legalName || ctx.clientDetails?.companyName || ""),
      gstin: billTo.gstin ? String(billTo.gstin).toUpperCase() : "",
      billingAddress: buildAddressStr({
        addressLine1: a.line1, addressLine2: a.line2, city: a.city, state, country: a.country || "India", pincode: a.pincode,
      }) || ctx.clientDetails?.billingAddress || "",
      addressLine1: a.line1 || "",
      addressLine2: a.line2 || "",
      city: a.city || "",
      country: a.country || "India",
      pincode: a.pincode || "",
      contactPerson: billTo.kind === "INDIVIDUAL" ? String(billTo.legalName || "") : ctx.clientDetails?.contactPerson || "",
      email: billTo.email || ctx.clientDetails?.email || "",
      state,
      billToKind: billTo.kind,
      ...(billTo.registrationId ? { billToRegistrationId: String(billTo.registrationId) } : {}),
    },
  };
}
