// apps/backend/src/models/User.ts
import { Schema, model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

const UserSchema = new Schema(
  {
    /* -------------------------------------------------------------- */
    /* Core auth / identity                                           */
    /* -------------------------------------------------------------- */
    email: {
      type: String,
      unique: true,
      required: true,
      lowercase: true,
      trim: true,
    },
    officialEmail: { type: String, trim: true }, // company email alias

    // ✅ Workspace linkage (multi-tenancy)
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    customerId: { type: String, trim: true, index: true }, // legacy — kept for migration
    businessId: { type: String, trim: true, index: true }, // legacy alias
    vendorId: { type: String, trim: true, index: true },

    // ✅ helpful normalized identity fields (optional but safe)
    accountType: { type: String, trim: true }, // CUSTOMER | VENDOR | EMPLOYEE
    userType: { type: String, trim: true }, // same as accountType in some modules

    /**
     * ✅ AWS S3 only: source-of-truth avatar object key
     * Example: avatars/<tenantId>/<userId>/<timestamp>-<rand>-file.png
     */
    avatarKey: { type: String, trim: true, default: "" },

    /**
     * ✅ Optional: when avatarKey last changed (useful for audit + cache bust)
     */
    avatarUpdatedAt: { type: Date },

    /**
     * Legacy field (DO NOT STORE SIGNED URLS HERE).
     * Kept to avoid breaking older code that may read avatarUrl from user documents.
     * New system must always compute signed url at runtime.
     */
    avatarUrl: { type: String, trim: true, default: "" },

    personalEmail: { type: String, trim: true },

    phone: { type: String, trim: true },
    personalContact: { type: String, trim: true }, // personal mobile

    passwordHash: { type: String, required: true },

    resetTokenHash:   { type: String },
    resetTokenExpiry: { type: Date },

    name: { type: String, trim: true },
    firstName: { type: String, trim: true },
    middleName: { type: String, trim: true },
    lastName: { type: String, trim: true },

    status: { type: String, trim: true, default: "ACTIVE" },

    /* -------------------------------------------------------------- */
    /* HR structure / roles                                           */
    /* -------------------------------------------------------------- */
    department: { type: String, trim: true },
    designation: { type: String, trim: true },

    roles: {
      type: [String],
      default: ["EMPLOYEE"],
      set: (arr: string[]) => {
        if (!Array.isArray(arr) || arr.length === 0) return ["EMPLOYEE"];
        return arr.map((r) => String(r).toUpperCase());
      },
    },

    role: { type: String, trim: true }, // primary role (filled in toJSON)

    hrmsAccessRole: { type: String, trim: true, default: "EMPLOYEE" },
    hrmsAccessLevel: { type: String, trim: true, default: "EMPLOYEE" },

    employeeCode: { type: String, trim: true, index: true },
    employeeType: { type: String, trim: true }, // Permanent / Contract / etc.
    employmentStatus: { type: String, trim: true }, // Active / Resigned / etc.
    jobLocation: { type: String, trim: true },

    reportingL1: { type: String, trim: true },
    reportingL2: { type: String, trim: true },
    reportingL3: { type: String, trim: true },
    managerName: { type: String, trim: true },

    managerId: { type: Schema.Types.ObjectId, ref: "User" },
    hrOwnerId: { type: Schema.Types.ObjectId, ref: "User" },

    /* -------------------------------------------------------------- */
    /* Personal & contact details (TeamProfiles – Personal tab)       */
    /* -------------------------------------------------------------- */
    dateOfBirth: { type: String, trim: true }, // keep as string (yyyy-mm-dd)
    gender: { type: String, trim: true },
    maritalStatus: { type: String, trim: true },
    nationality: { type: String, trim: true },
    bloodGroup: { type: String, trim: true },

    permanentAddress: { type: String, trim: true },
    currentAddress: { type: String, trim: true },

    emergencyContactName: { type: String, trim: true },
    emergencyContactNumber: { type: String, trim: true },
    emergencyContactRelation: { type: String, trim: true },

    // Old photo field (kept for backward compatibility / other uses)
    photoUrl: { type: String, trim: true },

    pan: { type: String, trim: true },
    aadhaar: { type: String, trim: true },
    passportNumber: { type: String, trim: true },
    passportExpiry: { type: String, trim: true },
    voterId: { type: String, trim: true },
    disabilityStatus: { type: String, trim: true },

    /* -------------------------------------------------------------- */
    /* Employment details (TeamProfiles – Employment tab)             */
    /* -------------------------------------------------------------- */
    dateOfJoining: { type: String, trim: true },
    dateOfConfirmation: { type: String, trim: true },

    shiftDetails: { type: String, trim: true },
    probationPeriod: { type: String, trim: true },
    contractStartDate: { type: String, trim: true },
    contractEndDate: { type: String, trim: true },
    exitDate: { type: String, trim: true },
    exitReason: { type: String, trim: true },
    supervisorDetails: { type: String, trim: true },

    /* -------------------------------------------------------------- */
    /* Compensation & payroll (TeamProfiles – Compensation tab)       */
    /* -------------------------------------------------------------- */
    salaryStructure: { type: String, trim: true },
    payGrade: { type: String, trim: true },
    ctc: { type: Number },

    bankName: { type: String, trim: true },
    bankAccountNumber: { type: String, trim: true },
    bankIfsc: { type: String, trim: true },

    taxPan: { type: String, trim: true },
    tanOrTdsDetails: { type: String, trim: true },
    pfNumber: { type: String, trim: true },
    esiNumber: { type: String, trim: true },
    professionalTaxNumber: { type: String, trim: true },

    salaryPaymentMode: { type: String, trim: true },
    salaryComponents: { type: String, trim: true },
    payrollCycle: { type: String, trim: true },
    bonusDetails: { type: String, trim: true },
    overtimeDetails: { type: String, trim: true },
    leaveEncashmentPolicy: { type: String, trim: true },
    deductions: { type: String, trim: true },
    investmentDeclarationsLegacy: { type: String, trim: true },
    investmentDeclarations: {
      section80C: { type: Number, default: 0 },
      section80D: { type: Number, default: 0 },
      section80CCD1B: { type: Number, default: 0 },
      hra: { type: Number, default: 0 },
      lta: { type: Number, default: 0 },
      homeLoanInterest: { type: Number, default: 0 },
      otherDeductions: { type: Number, default: 0 },
      parentsHealthInsurance: { type: Number, default: 0 },
      parentsAreSenior: { type: Boolean, default: false },
      educationLoanInterest: { type: Number, default: 0 },
      savingsInterest: { type: Number, default: 0 },
      ltaClaimedThisYear: { type: Number, default: 0 },
      donations: [
        {
          organizationName: { type: String, trim: true },
          amount: { type: Number, default: 0 },
          deductionPercent: { type: Number, default: 50 },
        },
      ],
    },
    uanNumber: { type: String },
    salaryEffectiveDate: { type: Date },
    taxRegimePreference: { type: String, enum: ['OLD', 'NEW'], default: 'NEW' },
    taxFormRecords: { type: String, trim: true },

    /* -------------------------------------------------------------- */
    /* Attendance & leave (TeamProfiles – Attendance tab)             */
    /* -------------------------------------------------------------- */
    attendanceNotes: { type: String, trim: true },
    leaveEntitlements: { type: String, trim: true },
    leaveHistoryNotes: { type: String, trim: true },
    wfhRecords: { type: String, trim: true },
    shiftPatterns: { type: String, trim: true },
    timesheetDetails: { type: String, trim: true },
    holidayCalendarReference: { type: String, trim: true },

    /* -------------------------------------------------------------- */
    /* Learning / performance / compliance (Learning tab)             */
    /* -------------------------------------------------------------- */
    educationalQualifications: { type: String, trim: true },
    professionalCertifications: { type: String, trim: true },
    trainingHistory: { type: String, trim: true },
    skills: { type: String, trim: true },
    performanceAppraisals: { type: String, trim: true },
    promotionsTransfers: { type: String, trim: true },
    disciplinaryRecords: { type: String, trim: true },
    rewardsRecognition: { type: String, trim: true },
    employmentContracts: { type: String, trim: true },
    ndaOrNonCompete: { type: String, trim: true },
    backgroundVerification: { type: String, trim: true },
    medicalHealthRecords: { type: String, trim: true },
    workPermits: { type: String, trim: true },
    legalNotices: { type: String, trim: true },

    /* -------------------------------------------------------------- */
    /* Assets / notes / misc (Assets tab)                             */
    /* -------------------------------------------------------------- */
    companyAssets: { type: String, trim: true },
    assetReturnRecords: { type: String, trim: true },
    employeeNotes: { type: String, trim: true },
    portalAccessDetails: { type: String, trim: true },
    bankLoanDetails: { type: String, trim: true },
    travelExpenseRecords: { type: String, trim: true },
    exitInterviewDetails: { type: String, trim: true },
    documentRepository: { type: String, trim: true },

    /* -------------------------------------------------------------- */
    /* Old address block (keep for backward compatibility)            */
    /* -------------------------------------------------------------- */
    address: {
      line1: { type: String, trim: true },
      line2: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      zip: { type: String, trim: true },
      country: { type: String, trim: true },
    },

    /* -------------------------------------------------------------- */
    /* Access activation                                              */
    /* -------------------------------------------------------------- */
    tempPassword: { type: Boolean, default: false },
    activatedByAdmin: { type: Boolean, default: false },
    activatedAt: { type: Date },
    sbtEnabled: { type: Boolean, default: false },
    sbtBookingType: { type: String, enum: ["flight", "hotel", "both"], default: "both" },
    sbtRole: { type: String, enum: ["L1", "L2", "BOTH"], default: null },
    bandNumber: { type: Number, default: null, min: 1, max: 10 },
    sbtAssignedBookerId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    canRaiseRequest: { type: Boolean, default: true },
    canViewBilling: { type: Boolean, default: false },
    canManageUsers: { type: Boolean, default: false },

    /* -------------------------------------------------------------- */
    /* Onboarding linkage                                             */
    /* -------------------------------------------------------------- */
    onboardingId: { type: Schema.Types.ObjectId, ref: "Onboarding" },
    onboardingSnapshot: { type: Schema.Types.Mixed },

    /* -------------------------------------------------------------- */
    /* Simple documents array                                         */
    /* -------------------------------------------------------------- */
    documents: [
      {
        key: { type: String, trim: true }, // machine key -> "AADHAAR", "PAN"
        name: { type: String, trim: true }, // user-facing name
      },
    ],

    lastSeenAt: { type: Date, default: null },

    createdAt: { type: Date, default: Date.now },
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

UserSchema.plugin(workspaceScopePlugin);
UserSchema.index({ workspaceId: 1, email: 1 }, { unique: true });

// Virtual: fullName
UserSchema.virtual("fullName").get(function () {
  const fn = (this as any).firstName || "";
  const ln = (this as any).lastName || "";
  return `${fn} ${ln}`.trim();
});

// Always send uppercase roles + a single `role` for convenience
UserSchema.methods.toJSON = function () {
  const obj: any = this.toObject();

  if (Array.isArray(obj.roles) && obj.roles.length) {
    obj.roles = obj.roles.map((r: string) => String(r).toUpperCase());
    obj.role = obj.roles[0];
  } else {
    obj.roles = ["EMPLOYEE"];
    obj.role = "EMPLOYEE";
  }

  // never leak password
  delete obj.passwordHash;
  return obj;
};

export default model("User", UserSchema);
