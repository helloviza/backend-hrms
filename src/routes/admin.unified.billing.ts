// apps/backend/src/routes/admin.unified.billing.ts
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { requireAuth } from "../middleware/auth.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import { resolveWorkspaceForUser } from "../middleware/requireWorkspace.js";
import TravelBooking from "../models/TravelBooking.js";
import User from "../models/User.js";
import Employee from "../models/Employee.js";
import CustomerMember from "../models/CustomerMember.js";
import { isHouseUser } from "../middleware/requirePlatformAdmin.js";
import { computeFlightInsights } from "../services/flightInsights.js";
import {
  computeLeadTime, computeHotelRates, computeTopRoutes, computeCarbon, computeServiceCards,
  SERVICE_CARDS, type ServiceCardKey,
} from "../services/travelKpis.js";
import { summarise, sortViolations, type RegionBy } from "../services/policyCompliance/evaluate.js";
import {
  loadComplianceTrips, complianceState, domesticBasisFor, classifyForCompany, DOMESTIC_FIELDS, EXPORT_COLUMNS, exportCell,
} from "../services/policyCompliance/service.js";
import { quarterPlan, buildQuarterly, type QuarterRow, type QuarterlyStats } from "../services/quarterlySpend.js";

const router = Router();
router.use(requireAuth);

/**
 * Local defense-in-depth: this router serves company-wide, cross-workspace
 * (GLOBAL-scope) cost-free travel-spend data. Its only protection against
 * SAAS_HRMS-tenant access was blockTravelForSaas's prefix-string list in
 * server.ts — correct today, but a single external list this router has no
 * visibility into. This re-checks the same tenantType rule locally so the
 * protection doesn't depend solely on that list staying in sync.
 *
 * Reuses req.workspace — already resolved by requireWorkspace, mounted ahead
 * of this router (server.ts). Only falls back to resolving it again if that's
 * somehow absent (e.g. this router mounted elsewhere without requireWorkspace
 * ahead of it), so the normal request path never resolves the workspace twice.
 */
router.use(async (req: Request, res: Response, next: NextFunction) => {
  if (isSuperAdmin(req)) return next();
  const workspace = (req as any).workspace || (await resolveWorkspaceForUser((req as any).user));
  if (workspace?.tenantType === "SAAS_HRMS") {
    res.status(403).json({
      error: "TRAVEL_MODULE_BLOCKED",
      message: "This module is not available on SaaS HRMS plans.",
    });
    return;
  }
  next();
});

/* ─────────────────────────────────────────────────────────────
 * Helpers
 * ───────────────────────────────────────────────────────────── */

const ALL_SERVICES = [
  "FLIGHT",
  "HOTEL",
  "VISA",
  "CAB",
  "FOREX",
  "ESIM",
  "HOLIDAY",
  "MICE",
] as const;

/* ── Role-based access scope ─────────────────────────────────
 * Determines what data a user can see based on their role:
 *   GLOBAL   – ADMIN/SUPERADMIN: all records
 *   ORG      – L0 / L2: records belonging to their org (tenantId)
 *   OWN      – L1 / everyone else: only their own bookings
 * ──────────────────────────────────────────────────────────── */

type AccessLevel = "GLOBAL" | "ORG" | "OWN";

interface AccessScope {
  matchFilter: Record<string, any>;
  accessLevel: AccessLevel;
}

export function resolveAccessScope(user: any): AccessScope {
  const roles: string[] = Array.isArray(user?.roles) ? user.roles : [];
  const normRoles = roles.map((r) =>
    String(r).toUpperCase().replace(/[\s_-]+/g, ""),
  );
  const accessRole = String(user?.hrmsAccessRole || "")
    .toUpperCase()
    .replace(/[\s_-]+/g, "");

  // SUPERADMIN, or a Plumtrips (HOUSE) ADMIN → GLOBAL (all records). A
  // customer company's own ADMIN falls through to the ORG / OWN rules below.
  if (
    (normRoles.includes("SUPERADMIN") && !user?._demoImpersonation) ||
    (isHouseUser(user) &&
      (normRoles.includes("ADMIN") || String(user?.accountType || "").toUpperCase() === "ADMIN"))
  ) {
    return { matchFilter: {}, accessLevel: "GLOBAL" };
  }

  // Resolve the tenant identifier from the user record
  const tenantId: string | null =
    user?.customerId || user?.businessId || null;

  // L0 (CUSTOMER_ADMIN or hrmsAccessRole L0) → ORG
  if (normRoles.includes("CUSTOMERADMIN") || accessRole === "L0") {
    if (tenantId) {
      return { matchFilter: { tenantId }, accessLevel: "ORG" };
    }
  }

  // L2 / CUSTOMER_APPROVER / APPROVER → ORG (see all org bookings)
  // Note: TravelBooking has no approverId field so we scope to the full org.
  // APPROVER is the role customer approvers actually carry (roles
  // [CUSTOMER, APPROVER]); it used to fall through to OWN, where userId is
  // the staff booker on manual rows, so approvers saw an empty dashboard
  // (Travel Spend audit 2026-11, 3b). REQUESTER stays OWN for now.
  if (accessRole === "L2" || normRoles.includes("CUSTOMERAPPROVER") || normRoles.includes("APPROVER")) {
    if (tenantId) {
      return { matchFilter: { tenantId }, accessLevel: "ORG" };
    }
  }

  // WORKSPACE_LEADER → ORG (full workspace scope, same as CUSTOMERAPPROVER)
  const isWL =
    normRoles.includes("WORKSPACELEADER") ||
    String(user?.customerMemberRole || "").toUpperCase().replace(/[\s_-]+/g, "") === "WORKSPACELEADER";
  if (isWL && tenantId) {
    return { matchFilter: { tenantId }, accessLevel: "ORG" };
  }

  // L1 / all other users → OWN (only their own bookings)
  // user._id from JWT is a string; TravelBooking.userId is ObjectId — must cast
  const uid = user?._id || user?.sub;
  const objectId = uid && mongoose.isValidObjectId(uid)
    ? new mongoose.Types.ObjectId(uid)
    : uid;
  return { matchFilter: { userId: objectId }, accessLevel: "OWN" };
}

function resolveDateField(req: any): string {
  const df = String(req.query.dateField || "bookedAt");
  return df === "travelDate" ? "travelDate" : "bookedAt";
}

