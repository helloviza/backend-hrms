// apps/backend/src/models/TravellerProfile.ts
import mongoose, { Schema, type Document, type Model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

// Standing dietary/SSR preference codes (IATA special-meal codes). Kept on
// the schema and NOT yet surfaced in the booking UI — SBTPassengers.tsx has
// no meal field today, and MealDynamic there is a paid per-flight upsell,
// not a standing SSR. Submitting this code to TBO is separate, unscoped
// follow-on work (see docs/prd/traveller-profiles.md). Storing it now is
// harmless; silently promising a meal that never reaches the airline is not.
export const MEAL_PREFERENCE_CODES = [
  "VGML", "VJML", "AVML", "HNML", "MOML", "GFML", "KSML",
  "DBML", "CHML", "BLML", "RVML", "LSML", "LFML", "NLML", "SFML", "FPML", "LCML",
] as const;
export type MealPreferenceCode = (typeof MEAL_PREFERENCE_CODES)[number];

export type TravellerProfileSource = "MANUAL" | "BULK_IMPORT" | "BOOKING_AUTOCAPTURE";

export interface FrequentFlyerEntry {
  airline?: string;
  number?: string;
}

export interface TravellerProfileDocument extends Document {
  workspaceId: mongoose.Types.ObjectId; // CustomerWorkspace._id, via workspaceScopePlugin
  travelerId: string; // "<CODE>-NNN", issued at document-create time

  // Set only via the explicit "Is this you?" claim flow (POST /:id/claim) —
  // never inferred silently from an email string match. Drives REQUESTER
  // self-edit rights alongside createdBy. See docs/prd/traveller-profiles.md §1.
  linkedMemberId?: mongoose.Types.ObjectId; // ref CustomerMember
  claimedBy?: mongoose.Types.ObjectId; // ref User — who performed the claim
  claimedAt?: Date;

  title?: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  gender?: string;
  dob?: string; // "YYYY-MM-DD" — plain date string, never Date/datetime (timezone-shift history in this codebase)
  nationality?: string;
  mealPreference?: MealPreferenceCode;

  passportNo?: string;
  passportExpiry?: string; // "YYYY-MM-DD"
  passportIssueCountry?: string;
  passportIssueDate?: string; // "YYYY-MM-DD"

  mobile?: string;
  email?: string; // single fact: the traveller's own contact address — also the dedup/claim match key

  frequentFlyer: FrequentFlyerEntry[];

  createdBy: mongoose.Types.ObjectId; // ref User — who created this record
  source: TravellerProfileSource;

  isActive: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

const FrequentFlyerSchema = new Schema<FrequentFlyerEntry>(
  { airline: { type: String, trim: true }, number: { type: String, trim: true } },
  { _id: false },
);

const TravellerProfileSchema = new Schema<TravellerProfileDocument>(
  {
    travelerId: { type: String, required: true },

    linkedMemberId: { type: Schema.Types.ObjectId, ref: "CustomerMember" },
    claimedBy: { type: Schema.Types.ObjectId, ref: "User" },
    claimedAt: { type: Date },

    title: { type: String, trim: true },
    firstName: { type: String, required: true, trim: true },
    middleName: { type: String, trim: true },
    lastName: { type: String, required: true, trim: true },
    gender: { type: String, trim: true },
    dob: { type: String },
    nationality: { type: String, trim: true },
    mealPreference: { type: String, enum: MEAL_PREFERENCE_CODES },

    passportNo: { type: String, trim: true },
    passportExpiry: { type: String },
    passportIssueCountry: { type: String, trim: true },
    passportIssueDate: { type: String },

    mobile: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },

    frequentFlyer: { type: [FrequentFlyerSchema], default: [] },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    source: { type: String, enum: ["MANUAL", "BULK_IMPORT", "BOOKING_AUTOCAPTURE"], required: true },

    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

TravellerProfileSchema.plugin(workspaceScopePlugin);

TravellerProfileSchema.index({ workspaceId: 1, travelerId: 1 }, { unique: true });
TravellerProfileSchema.index({ workspaceId: 1, email: 1 });
TravellerProfileSchema.index({ workspaceId: 1, firstName: 1, lastName: 1, dob: 1 }); // tier-2 dedup lookup
TravellerProfileSchema.index({ workspaceId: 1, isActive: 1 });

const TravellerProfile: Model<TravellerProfileDocument> =
  mongoose.models.TravellerProfile ||
  mongoose.model<TravellerProfileDocument>("TravellerProfile", TravellerProfileSchema);

export default TravellerProfile;
