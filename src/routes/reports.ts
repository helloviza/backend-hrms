// apps/backend/src/routes/reports.ts
import express from "express";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import ManualBooking from "../models/ManualBooking.js";
import Invoice from "../models/Invoice.js";
import ReportSchedule from "../models/ReportSchedule.js";
import User from "../models/User.js";
import BillingPermission from "../models/BillingPermission.js";
import { sendReportEmail } from "../utils/reportMailer.js";

const router = express.Router();
router.use(requireAuth);
router.use(requireWorkspace);

/* ── Types ─────────────────────────────────────────────────────── */

export interface ReportOverview {
  totalBookings: number;
  totalQuoted: number;
  totalActual: number;
  totalDiff: number;
  totalGST: number;
  totalBaseProfit: number;
  avgMarginPercent: number;
  pendingCount: number;
  wipCount: number;
  confirmedCount: number;
  invoicedCount: number;
  cancelledCount: number;
}

export interface ByClientRow {
  workspaceId: string;
  clientName: string;
  bookings: number;
  totalQuoted: number;
  totalActual: number;
  totalDiff: number;
  totalGST: number;
  totalBaseProfit: number;
  avgMargin: number;
  invoicedAmount: number;
  pendingAmount: number;
}

export interface ByTypeRow {
  type: string;
  count: number;
  totalQuoted: number;
  totalActual: number;
  totalDiff: number;
  totalGST: number;
  totalBaseProfit: number;
  avgMargin: number;
}

export interface ByStaffRow {
  bookedById: string;
  staffName: string;
  staffEmail: string;
  bookings: number;
  totalQuoted: number;
  totalDiff: number;
  totalBaseProfit: number;
  avgMargin: number;
}

export interface ByWeekRow {
  week: number;
  month: string;
  bookings: number;
  totalQuoted: number;
  totalBaseProfit: number;
}

export interface ByMonthRow {
  month: string;
  bookings: number;
  totalQuoted: number;
  totalActual: number;
  totalBaseProfit: number;
  avgMargin: number;
}

export interface UnpaidInvoice {
  invoiceId: string;
  invoiceNo: string;
  clientName: string;
  grandTotal: number;
  generatedAt: Date;
  dueDate: Date | null;
  pendingDays: number;
}

export interface ByPartnerRow {
  supplierName: string;
  bookings: number;
  totalActual: number;
  totalQuoted: number;
  totalBaseProfit: number;
}

export interface ByEmployeeRow {
  userId: string;
  staffName: string;
  staffEmail: string;
  bookings: number;
  totalQuoted: number;
  totalBaseProfit: number;
  avgMargin: number;
  lastBookingDate: Date | null;
  activityStatus: "ACTIVE" | "SLOW" | "IDLE";
}

export interface ReportSummary {
  overview: ReportOverview;
  byClient: ByClientRow[];
  byType: ByTypeRow[];
  byStaff: ByStaffRow[];
  byWeek: ByWeekRow[];
  byMonth: ByMonthRow[];
  unpaidInvoices: UnpaidInvoice[];
  byPartner: ByPartnerRow[];
  byEmployee: ByEmployeeRow[];
}

/* ── Shared aggregation function ───────────────────────────────── */