function buildScopedMatch(req: any): any {
  const q = req.query;
  const match: any = {};
  const from = q.from as string | undefined;
  const to = q.to as string | undefined;
  const dateField = resolveDateField(req);
  if (from || to) {
    match[dateField] = {} as any;
    if (from) match[dateField].$gte = new Date(from);
    if (to) match[dateField].$lte = new Date(to + "T23:59:59Z");
  }
  if (q.service) match.service = { $in: String(q.service).split(",") };

  const pm = String(q.paymentMode || "").toUpperCase();
  if (pm === "OFFICIAL" || pm === "PERSONAL") match.paymentMode = pm;

  // Apply role-based access scope
  const { matchFilter, accessLevel } = resolveAccessScope(req.user);
  Object.assign(match, matchFilter);

  // Demo Platform — exclude demo bookings from production travel-spend views.
  // A demo login sees ONLY its own company's (or its own) demo bookings, as in
  // myBookings; never from a GLOBAL scope.
  match.isDemo = req.user?.isDemoUser === true && accessLevel !== "GLOBAL" ? true : { $ne: true };
  // Internal test bookings (scripts/mark-sbt-test-data.ts) never count.
  match.isTest = { $ne: true };

  // A soft-deleted source ManualBooking must not keep counting here, in any
  // status bucket (CONFIRMED, CANCELLED, or PENDING) — applied once here so
  // every endpoint built on this match (summary, spend-trend, top-destinations,
  // top-travellers, spend-by-department, bookings, export, heatmap, quarterly)
  // gets it uniformly, including the heatmap's all-statuses "activity" view.
  match.isActive = { $ne: false };

  return match;
}

/* ─────────────────────────────────────────────────────────────
 * Response types (TravelSpendDashboard.tsx contract)
 * ───────────────────────────────────────────────────────────── */
interface StatusCell { count: number; amount: number }
interface PayCell { count: number; amount: number; pct: number }
interface StatusBreakdown { CONFIRMED: StatusCell; PENDING: StatusCell; CANCELLED: StatusCell; FAILED: StatusCell }
interface PaymentBreakdown { OFFICIAL: PayCell; PERSONAL: PayCell }
interface Sparklines { total: number[]; trips: number[]; travellers: number[]; avg: number[] }

interface SummaryResponse {
  totalSpend: number;
  confirmedTrips: number;
  cancelledTrips: number;
  failedTrips: number;
  pendingTrips: number;
  uniqueTravellers: number;
  cancelledSpend: number;
  momGrowth: number;
  byService: Record<string, { spend: number; trips: number }>;
  statusBreakdown: StatusBreakdown;
  paymentBreakdown: PaymentBreakdown;
  policyCompliance: number;
  sparklines: Sparklines;
}

type Granularity = "daily" | "weekly" | "monthly";
interface TrendBucket { label: string; date: string; thisPeriod: number; lastPeriod: number }
interface SpendTrendResponse {
  ok: true;
  buckets: TrendBucket[];
  granularity: Granularity;
  peak: { label: string; value: number };
  stats: { total: number; best: { label: string; value: number }; average: number; runRateAnnualised: number };
}

interface TopDestination { city: string; country: string | null; international: boolean | null; spend: number; trips: number }
interface TopDestinationsResponse {
  ok: true;
  destinations: TopDestination[];
  unresolved: { count: number; spend: number };
}

interface HeatmapResponse {
  ok: true;
  weeks: number;
  grid: number[][];
  weekLabels: string[];
  maxCount: number;
  insight: string;
}

interface QuarterlyResponse {
  ok: true;
  quarters: QuarterRow[];
  stats: QuarterlyStats;
}

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/* ─────────────────────────────────────────────────────────────
 * Bucketing — shared by /summary sparklines and /spend-trend so the
 * two series align (identical boundaries + count).
 *
 * Days are IST calendar days. Manual rows store bookedAt / travelDate as UTC
 * midnight of the IST date, SBT rows carry real instants; grouping with
 * timezone Asia/Kolkata puts both on the IST date they belong to (the old
 * UTC grouping moved an SBT booking made 00:00–05:30 IST to the day before).
 * Bucket boundaries are "day-key epochs": Date.UTC of the IST date.
 *
 * Granularity thresholds (range = to − from):
 *   ≤ 14 days → daily (1-day buckets)
 *   15–70 days → weekly (7-day buckets from `from`)
 *   > 70 days → monthly = IST CALENDAR months (Travel Spend audit N10; was
 *               fixed 30-day blocks labelled as months). The first / last
 *               month may be partial.
 * The previous period is the same window shifted back: by its length for
 * daily / weekly, by the same number of calendar months for monthly.
 * ───────────────────────────────────────────────────────────── */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86400000;
const IST_TZ = "Asia/Kolkata";

interface RangeBucket { label: string; date: string; start: number; end: number }
interface BucketPlan { granularity: Granularity; buckets: RangeBucket[]; prevBuckets: RangeBucket[] }

function pickGranularity(rangeDays: number): { granularity: Granularity; unitDays: number } {
  if (rangeDays <= 14) return { granularity: "daily", unitDays: 1 };
  if (rangeDays <= 70) return { granularity: "weekly", unitDays: 7 };
  return { granularity: "monthly", unitDays: 30 };
}

function fmtLabel(startMs: number, g: Granularity): string {
  const d = new Date(startMs);
  if (g === "monthly") return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "YYYY-MM-DD" → Date.UTC of that date. */
function dayKeyToEpoch(s: string): number {
  return Date.parse(`${s}T00:00:00Z`);
}

/** An instant → the day-key epoch of its IST date. */
export function istDayEpoch(d: Date): number {
  return dayKeyToEpoch(new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10));
}

/** Same day-of-month `n` months earlier/later, clamped to the month's end. */
function addMonths(dayMs: number, n: number): number {
  const d = new Date(dayMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), last));
}

const mk = (start: number, end: number, g: Granularity): RangeBucket => ({
  label: fmtLabel(start, g), date: new Date(start).toISOString().slice(0, 10), start, end,
});

/** `fromDay` / `toDay` are day-key epochs (inclusive). Exported for tests. */
export function buildBucketPlan(fromDay: number, toDay: number): BucketPlan {
  const endExcl = toDay + DAY_MS;
  const rangeDays = Math.max(0, (toDay - fromDay) / DAY_MS);
  const { granularity, unitDays } = pickGranularity(rangeDays);
  const buckets: RangeBucket[] = [];
  const prevBuckets: RangeBucket[] = [];

  if (granularity === "monthly") {
    let start = fromDay;
    while (start < endExcl) {
      const d = new Date(start);
      const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      buckets.push(mk(start, Math.min(monthEnd, endExcl), granularity));
      start = monthEnd;
    }
    const n = buckets.length;
    for (const b of buckets) prevBuckets.push(mk(addMonths(b.start, -n), addMonths(b.end, -n), granularity));
  } else {
    const unitMs = unitDays * DAY_MS;
    for (let start = fromDay; start < endExcl; start += unitMs) buckets.push(mk(start, start + unitMs, granularity));
    const periodMs = buckets.length * unitMs;
    for (const b of buckets) prevBuckets.push(mk(b.start - periodMs, b.end - periodMs, granularity));
  }
  // Always emit at least one bucket so the series is never empty.
  if (!buckets.length) {
    buckets.push(mk(fromDay, fromDay + DAY_MS, granularity));
    prevBuckets.push(mk(fromDay - DAY_MS, fromDay, granularity));
  }
  return { granularity, buckets, prevBuckets };
}

/** [from, to] of a bucket list as the instants fetchDailyConfirmed filters on. */
function bucketWindow(b: RangeBucket[]): { from: Date; to: Date } {
  return { from: new Date(b[0].start), to: new Date(b[b.length - 1].end - 1000) };
}

