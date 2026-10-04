// apps/backend/src/services/approvalReminders.ts
//
// Reminders for decisions nobody has made (jobs/approval-reminders.ts runs
// this every 15 minutes):
//
//   request  — pending with the approver (REQUEST_RAISED / REQUEST_ON_HOLD),
//              counted from when it last reached them: submitted, resubmitted
//              or the requester's clarification reply.
//   proposal — SUBMITTED, counted from its latest submit.
//
// Reminder 1 at 24h, 2 at 48h, 3 at 72h, then never again for that round; to
// the deciders (approver + Workspace Leaders), each with fresh decision links.
// They stop by themselves once the request/proposal is decided, revoked,
// cancelled or waiting on the requester — those leave the queries below.
// Anything that reached the approver more than 4 days ago is never reminded
// (so switching this on does not mail every old pending request).
//
// The count lives on the record (ApprovalRequest.meta.approvalReminder,
// Proposal.reminder) and is claimed with a conditional update before the
// email goes, so two instances never send the same reminder.
import ApprovalRequest from "../models/ApprovalRequest.js";
import Proposal from "../models/Proposal.js";
import { notifySafely } from "./approvalEmails/dispatch.js";

type AnyObj = Record<string, any>;

export const REMINDER_EVERY_MS = 24 * 3600_000;
export const MAX_REMINDERS = 3;
/** Older than this (since it reached the approver) and nothing is sent. */
export const REMINDER_WINDOW_MS = (MAX_REMINDERS + 1) * REMINDER_EVERY_MS;
/** Never two reminders for one round closer together than this. */
const MIN_GAP_MS = 23 * 3600_000;

const REQUEST_SINCE_ACTIONS = new Set(["submitted", "resubmitted", "clarification_replied"]);

function latestAt(history: any[], match: (action: string) => boolean): Date | null {
  let best: Date | null = null;
  for (const h of Array.isArray(history) ? history : []) {
    if (!match(String(h?.action || ""))) continue;
    const d = new Date(h?.at);
    if (!Number.isNaN(d.getTime()) && (!best || d > best)) best = d;
  }
  return best;
}

type ReminderState = { key?: string; count?: number; lastAt?: any } | null | undefined;

/** Which reminder (1..3) is due now for a round that started at `since`, or 0. */
export function dueReminder(since: Date, state: ReminderState, now: Date): number {
  const age = now.getTime() - since.getTime();
  if (age < REMINDER_EVERY_MS || age > REMINDER_WINDOW_MS) return 0;
  const key = since.toISOString();
  const sent = state?.key === key ? Number(state?.count || 0) : 0;
  if (sent >= MAX_REMINDERS) return 0;
  if (age < REMINDER_EVERY_MS * (sent + 1)) return 0;
  if (state?.key === key && state?.lastAt && now.getTime() - new Date(state.lastAt).getTime() < MIN_GAP_MS) return 0;
  return sent + 1;
}

/** Conditional claim: only one caller moves the count from n-1 to n. */
function claimFilter(path: string, key: string, n: number) {
  return n === 1
    ? { $or: [{ [`${path}.key`]: { $ne: key } }, { [`${path}.count`]: 0 }] }
    : { [`${path}.key`]: key, [`${path}.count`]: n - 1 };
}

export async function runApprovalReminders(now = new Date()): Promise<{ requests: number; proposals: number }> {
  const recent = new Date(now.getTime() - REMINDER_WINDOW_MS - REMINDER_EVERY_MS);
  let requests = 0;
  let proposals = 0;

  const ars: any[] = await ApprovalRequest.find({
    status: "pending",
    stage: { $in: ["REQUEST_RAISED", "REQUEST_ON_HOLD", null] },
    "meta.revoked": { $ne: true },
    updatedAt: { $gte: recent },
  })
    .lean()
    .exec();
  for (const ar of ars) {
    const since = latestAt(ar.history, (a) => REQUEST_SINCE_ACTIONS.has(a)) || new Date(ar.createdAt);
    const n = dueReminder(since, ar.meta?.approvalReminder, now);
    if (!n) continue;
    const key = since.toISOString();
    const claimed = await ApprovalRequest.updateOne(
      { _id: ar._id, status: "pending", ...claimFilter("meta.approvalReminder", key, n) },
      { $set: { "meta.approvalReminder": { key, count: n, lastAt: now } } },
    ).exec();
    if (!claimed.modifiedCount) continue;
    await notifySafely("request_reminder", { ar, reminderNo: n, now });
    requests++;
  }

  const ps: any[] = await Proposal.find({ status: "SUBMITTED", updatedAt: { $gte: recent } }).lean().exec();
  for (const p of ps) {
    const since = latestAt(p.history, (a) => a === "SUBMITTED") || new Date(p.updatedAt);
    const n = dueReminder(since, p.reminder, now);
    if (!n) continue;
    const ar: AnyObj | null = await ApprovalRequest.findOne({ _id: p.requestId }).lean().exec();
    // The request itself was closed meanwhile: nothing to decide.
    if (
      !ar ||
      ar.meta?.revoked ||
      String(ar.status || "").toLowerCase() === "declined" ||
      String(ar.adminState || "") === "cancelled" ||
      String(ar.stage || "").toUpperCase() === "BOOKING_CANCELLED"
    ) {
      continue;
    }
    const key = since.toISOString();
    const claimed = await Proposal.updateOne(
      { _id: p._id, status: "SUBMITTED", ...claimFilter("reminder", key, n) },
      { $set: { reminder: { key, count: n, lastAt: now } } },
    ).exec();
    if (!claimed.modifiedCount) continue;
    await notifySafely("proposal_reminder", { ar, proposal: p, reminderNo: n, now });
    proposals++;
  }

  return { requests, proposals };
}
