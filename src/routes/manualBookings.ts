import express from "express";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import multer from "multer";
import XLSX from "xlsx";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import ManualBooking from "../models/ManualBooking.js";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import Customer from "../models/Customer.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import CustomerMember from "../models/CustomerMember.js";
import Invoice from "../models/Invoice.js";
import User from "../models/User.js";

const router = express.Router();
const xlsxUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(requireAuth);

/* ── Helpers ────────────────────────────────────────────────────── */

function buildSearchFilter(query: Record<string, any>) {
  const filter: Record<string, any> = {};

  // Bug 5 fix: explicit ObjectId cast so the query is always typed correctly
  if (query.workspaceId) {
    try {
      filter.workspaceId = new mongoose.Types.ObjectId(query.workspaceId);
    } catch {
      filter._id = { $in: [] }; // invalid id → force empty result
    }
  }

  if (query.status) filter.status = query.status;
  if (query.type) filter.type = query.type;
  if (query.source) filter.source = query.source;
  if (query.givenBy) filter.givenBy = new RegExp(query.givenBy, "i");
  if (query.sector) filter.sector = new RegExp(query.sector, "i");
  if (query.week) filter.bookingWeek = parseInt(query.week);
  if (query.month) filter.bookingMonth = query.month;
  if (query.sourceBookingId) filter.sourceBookingId = query.sourceBookingId;

  // createdBy is stored as a plain string (String(user._id))
  if (query.createdBy) filter.createdBy = String(query.createdBy);

  // Bug 1+2 fix: filter bookingDate (what the UI column shows), and include full last day
  if (query.dateFrom || query.dateTo) {
    filter.bookingDate = {};
    if (query.dateFrom) filter.bookingDate.$gte = new Date(query.dateFrom);
    if (query.dateTo)   filter.bookingDate.$lte = new Date(`${query.dateTo}T23:59:59.999Z`);
  }

  if (query.search) {
    const re = new RegExp(query.search, "i");
    filter.$or = [
      { bookingRef: re },
      { sourceBookingRef: re },
      { supplierPNR: re },
      { "passengers.name": re },
      { sector: re },
      { givenBy: re },
    ];
  }

  return filter;
}

// Bug 3 fix: async invoice-number filter applied after buildSearchFilter
async function applyInvoiceFilter(filter: Record<string, any>, invoiceNo: string) {
  const matches = await Invoice.find({
    invoiceNo: { $regex: invoiceNo, $options: "i" },
  }).select("_id").lean();
  const ids = matches.map((inv: any) => inv._id);
  if (ids.length === 0) {
    filter._id = { $in: [] };
  } else {
    filter.invoiceId = { $in: ids };
  }
}

function invoicePendingDays(b: any): number {
  if (!b.invoiceRaisedDate) return 0;
  if (b.status === "PAID" || b.status === "CANCELLED") return 0;
  return Math.floor(
    (Date.now() - new Date(b.invoiceRaisedDate).getTime()) / (1000 * 60 * 60 * 24),
  );
}

function fmtDateDMY(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = new Date(d as string);
  if (isNaN(dt.getTime())) return "";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${dt.getFullYear()}`;
}

function csvRow(values: (string | number | undefined | null)[]) {
  return (
    values
      .map((v) => {
        const s = v == null ? "" : String(v);
        return s.includes(",") || s.includes('"') || s.includes("\n")
          ? `"${s.replace(/"/g, '""')}"`
          : s;
      })
      .join(",") + "\n"
  );
}

const BOOKING_COLUMNS = [
  "Sr. No",
  "Business Name",
  "Invoice Date",
  "Invoice Number",
  "Partner",
  "Req Date",
  "Pax Name",
  "Traveler ID",
  "Booked By",
  "Given By",
  "Type",
  "Sector",
  "Travel Date",
  "Arrival Date",
  "Quoted Price",
  "Actual Price",
  "Diff",
  "GST",
  "Base Price",
  "Grand Total",
  "Status",
  "Sub Status",
  "Price Benefits",
  "Request Process TAT",
  "Invoice Raised Date",
  "Invoice Status",
  "Invoice Pending Days",
  "Booking Week",
  "Booking Month",
];

// Money column indices (1-based): Quoted=15, Actual=16, Diff=17, GST=18, Base=19, Grand=20
const MONEY_COLS = [15, 16, 17, 18, 19, 20];

function bookingToRow(b: any, srNo: number, wsNameMap: Record<string, string> = {}, tidMap: Record<string, string> = {}): (string | number | undefined)[] {
  const wsName =
    wsNameMap[b.workspaceId?.toString() ?? ""] ||
    b.workspaceId?.name || b.workspaceId?.companyName || String(b.workspaceId ?? "");
  const invoiceDocDate    = fmtDateDMY(b.invoiceId?.invoiceDate);  // Invoice document's issued date
  const invoiceRaisedDate = fmtDateDMY(b.invoiceRaisedDate);       // booking-level raised date
  const invNo   = b.invoiceId?.invoiceNo ?? "";
  const invStatus = b.invoiceId?.status ?? "";
  const sector  =
    b.sector ||
    (b.itinerary?.origin && b.itinerary?.destination
      ? `${b.itinerary.origin}-${b.itinerary.destination}`
      : b.itinerary?.hotelName || "");
  const paxNames = (b.passengers || []).map((p: any) => p.name).join(" | ");
  const tat = b.requestProcessTAT ? `${b.requestProcessTAT} days` : "";
  const wid = b.workspaceId?.toString() ?? "";
  const firstPaxEmail = String(b.passengers?.[0]?.email || "").toLowerCase();
  const travelerId = firstPaxEmail ? (tidMap[`${wid}:${firstPaxEmail}`] || "") : "";

  return [
    srNo,
    wsName,
    invoiceDocDate,
    invNo,
    b.supplierName ?? "",
    fmtDateDMY(b.reqDate),
    paxNames,
    travelerId,
    b.bookedBy?.email ?? b.bookedBy?.name ?? "",
    b.givenBy ?? "",
    b.type ?? "",
    sector,
    fmtDateDMY(b.travelDate),
    fmtDateDMY(b.returnDate),
    b.pricing?.quotedPrice ?? b.pricing?.sellingPrice ?? 0,
    b.pricing?.actualPrice ?? b.pricing?.supplierCost ?? 0,
    b.pricing?.diff ?? b.pricing?.markupAmount ?? 0,
    b.pricing?.gstAmount ?? 0,
    b.pricing?.basePrice ?? 0,
    b.pricing?.grandTotal ?? b.pricing?.quotedPrice ?? 0,
    b.status ?? "",
    b.subStatus ?? "",
    b.priceBenefits ?? "",
    tat,
    invoiceRaisedDate,
    invStatus,
    invoicePendingDays(b),
    b.bookingWeek ? `Week ${b.bookingWeek}` : "",
    b.bookingMonth ?? "",
  ];
}

