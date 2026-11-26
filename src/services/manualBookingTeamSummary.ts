// apps/backend/src/services/manualBookingTeamSummary.ts
//
// Manual Bookings "Team Summary" — who has how many cases, by person.
// GET /api/admin/manual-bookings/summary (+ /summary/export), wired in
// routes/manualBookings.ts, which hands this module an ALREADY GATED base
// filter (buildSearchFilter + applyBookingReadGates — the same visibility
// rule as the list, so every click-through shows exactly the counted cases).
//
// RULES (decisions 2026-11-16):
//  - Group by assignee (assignPerson, default) or creator (createdBy). No
//    assignee / no creator = the "Unassigned" / "No creator" row, first.
//  - Pending = PENDING + WIP, ALL currently open cases regardless of date
//    ("Open now"). Completed = CONFIRMED + INVOICED, Cancelled = CANCELLED,
//    both by bookingDate inside the range (IST days) — the field the list's
//    date filter uses. Cancelled is never in Total, Completion % or GMV.
//  - Total = Completed + Pending. Completion % = Completed / Total.
//  - GMV = the list's "Gross sales": grandTotal ?? totalWithGST ?? quotedPrice
//    (GST-inclusive), over Completed rows only (the list's stat strip also
//    counts CONFIRMED + INVOICED).
//  - Age of a pending case = time since createdAt (the model records no
//    assignment time).
//  - Non-wide scopes (TEAM / OWN) only get rows for people in scope (+ the
//    Unassigned row); everything sums from those rows so cards, charts and
//    table always agree.
//
// One aggregate per widget (table, last booking, trend) + one batched User
// lookup for names / roles. No per-user queries.

import mongoose from "mongoose";
import ExcelJS from "exceljs";
import ManualBooking from "../models/ManualBooking.js";
import User from "../models/User.js";
import { parseISTStart, parseISTEnd, istDateString, IST_OFFSET_MS } from "../utils/dateIST.js";

export type SummaryGroupBy = "assignee" | "creator";
export const OPEN_STATUSES = ["PENDING", "WIP"] as const;
export const COMPLETED_STATUSES = ["CONFIRMED", "INVOICED"] as const;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The list's "Gross sales" expression (routes/manualBookings.ts GET /). */
export const GROSS_EXPR = {
  $ifNull: ["$pricing.grandTotal", { $ifNull: ["$pricing.totalWithGST", "$pricing.quotedPrice"] }],
};

export interface SummaryRow {
  key: string | null; // User id, or null for Unassigned / No creator
  name: string;
  role: string;
  total: number;
  completed: number;
  pending: number;
  pendingOnly: number; // PENDING part of `pending`
  wip: number; // WIP part of `pending`
  confirmed: number;
  invoiced: number;
  cancelled: number;
  completionPct: number;
  gmv: number;
  olderThan1d: number;
  olderThan3d: number;
  oldestPendingAt: string | null;
  lastBookingAt: string | null;
}