export async function getReportData(filters: {
  dateFrom?: string;
  dateTo?: string;
  workspaceId?: string;
  type?: string;
  status?: string;
}): Promise<ReportSummary> {
  const match: Record<string, any> = {};

  if (filters.dateFrom || filters.dateTo) {
    match.createdAt = {};
    if (filters.dateFrom) match.createdAt.$gte = new Date(filters.dateFrom);
    if (filters.dateTo) {
      const end = new Date(filters.dateTo);
      end.setHours(23, 59, 59, 999);
      match.createdAt.$lte = end;
    }
  }
  if (filters.workspaceId) {
    try {
      match.workspaceId = new mongoose.Types.ObjectId(filters.workspaceId);
    } catch {
      match.workspaceId = filters.workspaceId;
    }
  }
  if (filters.type) match.type = filters.type;
  if (filters.status) match.status = filters.status;

  // One-time: backfill createdByEmail on all bookings missing it
  ManualBooking.find({ createdByEmail: { $exists: false } })
    .populate("bookedBy", "email")
    .then(async (docs) => {
      // Pass 1: bookings with a populated bookedBy user
      for (const doc of docs) {
        const bookedByUser = (doc as any).bookedBy;
        const email = bookedByUser?.email ?? null;
        if (email) {
          await ManualBooking.updateOne(
            { _id: doc._id },
            { $set: { createdByEmail: email, createdBy: String(bookedByUser._id) } },
          );
        }
      }

      // Pass 2: bookings with createdBy string but still no createdByEmail
      const pass2 = await ManualBooking.find(
        { createdBy: { $exists: true, $ne: "" }, createdByEmail: { $exists: false } },
      ).lean();
      for (const doc of pass2) {
        const user = await User.findById((doc as any).createdBy, { email: 1 }).lean();
        if (user?.email) {
          await ManualBooking.updateOne(
            { _id: doc._id },
            { $set: { createdByEmail: user.email } },
          );
        }
      }
    })
    .catch(() => {}); // silent — non-blocking

  // Pass 3: Fix bookingMonth on existing docs — recompute from createdAt instead of travelDate
  ManualBooking.find({ createdAt: { $exists: true } }, { _id: 1, createdAt: 1, bookingMonth: 1 })
    .lean()
    .then(async (docs) => {
      for (const doc of docs) {
        const d = new Date((doc as any).createdAt);
        const correctMonth = d.toLocaleString("en-IN", { month: "long", year: "numeric" });
        if ((doc as any).bookingMonth !== correctMonth) {
          const startOfYear = new Date(d.getFullYear(), 0, 1);
          const weekNo = Math.ceil(
            ((d.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7,
          );
          await ManualBooking.updateOne(
            { _id: doc._id },
            { $set: { bookingMonth: correctMonth, bookingWeek: weekNo } },
          );
        }
      }
      console.log("[BACKFILL] bookingMonth recomputed from createdAt for stale docs");
    })
    .catch(() => {});

  const [
    overviewResult,
    byClientResult,
    byTypeResult,
    byStaffResult,
    byWeekResult,
    byMonthResult,
    byPartnerResult,
    unpaidResult,
  ] = await Promise.all([
    // Overview
    ManualBooking.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalBookings: { $sum: 1 },
          totalQuoted: { $sum: "$pricing.quotedPrice" },
          totalActual: { $sum: "$pricing.actualPrice" },
          totalDiff: { $sum: "$pricing.diff" },
          totalGST: { $sum: "$pricing.gstAmount" },
          totalBaseProfit: { $sum: "$pricing.basePrice" },
          avgMarginPercent: { $avg: "$pricing.profitMargin" },
          pendingCount: { $sum: { $cond: [{ $eq: ["$status", "PENDING"] }, 1, 0] } },
          wipCount: { $sum: { $cond: [{ $eq: ["$status", "WIP"] }, 1, 0] } },
          confirmedCount: { $sum: { $cond: [{ $eq: ["$status", "CONFIRMED"] }, 1, 0] } },
          invoicedCount: { $sum: { $cond: [{ $eq: ["$status", "INVOICED"] }, 1, 0] } },
          cancelledCount: { $sum: { $cond: [{ $eq: ["$status", "CANCELLED"] }, 1, 0] } },
        },
      },
    ]),

    // By client
    ManualBooking.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$workspaceId",
          bookings: { $sum: 1 },
          totalQuoted: { $sum: "$pricing.quotedPrice" },
          totalActual: { $sum: "$pricing.actualPrice" },
          totalDiff: { $sum: "$pricing.diff" },
          totalGST: { $sum: "$pricing.gstAmount" },
          totalBaseProfit: { $sum: "$pricing.basePrice" },
          avgMargin: { $avg: "$pricing.profitMargin" },
          invoicedAmount: {
            $sum: {
              $cond: [{ $eq: ["$status", "INVOICED"] }, "$pricing.grandTotal", 0],
            },
          },
          pendingAmount: {
            $sum: {
              $cond: [{ $ne: ["$status", "INVOICED"] }, "$pricing.grandTotal", 0],
            },
          },
        },
      },
      {
        $lookup: {
          from: "customers",
          localField: "_id",
          foreignField: "_id",
          as: "customer",
        },
      },
      { $unwind: { path: "$customer", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          workspaceId: { $toString: "$_id" },
          clientName: {
            $ifNull: [
              "$customer.legalName",
              { $ifNull: ["$customer.name", "Unknown"] },
            ],
          },
          bookings: 1,
          totalQuoted: 1,
          totalActual: 1,
          totalDiff: 1,
          totalGST: 1,
          totalBaseProfit: 1,
          avgMargin: { $ifNull: ["$avgMargin", 0] },
          invoicedAmount: 1,
          pendingAmount: 1,
        },
      },
      { $sort: { totalQuoted: -1 } },
    ]),

    // By type
    ManualBooking.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$type",
          count: { $sum: 1 },
          totalQuoted: { $sum: "$pricing.quotedPrice" },
          totalActual: { $sum: "$pricing.actualPrice" },
          totalDiff: { $sum: "$pricing.diff" },
          totalGST: { $sum: "$pricing.gstAmount" },
          totalBaseProfit: { $sum: "$pricing.basePrice" },
          avgMargin: { $avg: "$pricing.profitMargin" },
        },
      },
      {
        $project: {
          type: "$_id",
          count: 1,
          totalQuoted: 1,
          totalActual: 1,
          totalDiff: 1,
          totalGST: 1,
          totalBaseProfit: 1,
          avgMargin: { $ifNull: ["$avgMargin", 0] },
        },
      },
      { $sort: { totalQuoted: -1 } },
    ]),

    // By staff
    ManualBooking.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$bookedBy",
          bookings: { $sum: 1 },
          totalQuoted: { $sum: "$pricing.quotedPrice" },
          totalDiff: { $sum: "$pricing.diff" },
          totalBaseProfit: { $sum: "$pricing.basePrice" },
          avgMargin: { $avg: "$pricing.profitMargin" },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          bookedById: { $toString: "$_id" },
          staffName: {
            $ifNull: [
              { $concat: [{ $ifNull: ["$user.firstName", ""] }, " ", { $ifNull: ["$user.lastName", ""] }] },
              { $ifNull: ["$user.name", "Unknown"] },
            ],
          },
          staffEmail: { $ifNull: ["$user.email", ""] },
          bookings: 1,
          totalQuoted: 1,
          totalDiff: 1,
          totalBaseProfit: 1,
          avgMargin: { $ifNull: ["$avgMargin", 0] },
        },
      },
      { $sort: { bookings: -1 } },
    ]),

    // By week
    ManualBooking.aggregate([
      { $match: match },
      {
        $group: {
          _id: { week: "$bookingWeek", month: "$bookingMonth" },
          bookings: { $sum: 1 },
          totalQuoted: { $sum: "$pricing.quotedPrice" },
          totalBaseProfit: { $sum: "$pricing.basePrice" },
        },
      },
      {
        $project: {
          week: "$_id.week",
          month: "$_id.month",
          bookings: 1,
          totalQuoted: 1,
          totalBaseProfit: 1,
        },
      },
      { $sort: { week: 1 } },
    ]),

    // By month
    ManualBooking.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$bookingMonth",
          bookings: { $sum: 1 },
          totalQuoted: { $sum: "$pricing.quotedPrice" },
          totalActual: { $sum: "$pricing.actualPrice" },
          totalBaseProfit: { $sum: "$pricing.basePrice" },
          avgMargin: { $avg: "$pricing.profitMargin" },
        },
      },
      {
        $project: {
          month: "$_id",
          bookings: 1,
          totalQuoted: 1,
          totalActual: 1,
          totalBaseProfit: 1,
          avgMargin: { $ifNull: ["$avgMargin", 0] },
        },
      },
      { $sort: { _id: -1 } },
    ]),

    // By partner
    ManualBooking.aggregate([
      { $match: { ...match, supplierName: { $exists: true, $ne: "" } } },
      {
        $group: {
          _id: "$supplierName",
          bookings: { $sum: 1 },
          totalActual: { $sum: "$pricing.actualPrice" },
          totalQuoted: { $sum: "$pricing.quotedPrice" },
          totalBaseProfit: { $sum: "$pricing.basePrice" },
        },
      },
      {
        $project: {
          supplierName: "$_id",
          bookings: 1,
          totalActual: 1,
          totalQuoted: 1,
          totalBaseProfit: 1,
        },
      },
      { $sort: { totalActual: -1 } },
    ]),

    // Unpaid invoices
    Invoice.aggregate([
      { $match: { status: { $in: ["DRAFT", "SENT"] } } },
      {
        $project: {
          invoiceId: { $toString: "$_id" },
          invoiceNo: 1,
          grandTotal: 1,
          generatedAt: 1,
          dueDate: 1,
          clientName: { $ifNull: ["$clientDetails.companyName", "Unknown"] },
          pendingDays: {
            $toInt: {
              $divide: [
                { $subtract: [new Date(), "$generatedAt"] },
                1000 * 60 * 60 * 24,
              ],
            },
          },
        },
      },
      { $sort: { pendingDays: -1 } },
    ]),
  ]);

  // byEmployee: SOURCE 1 — super admins always appear
  const superAdmins = await User.find(
    { roles: { $in: ["SUPERADMIN"] } },
    { _id: 1, firstName: 1, lastName: 1, name: 1, email: 1 },
  ).lean();

  // byEmployee: SOURCE 2 — users explicitly granted manualBookings billing access
  const grants = await BillingPermission.find(
    { pages: { $in: ["manualBookings"] } },
    { userId: 1 },
  ).lean();
  const grantedUserIds = grants.map((g) => g.userId).filter(Boolean);
  const grantedUsers = grantedUserIds.length
    ? await User.find(
        { _id: { $in: grantedUserIds } },
        { _id: 1, firstName: 1, lastName: 1, name: 1, email: 1 },
      ).lean()
    : [];

  // Merge and deduplicate by _id
  const seen = new Set<string>();
  const staffUsers = [...superAdmins, ...grantedUsers].filter((u) => {
    const key = String(u._id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Primary aggregation: group by bookedBy (ObjectId)
  const bookingsByUser = await ManualBooking.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$bookedBy",
        bookings: { $sum: 1 },
        totalQuoted: { $sum: "$pricing.quotedPrice" },
        totalBaseProfit: { $sum: "$pricing.basePrice" },
        avgMargin: { $avg: "$pricing.profitMargin" },
      },
    },
  ]);

  // Fallback aggregation: group by createdByEmail (for bookings where bookedBy is null/mismatched)
  const bookingsByEmail = await ManualBooking.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$createdByEmail",
        bookings: { $sum: 1 },
        totalQuoted: { $sum: "$pricing.quotedPrice" },
        totalBaseProfit: { $sum: "$pricing.basePrice" },
        avgMargin: { $avg: "$pricing.profitMargin" },
      },
    },
  ]);

  // Tertiary aggregation: group by createdBy (string userId)
  const bookingsByCreator = await ManualBooking.aggregate([
    { $match: { ...match, createdBy: { $exists: true, $ne: "" } } },
    {
      $group: {
        _id: "$createdBy",
        bookings: { $sum: 1 },
        totalQuoted: { $sum: "$pricing.quotedPrice" },
        totalBaseProfit: { $sum: "$pricing.basePrice" },
        avgMargin: { $avg: "$pricing.profitMargin" },
      },
    },
  ]);

  const bookingMap = new Map<string, (typeof bookingsByUser)[0]>(
    bookingsByUser.map((r) => [String(r._id), r]),
  );
  const creatorMap = new Map<string, (typeof bookingsByCreator)[0]>(
    bookingsByCreator.map((r) => [String(r._id), r]),
  );
  const emailMap = new Map<string, (typeof bookingsByEmail)[0]>(
    bookingsByEmail.map((r) => [String(r._id).toLowerCase(), r]),
  );

  const now = Date.now();

  const byEmployee: ByEmployeeRow[] = await Promise.all(
    staffUsers.map(async (u) => {
      const uid = String(u._id);
      const userEmail = ((u as any).email ?? "").toLowerCase();
      // Prefer ObjectId match; fall back to createdBy string; fall back to email match
      const agg = bookingMap.get(uid) ?? creatorMap.get(uid) ?? emailMap.get(userEmail);

      if ((u as any).email?.toLowerCase().includes("imran")) {
        console.log("[DEBUG IMRAN]", {
          uid,
          userEmail,
          bookingMapHas: bookingMap.has(uid),
          emailMapHas: emailMap.has(userEmail),
          creatorMapHas: creatorMap.has(uid),
          bookingMapKeys: [...bookingMap.keys()].slice(0, 5),
          emailMapKeys: [...emailMap.keys()].slice(0, 5),
          creatorMapKeys: [...creatorMap.keys()].slice(0, 5),
        });
      }

      const lastDoc = await ManualBooking.findOne(
        { $or: [{ bookedBy: u._id }, { createdByEmail: (u as any).email }] },
        { createdAt: 1 },
        { sort: { createdAt: -1 } },
      ).lean();

      const lastBookingDate = lastDoc ? lastDoc.createdAt as Date : null;
      const daysSince = lastBookingDate
        ? Math.floor((now - new Date(lastBookingDate).getTime()) / 86_400_000)
        : 999;

      const activityStatus: "ACTIVE" | "SLOW" | "IDLE" =
        daysSince <= 7 ? "ACTIVE" : daysSince <= 30 ? "SLOW" : "IDLE";

      const staffName =
        (u as any).firstName || (u as any).lastName
          ? `${(u as any).firstName ?? ""} ${(u as any).lastName ?? ""}`.trim()
          : (u as any).name ?? "Unknown";

      return {
        userId: uid,
        staffName,
        staffEmail: (u as any).email ?? "",
        bookings: agg?.bookings ?? 0,
        totalQuoted: agg?.totalQuoted ?? 0,
        totalBaseProfit: agg?.totalBaseProfit ?? 0,
        avgMargin: parseFloat(((agg?.avgMargin ?? 0) as number).toFixed(2)),
        lastBookingDate,
        activityStatus,
      };
    }),
  );

  byEmployee.sort((a, b) => {
    if (b.bookings !== a.bookings) return b.bookings - a.bookings;
    const aDate = a.lastBookingDate ? new Date(a.lastBookingDate).getTime() : 0;
    const bDate = b.lastBookingDate ? new Date(b.lastBookingDate).getTime() : 0;
    return bDate - aDate;
  });

  const ov = overviewResult[0] || {};

  return {
    overview: {
      totalBookings: ov.totalBookings ?? 0,
      totalQuoted: ov.totalQuoted ?? 0,
      totalActual: ov.totalActual ?? 0,
      totalDiff: ov.totalDiff ?? 0,
      totalGST: ov.totalGST ?? 0,
      totalBaseProfit: ov.totalBaseProfit ?? 0,
      avgMarginPercent: parseFloat((ov.avgMarginPercent ?? 0).toFixed(2)),
      pendingCount: ov.pendingCount ?? 0,
      wipCount: ov.wipCount ?? 0,
      confirmedCount: ov.confirmedCount ?? 0,
      invoicedCount: ov.invoicedCount ?? 0,
      cancelledCount: ov.cancelledCount ?? 0,
    },
    byClient: byClientResult,
    byType: byTypeResult,
    byStaff: byStaffResult,
    byWeek: byWeekResult,
    byMonth: byMonthResult,
    byPartner: byPartnerResult,
    unpaidInvoices: unpaidResult,
    byEmployee,
  };
}

