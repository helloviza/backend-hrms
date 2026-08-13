// apps/backend/src/models/cstep/CstepAttachment.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepAttachment
 * ---------------
 * CSTEP Travel & Claim Portal — an uploaded supporting document. Stores only
 * the S3 key (never a URL) — same pattern as Expense.imageKey; the URL is
 * presigned on read via utils/s3Presign.ts.
 *
 * Tenant isolation reuses the standard workspaceScopePlugin, same as
 * Expense.ts.
 */

export type CstepDocumentType =
  | "BOARDING_PASS"
  | "ETICKET"
  | "HOTEL_FOLIO"
  | "CAB_RECEIPT"
  | "TAX_INVOICE"
  | "FOREX_RECEIPT"
  | "OTHER";

export interface ICstepAttachment extends Document {
  workspaceId: mongoose.Types.ObjectId;
  // Optional — a CstepClaim only exists for an approved TOUR_PROPOSAL (see
  // routes/cstep.ts's approve handler); an EVENT_REQUEST never gets one, so
  // Step 4 Travel Report attachments (which can belong to either formType)
  // can't always set this. travelRequestId (below) is the reference that's
  // always available for those.
  claimId?: mongoose.Types.ObjectId; // ref CstepClaim
  // Step 4 Travel Report addition — set when this attachment was uploaded
  // for a CstepReportLeg, alongside claimId when one exists. Optional so
  // pre-existing (future Phase 2 claim-expense) attachments are unaffected.
  travelRequestId?: mongoose.Types.ObjectId; // ref CstepTravelRequest

  s3Key: string;
  originalName?: string;
  mime?: string;

  documentType: CstepDocumentType;

  ocrPayload?: any;
  ocrConfidence?: number;
  reviewedBy?: mongoose.Types.ObjectId; // ref User
  reviewedAt?: string; // ISO string, not Date — see module note

  createdBy: mongoose.Types.ObjectId; // ref User

  createdAt: Date;
  updatedAt: Date;
}

const CstepAttachmentSchema = new Schema<ICstepAttachment>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    claimId: { type: Schema.Types.ObjectId, ref: "CstepClaim", index: true },
    travelRequestId: { type: Schema.Types.ObjectId, ref: "CstepTravelRequest", index: true },

    s3Key: { type: String, required: true, trim: true },
    originalName: { type: String, trim: true },
    mime: { type: String, trim: true },

    documentType: {
      type: String,
      enum: ["BOARDING_PASS", "ETICKET", "HOTEL_FOLIO", "CAB_RECEIPT", "TAX_INVOICE", "FOREX_RECEIPT", "OTHER"],
      required: true,
    },

    ocrPayload: { type: Schema.Types.Mixed },
    ocrConfidence: { type: Number },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: String },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

CstepAttachmentSchema.plugin(workspaceScopePlugin);

const CstepAttachment =
  (mongoose.models.CstepAttachment as mongoose.Model<ICstepAttachment>) ||
  mongoose.model<ICstepAttachment>("CstepAttachment", CstepAttachmentSchema);

export default CstepAttachment;
