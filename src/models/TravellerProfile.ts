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
  /**
   * Loyalty status, e.g. "Gold", "Platinum" (2026-08-11, Tab 4). Free text
   * on purpose: every programme names its tiers differently and an enum
   * would reject correct values. Purely informational — see the Loyalty
   * Vault note below on what this is and is not used for.
   */
  tier?: string;
}

/**
 * NON-AIRLINE loyalty programmes — hotel, car, rail (2026-08-11, Tab 4).
 *
 * Deliberately a SIBLING of frequentFlyer rather than a generalisation of
 * it. frequentFlyer is airline-shaped by name (`airline`) and by use: the
 * bulk-import template, the CSV export and the existing form all read that
 * exact key, so widening it to hold hotel chains would either break those
 * three or leave `airline: "Marriott"` in the data. The design doc's rule
 * was "do not overload frequentFlyer.airline"; two arrays honour it with no
 * migration.
 *
 * The UI presents them as one "Loyalty Vault" in two labelled sections —
 * Airline programmes (frequentFlyer) and Hotel & car programmes (here) —
 * so the split is a storage detail, not something the user has to reason
 * about.
 */
export const LOYALTY_PROGRAMME_TYPES = ["HOTEL", "CAR", "RAIL", "OTHER"] as const;
export type LoyaltyProgrammeType = (typeof LOYALTY_PROGRAMME_TYPES)[number];

export interface LoyaltyProgrammeEntry {
  programmeType?: LoyaltyProgrammeType;
  programmeName?: string;
  membershipNumber?: string;
  tier?: string;
}

/**
 * Emergency contact (2026-08-11, Tab 1). An ARRAY, not two fixed slots:
 * the design shows a primary and a secondary, but capping the schema at two
 * would be an arbitrary limit to migrate away from later. The UI renders
 * the first as Primary and the second as Secondary.
 *
 * Deliberately NOT User.emergencyContactName/Number/Relation — that is the
 * HRMS staff model, a different population from workspace travellers, and
 * it is a single flat contact where this needs two.
 */
export interface EmergencyContactEntry {
  name?: string;
  relationship?: string;
  phone?: string;
  countryCode?: string;
}

/**
 * Standing seat preference (2026-08-11, Tab 4).
 *
 * STORED, NOT SUBMITTED — the same honest caveat mealPreference carries
 * below. Nothing in the SBT booking flow reads this today (verified: the
 * passenger form fills title/name/dob/gender/nationality/passport/email/
 * mobile from the profile and nothing else), so the UI labels it "saved",
 * never "applied" or "synced with the travel engine". Promising a window
 * seat that never reaches the airline is worse than not offering the field.
 */
export const SEAT_PREFERENCES = ["WINDOW", "AISLE", "MIDDLE", "NO_PREFERENCE"] as const;
export type SeatPreference = (typeof SEAT_PREFERENCES)[number];

/**
 * Hotel preferences, multi-select (2026-08-11, Tab 4). A fixed vocabulary
 * rather than free text so the values stay aggregatable; same
 * stored-not-submitted caveat as seat and meal.
 */