/* ── GET /api/admin/reports/summary ────────────────────────────── */

router.get("/summary", requirePermission("reports", "READ"), async (req, res, next) => {
  try {
    const { dateFrom, dateTo, type, status } = req.query as Record<string, string>;
    const data = await getReportData({ dateFrom, dateTo, workspaceId: req.workspaceObjectId?.toString(), type, status });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/* ── GET /api/admin/reports/export ─────────────────────────────── */

function fmtDateDMY(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = new Date(d as string);
  if (isNaN(dt.getTime())) return "";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${dt.getFullYear()}`;
}

function fmtNum(n: number | null | undefined): number {
  return parseFloat((n ?? 0).toFixed(2));
}

router.get("/export", requirePermission("reports", "FULL"), async (req, res, next) => {
  try {
    const { dateFrom, dateTo, type, status, format } = req.query as Record<string, string>;

    const data = await getReportData({ dateFrom, dateTo, workspaceId: req.workspaceObjectId?.toString(), type, status });

    const fname = `plumtrips-report-${dateFrom || "all"}-${dateTo || "all"}`;

    if (format === "csv") {
      // CSV — overview label/value pairs
      const lines: string[] = [
        "Label,Value",
        `Total Bookings,${data.overview.totalBookings}`,
        `Total Quoted,${fmtNum(data.overview.totalQuoted)}`,
        `Total Actual,${fmtNum(data.overview.totalActual)}`,
        `Total Diff,${fmtNum(data.overview.totalDiff)}`,
        `Total GST,${fmtNum(data.overview.totalGST)}`,
        `Total Base Profit,${fmtNum(data.overview.totalBaseProfit)}`,
        `Avg Margin %,${data.overview.avgMarginPercent}`,
        `Pending,${data.overview.pendingCount}`,
        `WIP,${data.overview.wipCount}`,
        `Confirmed,${data.overview.confirmedCount}`,
        `Invoiced,${data.overview.invoicedCount}`,
        `Cancelled,${data.overview.cancelledCount}`,
      ];
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${fname}.csv"`);
      return res.send(lines.join("\n"));
    }

    // XLSX — multi-sheet
    const wb = new ExcelJS.Workbook();
    wb.creator = "Plumtrips HRMS";
    wb.created = new Date();

    const MONEY_FMT = "#,##0.00";

    function boldHeader(sheet: ExcelJS.Worksheet, headers: string[]) {
      const row = sheet.getRow(1);
      row.values = headers;
      row.font = { bold: true };
      row.eachCell((cell) => {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FF0F172A" },
        };
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      });
      sheet.views = [{ state: "frozen", ySplit: 1 }];
    }

    function setColWidths(sheet: ExcelJS.Worksheet, widths: number[]) {
      widths.forEach((w, i) => {
        sheet.getColumn(i + 1).width = w;
      });
    }

    function moneyCol(sheet: ExcelJS.Worksheet, colNums: number[]) {
      colNums.forEach((c) => {
        sheet.getColumn(c).numFmt = MONEY_FMT;
      });
    }

    // Sheet 1 — Overview
    const s1 = wb.addWorksheet("Overview");
    boldHeader(s1, ["Label", "Value"]);
    setColWidths(s1, [28, 20]);
    const ovRows: [string, number | string][] = [
      ["Total Bookings", data.overview.totalBookings],
      ["Total Quoted (₹)", fmtNum(data.overview.totalQuoted)],
      ["Total Actual (₹)", fmtNum(data.overview.totalActual)],
      ["Total Diff (₹)", fmtNum(data.overview.totalDiff)],
      ["Total GST (₹)", fmtNum(data.overview.totalGST)],
      ["Total Base Profit (₹)", fmtNum(data.overview.totalBaseProfit)],
      ["Avg Margin %", data.overview.avgMarginPercent],
      ["Pending", data.overview.pendingCount],
      ["WIP", data.overview.wipCount],
      ["Confirmed", data.overview.confirmedCount],
      ["Invoiced", data.overview.invoicedCount],
      ["Cancelled", data.overview.cancelledCount],
    ];
    ovRows.forEach((r) => s1.addRow(r));

    // Sheet 2 — By Client
    const s2 = wb.addWorksheet("By Client");
    boldHeader(s2, ["Client", "Bookings", "Total Quoted", "Total Actual", "Total Diff", "Total GST", "Total Profit", "Avg Margin %", "Invoiced", "Pending"]);
    setColWidths(s2, [30, 12, 16, 16, 16, 14, 16, 14, 16, 16]);
    moneyCol(s2, [3, 4, 5, 6, 7, 9, 10]);
    data.byClient.forEach((r) =>
      s2.addRow([r.clientName, r.bookings, fmtNum(r.totalQuoted), fmtNum(r.totalActual), fmtNum(r.totalDiff), fmtNum(r.totalGST), fmtNum(r.totalBaseProfit), fmtNum(r.avgMargin), fmtNum(r.invoicedAmount), fmtNum(r.pendingAmount)])
    );

    // Sheet 3 — By Type
    const s3 = wb.addWorksheet("By Type");
    boldHeader(s3, ["Type", "Count", "Total Quoted", "Total Actual", "Total Diff", "Total GST", "Total Profit", "Avg Margin %"]);
    setColWidths(s3, [14, 10, 16, 16, 14, 14, 16, 14]);
    moneyCol(s3, [3, 4, 5, 6, 7]);
    data.byType.forEach((r) =>
      s3.addRow([r.type, r.count, fmtNum(r.totalQuoted), fmtNum(r.totalActual), fmtNum(r.totalDiff), fmtNum(r.totalGST), fmtNum(r.totalBaseProfit), fmtNum(r.avgMargin)])
    );

    // Sheet 4 — By Staff
    const s4 = wb.addWorksheet("By Staff");
    boldHeader(s4, ["Staff Name", "Email", "Bookings", "Total Quoted", "Total Diff", "Total Profit", "Avg Margin %"]);
    setColWidths(s4, [24, 30, 12, 16, 14, 16, 14]);
    moneyCol(s4, [4, 5, 6]);
    data.byStaff.forEach((r) =>
      s4.addRow([r.staffName, r.staffEmail, r.bookings, fmtNum(r.totalQuoted), fmtNum(r.totalDiff), fmtNum(r.totalBaseProfit), fmtNum(r.avgMargin)])
    );

    // Sheet 5 — By Month
    const s5 = wb.addWorksheet("By Month");
    boldHeader(s5, ["Month", "Bookings", "Total Quoted", "Total Actual", "Total Profit", "Avg Margin %"]);
    setColWidths(s5, [20, 12, 16, 16, 16, 14]);
    moneyCol(s5, [3, 4, 5]);
    data.byMonth.forEach((r) =>
      s5.addRow([r.month, r.bookings, fmtNum(r.totalQuoted), fmtNum(r.totalActual), fmtNum(r.totalBaseProfit), fmtNum(r.avgMargin)])
    );

    // Sheet 6 — By Partner
    const s6 = wb.addWorksheet("By Partner");
    boldHeader(s6, ["Partner / Supplier", "Bookings", "Total Cost", "Total Quoted", "Total Profit"]);
    setColWidths(s6, [28, 12, 16, 16, 16]);
    moneyCol(s6, [3, 4, 5]);
    data.byPartner.forEach((r) =>
      s6.addRow([r.supplierName, r.bookings, fmtNum(r.totalActual), fmtNum(r.totalQuoted), fmtNum(r.totalBaseProfit)])
    );

    // Sheet 7 — Unpaid
    const s7 = wb.addWorksheet("Unpaid");
    boldHeader(s7, ["Invoice No", "Client", "Grand Total", "Generated At", "Due Date", "Days Pending"]);
    setColWidths(s7, [18, 30, 16, 16, 14, 14]);
    moneyCol(s7, [3]);
    data.unpaidInvoices.forEach((r) =>
      s7.addRow([r.invoiceNo, r.clientName, fmtNum(r.grandTotal), fmtDateDMY(r.generatedAt), r.dueDate ? fmtDateDMY(r.dueDate) : "", r.pendingDays])
    );

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

/* ── POST /api/admin/reports/send-now ──────────────────────────── */

router.post("/send-now", requirePermission("reports", "WRITE"), async (req, res, next) => {
  try {
    const {
      recipients,
      dateFrom,
      dateTo,
      type,
      // includeUnpaid intentionally kept for future use but we always include
    } = req.body as {
      recipients: string[];
      dateFrom?: string;
      dateTo?: string;
      type?: string;
      includeUnpaid?: boolean;
    };

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: "recipients is required" });
    }

    const data = await getReportData({ dateFrom, dateTo, workspaceId: req.workspaceObjectId?.toString(), type });

    const fromStr = dateFrom ? new Date(dateFrom).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "All time";
    const toStr = dateTo ? new Date(dateTo).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "Today";
    const dateLabel = `${fromStr} – ${toStr}`;

    // Build a one-off schedule-like object for the mailer
    const scheduleObj = {
      name: "Ad-hoc Report",
      recipients,
      includeClientFacing: false,
      clientFacingRecipients: [],
      format: "EMAIL_HTML" as const,
      includeUnpaid: true,
    };

    await sendReportEmail(scheduleObj as any, data, dateLabel);

    return res.json({ success: true, sentTo: recipients });
  } catch (err) {
    next(err);
  }
});

