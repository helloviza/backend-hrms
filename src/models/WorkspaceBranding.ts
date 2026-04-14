import mongoose from "mongoose";

type WorkspaceBrandingDoc = {
  subjectType: "USER" | "CUSTOMER" | "BUSINESS" | "VENDOR";
  subjectId: string;
  logoKey?: string;
  logoUrl?: string;
};

const WorkspaceBrandingSchema = new mongoose.Schema<WorkspaceBrandingDoc>(
  {
    subjectType: { type: String, required: true },
    subjectId: { type: String, required: true, index: true },
    logoKey: { type: String, default: "" },
    logoUrl: { type: String, default: "" },
  },
  { timestamps: true }
);

WorkspaceBrandingSchema.index({ subjectType: 1, subjectId: 1 }, { unique: true });

const WorkspaceBranding = (
  mongoose.models.WorkspaceBranding ||
  mongoose.model<WorkspaceBrandingDoc>("WorkspaceBranding", WorkspaceBrandingSchema)
) as mongoose.Model<WorkspaceBrandingDoc>;

export default WorkspaceBranding;