export const HOTEL_PREFERENCES = [
  "NON_SMOKING",
  "HIGH_FLOOR",
  "LOW_FLOOR",
  "KING_BED",
  "TWIN_BEDS",
  "QUIET_ROOM",
  "AWAY_FROM_LIFT",
  "ACCESSIBLE_ROOM",
  "EARLY_CHECK_IN",
  "LATE_CHECK_OUT",
] as const;
export type HotelPreference = (typeof HOTEL_PREFERENCES)[number];

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
  /**
   * Job title, ADMIN/WORKSPACE_LEADER-set (2026-08-11, Tab 1). A REFERENCE
   * to the existing workspace-scoped Designation collection — the same
   * decision departmentId made above, and for the same reason: free text
   * degrades into the misspelt-duplicate mess ("Sr. Manager" / "Senior
   * Manager" / "Sr Manager") that a rename can never fix.
   *
   * Designation is scoped by workspaceId -> CustomerWorkspace, the SAME key
   * this model uses, so no translation step.
   *
   * NOTE the routes: master-data's own GET/POST /designations are
   * isHrAdmin-gated (SUPERADMIN/ADMIN/HR) and nothing there creates rows for
   * a CUSTOMER workspace, so a ref alone would have given customer leaders a
   * permanently empty picker. This model therefore ships alongside
   * customer-facing list/create routes on THIS router, gated on the
   * traveller write-RBAC — mirroring what departments already do, including
   * the inline "+ Add" for leaders. Decision recorded 2026-08-11.
   *
   * Optional by design, exactly like departmentId: a traveller with no
   * designation is valid and always will be.
   */
  designationId?: mongoose.Types.ObjectId | null; // ref Designation

  /**
   * The org's cost centre for this person (2026-08-11, Tab 1),
   * ADMIN/WORKSPACE_LEADER-set. A free STRING, deliberately unlike
   * designation above: there is no cost-centre collection anywhere in the
   * codebase to reference, and inventing one to hold a code the finance
   * system owns would be a second source of truth for somebody else's data.
   */
  costCenterId?: string;

  /** Office/base location, ADMIN/WORKSPACE_LEADER-set (2026-08-11, Tab 1). */
  workLocation?: string;

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
  /**
   * The traveller's own personal address (2026-08-11, Tab 1).
   *
   * INERT BY CONSTRUCTION, and that is the whole reason it can exist while
   * `email` above stays read-only. Nothing in any write path passes this to
   * ensureCstepTravellerLogin: it never upserts a CustomerMember, never
   * provisions a User, never fires an invite. It is contact data and
   * nothing else. `email` remains the single login/dedup/claim key.
   */
  personalEmail?: string;

  /**
   * Country of tax residency (2026-08-11, Tab 1). Sits in the Tax
   * Identification block on the dossier but is deliberately NOT
   * encryption-gated: a residency country is an ordinary demographic fact,
   * not a regulated national ID number. Only pan/aadhaar below are gated.
   */
  taxResidency?: string;

  pan?: TravellerIdentityNumber;
  aadhaar?: TravellerIdentityNumber;

  /** Tab 1. Array, not two fixed slots — see EmergencyContactEntry. */
  emergencyContacts: EmergencyContactEntry[];

  /** Tab 4 — all four STORED, NOT SUBMITTED. See SeatPreference. */
  seatPreference?: SeatPreference;
  /** IATA code of the airport this person usually departs from. */
  homeAirport?: string;
  hotelPreferences: HotelPreference[];
  loyaltyProgrammes: LoyaltyProgrammeEntry[];

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
  {
    airline: { type: String, trim: true },
    number: { type: String, trim: true },
    tier: { type: String, trim: true },
  },
  { _id: false },
);

const LoyaltyProgrammeSchema = new Schema<LoyaltyProgrammeEntry>(
  {
    programmeType: { type: String, enum: LOYALTY_PROGRAMME_TYPES },
    programmeName: { type: String, trim: true },
    membershipNumber: { type: String, trim: true },
    tier: { type: String, trim: true },
  },
  { _id: false },
);

const EmergencyContactSchema = new Schema<EmergencyContactEntry>(
  {
    name: { type: String, trim: true },
    relationship: { type: String, trim: true },
    phone: { type: String, trim: true },
    countryCode: { type: String, trim: true },
  },
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

    designationId: { type: Schema.Types.ObjectId, ref: "Designation", default: null },
    costCenterId: { type: String, trim: true },
    workLocation: { type: String, trim: true },
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

    // Lowercased/trimmed like `email`, so the two compare cleanly — but it
    // is NOT indexed and NOT a match key: nothing dedupes, claims or
    // provisions a login on this field. See the interface note.
    personalEmail: { type: String, lowercase: true, trim: true },
    taxResidency: { type: String, trim: true },

    pan: { type: IdentityNumberSchema },
    aadhaar: { type: IdentityNumberSchema },

    emergencyContacts: { type: [EmergencyContactSchema], default: [] },

    seatPreference: { type: String, enum: SEAT_PREFERENCES },
    homeAirport: { type: String, trim: true, uppercase: true },
    hotelPreferences: { type: [String], enum: HOTEL_PREFERENCES, default: [] },
    loyaltyProgrammes: { type: [LoyaltyProgrammeSchema], default: [] },

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
