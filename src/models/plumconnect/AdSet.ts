// apps/backend/src/models/plumconnect/AdSet.ts
//
// PlumConnect Slice 8 — the middle of the Meta hierarchy (Campaign → AdSet
// → Ad). Resolved upward from an ad id by the enrichment worker; never on
// the wire. Keyed by Meta's id, deduplicated on it. `campaignId` is the
// parent ref (our row); `metaCampaignId` the parent's Meta id, kept so the
// tree can be rebuilt even if a parent row is missing.

import mongoose, { Schema, type Document } from "mongoose";

export interface IPlumConnectAdSet extends Document {
  metaId: string;
  name: string;
  status: string;
  /** Parent Campaign row (null until the campaign is upserted). */
  campaignId?: mongoose.Types.ObjectId | null;
  metaCampaignId: string;
  lastEnrichedAt?: Date | null;
  raw?: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const PlumConnectAdSetSchema = new Schema<IPlumConnectAdSet>(
  {
    metaId: { type: String, required: true, trim: true },
    name: { type: String, trim: true, default: "" },
    status: { type: String, trim: true, default: "" },
    campaignId: { type: Schema.Types.ObjectId, ref: "PlumConnectCampaign", default: null },
    metaCampaignId: { type: String, trim: true, default: "" },
    lastEnrichedAt: { type: Date, default: null },
    raw: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

PlumConnectAdSetSchema.index({ metaId: 1 }, { unique: true });
PlumConnectAdSetSchema.index({ campaignId: 1 });

const PlumConnectAdSet =
  (mongoose.models.PlumConnectAdSet as mongoose.Model<IPlumConnectAdSet>) ||
  mongoose.model<IPlumConnectAdSet>("PlumConnectAdSet", PlumConnectAdSetSchema);

export default PlumConnectAdSet;
