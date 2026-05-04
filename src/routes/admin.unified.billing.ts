// apps/backend/src/routes/admin.unified.billing.ts
import { Router } from "express";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import TravelBooking from "../models/TravelBooking.js";
import User from "../models/User.js";
import Employee from "../models/Employee.js";
import CustomerMember from "../models/CustomerMember.js";

const router = Router();
router.use(requireAuth);
router.use(requireWorkspace);

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
  // GLOBAL scope (admin/superadmin) with no own filter — scope to workspace if set
  const effectiveFilter = (req.workspaceObjectId && Object.keys(matchFilter).length === 0)
    ? { workspaceId: req.workspaceObjectId }
    : matchFilter;
  Object.assign(match, effectiveFilter);

  return match;
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

    // MoM growth
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

    res.json({
      totalSpend,
      confirmedTrips,
      cancelledTrips,
      failedTrips,
      pendingTrips,
      uniqueTravellers,
      cancelledSpend,
      momGrowth,
      byService,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch summary", detail: err?.message });
  }
});

/* ═════════════════════════════════════════════════════════════
 * GET /spend-trend
 * ═════════════════════════════════════════════════════════════ */
router.get("/spend-trend", async (req: Request, res: Response) => {
  try {
    const match = { ...buildScopedMatch(req), status: "CONFIRMED" };
    const df = resolveDateField(req as any);

    const rows = await TravelBooking.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: "%Y-%m-%d", date: `$${df}` } },
            service: "$service",
          },
          amount: { $sum: "$amount" },
        },
      },
      { $sort: { "_id.date": 1 } },
    ]).exec();

    const dateMap: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      const d = r._id.date;
      if (!dateMap[d]) dateMap[d] = {};
      dateMap[d][r._id.service] = r.amount;
    }

    const trend = Object.keys(dateMap)
      .sort()
      .map((date) => {
        const entry: any = { date };
        let total = 0;
        for (const svc of ALL_SERVICES) {
          entry[svc] = dateMap[date][svc] || 0;
          total += entry[svc];
        }
        entry.total = total;
        return entry;
      });

    res.json({ ok: true, trend });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch spend trend", detail: err?.message });
  }
});

/* ═════════════════════════════════════════════════════════════
 * GET /top-destinations
 * ═════════════════════════════════════════════════════════════ */
router.get("/top-destinations", async (req: Request, res: Response) => {
  try {
    const match = {
      ...buildScopedMatch(req),
      status: "CONFIRMED",
      destination: { $ne: "" },
    };

    const rows = await TravelBooking.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$destination",
          spend: { $sum: "$amount" },
          trips: { $sum: 1 },
          services: { $addToSet: "$service" },
        },
      },
      { $sort: { spend: -1 } },
      { $limit: 10 },
    ]).exec();

    const destinations = rows.map((r) => ({
      destination: r._id,
      spend: r.spend,
      trips: r.trips,
      services: r.services,
    }));

    res.json({ ok: true, destinations });
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
        $group: {
          _id: { userId: "$userId", service: "$service" },
          spend: { $sum: "$amount" },
          trips: { $sum: 1 },
        },
      },
      {
        $group: {
          _id: "$_id.userId",
          totalSpend: { $sum: "$spend" },
          tripCount: { $sum: "$trips" },
          services: { $addToSet: "$_id.service" },
          byServiceArr: {
            $push: { service: "$_id.service", spend: "$spend" },
          },
        },
      },
      { $sort: { totalSpend: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "_user",
        },
      },
      { $unwind: { path: "$_user", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "employees",
          let: { uid: "$_id" },
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
      const name =
        u.name || [u.firstName, u.lastName].filter(Boolean).join(" ") || "";
      const byService: Record<string, number> = {};
      for (const s of r.byServiceArr || []) byService[s.service] = s.spend;

      return {
        userId: r._id,
        name,
        email: u.email || "",
        department: emp.department || u.department || "",
        designation: emp.designation || u.designation || "",
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
        $group: {
          _id: {
            dept: { $ifNull: ["$_emp.department", "Unassigned"] },
            service: "$service",
          },
          spend: { $sum: "$amount" },
          trips: { $sum: 1 },
          userIds: { $addToSet: "$userId" },
        },
      },
      {
        $group: {
          _id: "$_id.dept",
          spend: { $sum: "$spend" },
          trips: { $sum: "$trips" },
          userIds: { $push: "$userIds" },
          byServiceArr: {
            $push: { service: "$_id.service", spend: "$spend" },
          },
        },
      },
      { $sort: { spend: -1 } },
    ]).exec();

    const departments = rows.map((r) => {
      const allIds = new Set<string>();
      for (const arr of r.userIds || []) {
        for (const id of arr) allIds.add(String(id));
      }
      const byService: Record<string, number> = {};
      for (const s of r.byServiceArr || []) byService[s.service] = s.spend;

      return {
        department: r._id,
        spend: r.spend,
        trips: r.trips,
        travellers: allIds.size,
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
      const name = pop
        ? pop.name || [pop.firstName, pop.lastName].filter(Boolean).join(" ") || ""
        : "";
      const email = pop ? pop.email || "" : "";

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
        traveller: { name, email, department: empMap[uid] || "" },
        metadata: b.metadata,
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

    // Batch-lookup travelerId by traveller email
    const emails = [...new Set(
      (bookings as any[])
        .map((b) => (b.userId && typeof b.userId === "object" ? b.userId.email : ""))
        .filter(Boolean)
        .map((e: string) => String(e).toLowerCase()),
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
      const name = pop
        ? pop.name || [pop.firstName, pop.lastName].filter(Boolean).join(" ") || ""
        : "";
      const email = pop ? String(pop.email || "").toLowerCase() : "";

      lines.push(
        [
          csvEscape(b.bookedAt),
          csvEscape(b.service),
          csvEscape(name),
          csvEscape(email),
          csvEscape(travelerMap.get(email) || ""),
          csvEscape(empMap[uid] || ""),
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

export default router;
