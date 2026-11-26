// apps/backend/src/models/billToSchema.ts
//
// The bill-to SNAPSHOT a booking is invoiced to (docs/specs/sbt-to-manual-booking-spec.md
// §3.7; the same shape the multi-GST plan reserves for ManualBooking.billTo,
// docs/audits/client-multi-gst-audit.md §517). Taken at SBT checkout and
// copied, never re-read from the live company: SBTPayment.billTo →
// SBTBooking / SBTHotelBooking.billTo → ManualBooking.billTo.
//
//   COMPANY     one of the company's GST registrations (registrationId + its
//               GSTIN / state / legal name / address), or — a company with no
//               registrations — its name and state.
//   INDIVIDUAL  the traveller: name, state, address, optional GSTIN. With a
//               GSTIN the state is derived from it; without one the invoice
//               is B2C.
//
// Invoicing (services/invoiceGeneration.service.ts) turns it into the client
// block and the place of supply.
import { Schema } from "mongoose";

export type BillToKind = "COMPANY" | "INDIVIDUAL";
export type BillToSource = "SBT_CHECKOUT";

export interface BillTo {
  kind: BillToKind;
  registrationId?: string | null;
  gstin?: string | null;
  stateCode?: string | null;
  state: string;
  legalName: string;
  address?: { line1?: string; line2?: string; city?: string; pincode?: string; country?: string };
  email?: string | null;
  source: BillToSource;
  at?: Date;
}

export const BillToSchema = new Schema<BillTo>(
  {
    kind: { type: String, enum: ["COMPANY", "INDIVIDUAL"], required: true },
    registrationId: { type: String },
    gstin: { type: String },
    stateCode: { type: String },
    state: { type: String, required: true },
    legalName: { type: String, required: true },
    address: {
      type: new Schema(
        { line1: String, line2: String, city: String, pincode: String, country: String },
        { _id: false },
      ),
      default: undefined,
    },
    email: { type: String },
    source: { type: String, enum: ["SBT_CHECKOUT"], required: true },
    at: { type: Date },
  },
  { _id: false },
);

export const WALLET_MODE_VALUES = ["PREPAID", "POSTPAID", null] as const;
