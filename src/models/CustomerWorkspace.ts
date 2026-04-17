import mongoose, { Schema, type Document, type Model } from "mongoose";

/* ── Feature-flag shape ──────────────────────────────────────────── */
export interface WorkspaceFeatures {
  sbtEnabled: boolean;
  approvalFlowEnabled: boolean;
  approvalDirectEnabled: boolean;
  flightBookingEnabled: boolean;
  hotelBookingEnabled: boolean;
  visaEnabled: boolean;
  miceEnabled: boolean;
  forexEnabled: boolean;
  esimEnabled: boolean;
  payrollEnabled: boolean;
  performanceEnabled: boolean;
  attendanceEnabled: boolean;
  leaveEnabled: boolean;
  onboardingEnabled: boolean;
  analyticsEnabled: boolean;
  expenseBandEnabled: boolean;
}

export type WorkspacePlan = "trial" | "starter" | "growth" | "enterprise";
export type OnboardingStep =
  | "registered"
  | "plan_selected"
  | "workspace_configured"
  | "team_invited"
  | "complete";

export interface CustomerWorkspaceDocument extends Document {
  customerId: string;
  slug?: string;
  phone?: string;
  source?: "SUPERADMIN" | "SELF_SERVICE";

  // Company identity
  companyName: string;
  companyLogo?: string;
  gstNumber?: string;
  pan?: string;
  industry?: string;
  employeeCount?: string;
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    pincode?: string;
    country?: string;
  };

  // Existing (legacy / workspace resolution + invite gating)
  allowedDomains: string[];
  allowedEmails: string[];
  accessMode: "INVITE_ONLY" | "COMPANY_DOMAIN" | "EMAIL_ALLOWLIST";

  defaultApproverEmails: string[];
  canApproverCreateUsers: boolean;
  userCreationEnabled: boolean;

  userCreationAllowlistEmails: string[];
  userCreationAllowlistDomains: string[];
  userCreationAllowlistUpdatedBy: string;
  userCreationAllowlistUpdatedAt?: Date;

  travelMode: "SBT" | "FLIGHTS_ONLY" | "HOTELS_ONLY" | "BOTH" | "APPROVAL_FLOW";

  config: {
    travelFlow: "SBT" | "APPROVAL_FLOW" | "APPROVAL_DIRECT" | "HYBRID";
    approval: {
      requireL2: boolean;
      requireL0: boolean;
      requireProposal: boolean;
    };
    tokenExpiryHours: number;
    features: WorkspaceFeatures;
  };

  // Subscription / billing
  plan: WorkspacePlan;
  planActivatedAt?: Date;
  planExpiresAt?: Date;
  trialEndsAt?: Date;
  razorpaySubscriptionId?: string;

  // Onboarding state machine
  onboardingStep: OnboardingStep;
  onboardingCompletedAt?: Date;

  // Account management
  accountManagerId?: Schema.Types.ObjectId;
  contractStartDate?: Date;
  contractEndDate?: Date;
  notes?: string;

  // Verification
  isEmailVerified: boolean;
  emailVerificationToken?: string;
  emailVerificationExpiry?: Date;

  // Payroll configuration
  payrollConfig?: {
    pfApplicable: boolean;
    pfBasis: string;
    pfCap: number;
    esiApplicable: boolean;
    esiGrossLimit: number;
    ptApplicable: boolean;
    ptState: string;
    payrollCycleDate: number;
    taxRegimeDefault: string;
    lopDeductionEnabled: boolean;
    payslipFooterNote: string;
  };

  // Attendance configuration
  attendanceConfig?: {
    workingDays: string[];
    shiftStart: string;
    shiftEnd: string;
    graceMinutes: number;
    halfDayHours: number;
    minHoursForPresent: number;
  };

  // SBT Official Booking (per-workspace TBO wallet)
  sbtOfficialBooking?: {
    enabled: boolean;
    monthlyLimit: number;
    currentMonthSpend: number;
    lastResetMonth: string;
  };

  // Admin user (set after first user creation during self-service signup)
  adminUserId?: Schema.Types.ObjectId;

  // Legacy orphan flag (migration)
  _isLegacyOrphan?: boolean;

  status: "ACTIVE" | "INACTIVE" | "DELETED";
  createdAt?: Date;
  updatedAt?: Date;
}

