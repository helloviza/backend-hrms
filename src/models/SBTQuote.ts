import { Schema, model, type Document } from "mongoose";

/**
 * SBTQuote — short-lived server-side record of the price a server computed at
 * quote time (FareQuote for flights, PreBook for hotels). Written unconditionally
 * so that a later step (price reconciliation) can compare the amount the client
 * sends at create-order / book against what the server actually quoted.
 *
 * This is step 1 (persistence only). Nothing reads these rows to branch behaviour
 * yet — see utils/priceRecon.ts for the step-2 mode scaffold.
 */
export interface ISBTQuote extends Document {
  quoteId: string;
  product: "FLIGHT" | "HOTEL";
  serverDisplayFare: number; // margined, customer-facing total
  serverNetFare: number; // raw TBO cost, pre-margin
  sourceRef: string; // hotel: BookingCode | flight: `${TraceId}:${ResultIndex}`
  // Scope: a quote is usable only by the workspace + user that created it.
  workspaceId: string;
  userId: string;
  // FLIGHT — the TraceId / ResultIndex pairs the quote is valid for (request and
  // response sides; TBO may re-issue both).
  traceIds?: string[];
  resultIndexes?: string[];
  // FLIGHT — margined PublishedFare: what the customer is charged for the fare
  // (services/sbtPaymentGate.ts ceils the sum across legs).
  sellingFare?: number;
  // FLIGHT — quoted from a multi-city search (self-service may not book these).
  isMultiCity?: boolean;
  // FLIGHT — TBO's SupplierReissueCharges on this quote (reissue fare difference).
  supplierReissueCharges?: number;
  createdAt: Date;
}

const SBTQuoteSchema = new Schema<ISBTQuote>({
  quoteId: { type: String, required: true, unique: true, index: true },
  product: { type: String, enum: ["FLIGHT", "HOTEL"], required: true },
  serverDisplayFare: { type: Number, required: true },
  serverNetFare: { type: Number, required: true },
  sourceRef: { type: String, required: true },
  workspaceId: { type: String, default: "" },
  userId: { type: String, default: "" },
  traceIds: { type: [String], default: undefined },
  resultIndexes: { type: [String], default: undefined },
  sellingFare: { type: Number },
  isMultiCity: { type: Boolean },
  supplierReissueCharges: { type: Number },
  // TTL: rows self-expire 60 min after creation. This exceeds the
  // quote→pay→book window with margin; tunable if that window ever grows.
  createdAt: { type: Date, default: Date.now, expires: 3600 },
});

export default model<ISBTQuote>("SBTQuote", SBTQuoteSchema);
