// apps/backend/src/services/expenseAudit.service.ts
//
// The ONE append point for the expense audit trail (approval-engine sub-step
// 2). reports.service.ts#logActivity (claims) and expenseAdvances.ts#
// logAdvanceActivity (advances) both funnel here, as do the few in-route
// ExpenseActivity.create calls that used to bypass them.
//
// What this adds on top of the plain create that existed before:
//   • actorType  — WHO vs WHAT ("user" | "bot" | "system"), a first-class
//                  field so the Approval Bot is never mistaken for an
//                  anonymous person;
//   • elapsedMs  — ms since the previous entry on the same claim / advance,
//                  computed HERE at write time, plus prevActivityId, so the
//                  whole clock (submit → routed → approved → paid) is
//                  reconstructable from the rows alone;
//   • heldMs     — passed in by decision / payment writers: how long the item
//                  sat with the actor who just acted;
//   • details    — the structured, event-specific payload (the "how").
//
// Non-fatal by contract (a logging failure must never block a lifecycle
// action) — but it is LOUD: the error is logged with the event name.
import mongoose from "mongoose";
import ExpenseActivity, {
  type ExpenseActivityEvent,
  type ExpenseActorType,
} from "../models/ExpenseActivity.js";

const oid = (v: any) =>
  v && mongoose.Types.ObjectId.isValid(String(v)) ? new mongoose.Types.ObjectId(String(v)) : null;

export type AppendActivityParams = {
  workspaceId: mongoose.Types.ObjectId | string;
  reportId?: mongoose.Types.ObjectId | string | null;
  advanceId?: mongoose.Types.ObjectId | string | null;
  expenseId?: mongoose.Types.ObjectId | string | null;
  event: ExpenseActivityEvent;
  actorName: string;
  actorId?: mongoose.Types.ObjectId | string | null;
  actorType?: ExpenseActorType;
  note?: string | null;
  heldMs?: number | null;
  details?: Record<string, any> | null;
};

/** ms between two instants, never negative, null when either is missing. */
export function msBetween(from: Date | string | null | undefined, to: Date | string | null | undefined): number | null {
  if (!from || !to) return null;
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, b - a);
}

export async function appendActivity(params: AppendActivityParams): Promise<mongoose.Types.ObjectId | null> {
  try {
    const workspaceId = oid(params.workspaceId);
    const reportId = oid(params.reportId);
    const advanceId = oid(params.advanceId);
    if (!workspaceId || (!reportId && !advanceId)) throw new Error("appendActivity needs workspaceId and a subject");

    // The previous entry on the SAME subject → elapsedMs + prevActivityId.
    const subject = reportId ? { reportId } : { advanceId };
    const prev: any = await ExpenseActivity.findOne({ workspaceId, ...subject })
      .sort({ createdAt: -1, _id: -1 })
      .select("_id createdAt")
      .lean();
    const now = new Date();
    const elapsedMs = prev?.createdAt ? msBetween(prev.createdAt, now) : null;

    const actorType: ExpenseActorType =
      params.actorType ?? (params.actorId ? "user" : /bot$/i.test(params.actorName || "") ? "bot" : "system");

    const doc = await ExpenseActivity.create({
      workspaceId,
      ...(reportId ? { reportId } : {}),
      ...(advanceId ? { advanceId } : {}),
      expenseId: oid(params.expenseId),
      event: params.event,
      actorId: oid(params.actorId),
      actorName: params.actorName || (actorType === "system" ? "System" : "Unknown"),
      actorType,
      note: params.note ?? null,
      elapsedMs,
      heldMs: params.heldMs ?? null,
      prevActivityId: prev?._id ?? null,
      details: params.details ?? null,
      createdAt: now,
    });
    return doc._id as mongoose.Types.ObjectId;
  } catch (err: any) {
    console.error("[expense audit]", params.event, err?.message || err);
    return null;
  }
}

/** Human-readable duration for notes: 45s · 12m · 3h 05m · 2d 4h. */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Line snapshot for the `submitted` entry — original AND converted, always. */
export function lineSnapshot(e: any) {
  return {
    expenseId: e?._id ? String(e._id) : null,
    ref: e?.ref ?? null,
    merchant: e?.merchant ?? null,
    date: e?.date ?? null,
    amount: e?.amount ?? null,
    currency: e?.currency ?? null,
    amountBase: e?.amountBase ?? null,
    baseCurrency: e?.baseCurrency ?? null,
    exchangeRate: e?.exchangeRate ?? null,
    rateSource: e?.rateSource ?? null,
    categoryId: e?.categoryId ? String(e.categoryId) : null,
    hasReceipt: !!e?.imageKey,
  };
}