/* ── Static methods ──────────────────────────────────────────────── */
export interface CustomerWorkspaceModel extends Model<CustomerWorkspaceDocument> {
  getDefaultFeaturesForPlan(plan: string): Partial<WorkspaceFeatures>;
}

/* ── Schema ──────────────────────────────────────────────────────── */

const CustomerWorkspaceSchema = new Schema<CustomerWorkspaceDocument>(
  {
    customerId: { type: String, required: true, index: true, unique: true },
    slug: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
      trim: true,
      lowercase: true,
    },

    // ── Company identity ──
    companyName: { type: String, trim: true, default: "" },
    companyLogo: { type: String },
    gstNumber: { type: String, trim: true },
    pan: { type: String, trim: true },
    industry: { type: String, trim: true },
    employeeCount: { type: String, trim: true },
    address: {
      line1: { type: String },
      line2: { type: String },
      city: { type: String },
      state: { type: String },
      pincode: { type: String },
      country: { type: String, default: "India" },
    },

    // ── Access gating ──
    allowedDomains: { type: [String], default: [] },
    allowedEmails: { type: [String], default: [] },
    accessMode: {
      type: String,
      enum: ["INVITE_ONLY", "COMPANY_DOMAIN", "EMAIL_ALLOWLIST"],
      default: "INVITE_ONLY",
    },

    defaultApproverEmails: { type: [String], default: [] },
    canApproverCreateUsers: { type: Boolean, default: true },
    userCreationEnabled: { type: Boolean, default: false, index: true },

    userCreationAllowlistEmails: { type: [String], default: [] },
    userCreationAllowlistDomains: { type: [String], default: [] },
    userCreationAllowlistUpdatedBy: { type: String, default: "" },
    userCreationAllowlistUpdatedAt: { type: Date },

    travelMode: {
      type: String,
      enum: ["SBT", "FLIGHTS_ONLY", "HOTELS_ONLY", "BOTH", "APPROVAL_FLOW"],
      default: "APPROVAL_FLOW",
    },

    config: {
      travelFlow: {
        type: String,
        enum: ["SBT", "APPROVAL_FLOW", "APPROVAL_DIRECT", "HYBRID"],
        default: "APPROVAL_FLOW",
      },
      approval: {
        requireL2: { type: Boolean, default: true },
        requireL0: { type: Boolean, default: false },
        requireProposal: { type: Boolean, default: true },
      },
      tokenExpiryHours: { type: Number, default: 12 },
      features: {
        sbtEnabled: { type: Boolean, default: false },
        approvalFlowEnabled: { type: Boolean, default: true },
        approvalDirectEnabled: { type: Boolean, default: false },
        flightBookingEnabled: { type: Boolean, default: false },
        hotelBookingEnabled: { type: Boolean, default: false },
        visaEnabled: { type: Boolean, default: false },
        miceEnabled: { type: Boolean, default: false },
        forexEnabled: { type: Boolean, default: false },
        esimEnabled: { type: Boolean, default: false },
        payrollEnabled: { type: Boolean, default: false },
        performanceEnabled: { type: Boolean, default: false },
        attendanceEnabled: { type: Boolean, default: true },
        leaveEnabled: { type: Boolean, default: true },
        onboardingEnabled: { type: Boolean, default: false },
        analyticsEnabled: { type: Boolean, default: false },
        expenseBandEnabled: { type: Boolean, default: false },
      },
    },

    // ── Subscription / billing ──
    plan: {
      type: String,
      enum: ["trial", "starter", "growth", "enterprise"],
      default: "trial",
    },
    planActivatedAt: { type: Date },
    planExpiresAt: { type: Date },
    trialEndsAt: { type: Date },
    razorpaySubscriptionId: { type: String },

    // ── Onboarding state machine ──
    onboardingStep: {
      type: String,
      enum: ["registered", "plan_selected", "workspace_configured", "team_invited", "complete"],
      default: "registered",
    },
    onboardingCompletedAt: { type: Date },

    // ── Account management ──
    accountManagerId: { type: Schema.Types.ObjectId, ref: "User" },
    contractStartDate: { type: Date },
    contractEndDate: { type: Date },
    notes: { type: String },

    // ── Verification ──
    isEmailVerified: { type: Boolean, default: false },
    emailVerificationToken: { type: String },
    emailVerificationExpiry: { type: Date },

    // ── Payroll configuration ──
    payrollConfig: {
      pfApplicable: { type: Boolean, default: true },
      pfBasis: { type: String, enum: ['CAPPED', 'ACTUAL'], default: 'CAPPED' },
      pfCap: { type: Number, default: 15000 },
      esiApplicable: { type: Boolean, default: true },
      esiGrossLimit: { type: Number, default: 21000 },
      ptApplicable: { type: Boolean, default: true },
      ptState: { type: String, default: 'Karnataka' },
      payrollCycleDate: { type: Number, default: 25 },
      taxRegimeDefault: { type: String, enum: ['OLD', 'NEW'], default: 'NEW' },
      lopDeductionEnabled: { type: Boolean, default: true },
      payslipFooterNote: { type: String, default: '' },
    },

    // ── Attendance configuration ──
    attendanceConfig: {
      workingDays: { type: [String], default: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
      shiftStart: { type: String, default: '09:30' },
      shiftEnd: { type: String, default: '18:30' },
      graceMinutes: { type: Number, default: 15 },
      halfDayHours: { type: Number, default: 4.5 },
      minHoursForPresent: { type: Number, default: 2 },
    },

    // ── SBT Official Booking (per-workspace TBO wallet) ──
    sbtOfficialBooking: {
      enabled: { type: Boolean, default: false },
      monthlyLimit: { type: Number, default: 100000 },
      currentMonthSpend: { type: Number, default: 0 },
      lastResetMonth: { type: String, default: '' },
    },

    phone: { type: String, trim: true, default: "" },
    source: {
      type: String,
      enum: ["SUPERADMIN", "SELF_SERVICE"],
      default: "SUPERADMIN",
    },

    // ── Admin user (set after signup) ──
    adminUserId: { type: Schema.Types.ObjectId, ref: "User" },

    // ── Migration flag ──
    _isLegacyOrphan: { type: Boolean },

    status: { type: String, default: "ACTIVE", index: true },
  },
  { timestamps: true },
);

