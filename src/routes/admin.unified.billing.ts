// apps/backend/src/routes/admin.unified.billing.ts
import { Router } from "express";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import TravelBooking from "../models/TravelBooking.js";
import User from "../models/User.js";
import Employee from "../models/Employee.js";
import CustomerMember from "../models/CustomerMember.js";

const router = Router();
router.use(requireAuth);

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

function resolveAccessScope(user: any): AccessScope {
  const roles: string[] = Array.isArray(user?.roles) ? user.roles : [];
  const normRoles = roles.map((r) =>
    String(r).toUpperCase().replace(/[\s_-]+/g, ""),
  );
  const accessRole = String(user?.hrmsAccessRole || "")
    .toUpperCase()
    .replace(/[\s_-]+/g, "");

  // ADMIN / SUPERADMIN → GLOBAL (all records)
  if (
    normRoles.includes("ADMIN") ||
    normRoles.includes("SUPERADMIN") ||
    String(user?.accountType || "").toUpperCase() === "ADMIN"
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

  // L2 / CUSTOMER_APPROVER → ORG (see all org bookings)
  // Note: TravelBooking has no approverId field so we scope to the full org
  if (accessRole === "L2" || normRoles.includes("CUSTOMERAPPROVER")) {
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
  const { matchFilter } = resolveAccessScope(req.user);
  Object.assign(match, matchFilter);

  // Demo Platform — exclude demo bookings from production travel-spend views.
  match.isDemo = { $ne: true };

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

interface QuarterRow { label: string; partial: boolean; flight: number; hotel: number; other: number; total: number }
interface QuarterlyResponse {
  ok: true;
  quarters: QuarterRow[];
  stats: { q1Closed: number | null; q2ToDate: number; q2Projected: number | null };
}

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/* ─────────────────────────────────────────────────────────────
 * Bucketing — shared by /summary sparklines and /spend-trend so the
 * two series align (identical boundaries + count). Uniform offset buckets
 * (1-day / 7-day / 30-day) anchored at `from`, so the "previous period"
 * series is the SAME window shifted back by its own length.
 *
 * Granularity thresholds (range = to − from):
 *   ≤ 14 days → daily (1-day buckets)
 *   15–70 days → weekly (7-day buckets)
 *   > 70 days → monthly (30-day buckets)
 * ───────────────────────────────────────────────────────────── */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface RangeBucket { label: string; date: string; start: number; end: number }
interface BucketPlan { granularity: Granularity; unitMs: number; periodMs: number; windowStartMs: number; buckets: RangeBucket[] }

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

function buildBucketPlan(fromDate: Date, toDate: Date): BucketPlan {
  const fromMs = fromDate.getTime();
  const toMs = toDate.getTime();
  const rangeDays = Math.max(0, (toMs - fromMs) / 86400000);
  const { granularity, unitDays } = pickGranularity(rangeDays);
  const unitMs = unitDays * 86400000;
  const buckets: RangeBucket[] = [];
  let start = fromMs;
  while (start <= toMs) {
    buckets.push({
      label: fmtLabel(start, granularity),
      date: new Date(start).toISOString().slice(0, 10),
      start,
      end: start + unitMs,
    });
    start += unitMs;
  }
  // Always emit at least one bucket so the series is never empty.
  if (buckets.length === 0) {
    buckets.push({ label: fmtLabel(fromMs, granularity), date: new Date(fromMs).toISOString().slice(0, 10), start: fromMs, end: fromMs + unitMs });
  }
  return { granularity, unitMs, periodMs: buckets.length * unitMs, windowStartMs: fromMs, buckets };
}

function dayKeyToEpoch(s: string): number {
  return Date.parse(`${s}T00:00:00Z`);
}

// Resolve the [from,to] window: query params if present, else the data's
// min/max for the selected dateField within scope, else the last 30 days.
async function resolveWindow(baseMatch: any, dateField: string, req: any): Promise<{ fromDate: Date; toDate: Date }> {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  if (from && to) return { fromDate: new Date(from), toDate: new Date(`${to}T23:59:59Z`) };
  const [mm] = await TravelBooking.aggregate([
    { $match: { ...baseMatch, status: "CONFIRMED" } },
    { $group: { _id: null, min: { $min: `$${dateField}` }, max: { $max: `$${dateField}` } } },
  ]).exec();
  if (mm?.min && mm?.max) return { fromDate: new Date(mm.min), toDate: new Date(mm.max) };
  const now = new Date();
  return { fromDate: new Date(now.getTime() - 30 * 86400000), toDate: now };
}

interface DailyRow { t: number; spend: number; trips: number; users: string[] }

// CONFIRMED daily rollup for an arbitrary window. Overrides ONLY the date
// filter on the scoped match — tenant/user scope, paymentMode and service
// filters from buildScopedMatch are all retained.
async function fetchDailyConfirmed(baseMatch: any, dateField: string, winFrom: Date, winTo: Date): Promise<DailyRow[]> {
  const m: any = { ...baseMatch, status: "CONFIRMED", [dateField]: { $gte: winFrom, $lte: winTo } };
  const rows = await TravelBooking.aggregate([
    { $match: m },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: `$${dateField}`, timezone: "UTC" } },
        spend: { $sum: "$amount" },
        trips: { $sum: 1 },
        users: { $addToSet: "$userId" },
      },
    },
  ]).exec();
  return rows.map((r: any) => ({
    t: dayKeyToEpoch(r._id),
    spend: r.spend || 0,
    trips: r.trips || 0,
    users: (r.users || []).map((u: any) => String(u)),
  }));
}

