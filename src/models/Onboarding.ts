// apps/backend/src/models/Onboarding.ts
import mongoose, { Schema, InferSchemaType } from "mongoose";

export type OnboardingType = "vendor" | "business" | "employee";
export type OnboardingStatus =
  | "sent"
  | "started"
  | "submitted"
  | "verified"
  | "rejected"
  | "approved"
  | "expired";

/* ---------- Embedded subdocument schema for uploaded files ---------- */
const DocumentSchema = new Schema(
  {
    name: { type: String, required: true },
    key: { type: String, required: true }, // S3 key
    mime: { type: String },
    size: { type: Number },
    kind: { type: String }, // gst/pan/etc.
    url: { type: String }, // resolved link for admin view
  },
  { _id: false }
);

/* ---------- Main Onboarding schema ---------- */
const OnboardingSchema = new Schema(
  {
    type: {
      type: String,
      enum: ["vendor", "business", "employee"],
      required: true,
      index: true,
    },
    email: { type: String, required: true, index: true },
    inviteeName: { type: String },
    token: { type: String, required: true, unique: true }, // ✅ only unique, no extra index

    turnaroundHours: { type: Number, default: 72 },
    expiresAt: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: [
        "sent",
        "started",
        "submitted",
        "verified",
        "rejected",
        "approved",
        "expired",
      ],
      default: "sent",
      index: true,
    },

    startedAt: { type: Date },
    submittedAt: { type: Date },
    verifiedAt: { type: Date },

    documents: { type: [DocumentSchema], default: [] },

    formPayload: { type: Schema.Types.Mixed, default: {} },
    extras_json: { type: Schema.Types.Mixed, default: {} },

    ticket: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

/* ---------- Helpful compound indexes ---------- */
OnboardingSchema.index({ email: 1, type: 1, status: 1 });
OnboardingSchema.index({ createdAt: -1 }); // ✅ keep these only once

/* ---------- Debug log (only once) ---------- */
if (!mongoose.models.Onboarding) {
  console.log(
    "[Onboarding] Schema fields loaded:",
    Object.keys(OnboardingSchema.paths)
  );
}

/* ---------- Types ---------- */
export type OnboardingDoc = InferSchemaType<typeof OnboardingSchema> & {
  _id: mongoose.Types.ObjectId;
};

/* ---------- Model export ---------- */
export const Onboarding = (mongoose.models.Onboarding ||
  mongoose.model<OnboardingDoc>("Onboarding", OnboardingSchema)) as mongoose.Model<OnboardingDoc>;

export default Onboarding;
