// apps/backend/src/models/cstep/CstepNotification.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepNotification
 * -----------------
 * CSTEP Travel & Claim Portal — one row per notification email, written by
 * services/cstepNotifications.ts BEFORE the email is handed to the outbox.
 * It is the dedupe guard: the unique {logEntryId, recipient} index means one
 * transition (one CstepApproval entry) can notify a given address once, ever.
 *
 * Keyed on the log entry, not on {requestId, event}: the same event can
 * legitimately happen twice on one request (RETURN → RESUBMIT notifies the
 * approver again; a Finance send-back puts it with the Official again), and
 * each of those writes its own CstepApproval entry.
 *
 * The outbox can't hold this guard — it sends before it writes its row, and
 * delivered rows expire after 30 days (models/EmailOutbox.ts).
 */

export type CstepNotificationStatus = "QUEUED" | "SENT" | "PENDING" | "FAILED";

export interface ICstepNotification extends Document {
  workspaceId: mongoose.Types.ObjectId;
  requestId: mongoose.Types.ObjectId; // CstepTravelRequest._id
  logEntryId: mongoose.Types.ObjectId; // CstepApproval._id — the transition that fired it
  event: string;
  recipient: string; // lowercased email
  status: CstepNotificationStatus;
  outboxId?: mongoose.Types.ObjectId; // EmailOutbox._id
  createdAt: Date;
  updatedAt: Date;
}

const CstepNotificationSchema = new Schema<ICstepNotification>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    requestId: { type: Schema.Types.ObjectId, required: true, index: true },
    logEntryId: { type: Schema.Types.ObjectId, required: true },
    event: { type: String, required: true },
    recipient: { type: String, required: true },
    status: { type: String, enum: ["QUEUED", "SENT", "PENDING", "FAILED"], default: "QUEUED" },
    outboxId: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

CstepNotificationSchema.index({ logEntryId: 1, recipient: 1 }, { unique: true });
CstepNotificationSchema.plugin(workspaceScopePlugin);

const CstepNotification: mongoose.Model<ICstepNotification> =
  (mongoose.models.CstepNotification as mongoose.Model<ICstepNotification>) ||
  mongoose.model<ICstepNotification>("CstepNotification", CstepNotificationSchema);

export default CstepNotification;
