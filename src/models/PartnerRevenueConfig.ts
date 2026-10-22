import { Schema, model, type Document, type Types } from "mongoose";

/**
 * PartnerRevenueConfig — one partner's revenue-share terms (at most one row
 * per workspace). A partner is a CustomerWorkspace with an enabled row here.
 *
 *   bakedIn = ManualBooking.pricing.basePrice × visiblePct / 100
 *   share   = bakedIn × sharePct / 100
 *
 * KEYED ON CustomerWorkspace._id — ManualBooking.workspaceId is a Customer._id,
 * so readers bridge via CustomerWorkspace.customerId (services/partnerRevenue.ts).
 * The amounts are snapshotted onto each booking when it is invoiced
 * (ManualBooking.partnerShare); changing a row here never rewrites them.
 * Every change is logged in PartnerRevenueChange.
 */
export interface IPartnerRevenueConfig extends Document {
  workspaceId: Types.ObjectId;
  enabled: boolean;
  visiblePct: number;
  sharePct: number;
  reason: string;
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const pct = { type: Number, required: true, min: 0, max: 100 };

const PartnerRevenueConfigSchema = new Schema<IPartnerRevenueConfig>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, unique: true },
    enabled: { type: Boolean, default: true },
    visiblePct: pct,
    sharePct: pct,
    reason: { type: String, required: true, trim: true },
    version: { type: Number, default: 1 },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

export default model<IPartnerRevenueConfig>("PartnerRevenueConfig", PartnerRevenueConfigSchema);
