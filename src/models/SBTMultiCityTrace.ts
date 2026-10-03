import { Schema, model, type Document } from "mongoose";

/**
 * SBTMultiCityTrace — every TBO TraceId that came from a multi-city search
 * (/search-multi-city), or from a FareQuote on one. Lets the server recognise a
 * multi-city booking without trusting the browser's isMultiCity flag: self-service
 * multi-city is Travel Desk only (services/sbtPaymentGate.ts multiCityRefusal).
 */
export interface ISBTMultiCityTrace extends Document {
  traceId: string;
  createdAt: Date;
}

const SBTMultiCityTraceSchema = new Schema<ISBTMultiCityTrace>({
  traceId: { type: String, required: true, index: true },
  // TBO TraceIds live ~15 min; keep a margin.
  createdAt: { type: Date, default: Date.now, expires: 6 * 3600 },
});

export default model<ISBTMultiCityTrace>("SBTMultiCityTrace", SBTMultiCityTraceSchema);
