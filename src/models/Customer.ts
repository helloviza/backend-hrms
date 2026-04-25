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

    workspaceCode: { type: String, trim: true, default: "" },

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
       ACCOUNT TEAM
       ============================================================ */
    accountTeam: {
      accountManager: {
        userId: { type: Schema.Types.ObjectId, ref: "User" },
        name: { type: String },
        email: { type: String },
        phone: { type: String },
      },
      escalationManager: {
        userId: { type: Schema.Types.ObjectId, ref: "User" },
        name: { type: String },
        email: { type: String },
        phone: { type: String },
      },
      supportContact: {
        userId: { type: Schema.Types.ObjectId, ref: "User" },
        name: { type: String },
        email: { type: String },
        phone: { type: String },
      },
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

    /* ============================================================
       IMPORT METADATA
       ============================================================ */
    zohoContactId: { type: String, trim: true },

    source: { type: String, trim: true },

    importedAt: { type: Date },

    /* ============================================================
       ADDRESS
       ============================================================ */
    address: {
      street: { type: String, trim: true },
      street2: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      country: { type: String, trim: true },
      pincode: { type: String, trim: true },
    },

    /* ============================================================
       ZOHO FIELDS
       ============================================================ */
    firstName: { type: String, trim: true },

    lastName: { type: String, trim: true },

    mobile: { type: String, trim: true },

    gstTreatment: { type: String, trim: true },

    subType: { type: String, trim: true },

    companyName: { type: String, trim: true },

    /* ============================================================
       ZOHO METADATA
       ============================================================ */
    createdTime: { type: Date },

    lastModifiedTime: { type: Date },

    zohoCurrency: { type: String, trim: true },

    zohoNotes: { type: String, trim: true },

    zohoCreatedBy: { type: String, trim: true },

    openingBalance: { type: Number },

    creditLimit: { type: Number },

    portalEnabled: { type: Boolean },

    bankAccountPayment: { type: Boolean },

    priceList: { type: String, trim: true },

    paymentTerms: { type: String, trim: true },

    paymentTermsLabel: { type: String, trim: true },

    ownerName: { type: String, trim: true },

    primaryContactId: { type: String, trim: true },

    contactAddressId: { type: String, trim: true },

    zohoSource: { type: String, trim: true },

    /* ============================================================
       TAX
       ============================================================ */
    taxable: { type: Boolean },

    taxId: { type: String, trim: true },

    taxName: { type: String, trim: true },

    taxPercentage: { type: Number },

    exemptionReason: { type: String, trim: true },

    placeOfContact: { type: String, trim: true },

    placeOfContactWithStateCode: { type: String, trim: true },

    /* ============================================================
       BILLING ADDRESS EXTRAS
       ============================================================ */
    billingAttention: { type: String, trim: true },

    billingPhone: { type: String, trim: true },

    billingFax: { type: String, trim: true },

    billingLatitude: { type: String, trim: true },

    billingLongitude: { type: String, trim: true },

    billingCounty: { type: String, trim: true },

    /* ============================================================
       SHIPPING ADDRESS
       ============================================================ */
    shippingAddress: {
      attention: { type: String, trim: true },
      street: { type: String, trim: true },
      street2: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      country: { type: String, trim: true },
      county: { type: String, trim: true },
      pincode: { type: String, trim: true },
      phone: { type: String, trim: true },
      fax: { type: String, trim: true },
      latitude: { type: String, trim: true },
      longitude: { type: String, trim: true },
    },

    /* ============================================================
       SOCIAL
       ============================================================ */
    skype: { type: String, trim: true },

    facebook: { type: String, trim: true },

    twitter: { type: String, trim: true },

    /* ============================================================
       PROFESSIONAL
       ============================================================ */
    department: { type: String, trim: true },

    designation: { type: String, trim: true },

    salutation: { type: String, trim: true },

    /* ============================================================
       CONTACT DETAILS
       ============================================================ */
    contactName: { type: String, trim: true },

    contactType: { type: String, trim: true },
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
