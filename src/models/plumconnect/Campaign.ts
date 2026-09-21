// apps/backend/src/models/plumconnect/Campaign.ts
//
// PlumConnect Slice 8 — the top of the Meta ad hierarchy
// (Campaign → AdSet → Ad), as resolved UPWARD from the ad id a CTWA
// referral carries. Meta delivers ONLY the ad id on the wire
// (Lead.attribution.sourceId); the campaign and its name are learned later
// by the enrichment worker through the Graph API (ads_read) and never by
// the capture path. Keyed by Meta's id and deduplicated on it.
//
// Lineage, not routing: PlumConnectCampaignMap (Slice 5) answers "which
// department does this ad sell"; these rows answer "which campaign did this
// contact come from". Neither reads the other.
//
// Nothing here is required for a lead to exist: a Campaign row appears only
// once enrichment has run. `raw` keeps Meta's object as returned so a later
// field (objective, budget) is available without a re-fetch.

import mongoose, { Schema, type Document } from "mongoose";

export interface IPlumConnectCampaign extends Document {
  /** Meta's campaign id — the identity; unique. */
  metaId: string;
  name: string;
  /** Meta's effective_status as returned ("ACTIVE", "PAUSED", …). */
  status: string;
  objective: string;
  /** Meta's ad account id when the Graph response carries it. */
  accountId: string;
  lastEnrichedAt?: Date | null;
  raw?: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const PlumConnectCampaignSchema = new Schema<IPlumConnectCampaign>(
  {
    metaId: { type: String, required: true, trim: true },
    name: { type: String, trim: true, default: "" },
    status: { type: String, trim: true, default: "" },
    objective: { type: String, trim: true, default: "" },
    accountId: { type: String, trim: true, default: "" },
    lastEnrichedAt: { type: Date, default: null },
    raw: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

PlumConnectCampaignSchema.index({ metaId: 1 }, { unique: true });

const PlumConnectCampaign =
  (mongoose.models.PlumConnectCampaign as mongoose.Model<IPlumConnectCampaign>) ||
  mongoose.model<IPlumConnectCampaign>("PlumConnectCampaign", PlumConnectCampaignSchema);

export default PlumConnectCampaign;
