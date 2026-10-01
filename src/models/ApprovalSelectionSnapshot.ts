import { Schema, model, type Document, type Types } from "mongoose";

/**
 * ApprovalSelectionSnapshot — STAFF-ONLY copy of the live search option a
 * requester attached to an approval request item, prices included.
 *
 * Kept out of ApprovalRequest on purpose: edit/resubmit replace cartItems
 * wholesale, raw cartItems feed every email builder, and the customer item
 * renderer prints unknown meta keys. The request item carries only the
 * price-free `meta.selection` and the opaque `meta.optionRef`.
 *
 * Read only through GET /api/approvals/admin/requests/:id/selection-snapshot
 * (isStaffAdmin). One row per (requestId, optionRef).
 */
export interface IApprovalSelectionSnapshot extends Document {
  requestId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  /** Position of the item in cartItems when this row was last written. */
  itemKey: string;
  optionRef: string;
  /** Domestic round trip: the inbound pick, stored on the same item. */
  returnOptionRef?: string;
  kind: "flight" | "hotel";
  /** Raw TBO option(s) as searched, prices included. */
  rawOption: any;
  /** The price-free selection written to cartItems[].meta.selection. */
  selection: any;
  searchParams: any;
  searchedAt: Date;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const ApprovalSelectionSnapshotSchema = new Schema<IApprovalSelectionSnapshot>(
  {
    requestId: { type: Schema.Types.ObjectId, ref: "ApprovalRequest", required: true, index: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    itemKey: { type: String, required: true },
    optionRef: { type: String, required: true },
    returnOptionRef: { type: String },
    kind: { type: String, enum: ["flight", "hotel"], required: true },
    rawOption: { type: Schema.Types.Mixed, required: true },
    selection: { type: Schema.Types.Mixed, required: true },
    searchParams: { type: Schema.Types.Mixed, default: {} },
    searchedAt: { type: Date, required: true },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, minimize: false },
);

ApprovalSelectionSnapshotSchema.index({ requestId: 1, optionRef: 1 }, { unique: true });

export default model<IApprovalSelectionSnapshot>("ApprovalSelectionSnapshot", ApprovalSelectionSnapshotSchema);
