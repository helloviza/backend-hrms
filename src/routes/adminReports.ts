// apps/backend/src/routes/adminReports.ts
import express from "express";
import Attendance from "../models/Attendance.js";
import Leave from "../models/Leave.js";
import Vendor from "../models/Vendor.js";

const router = express.Router();

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatDate(d?: Date | string): string {
  if (!d) return "";
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function parseDateRange(query: any) {
  const mode = String(query.mode || "overall").toLowerCase();
  const now = new Date();
  let from: Date | null = null;

  if (mode === "month") {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (mode === "quarter") {
    const q = Math.floor(now.getMonth() / 3);
    from = new Date(now.getFullYear(), q * 3, 1);
  } else if (mode === "year") {
    from = new Date(now.getFullYear(), 0, 1);
  } else {
    from = null;
  }

  return { mode, from, to: now };
}

/* -------------------------------------------------------------------------- */
/* Attendance CSV                                                             */
/* -------------------------------------------------------------------------- */

router.get("/reports/attendance.csv", async (req, res, next) => {
  try {
    const { from, to } = parseDateRange(req.query);
    const dateFilter = from
      ? { date: { $gte: from, $lte: to } }
      : {};

    const rows = await Attendance.find(dateFilter).lean();

    const header = [
      "UserId",
      "EmployeeId",
      "Date",
      "Status",
      "CheckIn",
      "CheckOut",
      "Mode",
      "Source",
      "Notes",
      "CreatedAt",
      "UpdatedAt",
    ];

    const lines: string[] = [];
    lines.push(header.join(","));

    for (const r of rows as any[]) {
      lines.push(
        [
          csvEscape(r.userId),
          csvEscape(r.employeeId),
          csvEscape(formatDate(r.date)),
          csvEscape(r.status),
          csvEscape(formatDate(r.checkIn)),
          csvEscape(formatDate(r.checkOut)),
          csvEscape(r.mode),
          csvEscape(r.source),
          csvEscape(r.notes),
          csvEscape(formatDate(r.createdAt)),
          csvEscape(formatDate(r.updatedAt)),
        ].join(","),
      );
    }

    const csv = lines.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="attendance.csv"',
    );
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------------- */
/* Leaves CSV                                                                 */
/* -------------------------------------------------------------------------- */

router.get("/reports/leaves.csv", async (req, res, next) => {
  try {
    const { from, to } = parseDateRange(req.query);
    const dateFilter = from
      ? { startDate: { $gte: from, $lte: to } }
      : {};

    const rows = await Leave.find(dateFilter).lean();

    const header = [
      "EmployeeId",
      "Type",
      "LeaveType",
      "Status",
      "StartDate",
      "EndDate",
      "Days",
      "Reason",
      "CreatedAt",
      "UpdatedAt",
    ];

    const lines: string[] = [];
    lines.push(header.join(","));

    for (const r of rows as any[]) {
      lines.push(
        [
          csvEscape(r.employeeId),
          csvEscape(r.type),
          csvEscape(r.leaveType),
          csvEscape(r.status),
          csvEscape(formatDate(r.startDate)),
          csvEscape(formatDate(r.endDate)),
          csvEscape(r.days),
          csvEscape(r.reason),
          csvEscape(formatDate(r.createdAt)),
          csvEscape(formatDate(r.updatedAt)),
        ].join(","),
      );
    }

    const csv = lines.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="leaves.csv"',
    );
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------------- */
/* Vendors CSV                                                                */
/* -------------------------------------------------------------------------- */

router.get("/reports/vendors.csv", async (req, res, next) => {
  try {
    const rows = await Vendor.find({}).lean();

    const header = [
      "VendorId",
      "Name",
      "Email",
      "Phone",
      "Type",
      "Status",
      "BusinessAssociations",
      "OwnerId",
      "CreatedAt",
      "UpdatedAt",
    ];

    const lines: string[] = [];
    lines.push(header.join(","));

    for (const r of rows as any[]) {
      const business =
        Array.isArray(r.businessAssociations) &&
        r.businessAssociations.length
          ? r.businessAssociations.join("|")
          : "";

      lines.push(
        [
          csvEscape(r._id),
          csvEscape(r.name),
          csvEscape(r.email),
          csvEscape(r.phone),
          csvEscape(r.type),
          csvEscape(r.status),
          csvEscape(business),
          csvEscape(r.ownerId),
          csvEscape(formatDate(r.createdAt)),
          csvEscape(formatDate(r.updatedAt)),
        ].join(","),
      );
    }

    const csv = lines.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="vendors.csv"',
    );
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

export default router;
