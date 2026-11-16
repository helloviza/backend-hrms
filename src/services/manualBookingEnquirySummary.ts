// apps/backend/src/services/manualBookingEnquirySummary.ts
//
// Team Summary → "Enquiries" tab (2026-11-17). Same page, filters, date range,
// scope and click-through as the team view (services/manualBookingTeamSummary.ts);
// GET /admin/manual-bookings/enquiry-summary (+ /export) hands this module an
// ALREADY GATED base filter (the list's own gates).
//
// ENQUIRIES = ManualBookings with metadata.channel
//   "ADMIN_ENQUIRY"       — Log Enquiry (staff), source filter "Log Enquiry";
//   "TRAVEL_INTAKE_FORM"  — the public website form / Google Form intake
//                           (services/travelIntake.create.ts), "Website form".
//
// BUCKETS (bookingDate in the IST range unless said otherwise):
//   Received   = every enquiry booked in the range (any status)
//   Pending    = PENDING + WIP, OPEN NOW (any date) — with > 1 day / > 3 days
//                / oldest from createdAt
//   Completed  = CONFIRMED + INVOICED in the range
//   Cancelled  = CANCELLED in the range
//   Conversion % = Completed ÷ (Completed + Cancelled + Pending)
//   Avg time to complete = mean(confirmedAt − createdAt) over the Completed
//                rows that HAVE confirmedAt (stamped since 2026-11-17 by the
//                ManualBooking pre-save hook); null ("—") when none do.
//
// GROUP BY: assignee (assignPerson; none = "Unassigned") or logger
// (createdBy; a website-form row is always "Website form", whatever its
// system creator; none = "No creator"). Narrow scopes (TEAM / OWN) get rows
// only for people in scope; the Unassigned / Website form rows only when
// includeUnassigned (TEAM and wide scopes, not OWN). Cards sum the rows.

import mongoose from "mongoose";
import ExcelJS from "exceljs";
import ManualBooking from "../models/ManualBooking.js";
import User from "../models/User.js";
import { roleOf, DAY_MS, OPEN_STATUSES, COMPLETED_STATUSES, istStamp } from "./manualBookingTeamSummary.js";

export const ADMIN_ENQUIRY = "ADMIN_ENQUIRY";
export const WEBSITE_FORM = "TRAVEL_INTAKE_FORM";
export const WEBSITE_KEY = "__website";
export type EnquirySource = "all" | "admin" | "website";
export type EnquiryGroupBy = "assignee" | "logger";

export function parseEnquirySource(raw: unknown): EnquirySource {
  return raw === "admin" || raw === "website" ? raw : "all";
}
export function parseEnquiryGroupBy(raw: unknown): EnquiryGroupBy {
  return raw === "logger" || raw === "creator" ? "logger" : "assignee";
}
export function channelsFor(source: EnquirySource): string[] {
  return source === "admin" ? [ADMIN_ENQUIRY] : source === "website" ? [WEBSITE_FORM] : [ADMIN_ENQUIRY, WEBSITE_FORM];
}

export interface EnquiryRow {
  key: string | null; // user id, null (Unassigned / No creator) or "__website"
  name: string;
  role: string;
  received: number;
  pending: number;
  olderThan1d: number;
  olderThan3d: number;
  oldestPendingAt: string | null;
  completed: number;
  cancelled: number;
  conversionPct: number;
  avgCompleteMs: number | null;
  timedCompleted: number; // completed rows that carry confirmedAt
}

export interface EnquirySummary {
  groupBy: EnquiryGroupBy;
  source: EnquirySource;
  range: { from: string; to: string };
  generatedAt: string;
  conversionFormula: string;
  cards: { received: number; openNow: number; converted: number; cancelled: number; conversionPct: number; avgCompleteMs: number | null; timedCompleted: number };
  rows: EnquiryRow[];
}

export const CONVERSION_FORMULA = "Conversion % = Completed ÷ (Completed + Cancelled + Pending open now)";

export function conversionPct(completed: number, cancelled: number, pending: number): number {
  const d = completed + cancelled + pending;
  return d > 0 ? Math.round((completed / d) * 1000) / 10 : 0;
}

function keyExpr(groupBy: EnquiryGroupBy) {
  if (groupBy === "assignee") {
    return { $cond: [{ $ifNull: ["$assignPerson", false] }, { $toString: "$assignPerson" }, null] };
  }
  return {
    $cond: [
      { $eq: ["$metadata.channel", WEBSITE_FORM] },
      WEBSITE_KEY,
      { $cond: [{ $in: [{ $ifNull: ["$createdBy", ""] }, ["", null]] }, null, { $toString: "$createdBy" }] },
    ],
  };
}

