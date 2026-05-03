import mongoose, { Document, Schema } from "mongoose";

export interface CRMContactDoc extends Document {
  contactCode: string;
  firstName: string;
  lastName: string;
  jobTitle: string;
  phone: string;
  phone2: string;
  email: string;
  whatsapp: string;
  companyId?: mongoose.Types.ObjectId | null;
  companyName: string;
  linkedin: string;
  facebook: string;
  instagram: string;
  twitter: string;
  address: string;
  city: string;
  state: string;
  country: string;
  pincode: string;
  source: string;
  tags: string[];
  status: "active" | "inactive" | "do_not_contact";
  notes: string;
  avatarUrl: string;
  leadId?: mongoose.Types.ObjectId | null;
  assignedTo?: mongoose.Types.ObjectId | null;
  createdBy: mongoose.Types.ObjectId;
  isPrivate: boolean;
  visibleTo: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const CRMContactSchema = new Schema<CRMContactDoc>(
  {
    contactCode: { type: String, trim: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, trim: true, default: "" },
    jobTitle: { type: String, trim: true, default: "" },
    phone: { type: String, required: true, trim: true },
    phone2: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },
    whatsapp: { type: String, trim: true, default: "" },
    companyId: { type: Schema.Types.ObjectId, ref: "CRMCompany", default: null },
    companyName: { type: String, trim: true, default: "" },
    linkedin: { type: String, trim: true, default: "" },
    facebook: { type: String, trim: true, default: "" },
    instagram: { type: String, trim: true, default: "" },
    twitter: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    country: { type: String, trim: true, default: "" },
    pincode: { type: String, trim: true, default: "" },
    source: { type: String, trim: true, default: "manual" },
    tags: { type: [String], default: [] },
    status: {
      type: String,
      enum: ["active", "inactive", "do_not_contact"],
      default: "active",
    },
    notes: { type: String, default: "" },
    avatarUrl: { type: String, default: "" },
    leadId: { type: Schema.Types.ObjectId, ref: "Lead", default: null },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    isPrivate: { type: Boolean, default: false },
    visibleTo: { type: [Schema.Types.ObjectId], ref: "User", default: [] },
  },
  { timestamps: true }
);

CRMContactSchema.index({ phone: 1 });
CRMContactSchema.index({ email: 1 });
CRMContactSchema.index({ companyId: 1 });
CRMContactSchema.index({ assignedTo: 1 });
CRMContactSchema.index({ createdBy: 1 });
CRMContactSchema.index({ leadId: 1 });
CRMContactSchema.index({ contactCode: 1 }, { unique: true, sparse: true });

CRMContactSchema.pre("save", async function (next) {
  if (this.contactCode) return next();
  try {
    const year = new Date().getFullYear();
    const count = await (this.constructor as any).countDocuments({});
    this.contactCode = `CONT-${year}-${String(count + 1).padStart(4, "0")}`;
  } catch {
    // non-blocking — contactCode can be set manually if hook fails
  }
  next();
});

const CRMContact = mongoose.model<CRMContactDoc>("CRMContact", CRMContactSchema);
export default CRMContact;