// Resolve the [from,to] window as IST day-key epochs: query params if
// present, else the data's min/max for the selected dateField within scope,
// else the last 30 days.
async function resolveWindow(baseMatch: any, dateField: string, req: any): Promise<{ fromDay: number; toDay: number }> {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  if (from && to) return { fromDay: dayKeyToEpoch(from), toDay: dayKeyToEpoch(to) };
  const [mm] = await TravelBooking.aggregate([
    { $match: { ...baseMatch, status: "CONFIRMED" } },
    { $group: { _id: null, min: { $min: `$${dateField}` }, max: { $max: `$${dateField}` } } },
  ]).exec();
  if (mm?.min && mm?.max) return { fromDay: istDayEpoch(new Date(mm.min)), toDay: istDayEpoch(new Date(mm.max)) };
  const today = istDayEpoch(new Date());
  return { fromDay: today - 30 * DAY_MS, toDay: today };
}

interface DailyRow { t: number; spend: number; trips: number; travellers: string[] }

// The passenger identity /summary's Travellers card and /top-travellers use:
// travellerName (lower-cased) on manual rows, userId on SBT rows. The
// sparkline used to count distinct userId — the staff booker on manual rows —
// so card and sparkline counted different things (audit N9).
const TRAVELLER_KEY_EXPR = {
  $cond: [
    { $gt: [{ $strLenCP: { $ifNull: ["$travellerName", ""] } }, 0] },
    { $concat: ["name:", { $toLower: "$travellerName" }] },
    { $concat: ["uid:", { $toString: "$userId" }] },
  ],
};

// CONFIRMED daily rollup (IST days) for an arbitrary window. Overrides ONLY
// the date filter on the scoped match — tenant/user scope, paymentMode and
// service filters from buildScopedMatch are all retained.
async function fetchDailyConfirmed(baseMatch: any, dateField: string, winFrom: Date, winTo: Date): Promise<DailyRow[]> {
  const m: any = { ...baseMatch, status: "CONFIRMED", [dateField]: { $gte: winFrom, $lte: winTo } };
  const rows = await TravelBooking.aggregate([
    { $match: m },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: `$${dateField}`, timezone: IST_TZ } },
        spend: { $sum: "$amount" },
        trips: { $sum: 1 },
        travellers: { $addToSet: TRAVELLER_KEY_EXPR },
      },
    },
  ]).exec();
  return rows.map((r: any) => ({
    t: dayKeyToEpoch(r._id),
    spend: r.spend || 0,
    trips: r.trips || 0,
    travellers: (r.travellers || []).map((u: any) => String(u)),
  }));
}

// Assign daily rows into the given buckets (clamped to the ends). Returns aligned arrays.
export function rollIntoBuckets(daily: DailyRow[], buckets: RangeBucket[]) {
  const n = buckets.length;
  const spend = new Array<number>(n).fill(0);
  const trips = new Array<number>(n).fill(0);
  const sets: Set<string>[] = Array.from({ length: n }, () => new Set<string>());
  for (const d of daily) {
    let idx = buckets.findIndex((b) => d.t >= b.start && d.t < b.end);
    if (idx < 0) idx = d.t < buckets[0].start ? 0 : n - 1;
    spend[idx] += d.spend;
    trips[idx] += d.trips;
    for (const u of d.travellers) sets[idx].add(u);
  }
  return { spend, trips, travellers: sets.map((s) => s.size) };
}

/* ── Recent Bookings / CSV filters (audit N6, N8) ── */
const STATUSES = ["CONFIRMED", "PENDING", "CANCELLED", "FAILED"] as const;

/** ?status=CONFIRMED | CONFIRMED,PENDING | ALL (or absent) → match clause or null. */
export function statusFilter(raw: unknown): { $in: string[] } | null {
  const vals = String(raw ?? "").split(",").map((v) => v.trim().toUpperCase()).filter(Boolean);
  if (!vals.length || vals.includes("ALL")) return null;
  const ok = vals.filter((v) => (STATUSES as readonly string[]).includes(v));
  return ok.length ? { $in: ok } : { $in: ["__none__"] };
}

/** ?sort=date|amount|service&dir=asc|desc → a stable Mongo sort (newest first by default). */
export function bookingSort(q: any, dateField: string): Record<string, 1 | -1> {
  const dir: 1 | -1 = String(q?.dir || "").toLowerCase() === "asc" ? 1 : -1;
  const key = String(q?.sort || "date").toLowerCase();
  const field = key === "amount" ? "amount" : key === "service" ? "service" : dateField;
  return field === dateField ? { [field]: dir, _id: dir } : { [field]: dir, [dateField]: -1, _id: -1 };
}

