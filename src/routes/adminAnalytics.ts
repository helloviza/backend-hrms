// apps/backend/src/routes/adminAnalytics.ts
import express from "express";
import Employee from "../models/Employee.js";
import Attendance from "../models/Attendance.js";
import Leave from "../models/Leave.js";
import Vendor from "../models/Vendor.js";

const router = express.Router();

/**
 * Parse time window from query.
 *
 * Supports:
 *   - mode=overall (default)
 *   - mode=month&month=YYYY-MM
 *   - mode=range&from=YYYY-MM-DD&to=YYYY-MM-DD
 *   - (extra) mode=quarter | mode=year
 */
function parseDateRange(query: any) {
  const rawMode = String(query.mode || "overall").toLowerCase();
  const now = new Date();
  let mode = rawMode;
  let from: Date | null = null;
  let to: Date | null = now;

  if (rawMode === "month") {
    const monthStr = typeof query.month === "string" ? query.month : "";
    if (monthStr && /^\d{4}-\d{2}$/.test(monthStr)) {
      const [y, m] = monthStr.split("-").map((x: string) => parseInt(x, 10));
      if (!Number.isNaN(y) && !Number.isNaN(m)) {
        from = new Date(y, m - 1, 1);
        to = new Date(y, m, 0, 23, 59, 59, 999);
      }
    }
    if (!from) {
      // Fallback: current month
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      to = now;
    }
  } else if (rawMode === "range") {
    const fromStr = typeof query.from === "string" ? query.from : "";
    const toStr = typeof query.to === "string" ? query.to : "";

    if (fromStr) {
      const d = new Date(fromStr);
      if (!Number.isNaN(d.getTime())) from = d;
    }
    if (toStr) {
      const d = new Date(toStr);
      if (!Number.isNaN(d.getTime())) to = d;
    }
    if (!from && !to) {
      mode = "overall";
      from = null;
      to = now;
    }
  } else if (rawMode === "quarter") {
    const q = Math.floor(now.getMonth() / 3);
    from = new Date(now.getFullYear(), q * 3, 1);
    to = now;
  } else if (rawMode === "year") {
    from = new Date(now.getFullYear(), 0, 1);
    to = now;
  } else {
    // overall – no from/to filter
    mode = "overall";
    from = null;
    to = now;
  }

  return { mode, from, to };
}

/**
 * GET /api/admin/analytics
 *
 * Query:
 *   - mode=overall|month|range|quarter|year
 *   - month=YYYY-MM (when mode=month)
 *   - from=YYYY-MM-DD&to=YYYY-MM-DD (when mode=range)
 *   - dimension=overall|manager|department  (currently only overall is used)
 */
router.get("/analytics", async (req, res, next) => {
  try {
    const { mode, from, to } = parseDateRange(req.query);
    const dimension = String(req.query.dimension || "overall").toLowerCase();

    const dateFilter =
      from && to
        ? {
            $gte: from,
            $lte: to,
          }
        : undefined;

    const [
      headcount,
      vendors,
      attendanceRows,
      leaveRows,
      attritionCount,
    ] = await Promise.all([
      // Active employees
      Employee.countDocuments({
        $or: [{ isActive: { $exists: false } }, { isActive: true }],
      }),

      // All vendors
      Vendor.find({}).lean(),

      // Attendance in range (if range applied)
      Attendance.find(
        dateFilter ? { date: dateFilter } : {},
      ).lean(),

      // Leaves in range (if range applied)
      Leave.find(
        dateFilter ? { startDate: dateFilter } : {},
      ).lean(),

      // Attrition: employees with exit / resigned / terminated status
      Employee.countDocuments({
        status: { $in: ["EXITED", "RESIGNED", "TERMINATED"] },
        ...(dateFilter
          ? {
              updatedAt: {
                $gte: from!,
                $lte: to!,
              },
            }
          : {}),
      }),
    ]);

    // Absenteeism: % of attendance records marked as absent / unpaid
    let absenteeism = 0;
    if (attendanceRows.length) {
      const absentCount = attendanceRows.filter((row: any) => {
        const st = String(row.status || "").toUpperCase();
        return st === "ABSENT" || st === "A" || st === "LWP" || st === "UNPAID";
      }).length;

      absenteeism = Math.round((absentCount / attendanceRows.length) * 100);
    }

    const overall = {
      headcount,
      vendors: vendors.length,
      attrition: attritionCount,
      absenteeism,
      leavesCount: leaveRows.length,
    };

    // ───────── Vendor business breakdown (FLIGHTS / HOTELS / VISA / etc.) ──────
    const businessMap: Record<string, number> = {};
    for (const v of vendors as any[]) {
      const list: string[] =
        Array.isArray(v.businessAssociations) && v.businessAssociations.length
          ? v.businessAssociations
          : ["OTHER"];

      for (const raw of list) {
        const key = String(raw || "OTHER").toUpperCase();
        businessMap[key] = (businessMap[key] || 0) + 1;
      }
    }

    const vendorBusiness = Object.entries(businessMap)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);

    // Frontend expects:
    //  - top-level keys: attrition, absenteeism, headcount, vendors
    //  - kpis.breakdown: array of rows with label + headcount / attrition / absenteeism
    let breakdown: any[] = [];

    if (dimension === "overall") {
      breakdown = vendorBusiness.map((item) => ({
        label: item.label, // e.g. "FLIGHTS"
        headcount: item.count, // we treat this as "count of vendors"
        attrition: null,
        absenteeism: null,
      }));
    } else {
      // Manager / department breakdown can be added later
      breakdown = [];
    }

    res.json({
      ok: true,
      mode,
      dimension,
      from: from ? from.toISOString() : null,
      to: to ? to.toISOString() : null,

      // flat metrics – used by AdminAnalytics.tsx
      headcount: overall.headcount,
      attrition: overall.attrition,
      absenteeism: overall.absenteeism,
      vendors: overall.vendors,
      leavesCount: overall.leavesCount,

      // extra structures – for richer UIs if needed
      overall,
      vendorBusiness,
      breakdown,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