/* ── Plan-to-features mapping ────────────────────────────────────── */

CustomerWorkspaceSchema.statics.getDefaultFeaturesForPlan = (
  plan: string,
): Partial<WorkspaceFeatures> => {
  const base: Partial<WorkspaceFeatures> = {
    approvalFlowEnabled: true,
    attendanceEnabled: true,
    leaveEnabled: true,
  };
  const plans: Record<string, Partial<WorkspaceFeatures>> = {
    trial: { ...base },
    starter: {
      ...base,
      sbtEnabled: true,
      flightBookingEnabled: true,
      hotelBookingEnabled: true,
    },
    growth: {
      ...base,
      sbtEnabled: true,
      flightBookingEnabled: true,
      hotelBookingEnabled: true,
      payrollEnabled: true,
      performanceEnabled: true,
      analyticsEnabled: true,
    },
    enterprise: {
      ...base,
      sbtEnabled: true,
      flightBookingEnabled: true,
      hotelBookingEnabled: true,
      payrollEnabled: true,
      performanceEnabled: true,
      analyticsEnabled: true,
      visaEnabled: true,
      miceEnabled: true,
      forexEnabled: true,
      onboardingEnabled: true,
      esimEnabled: true,
    },
  };
  return plans[plan] || plans.trial;
};

const CustomerWorkspace: CustomerWorkspaceModel =
  (mongoose.models.CustomerWorkspace as CustomerWorkspaceModel) ||
  mongoose.model<CustomerWorkspaceDocument, CustomerWorkspaceModel>(
    "CustomerWorkspace",
    CustomerWorkspaceSchema,
  );

export default CustomerWorkspace;
