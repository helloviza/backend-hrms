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

/**
 * A regulated national ID — the number plus a pointer to the scan of the
 * card it came from. Nested rather than four flat keys so "the number" and
 * "the image it was read off" stay visibly one thing, and so the encryption
 * pass that eventually enables these has an obvious unit to encrypt.
 *
 * CAPTURE IS GATED. Both fields exist today and BOTH REFUSE WRITES while
 * config/platformCapabilities.ts's mrzEncryptionAtRest is false — for every
 * role, SUPERADMIN included, because that flag is a build-state gate and
 * not a permission. The shape is created now so the later work is a
 * migration of VALUES, not of schema. Until then nothing is stored here and
 * no surface claims anything is encrypted.
 * See infra/design/universal-traveller-profile-2026-08-11.md §4.
 */
export interface TravellerIdentityNumber {
  number?: string;
  docId?: mongoose.Types.ObjectId; // ref TravellerDocument — the card image
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

  /**
   * Line manager, ADMIN/WORKSPACE_LEADER-set (2026-08-11). Deliberately NOT
   * one of the three CSTEP routing slots below: those are pipeline stages
   * on a travel request (who approves it, who processes it, who pays it)
   * and are set through their own isCstepAdmin-gated route. This is the
   * org fact "who does this person report to", which a REQUESTER must
   * never be able to set about themselves.
   *
   * Also not User.managerId — that is the HRMS staff model, a different
   * population from workspace travellers.
   *
   * Skeleton limits, stated: any User in the workspace is accepted, there
   * is no check that they are actually a manager, and no cycle check
   * (A -> B -> A is storable). A directory pointer, not an org hierarchy.
   */
  reportingManagerId?: mongoose.Types.ObjectId; // ref User

  /**
   * The ORG's own employee number, ADMIN/WORKSPACE_LEADER-set (2026-08-11).
   * Distinct from travelerId above, which is a system-minted <CODE>-NNN
   * this collection issues for itself and mirrors to CustomerMember.
   *
   * Free text on purpose: every customer numbers its people differently,
   * and validating a format we do not know would reject correct data. NOT
   * unique-indexed in this skeleton — see the design doc §7.
   */
  employeeId?: string;

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
  /**
   * Dial code, e.g. "+91" (2026-08-11). Sits ALONGSIDE `mobile`, which
   * keeps its existing meaning (the subscriber number) unchanged — the two
   * were never merged into one string because every stored value today is
   * India-shaped 10 digits and re-parsing them into parts would be a
   * guess. Absent means "unknown", never "+91".
   */
  mobileCountryCode?: string;
  /**
   * The traveller's own contact address — also the dedup/claim match key.
   *
   * READ-ONLY ON EDIT since 2026-08-11, for every role including
   * SUPERADMIN: PUT /:id does not accept this key at all. Writing it at
   * CREATE time runs ensureCstepTravellerLogin, which upserts a
   * CustomerMember, provisions a real User and fires a live invite email —
   * correct when someone is deliberately adding a colleague, and a trap
   * when it happens as a side effect of correcting a profile. Create and
   * bulk import still write it, so invites still happen; see the design
   * doc §2.1 for every surviving invite path and for the one thing this
   * costs (correcting a typo'd address, which has no route yet).
   */
  email?: string;

  /**
   * Regulated national IDs — GATED, see TravellerIdentityNumber above.
   * The fields exist; writes are refused while encryption at rest is
   * unbuilt. Nothing is stored here today.
   */
  pan?: TravellerIdentityNumber;
  aadhaar?: TravellerIdentityNumber;

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

  /**
   * Who last saved this document (2026-08-11). Written by every route that
   * mutates it; pairs with the `updatedAt` timestamps already provide to
   * render "Last edited by X at Y" on the profile surfaces.
   *
   * The LAST edit only. There is no per-field history and no audit
   * collection, matching the existing decision for the claim routes
   * (routes/workspace.travellers.ts's identityLogger: log lines, not a
   * collection, because nothing reviews or retains them).
   */
  updatedBy?: mongoose.Types.ObjectId; // ref User

  source: TravellerProfileSource;

  isActive: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

const FrequentFlyerSchema = new Schema<FrequentFlyerEntry>(
  { airline: { type: String, trim: true }, number: { type: String, trim: true } },
  { _id: false },
);

// No `default: {}` — an absent sub-object must stay absent rather than
// materialising an empty one on every document, so "we hold nothing" reads
// as undefined everywhere instead of as a present-but-blank record.
const IdentityNumberSchema = new Schema<TravellerIdentityNumber>(
  {
    number: { type: String, trim: true },
    docId: { type: Schema.Types.ObjectId, ref: "TravellerDocument" },
  },
  { _id: false },
);

const TravellerProfileSchema = new Schema<TravellerProfileDocument>(
  {
    travelerId: { type: String, required: true },

    linkedMemberId: { type: Schema.Types.ObjectId, ref: "CustomerMember" },
    claimedBy: { type: Schema.Types.ObjectId, ref: "User" },
    claimedAt: { type: Date },

    departmentId: { type: Schema.Types.ObjectId, ref: "Department", default: null },

    reportingManagerId: { type: Schema.Types.ObjectId, ref: "User" },
    employeeId: { type: String, trim: true },

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
    mobileCountryCode: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },

    pan: { type: IdentityNumberSchema },
    aadhaar: { type: IdentityNumberSchema },

    tourApproverId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    officialUserId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    financeUserId: { type: Schema.Types.ObjectId, ref: "User", index: true },

    frequentFlyer: { type: [FrequentFlyerSchema], default: [] },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
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
