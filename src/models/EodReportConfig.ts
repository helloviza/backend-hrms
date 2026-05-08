// apps/backend/src/models/EodReportConfig.ts
import { Schema, model, type Document } from "mongoose";

export interface IEodRecipient {
  type: "individual" | "group";
  number: string;
  groupId: string;
  name: string;
  active: boolean;
}

/** Per-alert toggles. Image renderer ignores these (alerts visual is removed
 *  from the image per product decision). Text fallback honours them. */
export interface IEodAlertToggles {
  failedBookings: boolean;
  holdsExpiring: boolean;
  overdueInvoices: boolean;
}

export interface IEodSections {
  todaySnapshot: boolean;
  wtdSummary: boolean;
  mtdSummary: boolean;
  typeBreakdown: boolean;
  topPerformers: boolean;
  topClients: boolean;
  pipelineFollowups: boolean;
  alerts: IEodAlertToggles;
}

export interface IEodReportConfig extends Document {
  sendTime: string;
  timezone: string;
  enabled: boolean;
  recipients: IEodRecipient[];
  testRecipients: IEodRecipient[];
  sections: IEodSections;
  waConnected: boolean;
  waPhoneNumber: string;
  waSession: string;
  lastSentAt: Date | null;
  lastSentStatus: string;
  lastSentError: string;
}

const RecipientSchema = new Schema<IEodRecipient>(
  {
    type: { type: String, enum: ["individual", "group"], required: true },
    number: { type: String, default: "" },
    groupId: { type: String, default: "" },
    name: { type: String, default: "" },
    active: { type: Boolean, default: true },
  },
  { _id: false },
);

const AlertTogglesSchema = new Schema<IEodAlertToggles>(
  {
    failedBookings: { type: Boolean, default: false },
    holdsExpiring: { type: Boolean, default: true },
    overdueInvoices: { type: Boolean, default: true },
  },
  { _id: false },
);

const EodReportConfigSchema = new Schema<IEodReportConfig>(
  {
    sendTime: { type: String, default: "19:00" },
    timezone: { type: String, default: "Asia/Kolkata" },
    enabled: { type: Boolean, default: false },
    recipients: { type: [RecipientSchema], default: [] },
    testRecipients: { type: [RecipientSchema], default: [] },
    sections: {
      todaySnapshot: { type: Boolean, default: true },
      wtdSummary: { type: Boolean, default: true },
      mtdSummary: { type: Boolean, default: true },
      typeBreakdown: { type: Boolean, default: true },
      topPerformers: { type: Boolean, default: true },
      topClients: { type: Boolean, default: true },
      pipelineFollowups: { type: Boolean, default: true },
      // alerts is now a sub-object. Documents that previously stored a Boolean
      // here will be normalized at read-time in computeEodSnapshot().
      alerts: {
        type: AlertTogglesSchema,
        default: () => ({
          failedBookings: false,
          holdsExpiring: true,
          overdueInvoices: true,
        }),
      },
    },
    waConnected: { type: Boolean, default: false },
    waPhoneNumber: { type: String, default: "" },
    waSession: { type: String, default: "" },
    lastSentAt: { type: Date, default: null },
    lastSentStatus: { type: String, default: "" },
    lastSentError: { type: String, default: "" },
  },
  { timestamps: true, minimize: false },
);

export const EodReportConfig = model<IEodReportConfig>(
  "EodReportConfig",
  EodReportConfigSchema,
);

/** Normalize sections object — handles legacy `alerts: boolean` shape from
 *  pre-Phase-2 documents and applies defaults for missing flags. Use this
 *  whenever you read sections from the DB before passing to renderers. */
export function normalizeSections(raw: any): IEodSections {
  const r = raw ?? {};
  const a = r.alerts;
  let alerts: IEodAlertToggles;
  if (a == null) {
    alerts = { failedBookings: false, holdsExpiring: true, overdueInvoices: true };
  } else if (typeof a === "boolean") {
    // legacy boolean: true → on for the two non-failed types; false → all off
    alerts = a
      ? { failedBookings: false, holdsExpiring: true, overdueInvoices: true }
      : { failedBookings: false, holdsExpiring: false, overdueInvoices: false };
  } else {
    alerts = {
      failedBookings: a.failedBookings ?? false,
      holdsExpiring: a.holdsExpiring ?? true,
      overdueInvoices: a.overdueInvoices ?? true,
    };
  }
  return {
    todaySnapshot: r.todaySnapshot ?? true,
    wtdSummary: r.wtdSummary ?? true,
    mtdSummary: r.mtdSummary ?? true,
    typeBreakdown: r.typeBreakdown ?? true,
    topPerformers: r.topPerformers ?? true,
    topClients: r.topClients ?? true,
    pipelineFollowups: r.pipelineFollowups ?? true,
    alerts,
  };
}
