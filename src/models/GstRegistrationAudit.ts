// apps/backend/src/models/GstRegistrationAudit.ts
//
// One row per change to a client company's GST registrations
// (Customer.gstRegistrations), written by services/gstRegistrations.ts — the
// only writer. Append-only; never edited.
import { Schema, model } from "mongoose";

export const GST_REGISTRATION_ACTIONS = [
  "ADD",
  "UPDATE",
  "SET_DEFAULT",
  "DEACTIVATE",
  "REACTIVATE",
  "LEGACY_FIELD", // a pre-registrations writer (old form / API) supplied the company GSTIN
  "ONBOARDING", // created from the onboarding form at approval / promote
  "MIGRATED", // scripts/migrate-gst-registrations.ts
] as const;

const GstRegistrationAuditSchema = new Schema(
  {
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    registrationId: { type: Schema.Types.ObjectId },
    gstin: { type: String },
    action: { type: String, enum: GST_REGISTRATION_ACTIONS, required: true },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    actorId: { type: String },
    source: { type: String }, // route / script that made the change
    at: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

export default model("GstRegistrationAudit", GstRegistrationAuditSchema, "gstregistrationaudits");
