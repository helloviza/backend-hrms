import mongoose, { Document, Schema } from "mongoose";

export const ACTIVITY_TYPES = [
  "note", "call", "email", "meeting",
  "stage_change", "assignment", "follow_up",
  "won", "lost", "invite_sent",
] as const;
export type ActivityType = typeof ACTIVITY_TYPES[number];

export interface LeadActivityDoc extends Document {
  leadId: mongoose.Types.ObjectId;
  type: ActivityType;
  note: string;
  fromStage?: string;
  toStage?: string;
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  createdAt: Date;
}

const LeadActivitySchema = new Schema<LeadActivityDoc>(
  {
    leadId: { type: Schema.Types.ObjectId, ref: "Lead", required: true },
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    note: { type: String, default: "" },
    fromStage: { type: String },
    toStage: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    createdByName: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

LeadActivitySchema.index({ leadId: 1, createdAt: -1 });

const LeadActivity = mongoose.model<LeadActivityDoc>("LeadActivity", LeadActivitySchema);
export default LeadActivity;
