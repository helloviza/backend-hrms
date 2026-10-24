// apps/backend/src/services/cstepReportReminders.ts
//
// #14 — the overdue travel-report reminder. A Tour Proposal or Event Request
// still owes its travel report while it is ARRANGED (report not started) or
// REPORT_PENDING (started, or sent back for a fix). Once the trip is over the
// creator — the only one who can file it (routes/cstep.ts report/start,
// report/submit) — is reminded:
//
//   anchor    the request's returnDate (Event Request: the event's end), or
//             the IST day of the latest RETURN_REPORT entry if that is later
//             — a report sent back long after the trip gets a fresh 7 days.
//   due       reminder n (1–3) on anchor + 7n days; at most 3 per anchor.
//   backlog   the FIRST reminder of a series is sent only within
//             FIRST_GRACE_DAYS of its due day, so switching this on (or a
//             job that was off) never mails every old trip. A series already
//             started carries on.
//   claim     reportReminder { round: anchor, count, lastSentAt } is moved on
//             by a conditional update matching what was read, BEFORE the
//             send — of several instances sweeping at once only one wins.
//
// Each send goes through notifyCstep (REPORT_REMINDER), so it is dormant
// exactly like every CSTEP email: CSTEP_NOTIFICATIONS_ENABLED, the
// workspace's cstepEnabled and its own complete notification settings. The
// sweep checks the same gates before claiming, so a reminder is never
// counted while mail is off. Stand-alone claims (LTC / EXP) have no report
// and are never reminded.
import mongoose from "mongoose";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { CstepApproval, CstepTravelRequest } from "../models/cstep/index.js";
import { CSTEP_CLAIM_FORM_TYPES } from "../models/cstep/CstepTravelRequest.js";
import { cstepNotificationsEnabled, resolveCstepTransport } from "./cstepMailTransport.js";
import { notifyCstep } from "./cstepNotifications.js";
import { istDateString, todayIST } from "../utils/dateIST.js";
import logger from "../utils/logger.js";

export const REPORT_REMINDER_STATUSES = ["ARRANGED", "REPORT_PENDING"] as const;
export const REPORT_REMINDER_INTERVAL_DAYS = 7;
export const REPORT_REMINDER_MAX = 3;
export const REPORT_REMINDER_FIRST_GRACE_DAYS = 3;

const DAY_MS = 86_400_000;
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export type ReminderDue = { anchor: string; sentBack: boolean; number: number; dueDay: string };

/**
 * Which reminder, if any, is due today. `lastSendBackDay` is the IST day of
 * the latest RETURN_REPORT entry; `reminder` is the request's stored record.
 */
export function reportReminderDue(
  input: { returnDate?: unknown; lastSendBackDay?: string | null; reminder?: { round?: string; count?: number } | null },
  today: string,
): ReminderDue | null {
  const ret = isDay(input.returnDate) ? input.returnDate : null;
  const back = isDay(input.lastSendBackDay) ? input.lastSendBackDay : null;
  if (!ret) return null;
  const anchor = back && back > ret ? back : ret;
  const count = input.reminder?.round === anchor ? Number(input.reminder?.count || 0) : 0;
  if (count >= REPORT_REMINDER_MAX) return null;
  const dueDay = addDays(anchor, REPORT_REMINDER_INTERVAL_DAYS * (count + 1));
  if (today < dueDay) return null;
  if (count === 0 && daysBetween(dueDay, today) > REPORT_REMINDER_FIRST_GRACE_DAYS) return null;
  return { anchor, sentBack: anchor !== ret, number: count + 1, dueDay };
}

export type ReportReminderSent = { requestId: string; workspaceId: string; number: number; anchor: string; status: string; recipients: string[]; reason?: string };

export type ReportReminderSummary = {
  ran: boolean;
  reason?: string;
  today: string;
  workspaces: number;
  skippedWorkspaces: Array<{ workspaceId: string; reason: string }>;
  candidates: number;
  sent: ReportReminderSent[];
  lostClaims: number;
};

export async function runCstepReportReminders(now: Date = new Date()): Promise<ReportReminderSummary> {
  const today = todayIST(now);
  const summary: ReportReminderSummary = { ran: false, today, workspaces: 0, skippedWorkspaces: [], candidates: 0, sent: [], lostClaims: 0 };
  if (!cstepNotificationsEnabled()) return { ...summary, reason: "CSTEP_NOTIFICATIONS_ENABLED is off" };
  summary.ran = true;

  // The latest a first reminder can be due today puts returnDate at or
  // before today − 7; a later anchor only moves it further out.
  const returnedBy = addDays(today, -REPORT_REMINDER_INTERVAL_DAYS);
  const workspaces: any[] = await CustomerWorkspace.find({ "config.features.cstepEnabled": true }).select("_id").lean();
  for (const ws of workspaces) {
    summary.workspaces++;
    const transport = await resolveCstepTransport(ws._id);
    if (transport.ok === false) {
      summary.skippedWorkspaces.push({ workspaceId: String(ws._id), reason: transport.reason });
      continue;
    }

    const requests: any[] = await CstepTravelRequest.find({
      workspaceId: ws._id,
      status: { $in: [...REPORT_REMINDER_STATUSES] },
      formType: { $nin: [...CSTEP_CLAIM_FORM_TYPES] },
      returnDate: { $lte: returnedBy },
    }).lean();
    if (!requests.length) continue;
    summary.candidates += requests.length;

    const backs = await CstepApproval.aggregate([
      { $match: { workspaceId: ws._id, entityType: "REQUEST", action: "RETURN_REPORT", entityId: { $in: requests.map((r) => r._id) } } },
      { $group: { _id: "$entityId", at: { $max: "$at" } } },
    ]);
    const backDay = new Map(backs.map((b: any) => [String(b._id), istDateString(new Date(b.at))]));

    for (const r of requests) {
      const due = reportReminderDue({ returnDate: r.returnDate, lastSendBackDay: backDay.get(String(r._id)), reminder: r.reportReminder }, today);
      if (!due) continue;

      const prev = r.reportReminder;
      const claimed = await CstepTravelRequest.updateOne(
        {
          _id: r._id,
          workspaceId: ws._id,
          status: r.status,
          ...(prev?.round ? { "reportReminder.round": prev.round, "reportReminder.count": prev.count } : { "reportReminder.round": { $exists: false } }),
        },
        { $set: { reportReminder: { round: due.anchor, count: due.number, lastSentAt: now } } },
      );
      if (claimed.modifiedCount !== 1) {
        summary.lostClaims++;
        continue;
      }

      const res = await notifyCstep("REPORT_REMINDER", r, {
        // No audit entry for a system send; a fresh id keys the ledger row.
        logEntryId: new mongoose.Types.ObjectId(),
        reminder: { count: due.number, anchorDay: due.anchor, sentBack: due.sentBack },
      });
      summary.sent.push({
        requestId: String(r._id),
        workspaceId: String(ws._id),
        number: due.number,
        anchor: due.anchor,
        status: res.status,
        recipients: res.status === "QUEUED" ? res.recipients : [],
        ...(res.status === "SKIPPED" ? { reason: res.reason } : {}),
      });
    }
  }
  if (summary.sent.length) logger.info("[CstepReportReminder] sent", { today, sent: summary.sent.length });
  return summary;
}
