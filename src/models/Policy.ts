// apps/backend/src/models/Policy.ts
import { Schema, model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

const PolicySchema = new Schema(
  {
    title: { type: String, required: true, trim: true },

    // Legacy field: for URL-kind policies this holds the external link.
    // For pre-S3 FILE uploads it held `/uploads/policies/...`. New FILE
    // uploads leave this undefined and use the `s3` sub-doc below instead.
    url: { type: String, trim: true },

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
      enum: ["GLOBAL", "ORG", "WORKSPACE"],
      default: "GLOBAL",
    },

    // Multi-tenant workspace scope
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    // Legacy — kept for migration
    customerId: { type: String, trim: true, index: true },

    // Who can see this policy
    visibility: {
      type: String,
      enum: ["ALL", "CUSTOMER", "VENDOR", "INTERNAL"],
      default: "ALL",
    },

    // Legacy fields kept for back-compat with pre-S3 FILE uploads. New
    // uploads do NOT populate these — they use `s3` below.
    fileUrl: { type: String, trim: true },
    storagePath: { type: String, trim: true },

    // Canonical S3 location for new FILE uploads (voucher pattern).
    // Both subfields optional so legacy docs (no s3) still load fine.
    s3: {
      bucket: { type: String, trim: true },
      key: { type: String, trim: true },
    },

    // Extra metadata when kind === "FILE"
    fileName: { type: String, trim: true },
    mimeType: { type: String, trim: true },
    size: { type: Number },

    uploadedBy: { type: Schema.Types.ObjectId, ref: "User" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  {
    timestamps: true,
  },
);
PolicySchema.plugin(workspaceScopePlugin);
PolicySchema.index({ workspaceId: 1, type: 1 });

export default model("Policy", PolicySchema);
