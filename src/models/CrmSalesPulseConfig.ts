// apps/backend/src/models/CrmSalesPulseConfig.ts
//
// Single-document config for the CRM "Sales Pulse" report — modelled on
// EodReportConfig and, like it, delivered over WhatsApp as an image. MULTI-TIME
// (fires at several IST clock times per day). Edited by SUPERADMIN via the
// settings page.
//
// Built DISABLED by default: `enabled` starts false so cloning the EOD cron
// pattern never sends until someone explicitly turns it on.

import { Schema, model, type Document } from "mongoose";

/** A WhatsApp recipient — mirrors EodReportConfig's IEodRecipient shape exactly
 *  so the same whatsappService.sendImageToRecipients() path can be reused.
 *   - individual: `number` holds the phone (with country code, digits resolved
 *     to `<wid>@c.us` by the WA service).
 *   - group: `groupId` holds the `<id>@g.us` chat id.
 *  `active:false` is a soft mute kept in the list. */
export interface ICrmSalesPulseRecipient {
  type: "individual" | "group";
  number: string;
  groupId: string;
  name: string;
  active: boolean;
}

/** Per-section visibility toggles for the report body. */
export interface ICrmSalesPulseSections {
  kpis: boolean;
  leaderboard: boolean;
  pipelineMovement: boolean;
  stageDistribution: boolean;
  activityHeatmap: boolean;
  companiesTouched: boolean;
  repPerformance: boolean;
  leadAgeing: boolean;
  conversionTracker: boolean;
  insights: boolean;
}

export interface ICrmSalesPulseConfig extends Document {
  /** IST clock times in "HH:MM" the report fires at. Default 12/2/4/7 PM. */
  sendTimes: string[];
  timezone: string;
  /** Master on/off. DEFAULT false — nothing sends until explicitly enabled. */
  enabled: boolean;
  recipients: ICrmSalesPulseRecipient[];
  testRecipients: ICrmSalesPulseRecipient[];
  sections: ICrmSalesPulseSections;
  lastSentAt: Date | null;
  lastSentStatus: string;
  lastSentError: string;
  /** Render mode of the last send. "image" = PNG via render Lambda sent over
   *  WhatsApp, "unknown" = never sent (or render failed before any send). */
  lastSentMode: "image" | "unknown";
}

const RecipientSchema = new Schema<ICrmSalesPulseRecipient>(
  {
    type: { type: String, enum: ["individual", "group"], required: true },
    number: { type: String, default: "" },
    groupId: { type: String, default: "" },
    name: { type: String, default: "" },
    active: { type: Boolean, default: true },
  },
  { _id: false },
);

const CrmSalesPulseConfigSchema = new Schema<ICrmSalesPulseConfig>(
  {
    sendTimes: { type: [String], default: () => ["12:00", "14:00", "16:00", "19:00"] },
    timezone: { type: String, default: "Asia/Kolkata" },
    enabled: { type: Boolean, default: false },
    recipients: { type: [RecipientSchema], default: [] },
    testRecipients: { type: [RecipientSchema], default: [] },
    sections: {
      kpis: { type: Boolean, default: true },
      leaderboard: { type: Boolean, default: true },
      pipelineMovement: { type: Boolean, default: true },
      stageDistribution: { type: Boolean, default: true },
      activityHeatmap: { type: Boolean, default: true },
      companiesTouched: { type: Boolean, default: true },
      repPerformance: { type: Boolean, default: true },
      leadAgeing: { type: Boolean, default: true },
      conversionTracker: { type: Boolean, default: true },
      insights: { type: Boolean, default: true },
    },
    lastSentAt: { type: Date, default: null },
    lastSentStatus: { type: String, default: "" },
    lastSentError: { type: String, default: "" },
    lastSentMode: {
      type: String,
      enum: ["image", "unknown"],
      default: "unknown",
    },
  },
  { timestamps: true, minimize: false },
);

export const CrmSalesPulseConfig = model<ICrmSalesPulseConfig>(
  "CrmSalesPulseConfig",
  CrmSalesPulseConfigSchema,
);

/** Apply defaults for any missing section flag (forward-compat for new toggles). */
export function normalizeSalesPulseSections(raw: any): ICrmSalesPulseSections {
  const r = raw ?? {};
  return {
    kpis: r.kpis ?? true,
    leaderboard: r.leaderboard ?? true,
    pipelineMovement: r.pipelineMovement ?? true,
    stageDistribution: r.stageDistribution ?? true,
    activityHeatmap: r.activityHeatmap ?? true,
    companiesTouched: r.companiesTouched ?? true,
    repPerformance: r.repPerformance ?? true,
    leadAgeing: r.leadAgeing ?? true,
    conversionTracker: r.conversionTracker ?? true,
    insights: r.insights ?? true,
  };
}

/** Validate + normalize a list of "HH:MM" IST send times. Dedupes, sorts,
 *  drops malformed entries. Falls back to the 12/2/4/7 default when empty. */
export function normalizeSendTimes(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : [];
  const valid = arr
    .map((v) => String(v).trim())
    .filter((s) => /^(\d{1,2}):(\d{2})$/.test(s))
    .map((s) => {
      const [h, m] = s.split(":").map(Number);
      if (h < 0 || h > 23 || m < 0 || m > 59) return null;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    })
    .filter((s): s is string => s !== null);
  const deduped = [...new Set(valid)].sort();
  return deduped.length ? deduped : ["12:00", "14:00", "16:00", "19:00"];
}
