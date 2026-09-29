// apps/backend/src/models/Onboarding.ts
import mongoose, { Schema, InferSchemaType } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

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
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
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

    // Distinguishes an emailed onboarding invite from a manually-created master
    // record. Intentionally NOT required and with NO default, so pre-existing
    // docs (which have neither) remain valid — no migration needed.
    source: {
      type: String,
      enum: ["invite", "manual"],
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

    // Everything below was already written by the routes but silently
    // dropped (strict schema) until 2026-09-29 — e.g. welcomeEmailSent never
    // stuck, so approval AND promote both sent the welcome email.
    name: { type: String, trim: true }, // company / employee name set at submit
    photoKey: { type: String }, // employee photo, copied to the User on sync
    remarks: { type: String }, // admin's approve/reject note
    isActive: { type: Boolean }, // Master Data active/inactive; absent = active
    welcomeEmailSent: { type: Boolean },

    // What the onboarding became on promote.
    linkedCustomerId: { type: Schema.Types.ObjectId, ref: "Customer" },
    customerCode: { type: String },
    linkedUserId: { type: Schema.Types.ObjectId, ref: "User" },
    employeeCode: { type: String },
    linkedVendorId: { type: Schema.Types.ObjectId, ref: "Vendor" },
    vendorCode: { type: String },
  },
  { timestamps: true }
);

OnboardingSchema.plugin(workspaceScopePlugin);

/* ---------- Helpful compound indexes ---------- */
OnboardingSchema.index({ workspaceId: 1, employeeId: 1 });
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
