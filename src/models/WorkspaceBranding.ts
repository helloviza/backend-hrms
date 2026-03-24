import mongoose from "mongoose";

type WorkspaceBrandingDoc = {
  subjectType: "USER" | "CUSTOMER" | "BUSINESS" | "VENDOR";
  subjectId: string;
  logoUrl?: string;
};

const WorkspaceBrandingSchema = new mongoose.Schema<WorkspaceBrandingDoc>(
  {
    subjectType: { type: String, required: true },
    subjectId: { type: String, required: true, index: true },
    logoUrl: { type: String, default: "" },
  },
  { timestamps: true }
);

WorkspaceBrandingSchema.index({ subjectType: 1, subjectId: 1 }, { unique: true });

const WorkspaceBranding =
  mongoose.models.WorkspaceBranding ||
  mongoose.model("WorkspaceBranding", WorkspaceBrandingSchema);

export default WorkspaceBranding;
