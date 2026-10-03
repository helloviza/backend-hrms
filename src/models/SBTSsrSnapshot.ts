import { Schema, model, type Document } from "mongoose";

/**
 * SBTSsrSnapshot — the seat / meal / baggage prices TBO returned at /ssr, kept
 * server-side so add-ons are charged at TBO's price, not the price the browser
 * puts on a passenger. Scoped to the user + workspace that fetched it; expires
 * with the quote it belongs to.
 */
export interface SsrPriceItem {
  kind: "seat" | "meal" | "baggage";
  code: string;
  origin: string;
  destination: string;
  price: number;
}

export interface ISBTSsrSnapshot extends Document {
  traceId: string;
  resultIndex: string;
  userId: string;
  workspaceId: string;
  items: SsrPriceItem[];
  createdAt: Date;
}

const SBTSsrSnapshotSchema = new Schema<ISBTSsrSnapshot>({
  traceId: { type: String, default: "" },
  resultIndex: { type: String, required: true, index: true },
  userId: { type: String, required: true },
  workspaceId: { type: String, required: true },
  items: { type: Schema.Types.Mixed, default: [] } as any,
  createdAt: { type: Date, default: Date.now, expires: 3600 },
});

export default model<ISBTSsrSnapshot>("SBTSsrSnapshot", SBTSsrSnapshotSchema);
