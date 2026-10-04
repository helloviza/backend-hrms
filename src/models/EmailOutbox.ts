// apps/backend/src/models/EmailOutbox.ts
//
// One row per approval-flow email (services/emailOutbox.ts). The first send is
// tried at once; a failed send is retried by jobs/email-outbox-worker.ts with
// backoff, and after the last try the row is FAILED: logged, listed for staff
// (GET /api/approvals/admin/email-failures) and alerted to the ops desk.
// Not workspace-scoped on purpose: the worker and the staff list read across
// tenants.
import mongoose, { Schema } from "mongoose";

const AttachmentSchema = new Schema(
  {
    filename: { type: String, default: "" },
    path: { type: String, default: "" },
    contentType: { type: String, default: "" },
  },
  { _id: false },
);

const EmailOutboxSchema = new Schema(
  {
    /** Email map event key (services/approvalEmails/map.ts). */
    event: { type: String, required: true, index: true },
    kind: { type: String, default: "DEFAULT" },
    to: { type: [String], default: [] },
    cc: { type: [String], default: [] },
    replyTo: { type: String, default: "" },
    subject: { type: String, required: true },
    html: { type: String, default: "" },
    attachments: { type: [AttachmentSchema], default: [] },

    /** PENDING (waiting for a try) → SENDING (claimed) → SENT | FAILED. */
    status: { type: String, enum: ["PENDING", "SENDING", "SENT", "FAILED"], default: "PENDING", index: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    nextAttemptAt: { type: Date, default: () => new Date(), index: true },
    lockedUntil: { type: Date, default: null },
    lastError: { type: String, default: "" },
    sentAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    alertedAt: { type: Date, default: null },

    /** The case this email is about — for the staff list and the history row. */
    requestId: { type: Schema.Types.ObjectId, default: null, index: true },
    proposalId: { type: Schema.Types.ObjectId, default: null },
    caseCode: { type: String, default: "" },
    customerName: { type: String, default: "" },
    /**
     * History rows pushed onto the request when the send finally succeeds or
     * finally fails — so a record is marked "notified" only after a real send.
     */
    onSent: { type: Schema.Types.Mixed, default: null },
    onFailed: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

EmailOutboxSchema.index({ status: 1, nextAttemptAt: 1 });
// Delivered emails are kept 30 days for reference; failed ones stay until handled.
EmailOutboxSchema.index({ sentAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

const EmailOutbox: mongoose.Model<any> =
  (mongoose.models.EmailOutbox as mongoose.Model<any>) || mongoose.model<any>("EmailOutbox", EmailOutboxSchema);

export default EmailOutbox;
