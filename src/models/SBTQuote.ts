import { Schema, model, type Document } from "mongoose";

/**
 * SBTQuote — short-lived server-side record of what the server quoted at quote
 * time (FareQuote for flights, PreBook for hotels). It is the ONLY source of the
 * supplier net at booking time: customers never receive our cost, so Book /
 * Ticket read the net fare (flights) and NetAmount + RSP floor (hotels) from
 * here, by quote, scoped to the caller's workspace + user (services/sbtQuote.ts).
 *
 * serverDisplayFare / serverNetFare / sourceRef also feed price reconciliation
 * (utils/priceRecon.ts).
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
  // FLIGHT — TBO's FareQuote Fare and FareBreakdown, untouched (pre-margin).
  netFare?: Record<string, unknown> | null;
  netFareBreakdown?: Array<Record<string, unknown>>;
  // HOTEL — PreBook cost figures for room 0 (NetAmount is what TBO Book needs).
  netAmount?: number;
  recommendedSellingRate?: number | null;
  agentCommission?: number;
  tds?: number;
  isPublishedFare?: boolean;
  cancelPolicies?: Array<Record<string, unknown>>;
  // The margin that priced this quote (services/sbtMargin.ts marginRecord):
  // percent, DEFAULT / OVERRIDE / OFF, the override row, the defaults version,
  // domestic or international (server-decided), and selling − the net it was
  // applied to (flights: PublishedFare; hotels: room TotalFare).
  marginPct?: number;
  marginSource?: "DEFAULT" | "OVERRIDE" | "OFF";
  marginOverrideId?: string | null;
  marginVersion?: number;
  isInternational?: boolean;
  marginAmount?: number;
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
  netFare: { type: Schema.Types.Mixed, default: undefined },
  netFareBreakdown: { type: Schema.Types.Mixed, default: undefined },
  netAmount: { type: Number },
  recommendedSellingRate: { type: Number },
  agentCommission: { type: Number },
  tds: { type: Number },
  isPublishedFare: { type: Boolean },
  cancelPolicies: { type: Schema.Types.Mixed, default: undefined },
  marginPct: { type: Number },
  marginSource: { type: String, enum: ["DEFAULT", "OVERRIDE", "OFF"] },
  marginOverrideId: { type: String, default: undefined },
  marginVersion: { type: Number },
  isInternational: { type: Boolean },
  marginAmount: { type: Number },
  // TTL: rows self-expire 60 min after creation. This exceeds the
  // quote→pay→book window with margin; tunable if that window ever grows.
  createdAt: { type: Date, default: Date.now, expires: 3600 },
});

export default model<ISBTQuote>("SBTQuote", SBTQuoteSchema);
