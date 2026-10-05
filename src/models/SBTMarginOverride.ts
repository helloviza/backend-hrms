import { Schema, model, type Document, type Types } from "mongoose";

/**
 * SBTMarginOverride — one company's own SBT margins (at most one row per
 * workspace). Each of the four percents is either set or null = "use the
 * default". After validUntil the row is ignored at pricing time and the
 * company is back on the defaults — no job needed (services/sbtMargin.ts).
 * Every change is logged in SBTMarginChange.
 */
export interface ISBTMarginOverride extends Document {
  workspaceId: Types.ObjectId;
  flight: { domestic: number | null; international: number | null };
  hotel: { domestic: number | null; international: number | null };
  reason: string;
  validUntil: Date | null;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const pct = { type: Number, default: null };

const SBTMarginOverrideSchema = new Schema<ISBTMarginOverride>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, unique: true },
    flight: { domestic: pct, international: pct },
    hotel: { domestic: pct, international: pct },
    reason: { type: String, required: true, trim: true },
    validUntil: { type: Date, default: null },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

export default model<ISBTMarginOverride>("SBTMarginOverride", SBTMarginOverrideSchema);
