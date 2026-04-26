import mongoose, { Document, Schema } from "mongoose";

export interface CRMCompanyDoc extends Document {
  companyCode: string;
  name: string;
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
  createdAt: Date;
  updatedAt: Date;
}

const CRMCompanySchema = new Schema<CRMCompanyDoc>(
  {
    companyCode: { type: String, trim: true },
    name: { type: String, required: true, trim: true },
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
  },
  { timestamps: true }
);

CRMCompanySchema.index({ name: 1 });
CRMCompanySchema.index({ createdBy: 1 });
CRMCompanySchema.index({ leadId: 1 });
CRMCompanySchema.index({ companyCode: 1 }, { unique: true, sparse: true });

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
