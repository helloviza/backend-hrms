// apps/backend/src/models/cstep/CstepNotificationSettings.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepNotificationSettings
 * -------------------------
 * One per workspace, CSTEP-Admin edited (routes/cstep.notificationSettings.ts):
 * the mailbox CSTEP notification emails are sent as, over CSTEP's own SMTP
 * server (e.g. smtp.office365.com:587 STARTTLS), never Plumtrips' mailer.
 *
 * senderMailbox is both the From address and the SMTP username; senderName
 * is the From display name and the organisation label the email shows.
 * smtpPassEnc is a security/fieldCrypto.ts envelope (key CSTEP_SMTP_KEY,
 * aad "cstep-smtp:<workspaceId>") — select:false, and no API ever returns
 * it. adminRecipients receive the CSTEP Admin emails (claim approved,
 * claim sent back by Finance). Nothing sends unless `enabled` is true AND
 * the global CSTEP_NOTIFICATIONS_ENABLED switch is on.
 */
export interface ICstepNotificationSettings extends Document {
  workspaceId: mongoose.Types.ObjectId;
  enabled: boolean;
  senderMailbox: string;
  senderName: string;
  replyTo: string;
  smtpHost: string;
  smtpPort: number;
  smtpPassEnc?: string;
  adminRecipients: string[];
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const CstepNotificationSettingsSchema = new Schema<ICstepNotificationSettings>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, unique: true },
    enabled: { type: Boolean, default: false },
    senderMailbox: { type: String, trim: true, lowercase: true, default: "" },
    senderName: { type: String, trim: true, default: "" },
    replyTo: { type: String, trim: true, lowercase: true, default: "" },
    smtpHost: { type: String, trim: true, lowercase: true, default: "" },
    smtpPort: { type: Number, default: 587 },
    smtpPassEnc: { type: String, select: false },
    adminRecipients: { type: [String], default: [] },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

CstepNotificationSettingsSchema.plugin(workspaceScopePlugin);

const CstepNotificationSettings =
  (mongoose.models.CstepNotificationSettings as mongoose.Model<ICstepNotificationSettings>) ||
  mongoose.model<ICstepNotificationSettings>("CstepNotificationSettings", CstepNotificationSettingsSchema);

export default CstepNotificationSettings;
