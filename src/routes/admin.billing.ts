import express, { Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import logger from "../utils/logger.js";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import User from "../models/User.js";
import { scopedFindById } from "../middleware/scopedFindById.js";

const router = express.Router();
router.use(requireAuth);
router.use(requireWorkspace);

/* Allow admin (full access) OR sbtEnabled user (scoped to their customerId).
 * WORKSPACE_LEADER users bypass the canViewBilling flag — they always get
 * workspace-scoped billing access. */
async function requireAdminOrSBT(req: Request, res: Response, next: NextFunction) {
  const user: any = (req as any).user;
  const roles: string[] = [
    ...(Array.isArray(user?.roles) ? user.roles : []),
    ...(user?.role ? [user.role] : []),
  ].map((r: string) => String(r).toUpperCase().replace(/[\s_-]/g, ""));

  const adminRoles = ["ADMIN", "SUPERADMIN", "HR", "HRADMIN", "OPS"];
  if (roles.some((r) => adminRoles.includes(r))) return next(); // admin — full access

  // Detect WORKSPACE_LEADER via roles array or JWT customerMemberRole claim
  const isWL =
    roles.includes("WORKSPACELEADER") ||
    String(user?.customerMemberRole || "").toUpperCase().replace(/[\s_-]/g, "") === "WORKSPACELEADER";

  // Check sbtEnabled / WL for non-admin users
  const sub = String(user?.sub || user?._id || user?.id || "");
  if (!sub) return res.status(403).json({ error: "Access denied" });

  const dbUser: any = await User.findOne({ _id: sub, workspaceId: (req as any).workspaceObjectId }).select("sbtEnabled customerId canViewBilling").lean();

  console.log('[BILLING AUTH]', {
    roles: (req as any).user?.roles,
    customerMemberRole: (req as any).user?.customerMemberRole,
    isWL,
    customerId: dbUser?.customerId,
    sbtEnabled: dbUser?.sbtEnabled,
    canViewBilling: dbUser?.canViewBilling,
  });

  if (dbUser?.customerId && (dbUser?.sbtEnabled === true || isWL)) {
    // WL bypasses canViewBilling; regular SBT users still need the flag
    if (!isWL && dbUser?.canViewBilling !== true) {
      return res.status(403).json({
        error: "Billing access not enabled for your account.",
        code: "BILLING_ACCESS_DENIED",
      });
    }
    (req as any).sbtCustomerId = String(dbUser.customerId);
    return next();
  }

  return res.status(403).json({ error: "Access denied" });
}

/* =========================================================
 * Helpers
 * ======================================================= */

function buildDateFilter(from?: string, to?: string) {
  const f: any = {};
  if (from) f.$gte = new Date(from);
  if (to) f.$lte = new Date(to);
  return Object.keys(f).length ? f : undefined;
}

function buildFilter(q: Record<string, any>, sbtCustomerId?: string) {
  const filter: any = {};
  if (sbtCustomerId) {
    // SBT user: force-scope to their own company — ignore any ?customerId param
    filter.customerId = sbtCustomerId;
  } else if (q.customerId) {
    filter.customerId = q.customerId;
  }
  if (q.status && q.status !== "ALL") {
    filter.status = q.status;
  }
  // No status param or status=ALL → no filter, return everything
  const dateRange = buildDateFilter(q.from as string, q.to as string);
  if (dateRange) filter.bookedAt = dateRange;
  return filter;
}

async function buildUserLookup(ids: any[]): Promise<Record<string, { name: string; email: string }>> {
  if (!ids.length) return {};
  const users = await User.find({ _id: { $in: ids } }, { _id: 1, name: 1, firstName: 1, lastName: 1, email: 1 })
    .lean()
    .exec();
  const map: Record<string, { name: string; email: string }> = {};
  for (const u of users as any[]) {
    const nm = u.name || [u.firstName, u.lastName].filter(Boolean).join(" ") || "";
    map[String(u._id)] = { name: nm, email: u.email || "" };
  }
  return map;
}

/**
 * Build a $match stage for aggregation pipelines.
 * Excludes CANCELLED/FAILED by default (for spend queries).
 */
function buildMatchStage(q: Record<string, any>, sbtCustomerId?: string): any {
  const match: any = { status: { $nin: ["CANCELLED", "FAILED"] } };
  if (sbtCustomerId) {
    match.customerId = sbtCustomerId;
  } else if (q.customerId) {
    match.customerId = q.customerId;
  }
  const dateRange = buildDateFilter(q.from as string, q.to as string);
  if (dateRange) match.bookedAt = dateRange;
  return match;
}

function csvEscape(v: any): string {
  const s = String(v ?? "").replace(/"/g, '""');
  return `"${s}"`;
}

/* =========================================================
 * GET /bookings
 * ======================================================= */
router.get("/bookings", requireAdminOrSBT, async (req: any, res: any) => {
  try {
    const type = (req.query.type as string) || "all";
    const filter = buildFilter(req.query, req.sbtCustomerId);
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip = (page - 1) * limit;

    let flights: any[] = [];
    let hotels: any[] = [];
    let totalFlights = 0;
    let totalHotels = 0;

    if (type === "all" || type === "flights") {
      [flights, totalFlights] = await Promise.all([
        SBTBooking.find(filter)
          .populate("userId", "name firstName lastName email")
          .sort({ bookedAt: -1 }).skip(skip).limit(limit).lean().exec(),
        SBTBooking.countDocuments(filter).exec(),
      ]);
    }
    if (type === "all" || type === "hotels") {
      [hotels, totalHotels] = await Promise.all([
        SBTHotelBooking.find(filter)
          .populate("userId", "name firstName lastName email")
          .sort({ bookedAt: -1 }).skip(skip).limit(limit).lean().exec(),
        SBTHotelBooking.countDocuments(filter).exec(),
      ]);
    }

    const enrich = (doc: any) => {
      const pop = doc.userId && typeof doc.userId === "object" ? doc.userId : null;
      const uid = pop ? String(pop._id) : String(doc.userId || "");
      const name = pop
        ? pop.name || [pop.firstName, pop.lastName].filter(Boolean).join(" ") || ""
        : "";
      const email = pop ? pop.email || "" : "";
      return {
        ...doc,
        userId: uid,
        _user: { name, email },
      };
    };

    const totalCount = totalFlights + totalHotels;
    const totalPages = Math.max(1, Math.ceil(totalCount / limit));
    const totalAmount =
      flights.reduce((s: number, f: any) => s + (f.totalFare || 0), 0) +
      hotels.reduce((s: number, h: any) => s + (h.totalFare || 0), 0);

    res.json({
      flights: flights.map(enrich),
      hotels: hotels.map(enrich),
      totalFlights,
      totalHotels,
      totalAmount,
      page,
      totalPages,
    });
  } catch (err: any) {
    logger.error("admin.billing:bookings failed", { error: err?.message, stack: err?.stack });
    res.status(500).json({ error: "Failed to fetch bookings", detail: err?.message });
  }
});

/* =========================================================
 * GET /bookings/export.csv
 * ======================================================= */
router.get("/bookings/export.csv", requireAdminOrSBT, async (req: any, res: any) => {
  try {
    const type = (req.query.type as string) || "all";
    const filter = buildFilter(req.query, req.sbtCustomerId);

    let flights: any[] = [];
    let hotels: any[] = [];

    if (type === "all" || type === "flights") {
      flights = await SBTBooking.find(filter).sort({ bookedAt: -1 }).lean().exec();
    }
    if (type === "all" || type === "hotels") {
      hotels = await SBTHotelBooking.find(filter).sort({ bookedAt: -1 }).lean().exec();
    }

    const userIds = [
      ...flights.map((f: any) => f.userId),
      ...hotels.map((h: any) => h.userId),
    ];
    const userMap = await buildUserLookup(userIds);

    const lines: string[] = [];

    if (type === "all") {
      lines.push("Type,BookingId,PNR/ConfirmationNo,UserName,UserEmail,Route/Hotel,BookedAt,Amount,Status,CustomerId");
      for (const f of flights) {
        const u = userMap[String(f.userId)] || { name: "", email: "" };
        lines.push([
          csvEscape("Flight"),
          csvEscape(f.bookingId),
          csvEscape(f.pnr),
          csvEscape(u.name),
          csvEscape(u.email),
          csvEscape(`${f.origin?.city} → ${f.destination?.city}`),
          csvEscape(f.bookedAt),
          csvEscape(f.totalFare),
          csvEscape(f.status),
          csvEscape(f.customerId || ""),
        ].join(","));
      }
      for (const h of hotels) {
        const u = userMap[String(h.userId)] || { name: "", email: "" };
        lines.push([
          csvEscape("Hotel"),
          csvEscape(h.bookingId),
          csvEscape(h.confirmationNo),
          csvEscape(u.name),
          csvEscape(u.email),
          csvEscape(h.hotelName),
          csvEscape(h.bookedAt),
          csvEscape(h.totalFare),
          csvEscape(h.status),
          csvEscape(h.customerId || ""),
        ].join(","));
      }
    } else if (type === "flights") {
      lines.push("BookingId,PNR,UserName,UserEmail,Origin,Destination,BookedAt,Amount,Status,CustomerId");
      for (const f of flights) {
        const u = userMap[String(f.userId)] || { name: "", email: "" };
        lines.push([
          csvEscape(f.bookingId),
          csvEscape(f.pnr),
          csvEscape(u.name),
          csvEscape(u.email),
          csvEscape(f.origin?.city),
          csvEscape(f.destination?.city),
          csvEscape(f.bookedAt),
          csvEscape(f.totalFare),
          csvEscape(f.status),
          csvEscape(f.customerId || ""),
        ].join(","));
      }
    } else {
      lines.push("BookingId,ConfirmationNo,UserName,UserEmail,HotelName,CheckIn,CheckOut,BookedAt,Amount,Status,CustomerId");
      for (const h of hotels) {
        const u = userMap[String(h.userId)] || { name: "", email: "" };
        lines.push([
          csvEscape(h.bookingId),
          csvEscape(h.confirmationNo),
          csvEscape(u.name),
          csvEscape(u.email),
          csvEscape(h.hotelName),
          csvEscape(h.checkIn),
          csvEscape(h.checkOut),
          csvEscape(h.bookedAt),
          csvEscape(h.totalFare),
          csvEscape(h.status),
          csvEscape(h.customerId || ""),
        ].join(","));
      }
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="billing-export-${Date.now()}.csv"`);
    res.send(lines.join("\n"));
  } catch (err: any) {
    logger.error("admin.billing:export failed", { error: err?.message, stack: err?.stack });
    res.status(500).json({ error: "Failed to export bookings", detail: err?.message });
  }
});

/* =========================================================
 * GET /summary
 * ======================================================= */
router.get("/summary", requireAdminOrSBT, async (req: any, res: any) => {
  try {
    const filter = buildFilter(req.query, req.sbtCustomerId);

    const [flights, hotels] = await Promise.all([
      SBTBooking.find(filter).lean().exec(),
      SBTHotelBooking.find(filter).lean().exec(),
    ]);

    const totalFlightSpend = flights.reduce((s: number, f: any) => s + (f.totalFare || 0), 0);
    const totalHotelSpend = hotels.reduce((s: number, h: any) => s + (h.totalFare || 0), 0);

    const cancelledCount =
      flights.filter((f: any) => f.status === "CANCELLED" || f.status === "FAILED").length +
      hotels.filter((h: any) => h.status === "CANCELLED" || h.status === "FAILED").length;

    const failedCount =
      flights.filter((f: any) => f.status === "FAILED").length +
      hotels.filter((h: any) => h.status === "FAILED").length;

    // Top bookers
    const bookerMap: Record<string, { count: number; amount: number }> = {};
    for (const f of flights) {
      const key = String((f as any).userId);
      if (!bookerMap[key]) bookerMap[key] = { count: 0, amount: 0 };
      bookerMap[key].count++;
      bookerMap[key].amount += (f as any).totalFare || 0;
    }
    for (const h of hotels) {
      const key = String((h as any).userId);
      if (!bookerMap[key]) bookerMap[key] = { count: 0, amount: 0 };
      bookerMap[key].count++;
      bookerMap[key].amount += (h as any).totalFare || 0;
    }

    const sorted = Object.entries(bookerMap)
      .sort((a, b) => b[1].amount - a[1].amount)
      .slice(0, 5);

    const userMap = await buildUserLookup(sorted.map(([id]) => id));
    const topBookers = sorted.map(([id, data]) => ({
      name: userMap[id]?.name || "",
      email: userMap[id]?.email || "",
      count: data.count,
      amount: data.amount,
    }));

    // New summary fields
    const flightTrips = flights.filter((f: any) => f.status === "CONFIRMED").length;
    const hotelTrips = hotels.filter((h: any) => h.status === "CONFIRMED").length;
    const cancelledSpend =
      flights
        .filter((f: any) => f.status === "CANCELLED")
        .reduce((s: number, f: any) => s + (f.totalFare || 0), 0) +
      hotels
        .filter((h: any) => h.status === "CANCELLED")
        .reduce((s: number, h: any) => s + (h.totalFare || 0), 0);

    // MoM growth calculation
    const currentSpend = totalFlightSpend + totalHotelSpend;
    let momGrowth = 0;
    const now = new Date();
    const periodMs =
      filter.bookedAt?.$gte && filter.bookedAt?.$lte
        ? new Date(filter.bookedAt.$lte).getTime() - new Date(filter.bookedAt.$gte).getTime()
        : 30 * 24 * 60 * 60 * 1000;
    const curEnd = filter.bookedAt?.$gte ? new Date(filter.bookedAt.$gte) : now;
    const prevFilter: any = { ...filter };
    prevFilter.bookedAt = {
      $gte: new Date(curEnd.getTime() - periodMs),
      $lte: new Date(curEnd.getTime() - 1),
    };

    const [prevFlights, prevHotels] = await Promise.all([
      SBTBooking.find(prevFilter).lean().exec(),
      SBTHotelBooking.find(prevFilter).lean().exec(),
    ]);
    const prevSpend =
      prevFlights.reduce((s: number, f: any) => s + (f.totalFare || 0), 0) +
      prevHotels.reduce((s: number, h: any) => s + (h.totalFare || 0), 0);
    if (prevSpend > 0) {
      momGrowth = Math.round(((currentSpend - prevSpend) / prevSpend) * 10000) / 100;
    }

    res.json({
      totalFlightBookings: flights.length,
      totalHotelBookings: hotels.length,
      totalFlightSpend,
      totalHotelSpend,
      totalSpend: currentSpend,
      cancelledCount,
      failedCount,
      topBookers,
      flightTrips,
      hotelTrips,
      cancelledSpend,
      momGrowth,
    });
  } catch (err: any) {
    logger.error("admin.billing:summary failed", { error: err?.message, stack: err?.stack });
    res.status(500).json({ error: "Failed to fetch summary", detail: err?.message });
  }
});

/* =========================================================
 * GET /spend-trend
 * ======================================================= */
router.get("/spend-trend", requireAdminOrSBT, async (req: any, res: any) => {
  try {
    const match = buildMatchStage(req.query, req.sbtCustomerId);

    const datePipeline: any[] = [
      { $match: match },
      {
        $group: {
          _id: {
            y: { $year: "$bookedAt" },
            m: { $month: "$bookedAt" },
            d: { $dayOfMonth: "$bookedAt" },
          },
          spend: { $sum: "$totalFare" },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } },
    ];

    const [flightAgg, hotelAgg] = await Promise.all([
      SBTBooking.aggregate(datePipeline).exec(),
      SBTHotelBooking.aggregate(datePipeline).exec(),
    ]);

    const dateKey = (r: any) =>
      `${r._id.y}-${String(r._id.m).padStart(2, "0")}-${String(r._id.d).padStart(2, "0")}`;

    const merged: Record<string, { flights: number; hotels: number }> = {};
    for (const r of flightAgg) {
      const k = dateKey(r);
      if (!merged[k]) merged[k] = { flights: 0, hotels: 0 };
      merged[k].flights += r.spend;
    }
    for (const r of hotelAgg) {
      const k = dateKey(r);
      if (!merged[k]) merged[k] = { flights: 0, hotels: 0 };
      merged[k].hotels += r.spend;
    }

    const trend = Object.entries(merged)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({
        date,
        flights: v.flights,
        hotels: v.hotels,
        total: v.flights + v.hotels,
      }));

    res.json({ ok: true, trend });
  } catch (err: any) {
    logger.error("admin.billing:spend-trend failed", { error: err?.message, stack: err?.stack });
    res.status(500).json({ error: "Failed to fetch spend trend", detail: err?.message });
  }
});

/* =========================================================
 * GET /spend-by-service
 * ======================================================= */
router.get("/spend-by-service", requireAdminOrSBT, async (req: any, res: any) => {
  try {
    const confirmedMatch = { ...buildMatchStage(req.query, req.sbtCustomerId), status: "CONFIRMED" };

    // Base filter (with date/customer but no status restriction)
    const baseMatch: any = {};
    const sbtCid = req.sbtCustomerId as string | undefined;
    if (sbtCid) {
      baseMatch.customerId = sbtCid;
    } else if (req.query.customerId) {
      baseMatch.customerId = req.query.customerId;
    }
    const dateRange = buildDateFilter(req.query.from as string, req.query.to as string);
    if (dateRange) baseMatch.bookedAt = dateRange;

    const statusPipeline = (statuses: string[]): any[] => [
      { $match: { ...baseMatch, status: { $in: statuses } } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ];

    const [flightConf, hotelConf, flightStatuses, hotelStatuses] = await Promise.all([
      SBTBooking.aggregate([
        { $match: confirmedMatch },
        { $group: { _id: null, spend: { $sum: "$totalFare" }, trips: { $sum: 1 } } },
      ]).exec(),
      SBTHotelBooking.aggregate([
        { $match: confirmedMatch },
        { $group: { _id: null, spend: { $sum: "$totalFare" }, trips: { $sum: 1 } } },
      ]).exec(),
      SBTBooking.aggregate(statusPipeline(["CANCELLED", "FAILED", "PENDING"])).exec(),
      SBTHotelBooking.aggregate(statusPipeline(["CANCELLED", "FAILED", "PENDING"])).exec(),
    ]);

    const statusCounts: Record<string, number> = {};
    for (const s of [...flightStatuses, ...hotelStatuses]) {
      statusCounts[s._id] = (statusCounts[s._id] || 0) + s.count;
    }

    res.json({
      ok: true,
      flights: {
        spend: flightConf[0]?.spend || 0,
        trips: flightConf[0]?.trips || 0,
      },
      hotels: {
        spend: hotelConf[0]?.spend || 0,
        trips: hotelConf[0]?.trips || 0,
      },
      cancelledCount: statusCounts["CANCELLED"] || 0,
      failedCount: statusCounts["FAILED"] || 0,
      pendingCount: statusCounts["PENDING"] || 0,
    });
  } catch (err: any) {
    logger.error("admin.billing:spend-by-service failed", { error: err?.message, stack: err?.stack });
    res.status(500).json({ error: "Failed to fetch spend by service", detail: err?.message });
  }
});

/* =========================================================
 * GET /top-destinations
 * ======================================================= */
router.get("/top-destinations", requireAdminOrSBT, async (req: any, res: any) => {
  try {
    const confirmedMatch = { ...buildMatchStage(req.query, req.sbtCustomerId), status: "CONFIRMED" };

    const [flightDest, hotelDest] = await Promise.all([
      SBTBooking.aggregate([
        { $match: confirmedMatch },
        {
          $group: {
            _id: "$destination.city",
            spend: { $sum: "$totalFare" },
            trips: { $sum: 1 },
          },
        },
      ]).exec(),
      SBTHotelBooking.aggregate([
        { $match: confirmedMatch },
        {
          $group: {
            _id: "$cityName",
            spend: { $sum: "$totalFare" },
            trips: { $sum: 1 },
          },
        },
      ]).exec(),
    ]);

    const merged: Record<string, { spend: number; trips: number }> = {};
    for (const r of flightDest) {
      const city = r._id || "Unknown";
      if (!merged[city]) merged[city] = { spend: 0, trips: 0 };
      merged[city].spend += r.spend;
      merged[city].trips += r.trips;
    }
    for (const r of hotelDest) {
      const city = r._id || "Unknown";
      if (!merged[city]) merged[city] = { spend: 0, trips: 0 };
      merged[city].spend += r.spend;
      merged[city].trips += r.trips;
    }

    const destinations = Object.entries(merged)
      .map(([city, v]) => ({ city, spend: v.spend, trips: v.trips }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 10);

    res.json({ ok: true, destinations });
  } catch (err: any) {
    logger.error("admin.billing:top-destinations failed", { error: err?.message, stack: err?.stack });
    res.status(500).json({ error: "Failed to fetch top destinations", detail: err?.message });
  }
});

/* =========================================================
 * GET /top-travellers
 * ======================================================= */
router.get("/top-travellers", requireAdminOrSBT, async (req: any, res: any) => {
  try {
    const confirmedMatch = { ...buildMatchStage(req.query, req.sbtCustomerId), status: "CONFIRMED" };

    const userPipeline: any[] = [
      { $match: confirmedMatch },
      {
        $group: {
          _id: "$userId",
          spend: { $sum: "$totalFare" },
          trips: { $sum: 1 },
        },
      },
    ];

    const [flightUsers, hotelUsers] = await Promise.all([
      SBTBooking.aggregate(userPipeline).exec(),
      SBTHotelBooking.aggregate(userPipeline).exec(),
    ]);

    const merged: Record<string, { flightSpend: number; hotelSpend: number; flightTrips: number; hotelTrips: number }> = {};
    for (const r of flightUsers) {
      const uid = String(r._id);
      if (!merged[uid]) merged[uid] = { flightSpend: 0, hotelSpend: 0, flightTrips: 0, hotelTrips: 0 };
      merged[uid].flightSpend += r.spend;
      merged[uid].flightTrips += r.trips;
    }
    for (const r of hotelUsers) {
      const uid = String(r._id);
      if (!merged[uid]) merged[uid] = { flightSpend: 0, hotelSpend: 0, flightTrips: 0, hotelTrips: 0 };
      merged[uid].hotelSpend += r.spend;
      merged[uid].hotelTrips += r.trips;
    }

    const top = Object.entries(merged)
      .map(([uid, v]) => ({
        userId: uid,
        flightSpend: v.flightSpend,
        hotelSpend: v.hotelSpend,
        totalSpend: v.flightSpend + v.hotelSpend,
        tripCount: v.flightTrips + v.hotelTrips,
      }))
      .sort((a, b) => b.totalSpend - a.totalSpend)
      .slice(0, 10);

    // Lookup user details
    const userIds = top.map((t) => t.userId);
    const users = await User.find(
      { _id: { $in: userIds } },
      { _id: 1, name: 1, firstName: 1, lastName: 1, email: 1, department: 1, designation: 1 },
    )
      .lean()
      .exec();

    const uMap: Record<string, any> = {};
    for (const u of users as any[]) {
      uMap[String(u._id)] = u;
    }

    const travellers = top.map((t) => {
      const u = uMap[t.userId] || {};
      const name = u.name || [u.firstName, u.lastName].filter(Boolean).join(" ") || "";
      return {
        userId: t.userId,
        name,
        email: u.email || "",
        department: u.department || "",
        designation: u.designation || "",
        flightSpend: t.flightSpend,
        hotelSpend: t.hotelSpend,
        totalSpend: t.totalSpend,
        tripCount: t.tripCount,
      };
    });

    res.json({ ok: true, travellers });
  } catch (err: any) {
    logger.error("admin.billing:top-travellers failed", { error: err?.message, stack: err?.stack });
    res.status(500).json({ error: "Failed to fetch top travellers", detail: err?.message });
  }
});

/* =========================================================
 * GET /spend-by-department
 * ======================================================= */
router.get("/spend-by-department", requireAdminOrSBT, async (req: any, res: any) => {
  try {
    const confirmedMatch = { ...buildMatchStage(req.query, req.sbtCustomerId), status: "CONFIRMED" };

    const deptPipeline: any[] = [
      { $match: confirmedMatch },
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
        $group: {
          _id: { $ifNull: ["$_user.department", "Unassigned"] },
          spend: { $sum: "$totalFare" },
          trips: { $sum: 1 },
          userIds: { $addToSet: "$userId" },
        },
      },
    ];

    const [flightDepts, hotelDepts] = await Promise.all([
      SBTBooking.aggregate(deptPipeline).exec(),
      SBTHotelBooking.aggregate(deptPipeline).exec(),
    ]);

    const merged: Record<string, { spend: number; trips: number; userIds: Set<string> }> = {};
    const addResult = (rows: any[]) => {
      for (const r of rows) {
        const dept = r._id || "Unassigned";
        if (!merged[dept]) merged[dept] = { spend: 0, trips: 0, userIds: new Set() };
        merged[dept].spend += r.spend;
        merged[dept].trips += r.trips;
        for (const uid of r.userIds) merged[dept].userIds.add(String(uid));
      }
    };
    addResult(flightDepts);
    addResult(hotelDepts);

    const departments = Object.entries(merged)
      .map(([department, v]) => ({
        department,
        spend: v.spend,
        trips: v.trips,
        travellers: v.userIds.size,
      }))
      .sort((a, b) => b.spend - a.spend);

    res.json({ ok: true, departments });
  } catch (err: any) {
    logger.error("admin.billing:spend-by-department failed", { error: err?.message, stack: err?.stack });
    res.status(500).json({ error: "Failed to fetch spend by department", detail: err?.message });
  }
});

export default router;