/* ── CRUD ────────────────────────────────────────────────────────── */

// POST /api/admin/manual-bookings
router.post("/", requirePermission("manualBookings", "WRITE"), async (req: any, res: any) => {
  try {
    const booking = await ManualBooking.create({
      ...req.body,
      bookedBy: req.user._id,
      source: req.body.source || "MANUAL",
      sourceBookingId: req.body.sourceBookingId || undefined,
      createdBy: String(req.user._id || req.user.id || req.user.sub),
      createdByEmail: req.user.email,
    });
    res.status(201).json({ ok: true, booking });
  } catch (err: any) {
    console.error("[ManualBookings POST]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/manual-bookings
router.get("/", requirePermission("manualBookings", "READ"), async (req: any, res: any) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 25);
    const filter = buildSearchFilter(req.query);

    // Scope non-ALL users to their own bookings only
    const isAllScope = req.permissionScope === "ALL";
    if (!isAllScope) {
      filter.createdBy = String(req.user._id || req.user.id || req.user.sub);
    }

    // Bug 3 fix: resolve invoice number to booking invoiceId
    if (req.query.invoiceNo) await applyInvoiceFilter(filter, req.query.invoiceNo);

    const [docs, total, statsAgg] = await Promise.all([
      ManualBooking.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("bookedBy", "name email")
        .populate("workspaceId", "name companyName")
        .populate("invoiceId", "invoiceNo status")
        .lean(),
      ManualBooking.countDocuments(filter),
      // Bug 4 fix: aggregate over the full filtered set, not just the current page
      ManualBooking.aggregate([
        { $match: filter },
        { $group: {
          _id: null,
          grossValue:      { $sum: "$pricing.quotedPrice" },
          totalProfit:     { $sum: "$pricing.basePrice" },
          pendingInvoices: { $sum: { $cond: [{ $ne: ["$status", "INVOICED"] }, 1, 0] } },
        }},
      ]),
    ]);

    const aggStats = statsAgg[0] ?? { grossValue: 0, totalProfit: 0, pendingInvoices: 0 };

    // Resolve client names from Customer collection
    // (ManualBooking.workspaceId stores Customer._id, not CustomerWorkspace._id)
    const wsIds = [...new Set(
      docs.map((b: any) => b.workspaceId?.toString()).filter(Boolean),
    )];
    const customers = await Promise.all(
      wsIds.map((id) =>
        Customer.findById(id).select("legalName name companyName").lean().catch(() => null),
      ),
    );
    const clientNameMap: Record<string, string> = {};
    customers.filter(Boolean).forEach((c: any) => {
      clientNameMap[c._id.toString()] = c.legalName || c.name || c.companyName || "";
    });

    const enriched = docs.map((b: any) => ({
      ...b,
      clientName: clientNameMap[b.workspaceId?.toString()] || "",
      invoicePendingDays: invoicePendingDays(b),
    }));

    console.log('[manualBookings GET] enriched[0].clientName:', enriched?.[0]?.clientName);
    res.json({
      ok: true,
      docs: enriched,
      total,
      page,
      pages: Math.ceil(total / limit),
      stats: {
        totalBookings: total,
        grossValue:      aggStats.grossValue,
        totalProfit:     aggStats.totalProfit,
        pendingInvoices: aggStats.pendingInvoices,
      },
    });
  } catch (err: any) {
    console.error("[ManualBookings GET list]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/manual-bookings/export
router.get("/export", requirePermission("manualBookings", "FULL"), async (req: any, res: any) => {
  try {
    const filter = buildSearchFilter(req.query);
    if (req.query.invoiceNo) await applyInvoiceFilter(filter, req.query.invoiceNo);
    const format = req.query.format === "xlsx" ? "xlsx" : "csv";
    const docs = await ManualBooking.find(filter)
      .sort({ createdAt: -1 })
      .populate("bookedBy", "name email")
      .populate("workspaceId", "name companyName")
      .populate("invoiceId", "invoiceNo status invoiceDate")
      .lean();

    // Build workspace name map via Customer (has legalName / companyName / name)
    const wsIds = [...new Set(
      docs.map((b: any) => b.workspaceId?.toString()).filter(Boolean),
    )];
    const customers = await Promise.all(
      wsIds.map((id) => Customer.findById(id).lean().catch(() => null)),
    );
    const wsNameMap: Record<string, string> = {};
    customers.filter(Boolean).forEach((c: any) => {
      wsNameMap[c._id.toString()] = c.legalName || c.companyName || c.name || "";
    });

    // Build travelerIdMap: "workspaceId:email" → travelerId
    const tidEntries: Array<{ customerId: string; email: string }> = [];
    for (const b of docs) {
      const wid = (b as any).workspaceId?.toString() ?? "";
      for (const p of ((b as any).passengers || [])) {
        if (p.email && wid) tidEntries.push({ customerId: wid, email: String(p.email).toLowerCase() });
      }
    }
    const tidMap: Record<string, string> = {};
    if (tidEntries.length > 0) {
      const memberDocs = await CustomerMember.find({
        $or: tidEntries.map((e) => ({ customerId: e.customerId, email: e.email })),
      })
        .select("customerId email travelerId")
        .lean();
      for (const m of memberDocs) {
        const key = `${(m as any).customerId}:${String((m as any).email).toLowerCase()}`;
        tidMap[key] = String((m as any).travelerId || "");
      }
    }

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="bookings-export.csv"');

      res.write(csvRow(BOOKING_COLUMNS));
      docs.forEach((b, idx) => {
        res.write(csvRow(bookingToRow(b, idx + 1, wsNameMap, tidMap)));
      });
      res.end();
      return;
    }

    // XLSX
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Bookings");

    // Freeze header row
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    const headerRow = sheet.addRow(BOOKING_COLUMNS);
    headerRow.font = { bold: true };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF0" } };

    // Column widths (29 cols: Traveler ID inserted after Pax Name)
    const colWidths = [7, 22, 14, 18, 16, 12, 28, 14, 22, 16, 10, 18, 14, 14, 14, 14, 12, 10, 12, 14, 12, 22, 25, 20, 14, 14, 16, 12, 16];
    colWidths.forEach((width, i) => {
      sheet.getColumn(i + 1).width = width;
    });

    // Money columns number format
    MONEY_COLS.forEach((ci) => {
      sheet.getColumn(ci).numFmt = "#,##0.00";
    });

    const totals: Record<number, number> = {};
    MONEY_COLS.forEach((ci) => { totals[ci] = 0; });

    docs.forEach((b, idx) => {
      const row = bookingToRow(b, idx + 1, wsNameMap, tidMap);
      sheet.addRow(row);
      MONEY_COLS.forEach((ci) => {
        totals[ci] = (totals[ci] || 0) + (Number(row[ci - 1]) || 0);
      });
    });

    // Totals row
    const totalsRow: (string | number)[] = BOOKING_COLUMNS.map(() => "");
    totalsRow[0] = "TOTALS";
    MONEY_COLS.forEach((ci) => { totalsRow[ci - 1] = totals[ci]; });
    const tRow = sheet.addRow(totalsRow);
    tRow.font = { bold: true };
    tRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF3CD" } };

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", 'attachment; filename="bookings-export.xlsx"');

    await workbook.xlsx.write(res);
    res.end();
  } catch (err: any) {
    console.error("[ManualBookings EXPORT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── SBT Queue ───────────────────────────────────────────────────── */

// GET /api/admin/manual-bookings/sbt-queue
router.get("/sbt-queue", requirePermission("manualBookings", "READ"), async (req: any, res: any) => {
  try {
    // Fetch already-imported IDs (include all, flag with alreadyImported instead of excluding)
    const [importedRaw, importedHotelRaw] = await Promise.all([
      ManualBooking.find({ source: "SBT", type: { $ne: "HOTEL" } }).distinct("sourceBookingId"),
      ManualBooking.find({ source: "SBT", type: "HOTEL" }).distinct("sourceBookingId"),
    ]);
    const importedSet = new Set(importedRaw.map((id: any) => id.toString()));
    const importedHotelSet = new Set(importedHotelRaw.map((id: any) => id.toString()));

    const [flights, hotels] = await Promise.all([
      SBTBooking.find({
        status: { $in: ["CONFIRMED", "PENDING", "CANCELLED"] },
      })
        .populate("workspaceId", "name companyName customerId")
        .sort({ createdAt: -1 })
        .limit(200)
        .lean(),
      SBTHotelBooking.find({
        status: { $in: ["CONFIRMED", "PENDING", "HELD", "CANCELLED"] },
      })
        .populate("workspaceId", "name companyName customerId")
        .sort({ createdAt: -1 })
        .limit(200)
        .lean(),
    ]);

    // Build CWS id → CWS doc map for name resolution
    const cwsIds = [
      ...flights.map((b: any) => b.workspaceId?._id || b.workspaceId),
      ...hotels.map((b: any) => b.workspaceId?._id || b.workspaceId),
    ].filter(Boolean);

    const cwsDocs = await CustomerWorkspace.find({ _id: { $in: cwsIds } })
      .select("customerId name companyName")
      .lean();

    const cwsMap: Record<string, any> = {};
    (cwsDocs as any[]).forEach((cws) => {
      cwsMap[cws._id.toString()] = cws;
    });

    // Resolve Customer docs for accurate legalName via CWS.customerId
    const customerIds = (cwsDocs as any[])
      .map((cws: any) => cws.customerId)
      .filter(Boolean);

    const validCustomerIds = customerIds.filter((id: any) => {
      try { return mongoose.Types.ObjectId.isValid(id); } catch { return false; }
    });

    const customerDocs = await Customer.find({ _id: { $in: validCustomerIds } })
      .select("legalName name companyName")
      .lean();

    const customerMap: Record<string, string> = {};
    (customerDocs as any[]).forEach((c: any) => {
      customerMap[c._id.toString()] = c.legalName || c.name || c.companyName || "";
    });

    const mappedFlights = (flights as any[]).map((b) => {
      const cwsId = (b.workspaceId?._id || b.workspaceId)?.toString() ?? "";
      const cws = cwsMap[cwsId];
      const customerId = cws?.customerId?.toString();
      const clientName = customerId
        ? (customerMap[customerId] || cws?.companyName || cws?.name || "")
        : (cws?.companyName || cws?.name || "");
      return {
        _id: b._id.toString(),
        sourceType: "SBT",
        bookingType: "FLIGHT",
        bookingRef: b.pnr || b.bookingId || "",
        route: `${b.origin?.city || ""} → ${b.destination?.city || ""}`,
        passengerName: `${b.passengers?.[0]?.firstName || ""} ${b.passengers?.[0]?.lastName || ""}`.trim(),
        travelDate: b.departureTime || "",
        quotedPrice: b.displayAmount || b.totalFare || 0,
        status: b.status,
        workspaceId: customerId || cwsId,
        clientName,
        alreadyImported: importedSet.has(b._id.toString()),
      };
    });

    const mappedHotels = (hotels as any[]).map((b) => {
      const cwsId = (b.workspaceId?._id || b.workspaceId)?.toString() ?? "";
      const cws = cwsMap[cwsId];
      const customerId = cws?.customerId?.toString();
      const clientName = customerId
        ? (customerMap[customerId] || cws?.companyName || cws?.name || "")
        : (cws?.companyName || cws?.name || "");
      return {
        _id: b._id.toString(),
        sourceType: "SBT",
        bookingType: "HOTEL",
        bookingRef: b.confirmationNo || b.bookingRefNo || b.bookingId || "",
        route: b.hotelName || b.cityName || "",
        passengerName: `${b.guests?.[0]?.FirstName || ""} ${b.guests?.[0]?.LastName || ""}`.trim(),
        travelDate: b.checkIn || "",
        quotedPrice: b.displayAmount || b.totalFare || 0,
        status: b.status,
        workspaceId: customerId || cwsId,
        clientName,
        alreadyImported: importedHotelSet.has(b._id.toString()),
      };
    });

    const items = [...mappedFlights, ...mappedHotels].sort(
      (a, b) => new Date(b.travelDate).getTime() - new Date(a.travelDate).getTime(),
    );

    res.json({ items, total: items.length });
  } catch (err: any) {
    console.error("[ManualBookings sbt-queue]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Markup Analysis ──────────────────────────────────────────────── */

// POST /api/admin/manual-bookings/markup-analysis
router.post("/markup-analysis", requirePermission("manualBookings", "READ"), async (req: any, res: any) => {
  try {
    const { workspaceId, clientId, type, route, actualPrice, quotedPrice } = req.body as {
      workspaceId: string; clientId?: string; type: string;
      route?: string; actualPrice: number; quotedPrice: number;
    };

    const INSUFFICIENT: any = {
      verdict: "INSUFFICIENT_DATA", currentMarkupPct: 0, median: null,
      p25: null, p75: null, sampleSize: 0, confidence: 0,
      comparisonScope: "none",
      message: "Insufficient historical data to evaluate this markup.",
    };

    if (!workspaceId || !type || !(actualPrice > 0)) return res.json(INSUFFICIENT);

    const currentMarkupPct = parseFloat((((quotedPrice - actualPrice) / actualPrice) * 100).toFixed(2));

    const docs = await ManualBooking.aggregate([
      {
        $match: {
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          type,
          status: { $in: ["CONFIRMED", "INVOICED"] },
          "pricing.actualPrice": { $gt: 0 },
        },
      },
      {
        $project: {
          workspaceId: 1,
          origin: "$itinerary.origin",
          destination: "$itinerary.destination",
          hotelName: "$itinerary.hotelName",
          actualPrice: "$pricing.actualPrice",
          quotedPrice: "$pricing.quotedPrice",
        },
      },
    ]);

    function docRoute(origin: string, dest: string, hotelName: string): string {
      if (type === "FLIGHT") {
        const o = (origin || "").trim().toUpperCase();
        const d = (dest || "").trim().toUpperCase();
        return o && d ? `${o}-${d}` : "";
      }
      if (type === "HOTEL") return (dest || hotelName || "").trim() || "—";
      return "";
    }

    const enriched = docs.map((d: any) => ({
      wsId: d.workspaceId?.toString(),
      computedRoute: docRoute(d.origin || "", d.destination || "", d.hotelName || ""),
      markupPct: parseFloat((((d.quotedPrice - d.actualPrice) / d.actualPrice) * 100).toFixed(2)),
    }));

    const MIN = 10;
    const incomingRoute = (route || "").trim();
    const effectiveClientId = (clientId || workspaceId).toString();

    type ScopeKey = "client_route_type" | "route_type" | "type" | "none";
    let samples: number[] = [];
    let scope: ScopeKey = "none";

    if (incomingRoute) {
      const tierA = enriched.filter((d: any) => d.wsId === effectiveClientId && d.computedRoute === incomingRoute);
      if (tierA.length >= MIN) { samples = tierA.map((d: any) => d.markupPct); scope = "client_route_type"; }

      if (!samples.length) {
        const tierB = enriched.filter((d: any) => d.computedRoute === incomingRoute);
        if (tierB.length >= MIN) { samples = tierB.map((d: any) => d.markupPct); scope = "route_type"; }
      }
    }

    if (!samples.length && enriched.length >= MIN) {
      samples = enriched.map((d: any) => d.markupPct);
      scope = "type";
    }

    if (!samples.length) {
      return res.json({ ...INSUFFICIENT, currentMarkupPct, sampleSize: enriched.length });
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const n = sorted.length;
    function pct(p: number): number {
      const idx = (p / 100) * (n - 1);
      const lo = Math.floor(idx), hi = Math.ceil(idx);
      if (lo === hi) return parseFloat(sorted[lo].toFixed(2));
      return parseFloat((sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo])).toFixed(2));
    }

    const p25 = pct(25), median = pct(50), p75 = pct(75);
    const sampleSize = n;
    const confidence = Math.min(95, 50 + sampleSize * 5);

    let verdict: "NORMAL" | "HIGH" | "LOW";
    if (currentMarkupPct < p25) verdict = "LOW";
    else if (currentMarkupPct > p75) verdict = "HIGH";
    else verdict = "NORMAL";

    const message =
      verdict === "HIGH" ? "Markup is higher than typical (above the 75th percentile of past bookings)."
      : verdict === "LOW" ? "Markup is lower than typical (below the 25th percentile of past bookings)."
      : scope === "client_route_type" ? "Markup is within the normal range for this client and route."
      : scope === "route_type" ? "Markup is within the normal range for this route."
      : "Markup is within the normal range for this service type.";

    res.json({ verdict, currentMarkupPct, median, p25, p75, sampleSize, confidence, comparisonScope: scope, message });
  } catch (err: any) {
    console.error("[ManualBookings markup-analysis]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Excel Import Template ────────────────────────────────────────── */

// GET /api/admin/manual-bookings/import-template
router.get("/import-template", requirePermission("manualBookings", "READ"), async (req: any, res: any) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Bookings");
    ws.views = [{ state: "frozen", ySplit: 1 }];

    const headers = [
      "type", "clientName", "clientGSTIN", "source", "bookingDate",
      "travelDate", "returnDate",
      "origin", "destination", "flightNo", "airline", "trainClass",
      "hotelName", "roomType", "roomCount", "description",
      "passengerName", "passengerType",
      "phone", "pan",
      "actualPrice", "quotedPrice", "gstMode", "gstPercent",
      "supplierName", "supplierPNR", "notes",
    ];

    const hRow = ws.addRow(headers);
    hRow.font = { bold: true };
    hRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF0" } };

    ws.addRow([
      "FLIGHT", "Acme Corp", "", "MANUAL", "01-04-2025",
      "10-04-2025", "",
      "DEL", "BOM", "6E123", "IndiGo", "",
      "", "", "", "",
      "Nandurka Ravi Kumar // Arun Joseph", "ADULT",
      "9999999999 // 8888888888", "ABCDE1234F // FGHIJ5678K",
      "8000", "9500", "ON_MARKUP", "18",
      "IndiGo", "ABCDEF", "Sample notes",
    ]);

    [14, 24, 20, 12, 14, 14, 14, 8, 8, 10, 14, 10, 20, 14, 10, 22, 22, 12, 16, 14, 12, 12, 12, 12, 18, 14, 28]
      .forEach((w, i) => { ws.getColumn(i + 1).width = w; });

    const instr = wb.addWorksheet("Instructions");
    instr.addRow(["Field", "Required", "Notes"]);
    ([
      ["type", "YES", "FLIGHT, HOTEL, VISA, TRANSFER, OTHER, CAB, FOREX, ESIM, HOLIDAYS, EVENTS, DUMMY_FLIGHT, DUMMY_HOTEL"],
      ["clientName", "YES (or clientGSTIN)", "Must match an existing client's company or legal name"],
      ["clientGSTIN", "YES (or clientName)", "Alternative client lookup by GST number"],
      ["source", "NO", "MANUAL (default), SBT, ADMIN_QUEUE"],
      ["bookingDate", "NO", "DD-MM-YYYY. Defaults to today."],
      ["travelDate", "YES", "DD-MM-YYYY"],
      ["returnDate", "NO", "DD-MM-YYYY. For hotels: check-out date."],
      ["origin", "FLIGHT only", "IATA code or city, e.g. DEL"],
      ["destination", "FLIGHT/HOTEL", "IATA code or city, e.g. BOM"],
      ["flightNo", "NO", "e.g. 6E123"],
      ["airline", "NO", "e.g. IndiGo"],
      ["trainClass", "NO", "For TRAIN type only. Examples: 1AC, 2AC, 3AC, SL, CC, EC"],
      ["hotelName", "HOTEL only", "Full hotel name"],
      ["roomType", "NO", "e.g. Deluxe Double"],
      ["roomCount", "NO", "HOTEL/DUMMY_HOTEL only — number of rooms. Defaults to 1 if blank."],
      ["description", "NO", "For non-flight/hotel types"],
      ["passengerName", "YES", "Full name. For multiple passengers, separate with ' // ' (e.g. 'John Doe // Jane Smith'). Email auto-resolved from CustomerMember records if name matches; otherwise stored with name only."],
      ["passengerType", "NO", "ADULT (default), CHILD, or INFANT. Single value applies to all passengers in the row."],
      ["phone", "NO", "Optional. For multiple passengers, use ' // ' separator matching passenger order. Empty slots OK (e.g. '9999 //  // 8888'). Stored as last 10 digits."],
      ["pan", "NO", "Optional. Parallel ' // ' format like phone. Stored uppercase. No format validation."],
      ["actualPrice", "YES", "Supplier cost in INR. Must be >= 0."],
      ["quotedPrice", "YES", "Price charged to client. Must be > 0."],
      ["gstMode", "NO", "ON_MARKUP (default) or ON_FULL"],
      ["gstPercent", "NO", "0, 5, 12, or 18. Default: 18"],
      ["supplierName", "NO", "e.g. IndiGo, TBO"],
      ["supplierPNR", "NO", "PNR or confirmation number"],
      ["notes", "NO", "Internal notes"],
    ] as string[][]).forEach((r) => instr.addRow(r));
    instr.getColumn(1).width = 18;
    instr.getColumn(2).width = 22;
    instr.getColumn(3).width = 70;
    instr.getRow(1).font = { bold: true };

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="manual-bookings-template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err: any) {
    console.error("[ManualBookings import-template]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Excel Import ─────────────────────────────────────────────────── */

const IMPORT_VALID_TYPES = [
  "FLIGHT", "HOTEL", "VISA", "TRANSFER", "OTHER",
  "CAB", "FOREX", "ESIM", "HOLIDAYS", "EVENTS", "DUMMY_FLIGHT", "DUMMY_HOTEL", "TRAIN",
];
const IMPORT_VALID_SOURCES = ["MANUAL", "SBT", "ADMIN_QUEUE", "SBT_AUTO"];
const IMPORT_VALID_PAX   = ["ADULT", "CHILD", "INFANT"];
const IMPORT_VALID_GST   = ["ON_FULL", "ON_MARKUP"];

function parseDateDMY(val: any): Date | null {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  const s = String(val).trim();
  const m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (m) {
    const d = new Date(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T00:00:00.000Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// POST /api/admin/manual-bookings/import
router.post("/import", requirePermission("manualBookings", "WRITE"), xlsxUpload.single("file"), async (req: any, res: any) => {
  try {
    const dryRun = req.query.dryRun !== "false";

    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return res.status(400).json({ error: "Empty workbook" });

    const sheet = wb.Sheets[sheetName];
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });

    if (rows.length < 2) {
      return res.json(dryRun
        ? { rows: [], summary: { valid: 0, invalid: 0 } }
        : { inserted: 0, skipped: 0, errors: [] });
    }

    const rawHeaders = (rows[0] as any[]).map((h: any) => String(h ?? "").trim().toLowerCase().replace(/\s+/g, ""));
    const COLS: Record<string, number> = {};
    [
      "type", "clientname", "clientgstin", "source", "bookingdate",
      "traveldate", "returndate", "origin", "destination", "flightno", "airline", "trainclass",
      "hotelname", "roomtype", "roomcount", "description", "passengername", "passengertype",
      "phone", "pan",
      "actualprice", "quotedprice", "gstmode", "gstpercent",
      "suppliername", "supplierpnr", "notes",
    ].forEach((h) => { COLS[h] = rawHeaders.indexOf(h); });

    function cell(row: any[], key: string): string {
      const idx = COLS[key];
      if (idx === undefined || idx === -1) return "";
      return String(row[idx] ?? "").trim();
    }

    const trimStr = (v: any): string | undefined => {
      if (v == null) return undefined;
      const s = String(v).trim();
      return s.length === 0 ? undefined : s;
    };

    const normalizeRoute = (v: any): string | undefined => {
      const s = trimStr(v);
      if (!s || !s.includes("-")) return s;
      return s.split("-").map((p) => p.trim()).filter(Boolean).join("-");
    };

    // Pre-resolve all client names / GSTINs mentioned in the file
    const nameLookup = new Set<string>();
    const gstinLookup = new Set<string>();
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] as any[];
      if (!r.some(Boolean)) continue;
      const n = cell(r, "clientname");
      if (n) nameLookup.add(n.trim().replace(/\s+/g, " ").toLowerCase());
      const g = cell(r, "clientgstin"); if (g) gstinLookup.add(g.toUpperCase());
    }

    const clientMap: Record<string, string> = {};
    if (nameLookup.size) {
      const byName = await Customer.find({
        legalNameNormalized: { $in: [...nameLookup] },
      }).select("_id legalNameNormalized").lean() as any[];
      byName.forEach((c: any) => {
        if (c.legalNameNormalized) clientMap[c.legalNameNormalized] = c._id.toString();
      });
    }
    if (gstinLookup.size) {
      const byGst = await Customer.find({ gstNumber: { $in: [...gstinLookup] } })
        .select("_id gstNumber").lean() as any[];
      byGst.forEach((c: any) => {
        if (c.gstNumber) clientMap[c.gstNumber.toUpperCase()] = c._id.toString();
      });
    }

    type RowErr = { field: string; error: string };
    type RowResult = { rowNumber: number; valid: boolean; data?: any; errors?: RowErr[] };
    const results: RowResult[] = [];

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] as any[];
      if (!r.some((v) => v !== null && v !== undefined && String(v).trim() !== "")) continue;

      const rowNumber = i + 1;
      const errs: RowErr[] = [];

      const type = (trimStr(cell(r, "type")) ?? "").toUpperCase();
      if (!type) errs.push({ field: "type", error: "required" });
      else if (!IMPORT_VALID_TYPES.includes(type)) errs.push({ field: "type", error: `"${type}" is not a valid type` });

      const travelDate = parseDateDMY(COLS["traveldate"] !== -1 ? r[COLS["traveldate"]] : "");
      if (!travelDate) errs.push({ field: "travelDate", error: "required, use DD-MM-YYYY" });

      const bookingDate = parseDateDMY(COLS["bookingdate"] !== -1 ? r[COLS["bookingdate"]] : "") || new Date();
      const returnDate  = parseDateDMY(COLS["returndate"]  !== -1 ? r[COLS["returndate"]]  : "") || undefined;

      const actualPrice = parseFloat(cell(r, "actualprice").replace(/,/g, ""));
      const quotedPrice = parseFloat(cell(r, "quotedprice").replace(/,/g, ""));

      if (!cell(r, "actualprice") || isNaN(actualPrice)) errs.push({ field: "actualPrice", error: "required, must be a number" });
      else if (actualPrice < 0) errs.push({ field: "actualPrice", error: "must be >= 0" });

      if (!cell(r, "quotedprice") || isNaN(quotedPrice)) errs.push({ field: "quotedPrice", error: "required, must be a number" });
      else if (quotedPrice <= 0) errs.push({ field: "quotedPrice", error: "must be > 0" });

      const passengerRaw = cell(r, "passengername");
      const rawNames = passengerRaw.split(/\s*\/\/\s*/).map((n) => n.trim()).filter((n) => n.length > 0);
      if (rawNames.length === 0) errs.push({ field: "passengerName", error: "required, at least 1 passenger" });
      for (const pName of rawNames) {
        if (pName.length > 60) errs.push({ field: "passengerName", error: `Passenger '${pName}' name exceeds 60 characters` });
      }

      const phoneRaw = cell(r, "phone");
      const phoneSlots = phoneRaw ? phoneRaw.split(/\s*\/\/\s*/).map((s) => s.trim()) : [];
      if (phoneSlots.length > rawNames.length) errs.push({ field: "phone", error: "more values than passenger names" });

      const panRaw = cell(r, "pan");
      const panSlots = panRaw ? panRaw.split(/\s*\/\/\s*/).map((s) => s.trim()) : [];
      if (panSlots.length > rawNames.length) errs.push({ field: "pan", error: "more values than passenger names" });

      const passengerType = cell(r, "passengertype").toUpperCase() || "ADULT";
      if (!IMPORT_VALID_PAX.includes(passengerType)) errs.push({ field: "passengerType", error: `must be ADULT, CHILD, or INFANT` });

      const gstMode = (trimStr(cell(r, "gstmode")) ?? "ON_MARKUP").toUpperCase();
      if (!IMPORT_VALID_GST.includes(gstMode)) errs.push({ field: "gstMode", error: "must be ON_MARKUP or ON_FULL" });

      const gstPercent = parseFloat(cell(r, "gstpercent") || "18");

      const clientName  = cell(r, "clientname");
      const clientGstin = cell(r, "clientgstin").toUpperCase();
      const resolvedWs  =
        (clientGstin && clientMap[clientGstin]) ||
        (clientName && clientMap[clientName.trim().replace(/\s+/g, " ").toLowerCase()]) || "";

      if (!resolvedWs) {
        const ref = clientName || clientGstin;
        errs.push({ field: "clientName", error: ref ? `client "${ref}" not found` : "clientName or clientGSTIN required" });
      }

      const sourceRaw = cell(r, "source").toUpperCase();
      const source = IMPORT_VALID_SOURCES.includes(sourceRaw) ? sourceRaw : "MANUAL";

      if (errs.length) { results.push({ rowNumber, valid: false, errors: errs }); continue; }

      const paxType = (IMPORT_VALID_PAX.includes(passengerType) ? passengerType : "ADULT") as "ADULT" | "CHILD" | "INFANT";
      const passengers: any[] = [];
      for (let pi = 0; pi < rawNames.length; pi++) {
        const pName = rawNames[pi];
        const pax: any = { name: pName, type: paxType };

        const phoneVal = phoneSlots[pi] ?? "";
        if (phoneVal) {
          const digits = phoneVal.replace(/\D/g, "");
          if (digits) pax.phone = digits.length >= 10 ? digits.slice(-10) : digits;
        }

        const panVal = panSlots[pi] ?? "";
        if (panVal) pax.panNo = panVal.toUpperCase();

        if (resolvedWs) {
          try {
            const escapedName = pName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const member: any = await CustomerMember.findOne({
              customerId: resolvedWs,
              name: { $regex: `^${escapedName}$`, $options: "i" },
            }).select("email travelerId").lean();
            if (member) {
              if (member.email) pax.email = member.email;
              if (member.travelerId) pax.travelerId = member.travelerId;
            }
          } catch {
            // fall back to name-only on lookup failure
          }
        }
        passengers.push(pax);
      }

      results.push({
        rowNumber,
        valid: true,
        data: {
          workspaceId: resolvedWs,
          type,
          source,
          bookingDate,
          travelDate,
          returnDate,
          itinerary: {
            origin:      normalizeRoute(cell(r, "origin")),
            destination: normalizeRoute(cell(r, "destination")),
            flightNo:    trimStr(cell(r, "flightno")),
            airline:     trimStr(cell(r, "airline")),
            trainClass:  type === "TRAIN" ? trimStr(cell(r, "trainclass")) : undefined,
            hotelName:   trimStr(cell(r, "hotelname")),
            roomType:    trimStr(cell(r, "roomtype")),
            roomCount:   Math.max(1, parseInt(cell(r, "roomcount") || "1") || 1),
            description: trimStr(cell(r, "description")),
          },
          passengers,
          pricing: {
            actualPrice, quotedPrice,
            gstMode: IMPORT_VALID_GST.includes(gstMode) ? gstMode : "ON_MARKUP",
            gstPercent: isNaN(gstPercent) ? 18 : gstPercent,
            currency: "INR",
          },
          supplierName: trimStr(cell(r, "suppliername")),
          supplierPNR:  trimStr(cell(r, "supplierpnr")),
          notes:        trimStr(cell(r, "notes")),
          bookedBy:     req.user._id,
          status:       "PENDING",
        },
      });
    }

    const validRows = results.filter((r) => r.valid);

    if (dryRun) {
      return res.json({ rows: results, summary: { valid: validRows.length, invalid: results.length - validRows.length } });
    }

    const insertResults: PromiseSettledResult<any>[] = [];
    for (const row of validRows) {
      try {
        const booking = await ManualBooking.create(row.data);
        insertResults.push({ status: "fulfilled", value: booking });
      } catch (err: any) {
        insertResults.push({ status: "rejected", reason: err });
      }
    }
    const inserted = insertResults.filter((r) => r.status === "fulfilled").length;
    const skipped  = insertResults.filter((r) => r.status === "rejected").length;
    const commitErrors = insertResults
      .map((r, i) => r.status === "rejected" ? { rowNumber: validRows[i].rowNumber, error: (r as PromiseRejectedResult).reason?.message } : null)
      .filter(Boolean);

    res.json({ inserted, skipped, errors: commitErrors });
  } catch (err: any) {
    console.error("[ManualBookings import]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/manual-bookings/creators
// Returns the distinct set of staff users who have created at least one booking
router.get("/creators", requirePermission("manualBookings", "READ"), async (req: any, res: any) => {
  try {
    const raw = await ManualBooking.aggregate([
      { $match: { createdBy: { $exists: true, $nin: [null, ""] } } },
      { $group: { _id: "$createdBy", email: { $first: "$createdByEmail" } } },
      { $match: { _id: { $nin: [null, ""] } } },
      // Attempt to join to User for display name; createdBy is stored as String(ObjectId)
      { $addFields: {
        createdByObjId: {
          $cond: {
            if: { $regexMatch: { input: { $ifNull: ["$_id", ""] }, regex: "^[0-9a-fA-F]{24}$" } },
            then: { $toObjectId: "$_id" },
            else: null,
          },
        },
      }},
      { $lookup: {
        from: "users",
        localField: "createdByObjId",
        foreignField: "_id",
        as: "user",
      }},
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      { $project: {
        _id: 1,
        name:  { $ifNull: ["$user.name",  ""] },
        email: { $ifNull: ["$user.email", "$email", ""] },
      }},
      { $sort: { email: 1 } },
    ]);
    res.json({ ok: true, creators: raw });
  } catch (err: any) {
    console.error("[ManualBookings creators]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/manual-bookings/:id
router.get("/:id", requirePermission("manualBookings", "READ"), async (req: any, res: any) => {
  try {
    const booking: any = await ManualBooking.findById(req.params.id)
      .populate("bookedBy", "name email")
      .populate("workspaceId", "name companyName")
      .populate("invoiceId", "invoiceNo status")
      .lean();
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const isAllScope = req.permissionScope === "ALL";
    if (!isAllScope) {
      const callerId = String(req.user._id || req.user.id || req.user.sub);
      if (booking.createdBy && booking.createdBy !== callerId) {
        return res.status(403).json({ success: false, message: "Not found" });
      }
    }

    res.json({ ok: true, booking: { ...booking, invoicePendingDays: invoicePendingDays(booking) } });
  } catch (err: any) {
    console.error("[ManualBookings GET one]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/manual-bookings/:id
router.put("/:id", requirePermission("manualBookings", "WRITE"), async (req: any, res: any) => {
  try {
    const booking = await ManualBooking.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status === "INVOICED") {
      return res.status(400).json({ message: "Cannot edit an invoiced booking" });
    }

    Object.assign(booking, req.body);
    await booking.save();
    res.json({ ok: true, booking });
  } catch (err: any) {
    console.error("[ManualBookings PUT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/manual-bookings/:id
router.delete("/:id", requirePermission("manualBookings", "FULL"), async (req: any, res: any) => {
  try {
    const booking = await ManualBooking.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status !== "PENDING" && booking.status !== "DRAFT" as any) {
      return res.status(400).json({ message: "Only PENDING bookings can be deleted" });
    }
    await booking.deleteOne();
    res.json({ ok: true, success: true });
  } catch (err: any) {
    console.error("[ManualBookings DELETE]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Import from SBT ─────────────────────────────────────────────── */

// POST /api/admin/manual-bookings/import-from-sbt
router.post("/import-from-sbt", requirePermission("manualBookings", "FULL"), async (req: any, res: any) => {
  try {
    const { bookingIds } = req.body as { bookingIds: string[] };
    const sourceType = (req.body.sourceType as string) || "SBT";

    if (!Array.isArray(bookingIds) || !bookingIds.length) {
      return res.status(400).json({ error: "bookingIds array is required" });
    }

    let imported = 0;
    let skipped = 0;
    let failed = 0;
    const details: { bookingId: string; status: string; bookingRef?: string; error?: string }[] = [];

    for (const bookingId of bookingIds) {
      // Check if already imported
      const exists = await ManualBooking.findOne({ sourceBookingId: bookingId }).lean();
      if (exists) {
        skipped++;
        details.push({ bookingId, status: "skipped" });
        continue;
      }

      try {
        let sbtDoc: any = null;
        let bookingKind: "FLIGHT" | "HOTEL" = "FLIGHT";

        sbtDoc = await SBTBooking.findById(bookingId).lean();
        if (!sbtDoc) {
          const hotelDoc = await SBTHotelBooking.findById(bookingId).lean();
          if (hotelDoc) {
            sbtDoc = hotelDoc;
            bookingKind = "HOTEL";
          }
        }

        if (!sbtDoc) {
          failed++;
          details.push({ bookingId, status: "failed", error: "source booking not found" });
          continue;
        }

        // SBTBooking.workspaceId is a CustomerWorkspace._id.
        // Resolve to Customer._id so ManualBooking.workspaceId is consistent
        // with the rest of the system (which uses Customer._id, not CWS._id).
        const cws = await CustomerWorkspace.findById(sbtDoc.workspaceId)
          .select("customerId")
          .lean() as any;
        const workspaceId = cws?.customerId || sbtDoc.workspaceId;

        let data: any;

        if (bookingKind === "FLIGHT") {
          data = {
            workspaceId,
            type: "FLIGHT",
            source: "SBT",
            sourceBookingId: sbtDoc._id,
            sourceBookingRef: sbtDoc.pnr || sbtDoc.bookingId || String(sbtDoc._id),
            bookingDate: new Date(),
            travelDate: new Date(sbtDoc.departureTime),
            sector: `${sbtDoc.origin?.city || ""}-${sbtDoc.destination?.city || ""}`,
            itinerary: {
              origin: sbtDoc.origin?.city || "",
              destination: sbtDoc.destination?.city || "",
              airline: sbtDoc.airlineName || "",
              flightNo: sbtDoc.flightNumber || "",
              description: `${sbtDoc.origin?.city || ""} → ${sbtDoc.destination?.city || ""}`,
            },
            passengers: (sbtDoc.passengers || []).map((p: any) => ({
              name: `${p.firstName || ""} ${p.lastName || ""}`.trim(),
              type:
                p.paxType === "CHILD" || p.paxType === 2
                  ? "CHILD"
                  : p.paxType === "INFANT" || p.paxType === 3
                    ? "INFANT"
                    : "ADULT",
            })),
            pricing: {
              actualPrice: sbtDoc.netAmount || sbtDoc.totalFare || 0,
              quotedPrice: sbtDoc.displayAmount || sbtDoc.totalFare || 0,
              gstMode: "ON_MARKUP",
              gstPercent: 18,
              currency: "INR",
            },
            supplierName: sbtDoc.airlineName || "TBO",
            supplierPNR: sbtDoc.pnr || sbtDoc.bookingId,
            status: "CONFIRMED",
            bookedBy: req.user._id,
            notes: `Imported from SBT on ${new Date().toLocaleDateString()}`,
          };
        } else {
          const nights = Math.max(
            1,
            Math.round(
              (new Date(sbtDoc.checkOut).getTime() - new Date(sbtDoc.checkIn).getTime()) / 86400000,
            ),
          );
          data = {
            workspaceId,
            type: "HOTEL",
            source: "SBT",
            sourceBookingId: sbtDoc._id,
            sourceBookingRef:
              sbtDoc.confirmationNo || sbtDoc.bookingRefNo || sbtDoc.bookingId || String(sbtDoc._id),
            bookingDate: new Date(),
            travelDate: new Date(sbtDoc.checkIn),
            returnDate: new Date(sbtDoc.checkOut),
            sector: sbtDoc.cityName || "",
            itinerary: {
              hotelName: sbtDoc.hotelName || "",
              roomType: sbtDoc.roomName || "",
              destination: sbtDoc.cityName || "",
              nights,
              description: sbtDoc.hotelName || "",
            },
            passengers: (sbtDoc.guests || []).map((g: any) => ({
              name: `${g.FirstName || ""} ${g.LastName || ""}`.trim(),
              type: "ADULT",
            })),
            pricing: {
              actualPrice: sbtDoc.netAmount || sbtDoc.totalFare || 0,
              quotedPrice: sbtDoc.displayAmount || sbtDoc.totalFare || 0,
              gstMode: "ON_MARKUP",
              gstPercent: 18,
              currency: "INR",
            },
            supplierName: "TBO",
            supplierPNR: sbtDoc.confirmationNo || sbtDoc.bookingRefNo || sbtDoc.bookingId,
            status: "CONFIRMED",
            bookedBy: req.user._id,
            notes: `Imported from SBT Hotels on ${new Date().toLocaleDateString()}`,
          };
        }

        const doc = new ManualBooking(data);
        await doc.save();
        imported++;
        details.push({ bookingId, status: "imported", bookingRef: doc.bookingRef });
      } catch (saveErr: any) {
        failed++;
        details.push({ bookingId, status: "failed", error: saveErr.message });
      }
    }

    res.json({ ok: true, imported, skipped, failed, details });
  } catch (err: any) {
    console.error("[ManualBookings import-from-sbt]", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
