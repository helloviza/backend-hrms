import express from "express";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import ManualBooking from "../models/ManualBooking.js";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import Customer from "../models/Customer.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

const router = express.Router();

router.use(requireAuth);

/* ── Helpers ────────────────────────────────────────────────────── */

function buildSearchFilter(query: Record<string, any>) {
  const filter: Record<string, any> = {};

  if (query.workspaceId) filter.workspaceId = query.workspaceId;
  if (query.status) filter.status = query.status;
  if (query.type) filter.type = query.type;
  if (query.source) filter.source = query.source;
  if (query.givenBy) filter.givenBy = new RegExp(query.givenBy, "i");
  if (query.sector) filter.sector = new RegExp(query.sector, "i");
  if (query.week) filter.bookingWeek = parseInt(query.week);
  if (query.month) filter.bookingMonth = query.month;
  if (query.sourceBookingId) filter.sourceBookingId = query.sourceBookingId;

  if (query.dateFrom || query.dateTo) {
    filter.travelDate = {};
    if (query.dateFrom) filter.travelDate.$gte = new Date(query.dateFrom);
    if (query.dateTo) filter.travelDate.$lte = new Date(query.dateTo);
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
  "Price Benefits",
  "Request Process TAT",
  "Invoice Raised Date",
  "Invoice Status",
  "Invoice Pending Days",
  "Booking Week",
  "Booking Month",
];

// Money column indices (1-based): Quoted=14, Actual=15, Diff=16, GST=17, Base=18, Grand=19
const MONEY_COLS = [14, 15, 16, 17, 18, 19];

function bookingToRow(b: any, srNo: number, wsNameMap: Record<string, string> = {}): (string | number | undefined)[] {
  const wsName =
    wsNameMap[b.workspaceId?.toString() ?? ""] ||
    b.workspaceId?.name || b.workspaceId?.companyName || String(b.workspaceId ?? "");
  const invDate = fmtDateDMY(b.invoiceRaisedDate);
  const invNo   = b.invoiceId?.invoiceNo ?? "";
  const invStatus = b.invoiceId?.status ?? "";
  const sector  =
    b.sector ||
    (b.itinerary?.origin && b.itinerary?.destination
      ? `${b.itinerary.origin}-${b.itinerary.destination}`
      : b.itinerary?.hotelName || "");
  const paxNames = (b.passengers || []).map((p: any) => p.name).join(" | ");
  const tat = b.requestProcessTAT ? `${b.requestProcessTAT} days` : "";

  return [
    srNo,
    wsName,
    invDate,
    invNo,
    b.supplierName ?? "",
    fmtDateDMY(b.reqDate),
    paxNames,
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
    b.priceBenefits ?? "",
    tat,
    invDate,
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
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const filter = buildSearchFilter(req.query);

    // Scope non-ALL users to their own bookings only
    const isAllScope = req.permissionScope === "ALL";
    if (!isAllScope) {
      filter.createdBy = String(req.user._id || req.user.id || req.user.sub);
    }

    const [docs, total] = await Promise.all([
      ManualBooking.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("bookedBy", "name email")
        .populate("workspaceId", "name companyName")
        .populate("invoiceId", "invoiceNo status")
        .lean(),
      ManualBooking.countDocuments(filter),
    ]);

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
    res.json({ ok: true, docs: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (err: any) {
    console.error("[ManualBookings GET list]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/manual-bookings/export
router.get("/export", requirePermission("manualBookings", "FULL"), async (req: any, res: any) => {
  try {
    const filter = buildSearchFilter(req.query);
    const format = req.query.format === "xlsx" ? "xlsx" : "csv";
    const docs = await ManualBooking.find(filter)
      .sort({ createdAt: -1 })
      .populate("bookedBy", "name email")
      .populate("workspaceId", "name companyName")
      .populate("invoiceId", "invoiceNo status")
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

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="bookings-export.csv"');

      res.write(csvRow(BOOKING_COLUMNS));
      docs.forEach((b, idx) => {
        res.write(csvRow(bookingToRow(b, idx + 1, wsNameMap)));
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

    // Column widths
    const colWidths = [7, 22, 14, 18, 16, 12, 28, 22, 16, 10, 18, 14, 14, 14, 14, 12, 10, 12, 14, 12, 25, 20, 14, 14, 16, 12, 16];
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
      const row = bookingToRow(b, idx + 1, wsNameMap);
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
