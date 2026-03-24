// apps/backend/src/routes/admin.ts
import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import Vendor from "../models/Vendor.js";
import Attendance from "../models/Attendance.js";
import Employee from "../models/Employee.js";
import User from "../models/User.js";
import LeaveRequest from "../models/LeaveRequest.js"; // ✅ Correct leave model

const router = Router();

/* -------------------------------------------------------------------------- */
/* Small CSV helpers                                                          */
/* -------------------------------------------------------------------------- */

function toCsvRow(values: (string | number | null | undefined)[]): string {
  return values
    .map((v) => {
      if (v === null || v === undefined) return "";
      const str = String(v);
      if (/[",\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    })
    .join(",");
}

function fmtDate(d: any): string {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yyyy = dt.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function fmtTime(d: any): string {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Parse from/to date out of query. Frontend can send mode, from, to etc. */
function parseRange(q: any): { from?: Date; to?: Date } {
  const fromStr = q.from ? String(q.from) : "";
  const toStr = q.to ? String(q.to) : "";

  let from: Date | undefined;
  let to: Date | undefined;

  if (fromStr) {
    const d = new Date(fromStr);
    if (!Number.isNaN(d.getTime())) from = d;
  }
  if (toStr) {
    const d = new Date(toStr);
    if (!Number.isNaN(d.getTime())) {
      d.setHours(23, 59, 59, 999);
      to = d;
    }
  }

  return { from, to };
}

/* -------------------------------------------------------------------------- */
/* /api/admin/reports/vendors.csv                                             */
/* -------------------------------------------------------------------------- */

router.get("/reports/vendors.csv", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const vendors = await Vendor.find({}).lean().exec();
    console.log("[ADMIN] vendors.csv – total vendors:", vendors.length);

    const header = [
      "Name",
      "Email",
      "Phone",
      "Status",
      "Type",
      "BusinessAssociations",
      "FlightsEnabled",
      "HotelsEnabled",
      "CabsEnabled",
      "VisaEnabled",
      "MiceEventsEnabled",
      "ForexEnabled",
      "EsimsEnabled",
      "HolidaysEnabled",
      "CorporateGiftingEnabled",
      "DecorEnabled",
      "OtherEnabled",
      "CreatedAt",
      "UpdatedAt",
    ];

    const lines: string[] = [toCsvRow(header)];

    for (const v of vendors as any[]) {
      const services: any = v.services || {};
      const row = [
        v.name || "",
        v.email || "",
        v.phone || "",
        v.status || "",
        v.type || "",
        Array.isArray(v.businessAssociations)
          ? v.businessAssociations.join("|")
          : "",
        services.flights?.enabled ? "1" : "0",
        services.hotels?.enabled ? "1" : "0",
        services.cabs?.enabled ? "1" : "0",
        services.visa?.enabled ? "1" : "0",
        services.miceEvents?.enabled ? "1" : "0",
        services.forex?.enabled ? "1" : "0",
        services.esims?.enabled ? "1" : "0",
        services.holidays?.enabled ? "1" : "0",
        services.corporateGifting?.enabled ? "1" : "0",
        services.decor?.enabled ? "1" : "0",
        services.other?.enabled ? "1" : "0",
        v.createdAt ? new Date(v.createdAt).toISOString() : "",
        v.updatedAt ? new Date(v.updatedAt).toISOString() : "",
      ];
      lines.push(toCsvRow(row));
    }

    const csv = lines.join("\n");

    // 🔒 Disable caching so you don't keep seeing old CSVs
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="vendors.csv"',
    );
    return res.status(200).send(csv);
  } catch (err: any) {
    console.error("Admin vendors report error:", err);
    return res
      .status(500)
      .send("error,message\n1,Failed to export vendors report");
  }
});

/* -------------------------------------------------------------------------- */
/* /api/admin/reports/attendance.csv (already working)                        */
/* -------------------------------------------------------------------------- */

router.get(
  "/reports/attendance.csv",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { from, to } = parseRange(req.query);

      const findQuery: any = {};
      if (from && to) {
        const fromYmd = from.toISOString().slice(0, 10);
        const toYmd = to.toISOString().slice(0, 10);
        findQuery.date = { $gte: fromYmd, $lte: toYmd };
      }

      const attendanceRecords: any[] = await Attendance.find(findQuery)
        .lean()
        .exec();
      console.log(
        "[ADMIN] attendance.csv – total records:",
        attendanceRecords.length,
      );

      const userIds = Array.from(
        new Set(
          attendanceRecords
            .map((r) => r.userId)
            .filter(Boolean)
            .map((id: any) => String(id)),
        ),
      );

      const employeeByUserId: Record<string, any> = {};
      const employeeById: Record<string, any> = {};
      const userMap: Record<string, any> = {};

      if (userIds.length) {
        const employees = await Employee.find({
          $or: [{ userId: { $in: userIds } }, { _id: { $in: userIds } }],
        })
          .lean()
          .exec();

        for (const emp of employees as any[]) {
          if (emp.userId) {
            employeeByUserId[String(emp.userId)] = emp;
          }
          if (emp._id) {
            employeeById[String(emp._id)] = emp;
          }
        }

        const users = await User.find({ _id: { $in: userIds } }).lean().exec();
        for (const u of users as any[]) {
          if (u._id) {
            userMap[String(u._id)] = u;
          }
        }
      }

      const header = [
        "EmployeeId",
        "EmployeeName",
        "OfficialEmail",
        "Department",
        "Manager",
        "Date",
        "Status",
        "FirstCheckIn",
        "LastCheckOut",
        "Hours",
        "Source",
        "CreatedAt",
        "UpdatedAt",
      ];

      const lines: string[] = [toCsvRow(header)];

      for (const rec of attendanceRecords) {
        const userKey = rec.userId ? String(rec.userId) : "";

        const emp =
          (userKey && (employeeByUserId[userKey] || employeeById[userKey])) ||
          null;
        const user = (userKey && userMap[userKey]) || null;

        const empName =
          emp?.fullName ||
          [emp?.firstName, emp?.lastName].filter(Boolean).join(" ") ||
          emp?.name ||
          "";
        const userName =
          user?.fullName ||
          [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
          user?.name ||
          "";
        const fullName = empName || userName;

        const officialEmail =
          emp?.officialEmail ||
          emp?.officialEmailCompany ||
          emp?.workEmail ||
          emp?.email ||
          user?.officialEmail ||
          user?.workEmail ||
          user?.email ||
          "";

        const department =
          emp?.department ||
          emp?.departmentName ||
          emp?.dept ||
          emp?.team ||
          user?.department ||
          "";

        const managerName =
          emp?.managerName ||
          emp?.reportingManagerName ||
          emp?.manager ||
          emp?.reportTo ||
          user?.managerName ||
          "";

        const punches = Array.isArray(rec.punches) ? rec.punches.slice() : [];
        punches.sort((a: any, b: any) => {
          const ta =
            a?.ts || a?.time ? new Date(a.ts ?? a.time).getTime() : 0;
          const tb =
            b?.ts || b?.time ? new Date(b.ts ?? b.time).getTime() : 0;
          return ta - tb;
        });

        const firstPunch = punches[0] || null;
        const lastPunch = punches.length ? punches[punches.length - 1] : null;

        const dateVal =
          rec.date ||
          firstPunch?.ts ||
          firstPunch?.time ||
          lastPunch?.ts ||
          lastPunch?.time ||
          null;

        const firstCheckIn = firstPunch?.ts || firstPunch?.time || null;
        const lastCheckOut = lastPunch?.ts || lastPunch?.time || null;

        let hours: number | null = null;
        if (firstCheckIn && lastCheckOut) {
          const start = new Date(firstCheckIn).getTime();
          const end = new Date(lastCheckOut).getTime();
          if (!Number.isNaN(start) && !Number.isNaN(end) && end > start) {
            const diffHrs = (end - start) / (1000 * 60 * 60);
            hours = Math.round(diffHrs * 100) / 100;
          }
        } else if (typeof rec.hours === "number") {
          hours = rec.hours;
        }

        const statusRaw = String(rec.status || "").toUpperCase();
        const status =
          statusRaw || (punches.length > 0 ? "PRESENT" : "ABSENT");

        const source = rec.source || "SYSTEM";

        const createdIso =
          rec.createdAt
            ? new Date(rec.createdAt).toISOString()
            : dateVal
            ? new Date(dateVal).toISOString()
            : "";

        const updatedIso =
          rec.updatedAt ? new Date(rec.updatedAt).toISOString() : createdIso;

        const row = [
          emp?._id ? String(emp._id) : userKey,
          fullName,
          officialEmail,
          department,
          managerName,
          fmtDate(dateVal),
          status,
          fmtTime(firstCheckIn),
          fmtTime(lastCheckOut),
          hours !== null ? String(hours) : "",
          source,
          createdIso,
          updatedIso,
        ];

        lines.push(toCsvRow(row));
      }

      const csv = lines.join("\n");

      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="attendance.csv"',
      );
      return res.status(200).send(csv);
    } catch (err: any) {
      console.error("Admin attendance report error:", err);
      return res
        .status(500)
        .send("error,message\n1,Failed to export attendance report");
    }
  },
);

/* -------------------------------------------------------------------------- */
/* /api/admin/reports/leaves.csv – uses LeaveRequest (all statuses)          */
/* -------------------------------------------------------------------------- */

router.get("/reports/leaves.csv", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  try {
    // Export ALL leave requests in LeaveRequest collection
    const leaveRecords: any[] = await LeaveRequest.find({})
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    console.log(
      "[ADMIN] leaves.csv – total leaveRequests:",
      leaveRecords.length,
    );

    const userIds = Array.from(
      new Set(
        leaveRecords
          .map((r) => r.userId)
          .filter(Boolean)
          .map((id: any) => String(id)),
      ),
    );

    const employeeByUserId: Record<string, any> = {};
    const userMap: Record<string, any> = {};

    if (userIds.length) {
      const employees = await Employee.find({
        userId: { $in: userIds },
      })
        .lean()
        .exec();

      for (const emp of employees as any[]) {
        if (emp.userId) {
          employeeByUserId[String(emp.userId)] = emp;
        }
      }

      const users = await User.find({ _id: { $in: userIds } }).lean().exec();
      for (const u of users as any[]) {
        if (u._id) {
          userMap[String(u._id)] = u;
        }
      }
    }

    const header = [
      "EmployeeId", // Employee._id if available, else userId
      "EmployeeName",
      "OfficialEmail",
      "Department",
      "Status",
      "LeaveType",
      "StartDate",
      "EndDate",
      "Days",
      "Reason",
      "CreatedAt",
      "UpdatedAt",
    ];

    const lines: string[] = [toCsvRow(header)];

    for (const rec of leaveRecords) {
      const userKey = rec.userId ? String(rec.userId) : "";

      const emp = userKey ? employeeByUserId[userKey] : null;
      const user = userKey ? userMap[userKey] : null;

      const empName =
        emp?.fullName ||
        [emp?.firstName, emp?.lastName].filter(Boolean).join(" ") ||
        emp?.name ||
        "";
      const userName =
        user?.fullName ||
        [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
        user?.name ||
        "";
      const fullName = empName || userName;

      const officialEmail =
        emp?.officialEmail ||
        emp?.officialEmailCompany ||
        emp?.workEmail ||
        emp?.email ||
        user?.officialEmail ||
        user?.workEmail ||
        user?.email ||
        "";

      const department =
        emp?.department ||
        emp?.departmentName ||
        emp?.dept ||
        emp?.team ||
        user?.department ||
        "";

      const start = rec.from ? new Date(rec.from) : null;
      const end = rec.to ? new Date(rec.to) : null;

      let days: number | null = null;
      if (typeof rec.days === "number") {
        days = rec.days;
      } else if (
        start &&
        end &&
        !Number.isNaN(start.getTime()) &&
        !Number.isNaN(end.getTime())
      ) {
        const diff = end.getTime() - start.getTime();
        days = Math.round(diff / (1000 * 60 * 60 * 24)) + 1;
      }

      const createdIso =
        rec.createdAt ? new Date(rec.createdAt).toISOString() : "";
      const updatedIso =
        rec.updatedAt ? new Date(rec.updatedAt).toISOString() : createdIso;

      const row = [
        emp?._id ? String(emp._id) : userKey,
        fullName,
        officialEmail,
        department,
        rec.status || "",
        rec.type || "",
        fmtDate(rec.from),
        fmtDate(rec.to),
        days !== null ? String(days) : "",
        rec.reason || "",
        createdIso,
        updatedIso,
      ];

      lines.push(toCsvRow(row));
    }

    const csv = lines.join("\n");

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="leaves.csv"');
    return res.status(200).send(csv);
  } catch (err: any) {
    console.error("Admin leaves report error:", err);
    return res
      .status(500)
      .send("error,message\n1,Failed to export leaves report");
  }
});

export default router;