export interface TeamSummary {
  groupBy: SummaryGroupBy;
  range: { from: string; to: string };
  generatedAt: string;
  cards: { total: number; completed: number; pending: number; cancelled: number; gmv: number; completionPct: number };
  statusDonut: Array<{ status: string; count: number }>;
  rows: SummaryRow[];
  top5: Array<{ key: string; name: string; completed: number; pending: number }>;
  trend: Array<{ date: string; completed: number; pendingCreated: number }>;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** dateFrom / dateTo as IST days; default = this calendar month (IST) to today. */
export function resolveSummaryRange(query: Record<string, any>, now: Date = new Date()) {
  const today = istDateString(now);
  const from = YMD.test(String(query.dateFrom || "")) ? String(query.dateFrom) : `${today.slice(0, 8)}01`;
  const to = YMD.test(String(query.dateTo || "")) ? String(query.dateTo) : today;
  return { fromStr: from, toStr: to, from: parseISTStart(from), to: parseISTEnd(to) };
}

export function parseGroupBy(raw: unknown): SummaryGroupBy {
  return raw === "creator" ? "creator" : "assignee";
}

/**
 * Bookings the client made online in SBT (ManualBooking.clientSelfBooked,
 * linked by services/sbtManualLink.ts) group under ONE row of their own —
 * "Client self-booked (SBT)" — in both groupings, so they are never counted as
 * an unknown person nor as Unassigned / pending to assign (spec §3.2). The key
 * is also the list filter value (routes/manualBookings.filters.ts).
 */
export const SELF_BOOKED_KEY = "sbt-self";
export const SELF_BOOKED_NAME = "Client self-booked (SBT)";

/** The group key as a string (or null) inside an aggregation. */
function keyExpr(groupBy: SummaryGroupBy) {
  const person = groupBy === "assignee"
    ? { $cond: [{ $ifNull: ["$assignPerson", false] }, { $toString: "$assignPerson" }, null] }
    : { $cond: [{ $in: [{ $ifNull: ["$createdBy", ""] }, ["", null]] }, null, { $toString: "$createdBy" }] };
  return { $cond: [{ $eq: ["$clientSelfBooked", true] }, SELF_BOOKED_KEY, person] };
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const iso = (d: any) => (d ? new Date(d).toISOString() : null);

export function roleOf(u: any): string {
  if (!u) return "";
  if (u.designation) return String(u.designation);
  if (u.hrmsAccessRole) return String(u.hrmsAccessRole);
  return Array.isArray(u.roles) && u.roles.length ? String(u.roles[0]) : "";
}

export async function buildTeamSummary(opts: {
  base: Record<string, any>; // gated filter (tenant + scope + soft delete + demo + list filters)
  groupBy: SummaryGroupBy;
  range: { fromStr: string; toStr: string; from: Date; to: Date };
  /** null = wide scope (every person); else the people in scope. */
  people: string[] | null;
  /** The Unassigned / No creator row. Default true; OWN passes false ("only their own row"). */
  includeUnassigned?: boolean;
  now?: Date;
}): Promise<TeamSummary> {
  const { base, groupBy, range, people } = opts;
  const includeUnassigned = opts.includeUnassigned ?? true;
  const now = opts.now ?? new Date();
  const key = keyExpr(groupBy);
  const inRange = { $gte: range.from, $lte: range.to };
  const isOpen = { $in: ["$status", [...OPEN_STATUSES]] };
  const isCompleted = { $in: ["$status", [...COMPLETED_STATUSES]] };
  const cut1 = new Date(now.getTime() - DAY_MS);
  const cut3 = new Date(now.getTime() - 3 * DAY_MS);

  // Narrow scopes: only rows whose person is in scope, plus (unless OWN) the
  // null row. Wide scopes may still drop the null row if asked.
  const personMatch = people || !includeUnassigned
    ? [{ $match: { $expr: { $or: [
        ...(people ? [{ $in: [key, people] }] : [{ $ne: [key, null] }]),
        ...(includeUnassigned ? [{ $eq: [key, null] }] : []),
      ] } } }]
    : [];

  const counted = {
    $or: [
      { status: { $in: [...OPEN_STATUSES] } },
      { status: { $in: [...COMPLETED_STATUSES, "CANCELLED"] }, bookingDate: inRange },
    ],
  };
  const and = (...c: any[]) => ({ $and: [base, ...c] });

  const [tableAgg, lastAgg, trendAgg] = await Promise.all([
    ManualBooking.aggregate([
      { $match: and(counted) },
      ...personMatch,
      {
        $group: {
          _id: key,
          pendingOnly: { $sum: { $cond: [{ $eq: ["$status", "PENDING"] }, 1, 0] } },
          wip: { $sum: { $cond: [{ $eq: ["$status", "WIP"] }, 1, 0] } },
          confirmed: { $sum: { $cond: [{ $eq: ["$status", "CONFIRMED"] }, 1, 0] } },
          invoiced: { $sum: { $cond: [{ $eq: ["$status", "INVOICED"] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ["$status", "CANCELLED"] }, 1, 0] } },
          gmv: { $sum: { $cond: [isCompleted, { $ifNull: [GROSS_EXPR, 0] }, 0] } },
          olderThan1d: { $sum: { $cond: [{ $and: [isOpen, { $lt: ["$createdAt", cut1] }] }, 1, 0] } },
          olderThan3d: { $sum: { $cond: [{ $and: [isOpen, { $lt: ["$createdAt", cut3] }] }, 1, 0] } },
          oldestPendingAt: { $min: { $cond: [isOpen, "$createdAt", null] } },
        },
      },
    ]),
    ManualBooking.aggregate([
      { $match: base },
      ...personMatch,
      { $group: { _id: key, lastBookingAt: { $max: "$createdAt" } } },
    ]),
    ManualBooking.aggregate([
      {
        $match: and({
          $or: [
            { status: { $in: [...COMPLETED_STATUSES] }, bookingDate: inRange },
            { status: { $in: [...OPEN_STATUSES] }, createdAt: inRange },
          ],
        }),
      },
      ...personMatch,
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              timezone: "Asia/Kolkata",
              date: { $cond: [isCompleted, "$bookingDate", "$createdAt"] },
            },
          },
          completed: { $sum: { $cond: [isCompleted, 1, 0] } },
          pendingCreated: { $sum: { $cond: [isOpen, 1, 0] } },
        },
      },
    ]),
  ]);

  // Rows: everyone with a counted case, plus (narrow scope) everyone in scope.
  const keys = new Set<string | null>(tableAgg.map((r: any) => r._id ?? null));
  if (people) for (const p of people) keys.add(p);
  const lastOf = new Map(lastAgg.map((r: any) => [r._id ?? null, r.lastBookingAt]));
  const tableOf = new Map(tableAgg.map((r: any) => [r._id ?? null, r]));

  const ids = [...keys].filter((k): k is string => !!k && mongoose.Types.ObjectId.isValid(k));
  const users: any[] = ids.length
    ? await User.find({ _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } })
        .select("name firstName lastName email designation hrmsAccessRole roles")
        .lean()
    : [];
  const userOf = new Map(users.map((u) => [String(u._id), u]));
  const nullName = groupBy === "assignee" ? "Unassigned" : "No creator";

  const rows: SummaryRow[] = [...keys].map((k) => {
    const t: any = tableOf.get(k) ?? {};
    const u = k ? userOf.get(k) : null;
    const pendingOnly = t.pendingOnly ?? 0;
    const wip = t.wip ?? 0;
    const confirmed = t.confirmed ?? 0;
    const invoiced = t.invoiced ?? 0;
    const pending = pendingOnly + wip;
    const completed = confirmed + invoiced;
    const total = pending + completed;
    const selfBooked = k === SELF_BOOKED_KEY;
    const name = selfBooked
      ? SELF_BOOKED_NAME
      : k
        ? String(u?.name || [u?.firstName, u?.lastName].filter(Boolean).join(" ") || u?.email || "Unknown user")
        : nullName;
    return {
      key: k,
      name,
      role: selfBooked ? "Booked online" : k ? roleOf(u) : "",
      total,
      completed,
      pending,
      pendingOnly,
      wip,
      confirmed,
      invoiced,
      cancelled: t.cancelled ?? 0,
      completionPct: pct(completed, total),
      gmv: Math.round((t.gmv ?? 0) * 100) / 100,
      olderThan1d: t.olderThan1d ?? 0,
      olderThan3d: t.olderThan3d ?? 0,
      oldestPendingAt: iso(t.oldestPendingAt),
      lastBookingAt: iso(lastOf.get(k)),
    };
  });
  // Unassigned / No creator first, then the client self-booked row, then people.
  const rank = (r: SummaryRow) => (r.key === null ? 0 : r.key === SELF_BOOKED_KEY ? 1 : 2);
  rows.sort((a, b) =>
    rank(a) - rank(b) || b.total - a.total || b.pending - a.pending || a.name.localeCompare(b.name),
  );

  const sum = (f: (r: SummaryRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const completed = sum((r) => r.completed);
  const pending = sum((r) => r.pending);
  const cards = {
    total: completed + pending,
    completed,
    pending,
    cancelled: sum((r) => r.cancelled),
    gmv: Math.round(sum((r) => r.gmv) * 100) / 100,
    completionPct: pct(completed, completed + pending),
  };

  const statusDonut = [
    { status: "PENDING", count: sum((r) => r.pendingOnly) },
    { status: "WIP", count: sum((r) => r.wip) },
    { status: "CONFIRMED", count: sum((r) => r.confirmed) },
    { status: "INVOICED", count: sum((r) => r.invoiced) },
    { status: "CANCELLED", count: sum((r) => r.cancelled) },
  ];

  const top5 = rows
    .filter((r) => r.key !== null && r.key !== SELF_BOOKED_KEY && r.total > 0)
    .slice()
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map((r) => ({ key: r.key as string, name: r.name, completed: r.completed, pending: r.pending }));

  // Every IST day in the range, zero-filled.
  const byDay = new Map(trendAgg.map((r: any) => [r._id, r]));
  const trend: TeamSummary["trend"] = [];
  for (let d = range.fromStr, guard = 0; d <= range.toStr && guard < 400; guard++) {
    const r: any = byDay.get(d);
    trend.push({ date: d, completed: r?.completed ?? 0, pendingCreated: r?.pendingCreated ?? 0 });
    const next = new Date(`${d}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    d = next.toISOString().slice(0, 10);
  }

  return {
    groupBy,
    range: { from: range.fromStr, to: range.toStr },
    generatedAt: now.toISOString(),
    cards,
    statusDonut,
    rows,
    top5,
    trend,
  };
}

/** The table's person search (name or role, case-insensitive) — same on screen and in the export. */
export function filterRowsByPerson(rows: SummaryRow[], q: unknown): SummaryRow[] {
  const needle = String(q ?? "").trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => r.name.toLowerCase().includes(needle) || r.role.toLowerCase().includes(needle));
}

export const EXPORT_COLUMNS: Array<{ header: string; key: keyof SummaryRow | "ageDays"; width: number }> = [
  { header: "Person", key: "name", width: 26 },
  { header: "Role", key: "role", width: 18 },
  { header: "Total", key: "total", width: 9 },
  { header: "Completed", key: "completed", width: 11 },
  { header: "Pending (open now)", key: "pending", width: 18 },
  { header: "Pending > 1 day", key: "olderThan1d", width: 15 },
  { header: "Pending > 3 days", key: "olderThan3d", width: 16 },
  { header: "Oldest pending (days)", key: "ageDays", width: 20 },
  { header: "Cancelled", key: "cancelled", width: 11 },
  { header: "Completion %", key: "completionPct", width: 13 },
  { header: "GMV (incl. GST)", key: "gmv", width: 16 },
  { header: "Last booking", key: "lastBookingAt", width: 20 },
];

/** "2026-11-16 14:05 IST" — the export shows IST wall time, never UTC. */
export function istStamp(at: string | null): string {
  if (!at) return "";
  return new Date(new Date(at).getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ") + " IST";
}

export function ageDays(oldestPendingAt: string | null, now: Date = new Date()): number | null {
  if (!oldestPendingAt) return null;
  return Math.floor((now.getTime() - new Date(oldestPendingAt).getTime()) / DAY_MS);
}

/** The export's data rows — exactly the table rows, in table order. */
export function exportRows(rows: SummaryRow[], now: Date = new Date()): Array<Record<string, any>> {
  return rows.map((r) => ({
    name: r.name,
    role: r.role,
    total: r.total,
    completed: r.completed,
    pending: r.pending,
    olderThan1d: r.olderThan1d,
    olderThan3d: r.olderThan3d,
    ageDays: ageDays(r.oldestPendingAt, now),
    cancelled: r.cancelled,
    completionPct: r.completionPct,
    gmv: r.gmv,
    lastBookingAt: istStamp(r.lastBookingAt),
  }));
}

export async function summaryWorkbook(summary: TeamSummary, rows: SummaryRow[], filtersLine: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Team Summary");
  ws.addRow([`Manual Bookings — Team Summary (${summary.groupBy === "assignee" ? "by assigned to" : "by created by"})`]);
  ws.addRow([`Completed / cancelled / GMV: booking date ${summary.range.from} to ${summary.range.to} (IST). Pending = open now, any date.`]);
  ws.addRow([filtersLine]);
  ws.addRow([]);
  const header = ws.addRow(EXPORT_COLUMNS.map((c) => c.header));
  header.font = { bold: true };
  EXPORT_COLUMNS.forEach((c, i) => (ws.getColumn(i + 1).width = c.width));
  for (const r of exportRows(rows, new Date(summary.generatedAt))) {
    ws.addRow(EXPORT_COLUMNS.map((c) => r[c.key]));
  }
  const gmvCol = EXPORT_COLUMNS.findIndex((c) => c.key === "gmv") + 1;
  ws.getColumn(gmvCol).numFmt = "#,##0.00";
  return Buffer.from(await wb.xlsx.writeBuffer());
}
