// apps/backend/src/models/cstep/CstepTallySettings.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepTallySettings
 * ------------------
 * One per workspace, CSTEP-Admin edited: what the Finance "Export to Tally"
 * sheet (routes/cstep.tally.ts) writes into Company Name / Voucher Type, and
 * which expense ledger a paid vendor line is debited to — by the vendor's
 * type (CstepVendorType), falling back to defaultLedger for a type with no
 * mapping. The credit side is always the vendor's own ledger (its name).
 *
 * Locations: the debit row's "Locations " column carries locationLabel (the
 * Tally cost-centre category, "Locations" unless changed) and "Location CC"
 * the code locationMap gives the line's location — the traveller's base
 * (TravellerProfile.workLocation) or the trip's destination, per
 * locationSource. A location with no entry goes out as its own text.
 */
export const CSTEP_TALLY_LOCATION_SOURCES = ["BASE", "DESTINATION"] as const;
export type CstepTallyLocationSource = (typeof CSTEP_TALLY_LOCATION_SOURCES)[number];

export interface ICstepTallySettings extends Document {
  workspaceId: mongoose.Types.ObjectId;
  companyName: string;
  voucherType: string;
  defaultLedger: string;
  ledgerMap: Array<{ vendorTypeId: mongoose.Types.ObjectId; ledger: string }>;
  locationLabel: string;
  locationSource: CstepTallyLocationSource;
  locationMap: Array<{ location: string; code: string }>;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const CstepTallySettingsSchema = new Schema<ICstepTallySettings>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, unique: true },
    companyName: { type: String, trim: true, default: "" },
    voucherType: { type: String, trim: true, default: "Journal" },
    defaultLedger: { type: String, trim: true, default: "" },
    ledgerMap: {
      type: [
        {
          _id: false,
          vendorTypeId: { type: Schema.Types.ObjectId, ref: "CstepVendorType", required: true },
          ledger: { type: String, trim: true, required: true },
        },
      ],
      default: [],
    },
    locationLabel: { type: String, trim: true, default: "Locations" },
    locationSource: { type: String, enum: CSTEP_TALLY_LOCATION_SOURCES, default: "BASE" },
    locationMap: {
      type: [
        {
          _id: false,
          location: { type: String, trim: true, required: true },
          code: { type: String, trim: true, required: true },
        },
      ],
      default: [],
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

CstepTallySettingsSchema.plugin(workspaceScopePlugin);

const CstepTallySettings =
  (mongoose.models.CstepTallySettings as mongoose.Model<ICstepTallySettings>) ||
  mongoose.model<ICstepTallySettings>("CstepTallySettings", CstepTallySettingsSchema);

export default CstepTallySettings;
