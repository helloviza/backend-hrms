// apps/backend/src/models/plumconnect/CampaignMap.ts
//
// PlumConnect Slice 5 — the Ops-maintained map from a Meta ad / campaign to
// the business line it sells. On a CTWA referral the Intent Engine looks
// the ad id up here FIRST (intentSource "campaign_map"); a miss falls
// through to keyword classification exactly like an organic message.
//
// This is a ROUTING table, not attribution: it answers "which department
// does this ad's contact want", never "which ad did they come from" — that
// stays on Lead.attribution / Conversation.referralRaw (Slice 3b, Slice 8).
//
// Keys are Meta's identifiers as they arrive on message.referral:
//   adId       = referral.source_id  (the ad)
//   campaignId = reserved for a campaign-level id when one is available
// Either may be set; each is unique when present (sparse).

import mongoose, { Schema, type Document } from "mongoose";
import { BUSINESS_LINES, type BusinessLine } from "./Conversation.js";

export interface IPlumConnectCampaignMap extends Document {
  adId?: string | null;
  campaignId?: string | null;
  businessLine: BusinessLine;
  /** Human label for the Ops screen ("Bali Sept promo"). */
  label: string;
  enabled: boolean;
  createdBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const PlumConnectCampaignMapSchema = new Schema<IPlumConnectCampaignMap>(
  {
    // No default: an absent key must stay ABSENT so the sparse unique index skips it.
    adId: { type: String, trim: true },
    campaignId: { type: String, trim: true },
    businessLine: { type: String, enum: BUSINESS_LINES, required: true },
    label: { type: String, trim: true, default: "" },
    enabled: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

// One row per ad / per campaign; rows without the key are skipped by the index.
PlumConnectCampaignMapSchema.index({ adId: 1 }, { unique: true, sparse: true });
PlumConnectCampaignMapSchema.index({ campaignId: 1 }, { unique: true, sparse: true });

// A null must never be stored where the sparse unique index would see it as
// a value: coerce "" / null to undefined on the way in.
PlumConnectCampaignMapSchema.pre("validate", function (next) {
  if (!this.adId) this.adId = undefined;
  if (!this.campaignId) this.campaignId = undefined;
  if (!this.adId && !this.campaignId) return next(new Error("A campaign map row needs an adId or a campaignId."));
  next();
});

const PlumConnectCampaignMap =
  (mongoose.models.PlumConnectCampaignMap as mongoose.Model<IPlumConnectCampaignMap>) ||
  mongoose.model<IPlumConnectCampaignMap>("PlumConnectCampaignMap", PlumConnectCampaignMapSchema);

export default PlumConnectCampaignMap;
