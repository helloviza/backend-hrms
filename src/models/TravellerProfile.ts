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

  // Optional org department (2026-08-09). A REFERENCE to the existing
  // workspace-scoped Department collection, never free text and never
  // auto-created: an unknown name is an error to fix at the source, not a
  // new row to mint, or the list degrades into the misspelt-duplicate mess
  // free text always becomes.
  //
  // Department is scoped by workspaceId -> CustomerWorkspace, the SAME key
  // this model uses, so "the traveller's workspace" and "the department's
  // workspace" are the same field compared directly — there is no
  // customerId/workspaceId translation step to get wrong.
  //
  // Optional by design: a traveller with no department is valid and always
  // will be. Two of the four workspaces holding travellers in production
  // have no Department rows at all, so requiring it would make those
  // rosters unfillable. Unset reads as "No department" on the dashboard,
  // never as an error.
  //
  // NOTE this is the first departmentId REFERENCE in the codebase — the
  // HRMS side (User.department, and masterData.departments.ts's headcount
  // aggregate) still joins Department by NAME STRING. Deliberately not
  // copied: that pattern is why a rename silently orphans headcounts.
  departmentId?: mongoose.Types.ObjectId | null;

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

  // CSTEP Travel & Claim Portal (Phase 5) — this traveller's fixed Tour
  // Approver, deliberately SEPARATE from any Expense reporting-manager
  // (User.managerId). Optional: an unset value means the traveller's
  // submitted proposals fall back to CSTEP Admin routing — see
  // routes/cstep.ts. Set only via workspace.travellers.ts's dedicated
  // PATCH /:id/tour-approver route, CSTEP-Admin-only.
  tourApproverId?: mongoose.Types.ObjectId; // ref User

  // CSTEP three-person mapping (Traveller → Approver → Official user →
  // Finance user) — additive siblings of tourApproverId above, same rules:
  // ANY workspace user may go in either slot (no role restriction), unset
  // means that pipeline stage has nobody routed to it yet, and both are set
  // only via the same CSTEP-Admin-only PATCH /:id/tour-approver route
  // (extended to accept these two alongside tourApproverId — see
  // routes/workspace.travellers.ts). officialUserId is who processes an
  // APPROVED request; financeUserId is who handles it at the finance stage.
  // Neither is read by approve/return/audit/status logic — routes/cstep.ts's
  // GET /official-queue and GET /finance-queue are pure additional read
  // filters on top of the unchanged CstepTravelRequest lifecycle.
  officialUserId?: mongoose.Types.ObjectId; // ref User
  financeUserId?: mongoose.Types.ObjectId; // ref User

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

    departmentId: { type: Schema.Types.ObjectId, ref: "Department", default: null },

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

    tourApproverId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    officialUserId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    financeUserId: { type: Schema.Types.ObjectId, ref: "User", index: true },

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
// Department grouping on /visa/workspace reads exactly this pair.
TravellerProfileSchema.index({ workspaceId: 1, departmentId: 1 });

const TravellerProfile: Model<TravellerProfileDocument> =
  mongoose.models.TravellerProfile ||
  mongoose.model<TravellerProfileDocument>("TravellerProfile", TravellerProfileSchema);

export default TravellerProfile;
