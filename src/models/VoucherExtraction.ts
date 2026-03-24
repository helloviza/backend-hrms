// apps/backend/src/models/VoucherExtraction.ts
import mongoose, { Schema } from "mongoose";

export type VoucherStatus = "PROCESSING" | "SUCCESS" | "FAILED";

/**
 * S3 object pointer
 * - bucket/key = source of truth for signed URL generation
 * - url = optional public/console url captured at upload time (not necessarily signed)
 */
const S3Schema = new Schema(
  {
    bucket: { type: String, required: true },
    key: { type: String, required: true },
    url: { type: String, required: true },
  },
  { _id: false }
);

const FileSchema = new Schema(
  {
    originalName: { type: String, required: true },
    mime: { type: String, required: true },
    size: { type: Number, required: true },
  },
  { _id: false }
);

const VoucherExtractionSchema = new Schema(
  {
    customerId: { type: String, required: true, index: true },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    /**
     * ✅ Uploaded source file (what user uploaded)
     */
    s3: { type: S3Schema, required: true },
    file: { type: FileSchema, required: true },

    docType: {
      type: String,
      enum: ["hotel", "flight"],
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["PROCESSING", "SUCCESS", "FAILED"],
      default: "PROCESSING",
      index: true,
    },

    // Keep undefined when empty (cleaner than null)
    error: { type: String, default: undefined },

    // Final normalized voucher (schema-safe)
    extractedJson: { type: Schema.Types.Mixed, default: undefined },

    // Raw model output + debug snippets (may be large)
    rawModelResponse: { type: Schema.Types.Mixed, default: undefined },

    // Structured debug (stage, missing fields, timings, etc.)
    errorDetails: { type: Schema.Types.Mixed, default: undefined },

    // Optional analytics metadata (does not break existing routes)
    meta: { type: Schema.Types.Mixed, default: undefined },

    /**
     * ✅ Regenerated PDF artifact (NEW)
     * This is the thing you want to "Open Rendered PDF"
     */
    renderedS3: { type: S3Schema, default: undefined },

    /**
     * Render tracking (NEW)
     * - renderedAt/renderedBy: audit trail
     * - renderedTemplateVersion: tracks PDF template ("v1", "v2"...)
     * - renderedRevision: increments on every render/re-render
     * - renderError: rendering failures should NOT flip extraction to FAILED
     */
    renderedAt: { type: Date, default: undefined },
    renderedBy: { type: Schema.Types.ObjectId, ref: "User", default: undefined },

    renderedTemplateVersion: { type: String, default: "v1" },
    renderedRevision: { type: Number, default: 0 }, // 0 = never rendered, 1..n = render attempts
    renderError: { type: String, default: undefined },

    correctedBy: { type: Schema.Types.ObjectId, ref: "User", default: undefined },
    correctedAt: { type: Date, default: undefined },
  },
  { timestamps: true }
);

// Helpful compound index for listing + filtering
VoucherExtractionSchema.index({ customerId: 1, createdAt: -1 });
VoucherExtractionSchema.index({
  customerId: 1,
  docType: 1,
  status: 1,
  createdAt: -1,
});

// For admins auditing rendered vs non-rendered
VoucherExtractionSchema.index({ customerId: 1, renderedAt: -1 });

export default mongoose.model("VoucherExtraction", VoucherExtractionSchema);