// Assign daily rows into `bucketCount` buckets relative to `windowStartMs`
// (use the shifted start for the previous period). Returns aligned arrays.
function rollIntoBuckets(daily: DailyRow[], bucketCount: number, windowStartMs: number, unitMs: number) {
  const spend = new Array<number>(bucketCount).fill(0);
  const trips = new Array<number>(bucketCount).fill(0);
  const userSets: Set<string>[] = Array.from({ length: bucketCount }, () => new Set<string>());
  for (const d of daily) {
    let idx = Math.floor((d.t - windowStartMs) / unitMs);
    if (idx < 0) idx = 0;
    if (idx >= bucketCount) idx = bucketCount - 1;
    spend[idx] += d.spend;
    trips[idx] += d.trips;
    for (const u of d.users) userSets[idx].add(u);
  }
  return { spend, trips, travellers: userSets.map((s) => s.size) };
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
            { $group: { _id: "$userId" } },
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
    const { fromDate: spkFrom, toDate: spkTo } = await resolveWindow(match, dateField, req);
    const plan = buildBucketPlan(spkFrom, spkTo);
    const daily = await fetchDailyConfirmed(match, dateField, spkFrom, spkTo);
    const rolled = rollIntoBuckets(daily, plan.buckets.length, plan.windowStartMs, plan.unitMs);
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

    const { fromDate, toDate } = await resolveWindow(match, df, req);
    const plan = buildBucketPlan(fromDate, toDate);
    const n = plan.buckets.length;

    // thisPeriod
    const thisDaily = await fetchDailyConfirmed(match, df, fromDate, toDate);
    const thisRoll = rollIntoBuckets(thisDaily, n, plan.windowStartMs, plan.unitMs);

    // lastPeriod = the SAME window shifted back by its own length (Previous
    // period, NOT last year — data only starts 30 Jan 2026). Bucketed identically.
    const prevStartMs = plan.windowStartMs - plan.periodMs;
    const prevFrom = new Date(prevStartMs);
    const prevTo = new Date(plan.windowStartMs - 1);
    const prevDaily = await fetchDailyConfirmed(match, df, prevFrom, prevTo);
    const prevRoll = rollIntoBuckets(prevDaily, n, prevStartMs, plan.unitMs);

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
    if (req.query.status) match.status = req.query.status;

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;

    const sortField = resolveDateField(req as any);
    const [bookings, total] = await Promise.all([
      TravelBooking.find(match)
        .populate("userId", "name firstName lastName email")
        .sort({ [sortField]: -1 })
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
      "Date,Service,Traveller,Email,Traveler ID,Department,Origin,Destination,Amount,Status,Payment Mode,Source,Booking Reference";

    const match = buildScopedMatch(req);
    if (req.query.status) match.status = req.query.status;

    const csvSortField = resolveDateField(req as any);
    const bookings = await TravelBooking.find(match)
      .populate("userId", "name firstName lastName email")
      .sort({ [csvSortField]: -1 })
      .lean()
      .exec();

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

    // Effective traveller email per row: passenger for manual rows, booker's
    // populated email for SBT rows. Used for both the CSV column and the
    // travelerId lookup below.
    const effEmail = (b: any): string => {
      const pop = b.userId && typeof b.userId === "object" ? b.userId : null;
      const hasName = !!(b.travellerName && String(b.travellerName).trim());
      const e = hasName ? b.travellerEmail : pop?.email;
      return String(e || "").toLowerCase();
    };

    // Batch-lookup travelerId by effective traveller email
    const emails = [...new Set(
      (bookings as any[]).map(effEmail).filter(Boolean),
    )];
    const travelerMembers = await CustomerMember.find({ email: { $in: emails } })
      .select("email travelerId")
      .lean()
      .exec();
    const travelerMap = new Map<string, string>(
      (travelerMembers as any[]).map((m) => [String(m.email).toLowerCase(), m.travelerId || ""]),
    );

    const lines: string[] = [CSV_HEADER];

    for (const b of bookings as any[]) {
      const pop = b.userId && typeof b.userId === "object" ? b.userId : null;
      const uid = pop ? String(pop._id) : String(b.userId || "");
      const hasName = !!(b.travellerName && String(b.travellerName).trim());
      const userName = pop
        ? pop.name || [pop.firstName, pop.lastName].filter(Boolean).join(" ") || ""
        : "";
      // Manual rows: show the passenger, not the booker; don't attribute the
      // booker's department to the passenger.
      const name = hasName ? b.travellerName : userName;
      const email = effEmail(b);
      const department = hasName ? "" : empMap[uid] || "";

      lines.push(
        [
          csvEscape(b.bookedAt),
          csvEscape(b.service),
          csvEscape(name),
          csvEscape(email),
          csvEscape(travelerMap.get(email) || ""),
          csvEscape(department),
          csvEscape(b.origin),
          csvEscape(b.destination),
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
    // Week starts SUNDAY (UTC). Current week's Sunday 00:00 UTC:
    const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const currentWeekStartMs = todayUTC - new Date(todayUTC).getUTCDay() * DAY;
    const windowStartMs = currentWeekStartMs - (WEEKS - 1) * 7 * DAY; // week 0 = oldest
    const windowEndMs = currentWeekStartMs + 7 * DAY; // end of current week (exclusive)

    const match: any = { ...base, bookedAt: { $gte: new Date(windowStartMs), $lt: new Date(windowEndMs) } };

    const rows = await TravelBooking.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$bookedAt", timezone: "UTC" } },
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
    // Scoped match (tenant/user scope + paymentMode + any from/to on dateField)
    // + CONFIRMED. Grouped by calendar quarter of the selected dateField.
    const df = resolveDateField(req as any);
    const match = { ...buildScopedMatch(req), status: "CONFIRMED" };

    const rows = await TravelBooking.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            y: { $year: `$${df}` },
            q: { $ceil: { $divide: [{ $month: `$${df}` }, 3] } },
            svc: "$service",
          },
          amount: { $sum: "$amount" },
        },
      },
    ]).exec();

    // Fold service into flight / hotel / other per (year, quarter).
    const qmap = new Map<string, { y: number; q: number; flight: number; hotel: number; other: number }>();
    for (const r of rows as any[]) {
      const { y, q, svc } = r._id;
      const key = `${y}-${q}`;
      let e = qmap.get(key);
      if (!e) { e = { y, q, flight: 0, hotel: 0, other: 0 }; qmap.set(key, e); }
      if (svc === "FLIGHT") e.flight += r.amount;
      else if (svc === "HOTEL") e.hotel += r.amount;
      else e.other += r.amount; // Visa, Cab, Forex, Holiday, MICE, Train, Other …
    }

    const now = new Date();
    const nowY = now.getUTCFullYear();
    const nowQ = Math.ceil((now.getUTCMonth() + 1) / 3);

    const entries = [...qmap.values()].sort((a, b) => a.y - b.y || a.q - b.q);
    const quarters: QuarterRow[] = entries.map((e) => {
      const total = e.flight + e.hotel + e.other;
      const partial = e.y === nowY && e.q === nowQ;
      return { label: `Q${e.q}${partial ? "*" : ""}`, partial, flight: e.flight, hotel: e.hotel, other: e.other, total };
    });

    // stats — referenced to the CURRENT year (nowY).
    const q1 = entries.find((e) => e.y === nowY && e.q === 1);
    const q2 = entries.find((e) => e.y === nowY && e.q === 2);
    const q1Total = q1 ? q1.flight + q1.hotel + q1.other : null;
    // Q1 closed once we're past it (same year, current quarter > 1).
    const q1Closed = q1Total != null && nowQ > 1 ? q1Total : null;
    const q2ToDate = q2 ? q2.flight + q2.hotel + q2.other : 0;

    // q2Projected = q2ToDate / daysElapsedInQuarter × totalDaysInQuarter (run-rate).
    let q2Projected: number | null = null;
    if (q2) {
      if (nowQ === 2) {
        const qStart = Date.UTC(nowY, 3, 1); // Apr 1
        const qEnd = Date.UTC(nowY, 6, 1); // Jul 1 (exclusive)
        const totalDays = Math.round((qEnd - qStart) / 86400000); // 91
        const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        let daysElapsed = Math.floor((todayUTC - qStart) / 86400000) + 1;
        if (daysElapsed < 1) daysElapsed = 1;
        if (daysElapsed > totalDays) daysElapsed = totalDays;
        q2Projected = Math.round((q2ToDate / daysElapsed) * totalDays);
      } else {
        // Q2 already closed → projection is the realised total.
        q2Projected = q2ToDate;
      }
    }

    const payload: QuarterlyResponse = {
      ok: true,
      quarters,
      stats: { q1Closed, q2ToDate, q2Projected },
    };
    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch quarterly", detail: err?.message });
  }
});

export default router;
