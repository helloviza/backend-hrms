import { Schema, model, type Document } from "mongoose";

export interface IReportSchedule extends Document {
  name: string;
  frequency: "DAILY" | "WEEKLY" | "MONTHLY";
  dayOfWeek?: number;
  dayOfMonth?: number;
  timeIST: string;
  dateRangeType: "LAST_7_DAYS" | "LAST_30_DAYS" | "THIS_MONTH" | "LAST_MONTH";
  recipients: string[];
  includeClientFacing: boolean;
  clientFacingRecipients: string[];
  format: "EMAIL_HTML" | "EMAIL_PDF" | "BOTH";
  isActive: boolean;
  lastSentAt?: Date;
  createdBy?: Schema.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ReportScheduleSchema = new Schema<IReportSchedule>(
  {
    name: { type: String, required: true },
    frequency: { type: String, enum: ["DAILY", "WEEKLY", "MONTHLY"], required: true },
    dayOfWeek: Number,
    dayOfMonth: Number,
    timeIST: { type: String, default: "09:00" },
    dateRangeType: {
      type: String,
      enum: ["LAST_7_DAYS", "LAST_30_DAYS", "THIS_MONTH", "LAST_MONTH"],
      default: "LAST_30_DAYS",
    },
    recipients: [String],
    includeClientFacing: { type: Boolean, default: false },
    clientFacingRecipients: [String],
    format: { type: String, enum: ["EMAIL_HTML", "EMAIL_PDF", "BOTH"], default: "BOTH" },
    isActive: { type: Boolean, default: true },
    lastSentAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

export default model<IReportSchedule>("ReportSchedule", ReportScheduleSchema);