/** IST calendar date of an instant, "YYYY-MM-DD" ("" when absent). */
export function istDate(v: unknown): string {
  if (!v) return "";
  const d = new Date(v as any);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function csvEscape(v: any): string {
  const s = String(v ?? "").replace(/"/g, '""');
  return `"${s}"`;
}

const EMPTY_BY_SERVICE: Record<string, { spend: number; trips: number }> = {};
for (const svc of ALL_SERVICES) EMPTY_BY_SERVICE[svc] = { spend: 0, trips: 0 };

const EMPTY_SUMMARY = {
  totalSpend: 0,
  confirmedTrips: 0,
  cancelledTrips: 0,
  failedTrips: 0,
  pendingTrips: 0,
  uniqueTravellers: 0,
  cancelledSpend: 0,
  momGrowth: 0,
  byService: EMPTY_BY_SERVICE,
};

/* ═════════════════════════════════════════════════════════════
 * GET /summary
 * ═════════════════════════════════════════════════════════════ */
router.get("/summary", async (req: Request, res: Response) => {
  try {
    const match = buildScopedMatch(req);

    const [facetResult] = await TravelBooking.aggregate([
      { $match: match },
      {
        $facet: {
          totalSpend: [
            { $match: { status: "CONFIRMED" } },
            { $group: { _id: null, sum: { $sum: "$amount" } } },
          ],
          confirmedTrips: [
            { $match: { status: "CONFIRMED" } },
            { $count: "count" },
          ],
          cancelledTrips: [
            { $match: { status: "CANCELLED" } },
            { $count: "count" },
          ],
          failedTrips: [
            { $match: { status: "FAILED" } },
            { $count: "count" },
          ],
          pendingTrips: [
            { $match: { status: "PENDING" } },
            { $count: "count" },
          ],
          uniqueTravellers: [
            { $match: { status: "CONFIRMED" } },
            // Same passenger-identity key as /top-travellers: manual mirror
            // rows set userId to the staff booker and carry the real
            // passenger only in travellerName, so dedup on that when present;
            // SBT rows leave travellerName unset and dedup on userId.
            {
              $addFields: {
                _hasName: {
                  $gt: [{ $strLenCP: { $ifNull: ["$travellerName", ""] } }, 0],
                },
              },
            },
            {
              $addFields: {
                _travKey: {
                  $cond: [
                    "$_hasName",
                    { $concat: ["name:", { $toLower: "$travellerName" }] },
                    { $concat: ["uid:", { $toString: "$userId" }] },
                  ],
                },
              },
            },
            { $group: { _id: "$_travKey" } },
            { $count: "count" },
          ],
          byService: [
            { $match: { status: "CONFIRMED" } },
            {
              $group: {
                _id: "$service",
                spend: { $sum: "$amount" },
                trips: { $sum: 1 },
              },
            },
          ],
          cancelledSpend: [
            { $match: { status: "CANCELLED" } },
            { $group: { _id: null, sum: { $sum: "$amount" } } },
          ],
          statusBreakdown: [
            { $group: { _id: "$status", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
          ],
          paymentBreakdown: [
            { $match: { status: "CONFIRMED" } },
            { $group: { _id: "$paymentMode", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
          ],
        },
      },
    ]).exec();

    const totalSpend = facetResult.totalSpend[0]?.sum ?? 0;
    const confirmedTrips = facetResult.confirmedTrips[0]?.count ?? 0;
    const cancelledTrips = facetResult.cancelledTrips[0]?.count ?? 0;
    const failedTrips = facetResult.failedTrips[0]?.count ?? 0;
    const pendingTrips = facetResult.pendingTrips[0]?.count ?? 0;
    const uniqueTravellers = facetResult.uniqueTravellers[0]?.count ?? 0;
    const cancelledSpend = facetResult.cancelledSpend[0]?.sum ?? 0;

    const byService: Record<string, { spend: number; trips: number }> = {};
    for (const svc of ALL_SERVICES) byService[svc] = { spend: 0, trips: 0 };
    for (const row of facetResult.byService) {
      if (row._id) byService[row._id] = { spend: row.spend, trips: row.trips };
    }

    // statusBreakdown — all four statuses zero-filled; amount = sum(amount).
    const statusBreakdown: StatusBreakdown = {
      CONFIRMED: { count: 0, amount: 0 },
      PENDING: { count: 0, amount: 0 },
      CANCELLED: { count: 0, amount: 0 },
      FAILED: { count: 0, amount: 0 },
    };
    for (const row of (facetResult.statusBreakdown as any[]) || []) {
      const k = String(row?._id || "");
      if (k in statusBreakdown) {
        statusBreakdown[k as keyof StatusBreakdown] = { count: row.count ?? 0, amount: row.amount ?? 0 };
      }
    }

    // paymentBreakdown over CONFIRMED rows; pct = mode amount / total CONFIRMED
    // spend × 100 (1 dp). policyCompliance = OFFICIAL pct. Guard nulls.
    const paymentBreakdown: PaymentBreakdown = {
      OFFICIAL: { count: 0, amount: 0, pct: 0 },
      PERSONAL: { count: 0, amount: 0, pct: 0 },
    };
    for (const row of (facetResult.paymentBreakdown as any[]) || []) {
      const k = String(row?._id || "").toUpperCase();
      if (k === "OFFICIAL" || k === "PERSONAL") {
        paymentBreakdown[k] = { count: row.count ?? 0, amount: row.amount ?? 0, pct: 0 };
      }
    }
    (["OFFICIAL", "PERSONAL"] as const).forEach((k) => {
      paymentBreakdown[k].pct = totalSpend > 0 ? Math.round((paymentBreakdown[k].amount / totalSpend) * 1000) / 10 : 0;
    });
    const policyCompliance = paymentBreakdown.OFFICIAL.pct;

    // MoM growth (unchanged)
    let momGrowth = 0;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const dateField = resolveDateField(req as any);

    if (from && to) {
      const fromDate = new Date(from);
      const toDate = new Date(to + "T23:59:59Z");
      const periodMs = toDate.getTime() - fromDate.getTime();

      const prevMatch = { ...match };
      prevMatch[dateField] = {
        $gte: new Date(fromDate.getTime() - periodMs),
        $lte: new Date(fromDate.getTime() - 1),
      };
      prevMatch.status = "CONFIRMED";

      const [prevResult] = await TravelBooking.aggregate([
        { $match: prevMatch },
        { $group: { _id: null, sum: { $sum: "$amount" } } },
      ]).exec();

      const prevSpend = prevResult?.sum ?? 0;
      if (prevSpend > 0) {
        momGrowth = Math.round(((totalSpend - prevSpend) / prevSpend) * 10000) / 100;
      }
    }

    // sparklines — SAME bucketing as /spend-trend (same window + plan) so the
    // panels align. CONFIRMED only; travellers = distinct userId per bucket.
    const { fromDay, toDay } = await resolveWindow(match, dateField, req);
    const plan = buildBucketPlan(fromDay, toDay);
    const win = bucketWindow(plan.buckets);
    const daily = await fetchDailyConfirmed(match, dateField, win.from, win.to);
    const rolled = rollIntoBuckets(daily, plan.buckets);
    const sparklines: Sparklines = {
      total: rolled.spend,
      trips: rolled.trips,
      travellers: rolled.travellers,
      avg: rolled.spend.map((s, i) => (rolled.trips[i] > 0 ? Math.round(s / rolled.trips[i]) : 0)),
    };

    const payload: SummaryResponse = {
      totalSpend,
      confirmedTrips,
      cancelledTrips,
      failedTrips,
      pendingTrips,
      uniqueTravellers,
      cancelledSpend,
      momGrowth,
      byService,
      statusBreakdown,
      paymentBreakdown,
      policyCompliance,
      sparklines,
    };
    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch summary", detail: err?.message });
  }
});

/* ═════════════════════════════════════════════════════════════
 * GET /spend-trend
 * ═════════════════════════════════════════════════════════════ */
router.get("/spend-trend", async (req: Request, res: Response) => {
  try {
    // Scoped match (tenant/user scope + paymentMode + service + date) from
    // buildScopedMatch; fetchDailyConfirmed adds status:CONFIRMED and overrides
    // only the date window per period.
    const match = buildScopedMatch(req);
    const df = resolveDateField(req as any);

    const { fromDay, toDay } = await resolveWindow(match, df, req);
    const plan = buildBucketPlan(fromDay, toDay);
    const n = plan.buckets.length;

    // thisPeriod
    const thisWin = bucketWindow(plan.buckets);
    const thisDaily = await fetchDailyConfirmed(match, df, thisWin.from, thisWin.to);
    const thisRoll = rollIntoBuckets(thisDaily, plan.buckets);

    // lastPeriod = the SAME window shifted back (by its length, or by the
    // same number of calendar months) — Previous period, NOT last year.
    const prevWin = bucketWindow(plan.prevBuckets);
    const prevDaily = await fetchDailyConfirmed(match, df, prevWin.from, prevWin.to);
    const prevRoll = rollIntoBuckets(prevDaily, plan.prevBuckets);

    const buckets: TrendBucket[] = plan.buckets.map((b, i) => ({
      label: b.label,
      date: b.date,
      thisPeriod: thisRoll.spend[i],
      lastPeriod: prevRoll.spend[i],
    }));

    // stats
    const total = thisRoll.spend.reduce((a, b) => a + b, 0);
    let bestIdx = 0;
    for (let i = 1; i < n; i++) if (thisRoll.spend[i] > thisRoll.spend[bestIdx]) bestIdx = i;
    const best = n > 0 ? { label: buckets[bestIdx].label, value: thisRoll.spend[bestIdx] } : { label: "", value: 0 };
    const nonEmpty = thisRoll.spend.filter((v) => v > 0);
    const average = nonEmpty.length ? Math.round(nonEmpty.reduce((a, b) => a + b, 0) / nonEmpty.length) : 0;
    const yearScale = plan.granularity === "daily" ? 365 : plan.granularity === "weekly" ? 52 : 12;
    const runRateAnnualised = average * yearScale;

    const payload: SpendTrendResponse = {
      ok: true,
      buckets,
      granularity: plan.granularity,
      peak: best,
      stats: { total, best, average, runRateAnnualised },
    };
    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch spend trend", detail: err?.message });
  }
});

/* ═════════════════════════════════════════════════════════════
 * GET /top-destinations
 * ═════════════════════════════════════════════════════════════ */
router.get("/top-destinations", async (req: Request, res: Response) => {
  try {
    // Scoped match (tenant/user scope) + CONFIRMED. Grouping is on the clean
    // backfilled destinationCity — the old free-text `destination` (which mixed
    // city + hotel names) is no longer referenced, so no hotel name can leak.
    const match = { ...buildScopedMatch(req), status: "CONFIRMED" };

    const [facet] = await TravelBooking.aggregate([
      { $match: match },
      {
        $facet: {
          destinations: [
            { $match: { destinationCity: { $nin: [null, ""] } } },
            {
              $group: {
                _id: "$destinationCity",
                spend: { $sum: "$amount" },
                trips: { $sum: 1 },
                country: { $first: "$destinationCountry" },
                international: { $first: "$isInternational" },
              },
            },
            { $sort: { spend: -1 } },
            { $limit: 10 },
          ],
          unresolved: [
            // null / missing / "" destinationCity — excluded from the ranking
            // but surfaced honestly so the panel can footnote unassigned spend.
            { $match: { destinationCity: { $in: [null, ""] } } },
            { $group: { _id: null, count: { $sum: 1 }, spend: { $sum: "$amount" } } },
          ],
        },
      },
    ]).exec();

    const destinations: TopDestination[] = (facet?.destinations || []).map((r: any) => ({
      city: r._id,
      country: r.country ?? null,
      international: r.international ?? null,
      spend: r.spend,
      trips: r.trips,
    }));
    const unresolved = {
      count: facet?.unresolved?.[0]?.count ?? 0,
      spend: facet?.unresolved?.[0]?.spend ?? 0,
    };

    const payload: TopDestinationsResponse = { ok: true, destinations, unresolved };
    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch top destinations", detail: err?.message });
  }
});

/* ═════════════════════════════════════════════════════════════
 * GET /top-travellers
 * ═════════════════════════════════════════════════════════════ */
router.get("/top-travellers", async (req: Request, res: Response) => {
  try {
    const match = { ...buildScopedMatch(req), status: "CONFIRMED" };

    const rows = await TravelBooking.aggregate([
      { $match: match },
      {
        // Manual mirror rows set userId = the staff booker and carry the real
        // passenger only in travellerName. Group those by the passenger, not the
        // booker. SBT rows leave travellerName unset → keep grouping by userId.
        $addFields: {
          _hasName: {
            $gt: [{ $strLenCP: { $ifNull: ["$travellerName", ""] } }, 0],
          },
        },
      },
      {
        $addFields: {
          _travKey: {
            $cond: [
              "$_hasName",
              { $concat: ["name:", { $toLower: "$travellerName" }] },
              { $concat: ["uid:", { $toString: "$userId" }] },
            ],
          },
        },
      },
      {
        $group: {
          _id: { key: "$_travKey", service: "$service" },
          spend: { $sum: "$amount" },
          trips: { $sum: 1 },
          userId: { $first: "$userId" },
          hasName: { $first: "$_hasName" },
          travellerName: { $first: "$travellerName" },
          travellerEmail: { $first: "$travellerEmail" },
        },
      },
      {
        $group: {
          _id: "$_id.key",
          totalSpend: { $sum: "$spend" },
          tripCount: { $sum: "$trips" },
          services: { $addToSet: "$_id.service" },
          byServiceArr: {
            $push: { service: "$_id.service", spend: "$spend" },
          },
          userId: { $first: "$userId" },
          hasName: { $first: "$hasName" },
          travellerName: { $first: "$travellerName" },
          travellerEmail: { $first: "$travellerEmail" },
        },
      },
      { $sort: { totalSpend: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "_user",
        },
      },
      { $unwind: { path: "$_user", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "employees",
          let: { uid: "$userId" },
          pipeline: [
            { $match: { $expr: { $eq: ["$ownerId", "$$uid"] } } },
            { $limit: 1 },
          ],
          as: "_emp",
        },
      },
      { $unwind: { path: "$_emp", preserveNullAndEmptyArrays: true } },
    ]).exec();

    const travellers = rows.map((r) => {
      const u = r._user || {};
      const emp = r._emp || {};
      const hasName = !!r.hasName;
      const userName =
        u.name || [u.firstName, u.lastName].filter(Boolean).join(" ") || "";
      const byService: Record<string, number> = {};
      for (const s of r.byServiceArr || []) byService[s.service] = s.spend;

      // Manual rows: show the passenger, never the booker — and don't attribute
      // the booker's department/designation to the passenger.
      const name = hasName ? r.travellerName || "" : userName;
      const email = hasName ? r.travellerEmail || "" : u.email || "";
      const department = hasName ? "" : emp.department || u.department || "";
      const designation = hasName ? "" : emp.designation || u.designation || "";

      return {
        userId: hasName ? null : r.userId,
        name,
        email,
        department,
        designation,
        totalSpend: r.totalSpend,
        tripCount: r.tripCount,
        services: r.services,
        byService,
      };
    });

    res.json({ ok: true, travellers });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch top travellers", detail: err?.message });
  }
});

/* ═════════════════════════════════════════════════════════════
 * GET /spend-by-department
 * ═════════════════════════════════════════════════════════════ */
router.get("/spend-by-department", async (req: Request, res: Response) => {
  try {
    const match = { ...buildScopedMatch(req), status: "CONFIRMED" };

    const rows = await TravelBooking.aggregate([
      { $match: match },
      {
        // Manual rows: userId is the staff booker, and the passenger has no
        // employee record. Don't attribute the booker's department — bucket as
        // "Unassigned". Distinct-traveller count uses the passenger for manual
        // rows and the user for SBT rows.
        $addFields: {
          _hasName: {
            $gt: [{ $strLenCP: { $ifNull: ["$travellerName", ""] } }, 0],
          },
        },
      },
      {
        $lookup: {
          from: "employees",
          let: { uid: "$userId" },
          pipeline: [
            { $match: { $expr: { $eq: ["$ownerId", "$$uid"] } } },
            { $limit: 1 },
          ],
          as: "_emp",
        },
      },
      { $unwind: { path: "$_emp", preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          _dept: {
            $cond: [
              "$_hasName",
              "Unassigned",
              { $ifNull: ["$_emp.department", "Unassigned"] },
            ],
          },
          _travKey: {
            $cond: [
              "$_hasName",
              { $concat: ["name:", { $toLower: "$travellerName" }] },
              { $concat: ["uid:", { $toString: "$userId" }] },
            ],
          },
        },
      },
      {
        $group: {
          _id: {
            dept: "$_dept",
            service: "$service",
          },
          spend: { $sum: "$amount" },
          trips: { $sum: 1 },
          travKeys: { $addToSet: "$_travKey" },
        },
      },
      {
        $group: {
          _id: "$_id.dept",
          spend: { $sum: "$spend" },
          trips: { $sum: "$trips" },
          travKeys: { $push: "$travKeys" },
          byServiceArr: {
            $push: { service: "$_id.service", spend: "$spend" },
          },
        },
      },
      { $sort: { spend: -1 } },
    ]).exec();

    const departments = rows.map((r) => {
      const allKeys = new Set<string>();
      for (const arr of r.travKeys || []) {
        for (const k of arr) allKeys.add(String(k));
      }
      const byService: Record<string, number> = {};
      for (const s of r.byServiceArr || []) byService[s.service] = s.spend;

      return {
        department: r._id,
        spend: r.spend,
        trips: r.trips,
        travellers: allKeys.size,
        byService,
      };
    });

    res.json({ ok: true, departments });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch spend by department", detail: err?.message });
  }
});

/* ═════════════════════════════════════════════════════════════
 * GET /bookings
 * ═════════════════════════════════════════════════════════════ */
router.get("/bookings", async (req: Request, res: Response) => {
  try {
    const match = buildScopedMatch(req);
    const st = statusFilter(req.query.status);
    if (st) match.status = st;

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;

    // Server-side sort + paging over the whole range (audit N8 — the page
    // used to fetch 20 rows and sort / page only those).
    const sort = bookingSort(req.query, resolveDateField(req as any));
    const [bookings, total] = await Promise.all([
      TravelBooking.find(match)
        .populate("userId", "name firstName lastName email")
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      TravelBooking.countDocuments(match).exec(),
    ]);

    const userIds = bookings.map((b: any) =>
      b.userId && typeof b.userId === "object" ? b.userId._id : b.userId,
    );
    const employees = await Employee.find({ ownerId: { $in: userIds } })
      .select("ownerId department")
      .lean()
      .exec();
    const empMap: Record<string, string> = {};
    for (const e of employees as any[]) {
      empMap[String(e.ownerId)] = e.department || "";
    }

    const rows = bookings.map((b: any) => {
      const pop = b.userId && typeof b.userId === "object" ? b.userId : null;
      const uid = pop ? String(pop._id) : String(b.userId || "");
      const hasName = !!(b.travellerName && String(b.travellerName).trim());
      const userName = pop
        ? pop.name || [pop.firstName, pop.lastName].filter(Boolean).join(" ") || ""
        : "";
      // Manual rows: show the passenger (travellerName), not the staff booker,
      // and don't attribute the booker's department to the passenger.
      const name = hasName ? b.travellerName : userName;
      const email = hasName ? b.travellerEmail || "" : pop ? pop.email || "" : "";
      const department = hasName ? "" : empMap[uid] || "";

      return {
        _id: b._id,
        service: b.service,
        amount: b.amount,
        status: b.status,
        paymentMode: b.paymentMode,
        source: b.source,
        destination: b.destination,
        destinationCity: b.destinationCity ?? null,
        origin: b.origin,
        bookedAt: b.bookedAt,
        travelDate: b.travelDate,
        travelDateEnd: b.travelDateEnd,
        traveller: { name, email, department },
        // Cost-safe: never echo the raw Mixed metadata blob (it could carry
        // supplier/cost keys). Return only the display field the UI reads.
        metadata: { hotelName: (b.metadata && b.metadata.hotelName) || "" },
      };
    });

    res.json({
      ok: true,
      bookings: rows,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch bookings", detail: err?.message });
  }
});

/* ═════════════════════════════════════════════════════════════
 * GET /bookings/export.csv
 * ═════════════════════════════════════════════════════════════ */
router.get("/bookings/export.csv", async (req: Request, res: Response) => {
  try {
    const CSV_HEADER =
      "Date (IST),Travel Date (IST),Service,Traveller,Email,Traveler ID,Origin,Destination,Destination City,Destination Country,Amount,Status,Payment Mode,Source,Booking Reference";

    // Same status filter as the Recent Bookings table (audit N6): the page
    // sends CONFIRMED by default so the export matches Total Spend.
    const match = buildScopedMatch(req);
    const st = statusFilter(req.query.status);
    if (st) match.status = st;

    const bookings = await TravelBooking.find(match)
      .populate("userId", "name firstName lastName email")
      .sort(bookingSort(req.query, resolveDateField(req as any)))
      .lean()
      .exec();

    const userIds = bookings.map((b: any) =>
      b.userId && typeof b.userId === "object" ? b.userId._id : b.userId,
    );
    // No Department column (Phase B additions, 2026-11-18): the only source
    // was the BOOKER's employee record, which is ops staff on manual rows.

    // Effective traveller email per row: passenger for manual rows, booker's
    // populated email for SBT rows. Used for both the CSV column and the
    // travelerId lookup below.
    const effEmail = (b: any): string => {
      const pop = b.userId && typeof b.userId === "object" ? b.userId : null;
      const hasName = !!(b.travellerName && String(b.travellerName).trim());
      const e = hasName ? b.travellerEmail : pop?.email;
      return String(e || "").toLowerCase();
    };

    // Batch-lookup travelerId by effective traveller email WITHIN the row's
    // own company (tenantId = CustomerMember.customerId) — an email shared
    // across companies must not pull another company's traveller ID (N6).
    const emails = [...new Set(
      (bookings as any[]).map(effEmail).filter(Boolean),
    )];
    const tenants = [...new Set((bookings as any[]).map((b) => String(b.tenantId || "")).filter(Boolean))];
    const travelerMembers = emails.length && tenants.length
      ? await CustomerMember.find({ email: { $in: emails }, customerId: { $in: tenants } })
          .select("email customerId travelerId")
          .lean()
          .exec()
      : [];
    const travelerMap = new Map<string, string>(
      (travelerMembers as any[]).map((m) => [`${m.customerId}|${String(m.email).toLowerCase()}`, m.travelerId || ""]),
    );

    const lines: string[] = [CSV_HEADER];

    for (const b of bookings as any[]) {
      const pop = b.userId && typeof b.userId === "object" ? b.userId : null;
      const hasName = !!(b.travellerName && String(b.travellerName).trim());
      const userName = pop
        ? pop.name || [pop.firstName, pop.lastName].filter(Boolean).join(" ") || ""
        : "";
      // Manual rows: show the passenger, not the booker.
      const name = hasName ? b.travellerName : userName;
      const email = effEmail(b);

      lines.push(
        [
          csvEscape(istDate(b.bookedAt)),
          csvEscape(istDate(b.travelDate)),
          csvEscape(b.service),
          csvEscape(name),
          csvEscape(email),
          csvEscape(travelerMap.get(`${b.tenantId}|${email}`) || ""),
          csvEscape(b.origin),
          csvEscape(b.destination),
          csvEscape(b.destinationCity || ""),
          csvEscape(b.destinationCountry || ""),
          csvEscape(b.amount),
          csvEscape(b.status),
          csvEscape(b.paymentMode),
          csvEscape(b.source),
          csvEscape(b.reference || ""),
        ].join(","),
      );
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="travel-bookings.csv"`,
    );
    res.send(lines.join("\n"));
  } catch (err: any) {
    res.status(500).json({ error: "Failed to export bookings", detail: err?.message });
  }
});

/* ═════════════════════════════════════════════════════════════
 * GET /heatmap  (ACTIVITY — all statuses, NOT confirmed-only)
 * ═════════════════════════════════════════════════════════════ */
router.get("/heatmap", async (req: Request, res: Response) => {
  try {
    // Start from the scoped match, then drop the date window / dateField filter
    // and any service filter — the heatmap is ALWAYS the last 13 weeks by
    // bookedAt and counts ALL booking activity. Scope (tenantId/userId) and
    // paymentMode are retained; NO status filter is applied.
    const base = buildScopedMatch(req);
    delete base.bookedAt;
    delete base.travelDate;
    delete base.service;

    const WEEKS = 13;
    const DAY = 86400000;
    const now = new Date();
    // Week starts SUNDAY, IST calendar days (day-key epochs). Current week's Sunday:
    const todayUTC = istDayEpoch(now);
    const currentWeekStartMs = todayUTC - new Date(todayUTC).getUTCDay() * DAY;
    const windowStartMs = currentWeekStartMs - (WEEKS - 1) * 7 * DAY; // week 0 = oldest
    const windowEndMs = currentWeekStartMs + 7 * DAY; // end of current week (exclusive)

    // Day-key epochs → IST-midnight instants for the filter.
    const IST_MS = 5.5 * 3600 * 1000;
    const match: any = { ...base, bookedAt: { $gte: new Date(windowStartMs - IST_MS), $lt: new Date(windowEndMs - IST_MS) } };

    const rows = await TravelBooking.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$bookedAt", timezone: IST_TZ } },
          count: { $sum: 1 },
        },
      },
    ]).exec();

    const grid: number[][] = Array.from({ length: WEEKS }, () => new Array<number>(7).fill(0));
    for (const r of rows as any[]) {
      const dayMs = dayKeyToEpoch(r._id);
      const w = Math.floor((dayMs - windowStartMs) / (7 * DAY));
      if (w < 0 || w >= WEEKS) continue;
      const d = new Date(dayMs).getUTCDay(); // 0=Sun..6=Sat
      grid[w][d] += r.count;
    }

    const maxCount = grid.reduce((mx, week) => Math.max(mx, ...week), 0);

    const weekLabels = Array.from({ length: WEEKS }, (_, w) => {
      const ws = new Date(windowStartMs + w * 7 * DAY);
      return `${MONTHS[ws.getUTCMonth()]} ${String(ws.getUTCDate()).padStart(2, "0")}`;
    });

    // insight — derived from the real grid: peak weekday band + quiet days.
    const weekdayTotals = new Array<number>(7).fill(0);
    for (let w = 0; w < WEEKS; w++) for (let d = 0; d < 7; d++) weekdayTotals[d] += grid[w][d];
    const mx = Math.max(...weekdayTotals);
    let insight: string;
    if (mx === 0) {
      insight = "No booking activity in the last 13 weeks";
    } else {
      const argmax = weekdayTotals.indexOf(mx);
      let lo = argmax, hi = argmax;
      while (lo - 1 >= 0 && weekdayTotals[lo - 1] >= 0.6 * mx) lo--;
      while (hi + 1 < 7 && weekdayTotals[hi + 1] >= 0.6 * mx) hi++;
      const bandPart = lo === hi
        ? `${DOW_NAMES[lo]} is the peak booking day`
        : `${DOW_NAMES[lo]}–${DOW_NAMES[hi]} are peak booking days`;
      const quiet: number[] = [];
      for (let d = 0; d < 7; d++) if (weekdayTotals[d] < 0.4 * mx) quiet.push(d);
      let quietPart = "";
      if (quiet.includes(0) && quiet.includes(6)) quietPart = "weekends mostly quiet";
      else if (quiet.length === 1) quietPart = `${DOW_NAMES[quiet[0]]}s are quietest`;
      else if (quiet.length > 1) quietPart = `${quiet.map((d) => DOW_NAMES[d]).join(", ")} are quiet`;
      insight = quietPart ? `${bandPart} · ${quietPart}` : bandPart;
    }

    const payload: HeatmapResponse = { ok: true, weeks: WEEKS, grid, weekLabels, maxCount, insight };
    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch heatmap", detail: err?.message });
  }
});

/* ═════════════════════════════════════════════════════════════
 * GET /quarterly  (CONFIRMED only)
 * ═════════════════════════════════════════════════════════════ */
router.get("/quarterly", async (req: Request, res: Response) => {
  try {
    // Scoped match (tenant/user scope + paymentMode + service) + CONFIRMED,
    // grouped by IST calendar quarter of the selected dateField (audit N10).
    // The panel shows the last QUARTERS_SHOWN quarters ending with the quarter
    // of `to` (default: today) — it no longer narrows to the date preset, which
    // on the default "This month" left a single partial quarter.
    const df = resolveDateField(req as any);
    const match: any = { ...buildScopedMatch(req), status: "CONFIRMED" };
    delete match.bookedAt;
    delete match.travelDate;

    const now = new Date();
    const anchor = req.query.to ? new Date(`${req.query.to}T00:00:00Z`) : new Date(istDayEpoch(now));
    const plan = quarterPlan(anchor, now);
    match[df] = { $gte: new Date(plan.windowFromMs - 5.5 * 3600 * 1000), $lt: new Date(plan.windowToMs - 5.5 * 3600 * 1000) };

    const rows = await TravelBooking.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            y: { $year: { date: `$${df}`, timezone: IST_TZ } },
            q: { $ceil: { $divide: [{ $month: { date: `$${df}`, timezone: IST_TZ } }, 3] } },
            svc: "$service",
          },
          amount: { $sum: "$amount" },
        },
      },
    ]).exec();

    const payload: QuarterlyResponse = buildQuarterly(rows as any[], plan, now);
    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch quarterly", detail: err?.message });
  }
});

/** The one company this view is limited to, or null when it spans companies (staff, all companies). */
function viewedCompany(req: any, match: any): string | null {
  if (typeof match.tenantId === "string" && match.tenantId) return match.tenantId;
  if (resolveAccessScope(req.user).accessLevel === "GLOBAL") return null;
  return String(req.user?.customerId || req.user?.businessId || "") || null;
}

/* ═════════════════════════════════════════════════════════════
 * GET /flight-insights  (CONFIRMED only — Phase B panels)
 *   Domestic vs International (flights, hotels), Airline share (split by
 *   booking), Departure time slot (first leg, IST) + coverage.
 *   One request for all three panels; same scope + filters as the rest.
 *   Domestic vs International: a view of ONE company follows that company's
 *   "Domestic means" setting, as Policy Compliance does. A view across
 *   companies (Plumtrips staff) keeps the India rule.
 * ═════════════════════════════════════════════════════════════ */
router.get("/flight-insights", async (req: Request, res: Response) => {
  try {
    const match: any = { ...buildScopedMatch(req), status: "CONFIRMED" };
    const svc = match.service?.$in as string[] | undefined;
    const wanted = ["FLIGHT", "HOTEL"].filter((s) => !svc || svc.includes(s));
    match.service = { $in: wanted };
    const tenantId = viewedCompany(req, match);
    const { basis, workspaceId } = await domesticBasisFor(tenantId);
    const fields = "service amount isInternational metadata.carrierShares metadata.departMinutesIST metadata.departTimeUnknown metadata.departTimeSource metadata.cabinClass metadata.cabinClassSource";
    let rows: any[] = [];
    if (wanted.length && basis === "WORK_COUNTRY") {
      rows = await TravelBooking.find(match).select(`${fields} ${DOMESTIC_FIELDS}`).populate("userId", "name firstName lastName email").lean().exec();
      rows = await classifyForCompany(rows, tenantId!, workspaceId!);
    } else if (wanted.length) {
      rows = await TravelBooking.find(match).select(fields).lean().exec();
    }
    res.json({ ok: true, domesticBasis: basis, ...computeFlightInsights(rows) });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch flight insights", detail: err?.message });
  }
});

/* ═════════════════════════════════════════════════════════════
 * GET /travel-kpis  (CONFIRMED only — Phase B additions, 2026-11-18)
 *   Lead time + last-minute share, hotel nightly rate by city + average
 *   stay, top routes, carbon — each with its coverage. One request, same
 *   scope + filters as the rest.
 * ═════════════════════════════════════════════════════════════ */
router.get("/travel-kpis", async (req: Request, res: Response) => {
  try {
    const match: any = { ...buildScopedMatch(req), status: "CONFIRMED" };
    const svc = match.service?.$in as string[] | undefined;
    const wanted = ["FLIGHT", "HOTEL"].filter((s) => !svc || svc.includes(s));
    match.service = { $in: wanted };
    const rows: any[] = wanted.length
      ? await TravelBooking.find(match)
          .select("service amount bookedAt travelDate destinationCity reference metadata.originCity metadata.nights metadata.rooms")
          .lean()
          .exec()
      : [];
    const flightRefs = rows.filter((r) => r.service === "FLIGHT" && r.reference).map((r) => r.reference);
    const records = flightRefs.length
      ? await mongoose.connection.collection("carbonrecords")
          .find({ bookingId: { $in: flightRefs }, status: "calculated" }, { projection: { bookingId: 1, co2eKg: 1, distanceKm: 1 } })
          .toArray()
      : [];
    res.json({
      ok: true,
      leadTime: computeLeadTime(rows),
      hotels: computeHotelRates(rows),
      routes: computeTopRoutes(rows),
      carbon: computeCarbon(flightRefs, records as any[]),
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch travel KPIs", detail: err?.message });
  }
});

/* ═════════════════════════════════════════════════════════════
 * GET /service-cards  (Phase B additions, 2026-11-18)
 *   Visa / Forex / eSIM: processed (CONFIRMED), under processing (PENDING),
 *   total + average cost; visa outcomes once recorded on the booking. The
 *   US visa appointment fee mirrors as OTHER, so it is matched by its
 *   manual type. A service filter keeps only the cards it names.
 * ═════════════════════════════════════════════════════════════ */
router.get("/service-cards", async (req: Request, res: Response) => {
  try {
    const match: any = buildScopedMatch(req);
    const svc = match.service?.$in as string[] | undefined;
    delete match.service;
    match.status = { $in: ["CONFIRMED", "PENDING"] };
    match.$or = [{ service: { $in: [...SERVICE_CARDS] } }, { "metadata.manualType": "US_VISA_EARLY_APPOINTMENT_FEE" }];
    const rows = await TravelBooking.find(match)
      .select("service status amount metadata.manualType metadata.visaOutcome")
      .lean()
      .exec();
    const cards = computeServiceCards(rows as any[]);
    if (svc) for (const k of SERVICE_CARDS) if (!svc.includes(k)) delete (cards as Partial<Record<ServiceCardKey, unknown>>)[k];
    res.json({ ok: true, cards });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch service cards", detail: err?.message });
  }
});

/* ═════════════════════════════════════════════════════════════
 * GET /policy-compliance  (CONFIRMED flights + hotels)
 *   Was each trip requested the minimum days ahead that the Travel Policy
 *   in force on the request date asks for? services/policyCompliance/.
 *   enabled:false = the Travel Policy module is off: the page shows nothing.
 *   ?regionBy=work (default) | destination
 * GET /policy-compliance/export?format=csv|xlsx — every violation in range.
 * ═════════════════════════════════════════════════════════════ */
const VIOLATIONS_SHOWN = 1000;

const complianceAccess = (req: Request) => {
  const { accessLevel } = resolveAccessScope((req as any).user);
  const u: any = (req as any).user;
  return { staff: accessLevel === "GLOBAL", tenantId: String(u?.customerId || u?.businessId || "") };
};

router.get("/policy-compliance", async (req: Request, res: Response) => {
  try {
    const regionBy: RegionBy = req.query.regionBy === "destination" ? "destination" : "work";
    const { staff, tenantId } = complianceAccess(req);
    const state = await complianceState(staff ? null : tenantId);
    if (!state.enabled) return res.json({ ok: true, enabled: false, configured: false });
    const trips = await loadComplianceTrips(buildScopedMatch(req));
    const violations = sortViolations(trips);
    return res.json({
      ok: true,
      ...state,
      regionBy,
      showCompany: staff,
      ...summarise(trips, regionBy),
      violations: violations.slice(0, VIOLATIONS_SHOWN),
      violationsTotal: violations.length,
    });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to fetch policy compliance", detail: err?.message });
  }
});

/** A cell that starts like a formula is written as text (names and sectors are typed by people). */
const textCell = (v: string | number) => (typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

router.get("/policy-compliance/export", async (req: Request, res: Response) => {
  try {
    const { staff } = complianceAccess(req);
    const rows = sortViolations(await loadComplianceTrips(buildScopedMatch(req)));
    const cols = staff ? [{ key: "company" as const, label: "Company", width: 26 }, ...EXPORT_COLUMNS] : EXPORT_COLUMNS;
    const body = rows.map((t) => cols.map((c) => textCell(exportCell(t, c.key))));
    if (req.query.format === "xlsx") {
      const wb = new ExcelJS.Workbook();
      const sh = wb.addWorksheet("Policy violations", { views: [{ state: "frozen", ySplit: 1 }] });
      sh.addRow(cols.map((c) => c.label)).font = { bold: true };
      for (const b of body) sh.addRow(b);
      sh.columns.forEach((c, i) => { c.width = cols[i].width; });
      sh.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="policy-violations.xlsx"');
      return res.send(Buffer.from(await wb.xlsx.writeBuffer()));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="policy-violations.csv"');
    // BOM: Excel reads the arrows in "Delhi → London" as UTF-8.
    return res.send("\uFEFF" + [cols.map((c) => csvEscape(c.label)), ...body.map((b) => b.map(csvEscape))].map((l) => l.join(",")).join("\n"));
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to export policy violations", detail: err?.message });
  }
});

export default router;
