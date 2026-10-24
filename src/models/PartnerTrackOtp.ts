// apps/backend/src/models/PartnerTrackOtp.ts
//
// One-time codes for a student's "Track my case" on a partner link
// (routes/public.partnerTrack.ts). Neither the email nor the code is stored:
// only salted hashes. A code is for one email under one partner, lives 10
// minutes, allows 5 wrong tries, and is used once.
import mongoose, { Schema, type Model } from "mongoose";

export interface PartnerTrackOtpDoc {
  emailHash: string;
  partnerWorkspaceId: mongoose.Types.ObjectId;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  usedAt: Date | null;
  lockedAt: Date | null;
  createdAt?: Date;
}

const PartnerTrackOtpSchema = new Schema<PartnerTrackOtpDoc>(
  {
    emailHash: { type: String, required: true },
    partnerWorkspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    usedAt: { type: Date, default: null },
    lockedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Lookups: the newest code for an email under a partner; codes per email per hour.
PartnerTrackOtpSchema.index({ emailHash: 1, partnerWorkspaceId: 1, createdAt: -1 });
// Spent rows go a day after they expire.
PartnerTrackOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

const PartnerTrackOtp: Model<PartnerTrackOtpDoc> =
  (mongoose.models.PartnerTrackOtp as Model<PartnerTrackOtpDoc>) || mongoose.model<PartnerTrackOtpDoc>("PartnerTrackOtp", PartnerTrackOtpSchema);

export default PartnerTrackOtp;
