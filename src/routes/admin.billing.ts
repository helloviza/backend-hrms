import express, { Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import logger from "../utils/logger.js";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import User from "../models/User.js";

const router = express.Router();
router.use(requireAuth);

/* Allow admin (full access) OR sbtEnabled user (scoped to their customerId) */
async function requireAdminOrSBT(req: Request, res: Response, next: NextFunction) {
  const user: any = (req as any).user;
  const roles: string[] = [
    ...(Array.isArray(user?.roles) ? user.roles : []),
    ...(user?.role ? [user.role] : []),
  ].map((r: string) => String(r).toUpperCase().replace(/[\s_-]/g, ""));

  const adminRoles = ["ADMIN", "SUPERADMIN", "HR", "HRADMIN", "OPS"];
  if (roles.some((r) => adminRoles.includes(r))) return next(); // admin — full access

  // Check sbtEnabled for non-admin users
  const sub = String(user?.sub || user?._id || user?.id || "");
  if (!sub) return res.status(403).json({ error: "Access denied" });

  const dbUser: any = await User.findById(sub).select("sbtEnabled customerId canViewBilling").lean();
  if (dbUser?.sbtEnabled === true && dbUser?.customerId) {
    if (dbUser?.canViewBilling !== true) {
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
        SBTBooking.find(filter).sort({ bookedAt: -1 }).skip(skip).limit(limit).lean().exec(),
        SBTBooking.countDocuments(filter).exec(),
      ]);
    }
    if (type === "all" || type === "hotels") {
      [hotels, totalHotels] = await Promise.all([
        SBTHotelBooking.find(filter).sort({ bookedAt: -1 }).skip(skip).limit(limit).lean().exec(),
        SBTHotelBooking.countDocuments(filter).exec(),
      ]);
    }

    // user lookup
    const userIds = [
      ...flights.map((f: any) => f.userId),
      ...hotels.map((h: any) => h.userId),
    ];
    const userMap = await buildUserLookup(userIds);

    const enrich = (doc: any) => ({
      ...doc,
      _user: userMap[String(doc.userId)] || { name: "", email: "" },
    });

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

    res.json({
      totalFlightBookings: flights.length,
      totalHotelBookings: hotels.length,
      totalFlightSpend,
      totalHotelSpend,
      totalSpend: totalFlightSpend + totalHotelSpend,
      cancelledCount,
      failedCount,
      topBookers,
    });
  } catch (err: any) {
    logger.error("admin.billing:summary failed", { error: err?.message, stack: err?.stack });
    res.status(500).json({ error: "Failed to fetch summary", detail: err?.message });
  }
});

export default router;
