import express from "express";
import ExcelJS from "exceljs";
import { requireAuth } from "../middleware/auth.js";
import { requireRoles } from "../middleware/roles.js";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { parseISTStart, parseISTEnd } from "../utils/dateIST.js";

/**
 * SBT Booking Register (v1) — TBO-format Air + Hotel register for Plumtrips ops.
 *
 * Access: SUPERADMIN role AND an @plumtrips.com email. Role alone is not enough —
 * this report exposes cross-company supplier cost + margin, so the email-domain gate
 * (requirePlumtripsEmail below) restricts it to Plumtrips house staff on BOTH the
 * JSON and the CSV/XLSX export paths (single endpoint, one guard chain).
 *
 * Columns flagged `internal: true` (NET / Margin / Margin%) are cost/margin and are
 * INCLUDED in this Super-Admin v1; the flag lets a future client-facing variant strip
 * them without changing the data layer.
 *
 * TODO (out of scope v1): GST split columns (CGST/SGST/IGST — live on Invoice via a
 * ManualBooking link), raw-blob extractor columns (passport, PLB/incentive rates, K3,
 * fare basis), TCS/ROE, and the client-sanitized variant.
 */

const router = express.Router();

// ── Access guards (apply to every path on this router, incl. export) ──
function requirePlumtripsEmail(req: any, res: any, next: any) {
  const email = String(req.user?.email || "").trim().toLowerCase();
  if (!email.endsWith("@plumtrips.com")) {
    return res
      .status(403)
      .json({ error: "Forbidden: the booking register is restricted to Plumtrips staff." });
  }
  next();
}
router.use(requireAuth, requireRoles("SUPERADMIN"), requirePlumtripsEmail);

// ── Column meta (single source of truth for table + export) ──
type Col = { key: string; label: string; money?: boolean; internal?: boolean };

const AIR_COLUMNS: Col[] = [
  { key: "date", label: "Date" },
  { key: "company", label: "Company" },
  { key: "booker", label: "Booker" },
  { key: "paxName", label: "Pax Name" },
  { key: "pnr", label: "PNR" },
  { key: "ticketNo", label: "Ticket No" },
  { key: "airline", label: "Airline" },
  { key: "airlineCode", label: "Airline Code" },
  { key: "sector", label: "Sector" },
  { key: "travelDate", label: "Travel Date" },
  { key: "fare", label: "Fare", money: true },
  { key: "tax", label: "Tax", money: true },
  { key: "specialSerChrgs", label: "Special Ser Chrgs", money: true },
  { key: "gross", label: "Gross", money: true },
  { key: "net", label: "NET", money: true, internal: true },
  { key: "margin", label: "Margin", money: true, internal: true },
  { key: "marginPct", label: "Margin %", internal: true },
  { key: "paymentId", label: "Payment Id" },
  { key: "ticketStatus", label: "Ticket Status" },
  { key: "isAmendment", label: "Is Amendment" },
  { key: "status", label: "Status" },
];

const HOTEL_COLUMNS: Col[] = [
  { key: "date", label: "Date" },
  { key: "company", label: "Company" },
  { key: "booker", label: "Booker" },
  { key: "paxName", label: "Pax Name" },
  { key: "hotelName", label: "Hotel Name" },
  { key: "destinationCity", label: "Destination City" },
  { key: "checkIn", label: "Check In" },
  { key: "checkOut", label: "Check Out" },
  { key: "nights", label: "Nights" },
  { key: "rooms", label: "Rooms" },
  { key: "refNo", label: "Ref No" },
  { key: "confirmationNo", label: "Confirmation No" },
  { key: "tboConfirmationNo", label: "TBO Confirmation No" },
  { key: "intlDom", label: "INTL/DOM" },
  { key: "total", label: "Total", money: true },
  { key: "net", label: "NET", money: true, internal: true },
  { key: "margin", label: "Margin", money: true, internal: true },
  { key: "tds", label: "TDS", money: true },
  { key: "cancellationFee", label: "Cancellation Fee", money: true },
  { key: "paymentId", label: "Payment ID" },
  { key: "bookingClass", label: "Booking Class" },
  { key: "amendmentType", label: "Amendment Type" },
  { key: "status", label: "Status" },
  { key: "agencyReference", label: "Agency Reference" },
];

