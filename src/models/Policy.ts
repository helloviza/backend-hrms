// apps/backend/src/models/Policy.ts
import { Schema, model } from "mongoose";

const PolicySchema = new Schema(
  {
    title: { type: String, required: true, trim: true },

    // For both URL and uploaded file we store a URL-ish string here.
    // For uploaded files this will be something like `/uploads/policies/1234-file.pdf`.
    url: { type: String, required: true, trim: true },

    category: {
      type: String,
      enum: ["TRAVEL", "HR", "GENERAL"],
      default: "GENERAL",
      trim: true,
    },
    tags: [{ type: String, trim: true }],

    // Distinguish between pure URL and uploaded FILE
    kind: {
      type: String,
      enum: ["URL", "FILE"],
      default: "URL",
    },

    // Tenant scoping: GLOBAL = visible to all, ORG = org-specific
    scope: {
      type: String,
      enum: ["GLOBAL", "ORG"],
      default: "GLOBAL",
    },

    // Only set when scope === 'ORG' — the customer/business org this belongs to
    customerId: { type: String, trim: true, index: true },

    // Who can see this policy
    visibility: {
      type: String,
      enum: ["ALL", "CUSTOMER", "VENDOR", "INTERNAL"],
      default: "ALL",
    },

    // S3 / external file URL (when kind === 'FILE')
    fileUrl: { type: String, trim: true },

    // Extra metadata when kind === "FILE"
    fileName: { type: String, trim: true },
    mimeType: { type: String, trim: true },
    size: { type: Number },
    storagePath: { type: String, trim: true }, // usually same as `url` for FILE

    uploadedBy: { type: Schema.Types.ObjectId, ref: "User" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  {
    timestamps: true,
  },
);

export default model("Policy", PolicySchema);
