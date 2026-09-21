// apps/backend/src/models/plumconnect/Ad.ts
//
// PlumConnect Slice 8 — the leaf of the Meta hierarchy and the ONLY node a
// contact's message ever identifies: Lead.attribution.sourceId and
// Conversation.referralRaw.source_id ARE this row's `metaId`. A Lead links
// to its Ad by that id — no Lead field is added. Keyed by Meta's id,
// deduplicated on it.
//
// A row is created by the enrichment worker's DISCOVERY sweep the moment a
// bare ad id is seen on any lead or conversation (historical or new), with
// `enrichment.status: "pending"` and no name. Capture never writes here and
// never waits for it. The worker then resolves ad → adset → campaign via
// the Graph API (ads_read) and stamps `lastEnrichedAt`; without a token, or
// with Graph unreachable, the row simply stays pending. A deleted / invalid
// ad id ends as "failed" after bounded retries — never retried forever.
//
//   enrichment.status   pending → processing → enriched | failed
//   enrichment.attempts counts REAL failures (a rate limit or a network
//                       error is not an attempt — it only pushes nextAttemptAt)

import mongoose, { Schema, type Document } from "mongoose";

export const AD_ENRICHMENT_STATUSES = ["pending", "processing", "enriched", "failed"] as const;
export type AdEnrichmentStatus = (typeof AD_ENRICHMENT_STATUSES)[number];

export interface IPlumConnectAdEnrichment {
  status: AdEnrichmentStatus;
  attempts: number;
  nextAttemptAt?: Date | null;
  claimedAt?: Date | null;
  lastError: string;
  lastErrorCode: string;
}

export interface IPlumConnectAd extends Document {
  /** Meta's ad id — Lead.attribution.sourceId / referral.source_id. Unique. */
  metaId: string;
  name: string;
  status: string;
  /** Parent AdSet row (null until enriched). */
  adSetId?: mongoose.Types.ObjectId | null;
  metaAdSetId: string;
  /** Grandparent Campaign row, denormalised so the roll-up needs no second hop. */
  campaignId?: mongoose.Types.ObjectId | null;
  metaCampaignId: string;
  /** Where this id was first seen: "lead" | "conversation". */
  discoveredFrom: string;
  firstSeenAt?: Date | null;
  lastEnrichedAt?: Date | null;
  enrichment: IPlumConnectAdEnrichment;
  raw?: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const EnrichmentSchema = new Schema<IPlumConnectAdEnrichment>(
  {
    status: { type: String, enum: AD_ENRICHMENT_STATUSES, default: "pending" },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    claimedAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
    lastErrorCode: { type: String, default: "" },
  },
  { _id: false },
);

const PlumConnectAdSchema = new Schema<IPlumConnectAd>(
  {
    metaId: { type: String, required: true, trim: true },
    name: { type: String, trim: true, default: "" },
    status: { type: String, trim: true, default: "" },
    adSetId: { type: Schema.Types.ObjectId, ref: "PlumConnectAdSet", default: null },
    metaAdSetId: { type: String, trim: true, default: "" },
    campaignId: { type: Schema.Types.ObjectId, ref: "PlumConnectCampaign", default: null },
    metaCampaignId: { type: String, trim: true, default: "" },
    discoveredFrom: { type: String, trim: true, default: "" },
    firstSeenAt: { type: Date, default: null },
    lastEnrichedAt: { type: Date, default: null },
    enrichment: { type: EnrichmentSchema, default: () => ({}) },
    raw: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

PlumConnectAdSchema.index({ metaId: 1 }, { unique: true });
// The worker's claim query.
PlumConnectAdSchema.index({ "enrichment.status": 1, "enrichment.nextAttemptAt": 1 });
PlumConnectAdSchema.index({ adSetId: 1 });
PlumConnectAdSchema.index({ campaignId: 1 });

const PlumConnectAd =
  (mongoose.models.PlumConnectAd as mongoose.Model<IPlumConnectAd>) ||
  mongoose.model<IPlumConnectAd>("PlumConnectAd", PlumConnectAdSchema);

export default PlumConnectAd;