export async function buildEnquirySummary(opts: {
  base: Record<string, any>;
  groupBy: EnquiryGroupBy;
  source: EnquirySource;
  range: { fromStr: string; toStr: string; from: Date; to: Date };
  people: string[] | null;
  includeUnassigned?: boolean;
  now?: Date;
}): Promise<EnquirySummary> {
  const { base, groupBy, source, range, people } = opts;
  const includeUnassigned = opts.includeUnassigned ?? true;
  const now = opts.now ?? new Date();
  const key = keyExpr(groupBy);
  const inRange = { $gte: range.from, $lte: range.to };
  const inRangeExpr = { $and: [{ $gte: ["$bookingDate", range.from] }, { $lte: ["$bookingDate", range.to] }] };
  const isOpen = { $in: ["$status", [...OPEN_STATUSES]] };
  const isCompleted = { $in: ["$status", [...COMPLETED_STATUSES]] };
  const doneInRange = { $and: [isCompleted, inRangeExpr] };
  const timed = { $and: [doneInRange, { $ne: [{ $ifNull: ["$confirmedAt", null] }, null] }] };
  const cut1 = new Date(now.getTime() - DAY_MS);
  const cut3 = new Date(now.getTime() - 3 * DAY_MS);

  const special = [{ $eq: [key, null] }, { $eq: [key, WEBSITE_KEY] }];
  const personMatch = people || !includeUnassigned
    ? [{ $match: { $expr: { $or: [
        ...(people ? [{ $in: [key, people] }] : [{ $and: [{ $ne: [key, null] }, { $ne: [key, WEBSITE_KEY] }] }]),
        ...(includeUnassigned ? special : []),
      ] } } }]
    : [];

  const agg = await ManualBooking.aggregate([
    {
      $match: {
        $and: [
          base,
          { "metadata.channel": { $in: channelsFor(source) } },
          { $or: [{ status: { $in: [...OPEN_STATUSES] } }, { bookingDate: inRange }] },
        ],
      },
    },
    ...personMatch,
    {
      $group: {
        _id: key,
        received: { $sum: { $cond: [inRangeExpr, 1, 0] } },
        pending: { $sum: { $cond: [isOpen, 1, 0] } },
        olderThan1d: { $sum: { $cond: [{ $and: [isOpen, { $lt: ["$createdAt", cut1] }] }, 1, 0] } },
        olderThan3d: { $sum: { $cond: [{ $and: [isOpen, { $lt: ["$createdAt", cut3] }] }, 1, 0] } },
        oldestPendingAt: { $min: { $cond: [isOpen, "$createdAt", null] } },
        completed: { $sum: { $cond: [doneInRange, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "CANCELLED"] }, inRangeExpr] }, 1, 0] } },
        timedCompleted: { $sum: { $cond: [timed, 1, 0] } },
        timedMs: { $sum: { $cond: [timed, { $subtract: ["$confirmedAt", "$createdAt"] }, 0] } },
      },
    },
  ]);

  const keys = new Set<string | null>(agg.map((r: any) => r._id ?? null));
  if (people) for (const p of people) keys.add(p);
  const byKey = new Map(agg.map((r: any) => [r._id ?? null, r]));
  const ids = [...keys].filter((k): k is string => !!k && k !== WEBSITE_KEY && mongoose.Types.ObjectId.isValid(k));
  const users: any[] = ids.length
    ? await User.find({ _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } })
        .select("name firstName lastName email designation hrmsAccessRole roles")
        .lean()
    : [];
  const userOf = new Map(users.map((u) => [String(u._id), u]));
  const nullName = groupBy === "assignee" ? "Unassigned" : "No creator";

  let sumTimedMs = 0;
  const rows: EnquiryRow[] = [...keys].map((k) => {
    const t: any = byKey.get(k) ?? {};
    const u = k && k !== WEBSITE_KEY ? userOf.get(k) : null;
    const pending = t.pending ?? 0;
    const completed = t.completed ?? 0;
    const cancelled = t.cancelled ?? 0;
    const timedCompleted = t.timedCompleted ?? 0;
    sumTimedMs += t.timedMs ?? 0;
    return {
      key: k,
      name: k === WEBSITE_KEY ? "Website form" : k
        ? String(u?.name || [u?.firstName, u?.lastName].filter(Boolean).join(" ") || u?.email || "Unknown user")
        : nullName,
      role: u ? roleOf(u) : "",
      received: t.received ?? 0,
      pending,
      olderThan1d: t.olderThan1d ?? 0,
      olderThan3d: t.olderThan3d ?? 0,
      oldestPendingAt: t.oldestPendingAt ? new Date(t.oldestPendingAt).toISOString() : null,
      completed,
      cancelled,
      conversionPct: conversionPct(completed, cancelled, pending),
      avgCompleteMs: timedCompleted ? Math.round((t.timedMs ?? 0) / timedCompleted) : null,
      timedCompleted,
    };
  });
  const rank = (r: EnquiryRow) => (r.key === WEBSITE_KEY ? 0 : r.key === null ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || b.received - a.received || b.pending - a.pending || a.name.localeCompare(b.name));

  const sum = (f: (r: EnquiryRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const converted = sum((r) => r.completed);
  const cancelled = sum((r) => r.cancelled);
  const openNow = sum((r) => r.pending);
  const timedCompleted = sum((r) => r.timedCompleted);
  return {
    groupBy,
    source,
    range: { from: range.fromStr, to: range.toStr },
    generatedAt: now.toISOString(),
    conversionFormula: CONVERSION_FORMULA,
    cards: {
      received: sum((r) => r.received),
      openNow,
      converted,
      cancelled,
      conversionPct: conversionPct(converted, cancelled, openNow),
      avgCompleteMs: timedCompleted ? Math.round(sumTimedMs / timedCompleted) : null,
      timedCompleted,
    },
    rows,
  };
}

/** "2d 4h" / "5h" / "35m" / "—". */
export function durationLabel(ms: number | null): string {
  if (ms == null) return "—";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return mins % 60 ? `${h}h ${mins % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function enquiryExportColumns(groupBy: EnquiryGroupBy): Array<{ header: string; get: (r: EnquiryRow, now: Date) => any; width: number }> {
  const age = (r: EnquiryRow, now: Date) => (r.oldestPendingAt ? Math.floor((now.getTime() - new Date(r.oldestPendingAt).getTime()) / DAY_MS) : null);
  const hours = (r: EnquiryRow) => (r.avgCompleteMs == null ? null : Math.round((r.avgCompleteMs / 3_600_000) * 10) / 10);
  if (groupBy === "logger") {
    return [
      { header: "Logged by", get: (r) => r.name, width: 26 },
      { header: "Role", get: (r) => r.role, width: 18 },
      { header: "Logged", get: (r) => r.received, width: 9 },
      { header: "Completed", get: (r) => r.completed, width: 11 },
      { header: "Cancelled", get: (r) => r.cancelled, width: 11 },
      { header: "Conversion %", get: (r) => r.conversionPct, width: 13 },
    ];
  }
  return [
    { header: "Assigned to", get: (r) => r.name, width: 26 },
    { header: "Role", get: (r) => r.role, width: 18 },
    { header: "Received", get: (r) => r.received, width: 10 },
    { header: "Pending (open now)", get: (r) => r.pending, width: 18 },
    { header: "Pending > 1 day", get: (r) => r.olderThan1d, width: 15 },
    { header: "Pending > 3 days", get: (r) => r.olderThan3d, width: 16 },
    { header: "Oldest pending (days)", get: age, width: 20 },
    { header: "Completed", get: (r) => r.completed, width: 11 },
    { header: "Cancelled", get: (r) => r.cancelled, width: 11 },
    { header: "Conversion %", get: (r) => r.conversionPct, width: 13 },
    { header: "Avg time to complete (hours)", get: hours, width: 26 },
  ];
}

export async function enquiryWorkbook(s: EnquirySummary, rows: EnquiryRow[], filtersLine: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Enquiries");
  const cols = enquiryExportColumns(s.groupBy);
  ws.addRow([`Manual Bookings — Enquiries (${s.groupBy === "assignee" ? "by assigned to" : "by logged by"}, source: ${s.source === "admin" ? "Log Enquiry" : s.source === "website" ? "Website form" : "all"})`]);
  ws.addRow([`Received / completed / cancelled: booking date ${s.range.from} to ${s.range.to} (IST). Pending = open now, any date. ${s.conversionFormula}. Generated ${istStamp(s.generatedAt)}.`]);
  ws.addRow([filtersLine]);
  ws.addRow([]);
  ws.addRow(cols.map((c) => c.header)).font = { bold: true };
  cols.forEach((c, i) => (ws.getColumn(i + 1).width = c.width));
  const now = new Date(s.generatedAt);
  for (const r of rows) ws.addRow(cols.map((c) => c.get(r, now)));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
