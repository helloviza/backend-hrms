import mongoose, { Document, Schema } from "mongoose";
import { normalizeCompanyName } from "../utils/companyName.js";
import { isCrmV2FoundationEnabled } from "../config/crmV2.js";

// ── Company Account (Phase 1 / Slice 1) ──────────────────────────────
// The PRD's Company Account is built IN PLACE on this collection (locked
// decision — docs/crm/PLUMBOX_ARCHITECTURE_GAP_ANALYSIS.md §6): a fresh
// collection would force a live re-point of Lead.companyId,
// Lead.convertedToCompanyId, CRMContact.companyId and Task.linkedId. Every
// field below is optional with a safe default so the existing rows stay
// valid with NO backfill; nothing writes them unless CRM_V2_FOUNDATION is on.
export const ACCOUNT_TYPES = ["corporate", "agency", "supplier", "partner"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const LIFECYCLE_STATUSES = ["prospect", "onboarding", "active", "at_risk", "dormant"] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export const ACCOUNT_TIERS = ["strategic", "growth", "standard"] as const;
export type AccountTier = (typeof ACCOUNT_TIERS)[number];

export interface CRMCompanyDoc extends Document {
  companyCode: string;
  name: string;
  // trim + lowercase + collapse internal whitespace of `name` — the dedupe key
  // for resolve-or-create, derived by utils/companyName.ts (the ONE rule).
  // Declared non-unique here on purpose: the prod unique index is PARTIAL over
  // non-empty strings and was built by backfill-lead-companyId.ts --apply AFTER
  // dedupe, so Mongoose never auto-builds a unique index over dirty data.
  // Set on every save by the pre-validate hook below when CRM_V2_FOUNDATION is
  // on; before that only resolveOrCreateCompany wrote it (M8, code half).
  nameNormalized: string;
  industry: string;
  companySize: string;
  website: string;
  phone: string;
  email: string;
  city: string;
  state: string;
  country: string;
  address: string;
  notes: string;
  leadId?: mongoose.Types.ObjectId | null;
  contactCount: number;
  createdBy: mongoose.Types.ObjectId;
  isPrivate: boolean;

  // ── Company Account fields (Slice 1) ──
  accountType: AccountType;
  lifecycleStatus: LifecycleStatus;
  accountTier?: AccountTier | null;
  accountManagerId?: mongoose.Types.ObjectId | null;
  // Bridge to the billing/ops identity of an onboarded client. Two ids are
  // needed because the two id spaces already coexist in production:
  // ManualBooking.workspaceId / BillingProfile.customerId key on Customer._id,
  // while Invoice / TravelBooking / TravellerProfile key on CustomerWorkspace._id
  // (audit §6, risk D10). Both null for a prospect.
  customerId?: mongoose.Types.ObjectId | null;
  customerWorkspaceId?: string | null;

  createdAt: Date;
  updatedAt: Date;
}

const CRMCompanySchema = new Schema<CRMCompanyDoc>(
  {
    companyCode: { type: String, trim: true },
    name: { type: String, required: true, trim: true },
    nameNormalized: { type: String, trim: true, default: "" },
    industry: { type: String, trim: true, default: "" },
    companySize: { type: String, trim: true, default: "" },
    website: { type: String, trim: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    country: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },
    notes: { type: String, default: "" },
    leadId: { type: Schema.Types.ObjectId, ref: "Lead", default: null },
    contactCount: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    isPrivate: { type: Boolean, default: false },

    // ── Company Account fields (Slice 1) — all optional / defaulted ──
    accountType: { type: String, enum: ACCOUNT_TYPES, default: "corporate" },
    lifecycleStatus: { type: String, enum: LIFECYCLE_STATUSES, default: "prospect" },
    accountTier: { type: String, enum: ACCOUNT_TIERS, default: null },
    accountManagerId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", default: null },
    customerWorkspaceId: { type: String, trim: true, default: null },
  },
  { timestamps: true }
);

CRMCompanySchema.index({ name: 1 });
// Non-unique here (see field comment). Prod carries the unique+partial version.
CRMCompanySchema.index({ nameNormalized: 1 });
CRMCompanySchema.index({ createdBy: 1 });
CRMCompanySchema.index({ leadId: 1 });
CRMCompanySchema.index({ companyCode: 1 }, { unique: true, sparse: true });
CRMCompanySchema.index({ customerId: 1 }, { sparse: true });
CRMCompanySchema.index({ accountManagerId: 1 }, { sparse: true });

// Code half of M8 (docs/crm/PLUMBOX_RISK_REGISTER.md): derive nameNormalized
// from `name` on EVERY save path, so manual creates and renames stop writing
// "" / stale keys. A legacy row still carrying "" is re-keyed on its next save
// (the route checks for a clash first). pre("validate") rather than
// pre("save") so validators see the final value. Gated so the OFF state stays
// byte-for-byte legacy.
// NOTE: findOneAndUpdate paths (resolveOrCreateCompany) bypass document hooks
// and set the key themselves.
CRMCompanySchema.pre("validate", function (next) {
  if (
    isCrmV2FoundationEnabled() &&
    (this.isNew || this.isModified("name") || !this.nameNormalized)
  ) {
    this.nameNormalized = normalizeCompanyName(this.name);
  }
  next();
});

CRMCompanySchema.pre("save", async function (next) {
  if (this.companyCode) return next();
  try {
    const year = new Date().getFullYear();
    const count = await (this.constructor as any).countDocuments({});
    this.companyCode = `COMP-${year}-${String(count + 1).padStart(4, "0")}`;
  } catch {
    // non-blocking — companyCode can be set manually if hook fails
  }
  next();
});

const CRMCompany = mongoose.model<CRMCompanyDoc>("CRMCompany", CRMCompanySchema);
export default CRMCompany;