/* ── Report Schedule CRUD ──────────────────────────────────────── */

router.get("/schedules", requirePermission("reports", "READ"), async (_req, res, next) => {
  try {
    const schedules = await ReportSchedule.find().sort({ createdAt: -1 }).lean();
    res.json(schedules);
  } catch (err) {
    next(err);
  }
});

router.post("/schedules", requirePermission("reports", "WRITE"), async (req, res, next) => {
  try {
    const user = (req as any).user;
    const doc = await ReportSchedule.create({
      ...req.body,
      createdBy: user?._id,
    });
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

router.put("/schedules/:id", requirePermission("reports", "WRITE"), async (req, res, next) => {
  try {
    const doc = await ReportSchedule.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true },
    );
    if (!doc) return res.status(404).json({ error: "Schedule not found" });
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

router.delete("/schedules/:id", requirePermission("reports", "FULL"), async (req, res, next) => {
  try {
    await ReportSchedule.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post("/schedules/:id/send-now", requirePermission("reports", "WRITE"), async (req, res, next) => {
  try {
    const schedule = await ReportSchedule.findById(req.params.id);
    if (!schedule) return res.status(404).json({ error: "Schedule not found" });

    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const ist = new Date(now.getTime() + istOffset);

    const { dateFrom, dateTo } = computeDateRange(schedule.dateRangeType, ist);
    const fromStr = dateFrom.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    const toStr = dateTo.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    const dateLabel = `${fromStr} – ${toStr}`;

    const data = await getReportData({
      dateFrom: dateFrom.toISOString().slice(0, 10),
      dateTo: dateTo.toISOString().slice(0, 10),
    });

    await sendReportEmail(schedule, data, dateLabel);

    schedule.lastSentAt = now;
    await schedule.save();

    res.json({ success: true, sentTo: schedule.recipients });
  } catch (err) {
    next(err);
  }
});

/* ── Helper: compute date range from dateRangeType ─────────────── */

export function computeDateRange(
  dateRangeType: string,
  ist: Date,
): { dateFrom: Date; dateTo: Date } {
  const today = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));

  switch (dateRangeType) {
    case "LAST_7_DAYS": {
      const from = new Date(today);
      from.setUTCDate(from.getUTCDate() - 7);
      return { dateFrom: from, dateTo: today };
    }
    case "THIS_MONTH": {
      const from = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1));
      return { dateFrom: from, dateTo: today };
    }
    case "LAST_MONTH": {
      const lastMonthEnd = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 0));
      const lastMonthStart = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1));
      return { dateFrom: lastMonthStart, dateTo: lastMonthEnd };
    }
    case "LAST_30_DAYS":
    default: {
      const from = new Date(today);
      from.setUTCDate(from.getUTCDate() - 30);
      return { dateFrom: from, dateTo: today };
    }
  }
}

export default router;
