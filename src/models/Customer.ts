import { Schema, model } from "mongoose";

const CustomerSchema = new Schema(
  {
    /* ============================================================
       CORE IDENTITY
       ============================================================ */
    name: { type: String, trim: true },

    legalName: { type: String, trim: true },

    customerCode: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      index: true,
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
    },

    phone: { type: String, trim: true },

    type: {
      type: String,
      default: "CUSTOMER",
      set: (v: string) => String(v || "CUSTOMER").toUpperCase(),
    },

    status: {
      type: String,
      enum: ["ACTIVE", "INACTIVE"],
      default: "ACTIVE",
      set: (v: string) => String(v || "ACTIVE").toUpperCase(),
    },

    segment: { type: String, trim: true },

    industry: { type: String, trim: true },

    website: { type: String, trim: true },

    /* ============================================================
       BUSINESS / LEGAL DETAILS
       ============================================================ */
    gstNumber: { type: String, trim: true },

    panNumber: { type: String, trim: true },

    entityType: { type: String, trim: true },

    incorporationDate: { type: Date },

    employeesCount: { type: String, trim: true },

    description: { type: String, trim: true },

    /* ============================================================
       ADDRESSES
       ============================================================ */
    registeredAddress: { type: String, trim: true },

    operationalAddress: { type: String, trim: true },

    /* ============================================================
       BANKING & CONTACTS
       ============================================================ */
    bank: {
      type: Schema.Types.Mixed, // accountNumber, ifsc, bankName, branch
    },

    contacts: {
      type: Schema.Types.Mixed, // primaryPhone, officialEmail
    },

    keyContacts: {
      type: [Schema.Types.Mixed],
      default: [],
    },

    /* ============================================================
       ONBOARDING LINKAGE
       ============================================================ */
    onboardingId: { type: Schema.Types.ObjectId, ref: "Onboarding" },

    onboardingSnapshot: {
      type: Schema.Types.Mixed, // FULL formPayload snapshot
    },

    ownerId: { type: Schema.Types.ObjectId, ref: "User", index: true },

    /* ============================================================
       WHITELISTING & ACCESS CONTROL (UNCHANGED)
       ============================================================ */
    whitelistEnabled: { type: Boolean, default: true },

    allowedDomains: {
      type: [String],
      default: [],
      set: (arr: any[]) =>
        (Array.isArray(arr) ? arr : [])
          .map((d) =>
            String(d || "")
              .trim()
              .toLowerCase()
              .replace(/^@/, ""),
          )
          .filter(Boolean),
      index: true,
    },

    allowedEmails: {
      type: [String],
      default: [],
      set: (arr: any[]) =>
        (Array.isArray(arr) ? arr : [])
          .map((e) => String(e || "").trim().toLowerCase())
          .filter(Boolean),
      index: true,
    },

    approverEmails: {
      type: [String],
      default: [],
      set: (arr: any[]) =>
        (Array.isArray(arr) ? arr : [])
          .map((e) => String(e || "").trim().toLowerCase())
          .filter(Boolean),
    },

    approverUserIds: {
      type: [Schema.Types.ObjectId],
      ref: "User",
      default: [],
    },

    adminEmails: {
      type: [String],
      default: [],
      set: (arr: any[]) =>
        (Array.isArray(arr) ? arr : [])
          .map((e) => String(e || "").trim().toLowerCase())
          .filter(Boolean),
    },

    adminUserIds: {
      type: [Schema.Types.ObjectId],
      ref: "User",
      default: [],
    },

    allowSubUsers: { type: Boolean, default: true },

    allowedSubUserRoles: {
      type: [String],
      default: ["CUSTOMER_L1", "CUSTOMER_APPROVER"],
      set: (arr: any[]) =>
        (Array.isArray(arr) ? arr : [])
          .map((r) => String(r || "").trim().toUpperCase())
          .filter(Boolean),
    },
  },
  { timestamps: true }
);

CustomerSchema.methods.toJSON = function () {
  const obj: any = this.toObject();
  if (obj.type) obj.type = String(obj.type).toUpperCase();
  if (obj.status) obj.status = String(obj.status).toUpperCase();
  return obj;
};

export default model("Customer", CustomerSchema);
