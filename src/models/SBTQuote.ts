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
  createdAt: Date;
}

const SBTQuoteSchema = new Schema<ISBTQuote>({
  quoteId: { type: String, required: true, unique: true, index: true },
  product: { type: String, enum: ["FLIGHT", "HOTEL"], required: true },
  serverDisplayFare: { type: Number, required: true },
  serverNetFare: { type: Number, required: true },
  sourceRef: { type: String, required: true },
  // TTL: rows self-expire 60 min after creation. This exceeds the
  // quote→pay→book window with margin; tunable if that window ever grows.
  createdAt: { type: Date, default: Date.now, expires: 3600 },
});

export default model<ISBTQuote>("SBTQuote", SBTQuoteSchema);
