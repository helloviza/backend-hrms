import { Schema, model, type Document, type Types } from "mongoose";

/**
 * ApprovalSearchSession — one live TBO search run from the approval request
 * form (/api/approvals/search/*). Holds the RAW results, prices included, so
 * the server can later rebuild a price-free selection from an opaque
 * optionRef without ever trusting what the browser sends back.
 *
 * Never returned to a client. optionRef = `${sid}.${index}` (see
 * services/approvalSearch/optionRef.ts); it resolves only for the same user
 * and workspace while the session is unexpired.
 *
 * Expiry: the TTL index removes rows after expiresAt, but Mongo's TTL monitor
 * runs about once a minute, so every read also checks expiresAt explicitly.
 */
export const SEARCH_SESSION_TTL_MS = 60 * 60 * 1000;

export type ApprovalSearchKind = "flight" | "hotel";

export interface IApprovalSearchSession extends Document {
  sid: string;
  workspaceId: Types.ObjectId;
  userId: string;
  kind: ApprovalSearchKind;
  params: Record<string, any>;
  traceId?: string;
  /** Raw TBO options, prices included. flight: TBO Result; hotel: TBO HotelResult (with Rooms). */
  results: any;
  createdAt: Date;
  expiresAt: Date;
}

const ApprovalSearchSessionSchema = new Schema<IApprovalSearchSession>(
  {
    sid: { type: String, required: true, unique: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    userId: { type: String, required: true },
    kind: { type: String, enum: ["flight", "hotel"], required: true },
    params: { type: Schema.Types.Mixed, default: {} },
    traceId: { type: String },
    results: { type: [Schema.Types.Mixed], default: [] },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);

ApprovalSearchSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default model<IApprovalSearchSession>("ApprovalSearchSession", ApprovalSearchSessionSchema);
