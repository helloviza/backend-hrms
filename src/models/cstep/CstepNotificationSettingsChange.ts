// apps/backend/src/models/cstep/CstepNotificationSettingsChange.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepNotificationSettingsChange
 * -------------------------------
 * Audit of a CSTEP Admin changing the notification settings
 * (PUT /cstep/notifications/settings) or sending a test email
 * (POST /cstep/notifications/settings/test). Records WHICH fields changed —
 * never their old or new values, never the password ("smtpPass" in `fields`
 * says only that it was set or cleared). A save that changed nothing writes
 * nothing. Append-only.
 */
export interface ICstepNotificationSettingsChange extends Document {
  workspaceId: mongoose.Types.ObjectId;
  action: "UPDATE" | "TEST";
  fields: string[];
  testOk?: boolean;
  changedBy: mongoose.Types.ObjectId;
  changedAt: Date;
}

const CstepNotificationSettingsChangeSchema = new Schema<ICstepNotificationSettingsChange>({
  workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true },
  action: { type: String, enum: ["UPDATE", "TEST"], required: true },
  fields: { type: [String], default: [] },
  testOk: { type: Boolean },
  changedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  changedAt: { type: Date, default: Date.now },
});

CstepNotificationSettingsChangeSchema.index({ workspaceId: 1, changedAt: -1 });

CstepNotificationSettingsChangeSchema.plugin(workspaceScopePlugin);

const CstepNotificationSettingsChange =
  (mongoose.models.CstepNotificationSettingsChange as mongoose.Model<ICstepNotificationSettingsChange>) ||
  mongoose.model<ICstepNotificationSettingsChange>("CstepNotificationSettingsChange", CstepNotificationSettingsChangeSchema);

export default CstepNotificationSettingsChange;