// ── Small local formatters (mirror routes/manualBookings.ts; kept local to stay additive) ──
function fmtDateDMY(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = new Date(d as string);
  if (isNaN(dt.getTime())) return "";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${dt.getFullYear()}`;
}

function csvRow(values: (string | number | undefined | null)[]): string {
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nightsBetween(ci: string | undefined, co: string | undefined): number | "" {
  if (!ci || !co) return "";
  const a = new Date(ci);
  const b = new Date(co);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return "";
  const n = Math.round((b.getTime() - a.getTime()) / 86_400_000);
  return n > 0 ? n : "";
}

// ── Row builders ──
async function buildAirRows(filter: Record<string, any>): Promise<Record<string, any>[]> {
  const docs = await SBTBooking.find(filter)
    .sort({ bookedAt: -1 })
    .populate("workspaceId", "companyName name")
    .populate("userId", "email name")
    .lean();
  return docs.map((b: any) => {
    const pax: any[] = b.passengers || [];
    const lead = pax.find((p) => p.isLead) || pax[0] || {};
    return {
      date: fmtDateDMY(b.bookedAt),
      company: b.workspaceId?.companyName || b.workspaceId?.name || "",
      booker: b.userId?.email || "",
      paxName: `${lead.firstName || ""} ${lead.lastName || ""}`.trim(),
      pnr: b.pnr || "",
      ticketNo: b.ticketId || (b.ticketIds || []).join(", ") || "",
      airline: b.airlineName || "",
      airlineCode: b.airlineCode || "",
      sector: [b.origin?.code, b.destination?.code].filter(Boolean).join("–"),
      travelDate: fmtDateDMY(b.departureTime),
      fare: b.baseFare ?? 0,
      tax: b.taxes ?? 0,
      specialSerChrgs: b.extras ?? 0,
      gross: b.totalFare ?? 0,
      net: b.netAmount ?? 0,
      margin: b.marginAmount ?? 0,
      marginPct: b.marginPercent ?? 0,
      paymentId: b.razorpayPaymentId || "",
      ticketStatus: b.ticketingStatus || "",
      isAmendment: b.isReissued ? "Yes" : "No",
      status: b.status || "",
    };
  });
}

async function buildHotelRows(filter: Record<string, any>): Promise<Record<string, any>[]> {
  const docs = await SBTHotelBooking.find(filter)
    .sort({ bookedAt: -1 })
    .populate("workspaceId", "companyName name")
    .populate("userId", "email name")
    .lean();
  return docs.map((h: any) => {
    const guests: any[] = h.guests || [];
    const lead = guests.find((g) => g.LeadPassenger) || guests[0] || {};
    const total = h.totalFare ?? 0;
    const net = h.netAmount ?? 0;
    const lastAmend = (h.changeRequests || []).slice(-1)[0];
    const cc = String(h.countryCode || "").trim().toUpperCase();
    return {
      date: fmtDateDMY(h.bookedAt),
      company: h.workspaceId?.companyName || h.workspaceId?.name || "",
      booker: h.userId?.email || "",
      paxName: `${lead.FirstName || ""} ${lead.LastName || ""}`.trim(),
      hotelName: h.hotelName || "",
      destinationCity: h.cityName || "",
      checkIn: fmtDateDMY(h.checkIn),
      checkOut: fmtDateDMY(h.checkOut),
      nights: nightsBetween(h.checkIn, h.checkOut),
      rooms: h.rooms ?? "",
      refNo: h.bookingRefNo || "",
      confirmationNo: h.confirmationNo || "",
      tboConfirmationNo: h.tboReferenceNo || "",
      intlDom: cc ? (cc === "IN" ? "DOM" : "INTL") : "",
      total,
      // Hotel net is durable on the doc, so margin derives cleanly.
      margin: net > 0 ? total - net : 0,
      net,
      tds: h.tds ?? 0,
      cancellationFee: h.cancellationCharge ?? 0,
      paymentId: h.paymentId || "",
      bookingClass: h.roomName || "",
      amendmentType: lastAmend?.requestType || "",
      status: h.status || "",
      agencyReference: h.clientReferenceId || "",
    };
  });
}

// GET /api/admin/sbt/booking-register?type=air|hotel&dateFrom&dateTo&company[&format=csv|xlsx]
router.get("/", async (req: any, res: any) => {
  try {
    const type = req.query.type === "hotel" ? "hotel" : "air";
    const format =
      req.query.format === "xlsx" ? "xlsx" : req.query.format === "csv" ? "csv" : "json";
    const cols = type === "hotel" ? HOTEL_COLUMNS : AIR_COLUMNS;

    // Date range on bookedAt (IST day boundaries, same helpers as manual-bookings export).
    const filter: Record<string, any> = {};
    const from = req.query.dateFrom ? parseISTStart(String(req.query.dateFrom)) : null;
    const to = req.query.dateTo ? parseISTEnd(String(req.query.dateTo)) : null;
    if (from || to) {
      filter.bookedAt = {};
      if (from) filter.bookedAt.$gte = from;
      if (to) filter.bookedAt.$lte = to;
    }

    // Company filter → resolve matching workspace ids by companyName (case-insensitive contains).
    if (req.query.company) {
      const rx = new RegExp(escapeRegExp(String(req.query.company)), "i");
      const wss = await CustomerWorkspace.find({ companyName: rx }).select("_id").lean();
      filter.workspaceId = { $in: wss.map((w: any) => w._id) };
    }

    const rows = type === "hotel" ? await buildHotelRows(filter) : await buildAirRows(filter);

    if (format === "json") {
      return res.json({ type, columns: cols, rows });
    }

    // ── Export (CSV / XLSX) — includes internal columns in this Super-Admin v1 ──
    const header = cols.map((c) => c.label);
    const matrix = rows.map((r) => cols.map((c) => r[c.key]));

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="sbt-booking-register-${type}.csv"`,
      );
      res.write(csvRow(header));
      matrix.forEach((r) => res.write(csvRow(r)));
      return res.end();
    }

    // XLSX (mirror the manual-bookings ExcelJS pattern: frozen header, money number format)
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(type === "hotel" ? "Hotel" : "Air");
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    const headerRow = sheet.addRow(header);
    headerRow.font = { bold: true };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF0" } };
    cols.forEach((c, i) => {
      if (c.money) sheet.getColumn(i + 1).numFmt = "#,##0.00";
    });
    matrix.forEach((r) => sheet.addRow(r));
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="sbt-booking-register-${type}.xlsx"`,
    );
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err: any) {
    console.error("[SBT BookingRegister]", err?.message);
    res.status(500).json({ error: err?.message || "Booking register failed" });
  }
});

export default router;
