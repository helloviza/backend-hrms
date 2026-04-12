// apps/backend/src/models/EodReportConfig.ts
import { Schema, model, type Document } from "mongoose";

export interface IEodRecipient {
  type: "individual" | "group";
  number: string;
  groupId: string;
  name: string;
  active: boolean;
}

export interface IEodReportConfig extends Document {
  sendTime: string;
  timezone: string;
  enabled: boolean;
  recipients: IEodRecipient[];
  sections: {
    bookingsToday: boolean;
    revenueToday: boolean;
    teamActivity: boolean;
    pipeline: boolean;
    wtdSummary: boolean;
    mtdSummary: boolean;
  };
  waConnected: boolean;
  waPhoneNumber: string;
  waSession: string;
  lastSentAt: Date | null;
  lastSentStatus: string;
  lastSentError: string;
}

const EodReportConfigSchema = new Schema<IEodReportConfig>(
  {
    sendTime: { type: String, default: "19:00" },
    timezone: { type: String, default: "Asia/Kolkata" },
    enabled: { type: Boolean, default: false },
    recipients: [
      {
        type: { type: String, enum: ["individual", "group"], required: true },
        number: { type: String, default: "" },
        groupId: { type: String, default: "" },
        name: { type: String, default: "" },
        active: { type: Boolean, default: true },
      },
    ],
    sections: {
      bookingsToday: { type: Boolean, default: true },
      revenueToday: { type: Boolean, default: true },
      teamActivity: { type: Boolean, default: true },
      pipeline: { type: Boolean, default: true },
      wtdSummary: { type: Boolean, default: true },
      mtdSummary: { type: Boolean, default: true },
    },
    waConnected: { type: Boolean, default: false },
    waPhoneNumber: { type: String, default: "" },
    waSession: { type: String, default: "" },
    lastSentAt: { type: Date, default: null },
    lastSentStatus: { type: String, default: "" },
    lastSentError: { type: String, default: "" },
  },
  { timestamps: true },
);

export const EodReportConfig = model<IEodReportConfig>(
  "EodReportConfig",
  EodReportConfigSchema,
);
