// apps/backend/src/models/MasterData.ts
import mongoose, { Schema, type Document, type Model, type CallbackError } from "mongoose";

export interface MasterDataDocument extends Document {
  type: string;

  name?: string;
  inviteeName?: string;
  fullName?: string;
  contactName?: string;
  businessName?: string;
  companyName?: string;
  title?: string;

  email?: string;
  officialEmail?: string;
  personalEmail?: string;

  website?: string;
  officialWebsite?: string;
  domain?: string;

  status?: string;
  isActive?: boolean;

  token?: string;
  submittedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;

  // allow extra dynamic fields from onboarding payload
  [key: string]: any;
}

const MasterDataSchema = new Schema<MasterDataDocument>(
  {
    type: { type: String, required: true, index: true }, // "Vendor", "Business", "Customer", etc.

    name: { type: String },
    inviteeName: { type: String },
    fullName: { type: String },
    contactName: { type: String },
    businessName: { type: String },
    companyName: { type: String },
    title: { type: String },

    email: { type: String, index: true },
    officialEmail: { type: String, index: true },
    personalEmail: { type: String, index: true },

    website: { type: String },
    officialWebsite: { type: String },
    domain: { type: String, index: true },

    status: { type: String, default: "Active", index: true },
    isActive: { type: Boolean, default: true, index: true },

    token: { type: String, index: true },
    submittedAt: { type: Date },
  },
  {
    timestamps: true, // adds createdAt / updatedAt
    strict: false, // allow arbitrary onboarding fields
  }
);

/* ------------------------------------------------------------
 * Indexes (safe + helps search/resolve)
 * ---------------------------------------------------------- */
MasterDataSchema.index({ type: 1, email: 1 });
MasterDataSchema.index({ type: 1, officialEmail: 1 });
MasterDataSchema.index({ type: 1, personalEmail: 1 });
MasterDataSchema.index({ type: 1, domain: 1 });

/* ------------------------------------------------------------
 * Normalizers (typed)
 * ---------------------------------------------------------- */
function normEmail(v: unknown): string {
  return String(v || "").trim().toLowerCase();
}

function normalizeDomain(input: unknown): string {
  let s = String(input ?? "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.replace(/\/.*$/, "");
  s = s.replace(/^@/, "");
  return s.trim();
}

MasterDataSchema.pre<MasterDataDocument>("save", function (next: (err?: CallbackError) => void) {
  try {
    if (this.email) this.email = normEmail(this.email);
    if (this.officialEmail) this.officialEmail = normEmail(this.officialEmail);
    if (this.personalEmail) this.personalEmail = normEmail(this.personalEmail);

    // If domain not explicitly set, derive from best-known email
    if (this.domain) {
      this.domain = normalizeDomain(this.domain);
    } else {
      const e = this.officialEmail || this.email || this.personalEmail || "";
      const at = String(e).lastIndexOf("@");
      if (at >= 0) this.domain = normalizeDomain(String(e).slice(at + 1));
    }

    next();
  } catch (err) {
    next(err as any);
  }
});

// Avoid model overwrite in dev hot-reload
const MasterData: Model<MasterDataDocument> =
  mongoose.models.MasterData || mongoose.model<MasterDataDocument>("MasterData", MasterDataSchema);

export default MasterData;
