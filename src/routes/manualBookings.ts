import express from "express";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import multer from "multer";
import XLSX from "xlsx";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { triggerTaskAutomation } from "../services/taskAutomation.js";
import ManualBooking from "../models/ManualBooking.js";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import Customer from "../models/Customer.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import CustomerMember from "../models/CustomerMember.js";
import Invoice from "../models/Invoice.js";
import User from "../models/User.js";
import { parseISTStart, parseISTEnd } from "../utils/dateIST.js";
import { canAccessBooking, isHouseCallerContext } from "../utils/bookingAccess.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import { uploadBufferToS3 } from "../utils/s3Upload.js";
import { presignGetObject } from "../utils/s3Presign.js";
import { s3 } from "../config/aws.js";
import { env } from "../config/env.js";
import { maskTailId } from "../utils/piiMask.js";

const router = express.Router();
const xlsxUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Ticket/voucher attachment uploads — see infra/audit/
// manual-bookings-voucher-upload-audit.md. Same memoryStorage-then-S3 pattern
// as xlsxUpload above and HR Policies/Vouchers elsewhere in the codebase.
const ATTACHMENT_ALLOWED_MIME = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ATTACHMENT_ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
    cb(new Error("Only PDF, PNG, JPEG, or WEBP files are allowed."));
  },
});

// PlumTrips House Customer._id — see scripts/seed-intake-system-identities.ts
// and routes/intake.travel.ts. Intake-created bookings carry this workspaceId
// and createdBy=SYSTEM_INTAKE_USER_ID, so the createdBy-scoped filter below
// would otherwise hide them from every non-ALL-scope triage staffer.
const HOUSE_CUSTOMER_ID = "6a4e0d2ea90c293c9e129f48";

router.use(requireAuth);

/* ── Helpers ────────────────────────────────────────────────────── */

// Builds the caller-side context canAccessBooking() checks a record against —
// see utils/bookingAccess.ts for the predicate and infra/audit/
// manual-bookings-access-verification.md for why each field is needed.
function bookingAccessContextFromReq(req: any) {
  return {
    callerId: String(req.user._id || req.user.id || req.user.sub),
    customerId: req.workspace?.customerId ?? null,
    workspaceObjectId: req.workspaceObjectId,
    permissionScope: req.permissionScope,
    isSuperAdmin: isSuperAdmin(req),
  };
}

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

  // Filter bookingDate (what the UI column shows). YYYY-MM-DD inputs are
  // interpreted as IST calendar days; full last day is included.
  if (query.dateFrom || query.dateTo) {
    filter.bookingDate = {};
    if (query.dateFrom) filter.bookingDate.$gte = parseISTStart(query.dateFrom);
    if (query.dateTo)   filter.bookingDate.$lte = parseISTEnd(query.dateTo);
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

  // Demo Platform — exclude demo bookings from admin manual-bookings views.
  filter.isDemo = { $ne: true };

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

export function invoicePendingDays(b: any): number {
  if (!b.invoiceRaisedDate) return 0;
  if (b.status === "PAID" || b.status === "CANCELLED") return 0;
  return Math.floor(
    (Date.now() - new Date(b.invoiceRaisedDate).getTime()) / (1000 * 60 * 60 * 24),
  );
}

/* ── Required-field validation ───────────────────────────────────────
 * Mirrors the ManualBookingForm front-end rules so bookings created
 * outside the form (API, imports) can't bypass them. Booking-type matrix:
 *   - supplierName : required for every type
 *   - givenBy      : required for every type (form + create/update API only)
 *   - City         : required for HOTEL/DUMMY_HOTEL (sector OR itinerary.destination)
 *   - returnDate   : required for HOTEL/DUMMY_HOTEL (check-out)
 * Import paths (Excel /import, SBT import) carry no givenBy and SBT flights
 * carry no return date, so imports enforce the reduced set (supplier + city).
 */
const HOTEL_TYPES = ["HOTEL", "DUMMY_HOTEL"];

function hotelCityPresent(b: any): boolean {
  return Boolean(
    String(b?.sector ?? "").trim() ||
    String(b?.itinerary?.destination ?? "").trim(),
  );
}

// Full rule set — used by the form-driven create/update API.
function validateBookingRequired(b: any): string[] {
  const errors: string[] = [];
  const type = String(b?.type ?? "").toUpperCase();
  if (!String(b?.supplierName ?? "").trim()) errors.push("Supplier Name is required");
  if (!String(b?.givenBy ?? "").trim()) errors.push("Given By is required");
  if (HOTEL_TYPES.includes(type)) {
    if (!hotelCityPresent(b)) errors.push("City is required for hotel bookings");
    if (!b?.returnDate) errors.push("Check-out (return) date is required for hotel bookings");
  }
  return errors;
}

// Reduced rule set for import paths — supplier + hotel-city only.
function validateImportRequired(b: any): string[] {
  const errors: string[] = [];
  const type = String(b?.type ?? "").toUpperCase();
  if (!String(b?.supplierName ?? "").trim()) errors.push("supplierName is required");
  if (HOTEL_TYPES.includes(type) && !hotelCityPresent(b)) errors.push("city is required for hotel bookings");
  return errors;
}

// Update rule set (Option B) — enforce a required field ONLY if it was already
// present in the pre-update document. This means an edit may not blank out a
// previously-filled required field, but a legacy/incomplete booking that never
// had the field stays editable (no forced backfill). `merged` is the document
// after req.body is applied; `before` is a snapshot taken beforehand.
function validateBookingRequiredForUpdate(merged: any, before: any): string[] {
  const errors: string[] = [];
  const type = String(merged?.type ?? "").toUpperCase();

  if (String(before?.supplierName ?? "").trim() && !String(merged?.supplierName ?? "").trim())
    errors.push("Supplier Name is required");

  if (String(before?.givenBy ?? "").trim() && !String(merged?.givenBy ?? "").trim())
    errors.push("Given By is required");

  if (HOTEL_TYPES.includes(type)) {
    if (hotelCityPresent(before) && !hotelCityPresent(merged))
      errors.push("City is required for hotel bookings");
    if (before?.returnDate && !merged?.returnDate)
      errors.push("Check-out (return) date is required for hotel bookings");
  }

  return errors;
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
  "Booking Date",
  "Ref No.",
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
  // Per-type detail columns (appended — see infra/audit/manual-bookings-export-fields-audit.md).
  // Sourced from the uniform ManualBooking.itinerary sub-schema + top-level supplierPNR.
  // Blank when not applicable to the row's booking type.
  "Flight / Train No",
  "Airline",
  "Train Class",
  "Hotel Name",
  "Room Type",
  "Nights",
  "Rooms",
  "Service Description",
  "Supplier PNR / Booking ID",
  // Group Booking (Holidays/Events/Group Booking) line-item table — see
  // infra/audit/events-line-items-audit.md. Flattened into ONE cell (not
  // exploded into extra rows) so Sr. No / Traveler ID / the MONEY_COLS
  // per-row-is-one-booking totals below all stay correct; blank for every
  // other type. Format: "1. Item — Qty N x Rate R (GST G%) = Amount".
  "Line Items",
  // Transfer/Cab and Visa detail columns — appended at the end (not inserted
  // among the cols above) to keep every existing column position stable for
  // anyone's downstream sheets. Blank when not applicable to the row's type.
  "Pickup Location",
  "Drop Location",
  "Vehicle Type",
  "Visa Country",
  "Visa Type",
];

// Money column indices (1-based): Quoted=17, Actual=18, Diff=19, GST=20, Base=21, Grand=22
// (shifted +2 by the "Booking Date" (pos 2) and "Ref No." (pos 3) columns)
const MONEY_COLS = [17, 18, 19, 20, 21, 22];

// Mask passport/PAN to last-4 for the admin list view — full plaintext stays
// available on the single-booking detail read (staff need it to service the
// booking) and to SUPERADMIN, but the list/export surface should never hand
// out full numbers to every manualBookings:READ holder. maskTailId itself
// lives in utils/piiMask.ts, shared with TravellerProfile's export route.
function maskPassengerPII(passengers: any[] | undefined): any[] | undefined {
  if (!Array.isArray(passengers)) return passengers;
  return passengers.map((p: any) => ({
    ...p,
    panNo: maskTailId(p?.panNo),
    passportNo: maskTailId(p?.passportNo),
  }));
}

// One flat cell per booking — see the "Line Items" column comment above.
export function formatLineItems(b: any): string {
  const items: any[] = Array.isArray(b.lineItems) ? b.lineItems : [];
  if (!items.length) return "";
  return items
    .map((li) => `${li.sNo}. ${li.itemDescription} — Qty ${li.quantity} x ₹${li.rate} (GST ${li.gstPct}%) = ₹${li.amount}`)
    .join(" | ");
}

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
    fmtDateDMY(b.bookingDate),
    b.bookingRef ?? "",
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
    b.itinerary?.flightNo ?? "",
    b.itinerary?.airline ?? "",
    b.itinerary?.trainClass ?? "",
    b.itinerary?.hotelName ?? "",
    b.itinerary?.roomType ?? "",
    b.itinerary?.nights ?? "",
    b.itinerary?.roomCount ?? "",
    b.itinerary?.description ?? "",
    b.supplierPNR ?? "",
    formatLineItems(b),
    b.itinerary?.pickupLocation ?? "",
    b.itinerary?.dropLocation ?? "",
    b.itinerary?.vehicleType ?? "",
    b.itinerary?.visaCountry ?? "",
    b.itinerary?.visaType ?? "",
  ];
}

/* ── CRUD ────────────────────────────────────────────────────────── */

// POST /api/admin/manual-bookings
router.post("/", requirePermission("manualBookings", "WRITE"), async (req: any, res: any) => {
  try {
    const vErrors = validateBookingRequired(req.body);
    if (vErrors.length) {
      return res.status(400).json({ error: vErrors.join("; "), details: vErrors });
    }

    const booking = await ManualBooking.create({
      ...req.body,
      bookedBy: req.user._id,
      source: req.body.source || "MANUAL",
      sourceBookingId: req.body.sourceBookingId || undefined,
      createdBy: String(req.user._id || req.user.id || req.user.sub),
      createdByEmail: req.user.email,
      // Demo Platform — booking authored under impersonation
      isDemo: req.user?.isDemoUser === true,
      createdByDemoUser: req.user?.isDemoUser === true,
    });

    // Task automation hook for pending bookings
    if ((booking as any).status === "PENDING" && (booking as any).workspaceId) {
      triggerTaskAutomation("booking.created_pending", {
        workspaceId: String((booking as any).workspaceId),
        entityType: "BOOKING",
        entityId: booking._id as any,
        entityRef: (booking as any).bookingRef,
        ownerId: req.user._id,
        variables: { bookingRef: (booking as any).bookingRef || "" },
      }).catch(() => {});
    }

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

    // Scope non-ALL users to their own bookings only — with a bypass for
    // HOUSE intake rows still awaiting triage (see HOUSE_CUSTOMER_ID above),
    // since those are createdBy=SYSTEM_INTAKE_USER_ID, never the viewing staffer.
    const accessCtx = bookingAccessContextFromReq(req);
    const isAllScope = req.permissionScope === "ALL";
    const selfId = accessCtx.callerId;

    const andClauses: any[] = [];
    if (filter.$or) {
      // buildSearchFilter may already own $or (free-text search) — AND it in
      // alongside whatever gets added below instead of clobbering it.
      andClauses.push({ $or: filter.$or });
      delete filter.$or;
    }

    // Tenant gate (infra/audit/manual-bookings-access-verification.md) — HOUSE
    // staff and SuperAdmin manage all tenants and are exempt. Everyone else,
    // including ALL-scope holders, is restricted to their own tenant, checked
    // in both id-spaces (ManualBooking.workspaceId is a Customer._id;
    // req.workspaceObjectId is a CustomerWorkspace._id — see bookingAccess.ts).
    if (!accessCtx.isSuperAdmin && !isHouseCallerContext(accessCtx)) {
      const tenantOr: any[] = [];
      if (accessCtx.customerId && mongoose.Types.ObjectId.isValid(accessCtx.customerId)) {
        tenantOr.push({ workspaceId: new mongoose.Types.ObjectId(accessCtx.customerId) });
      }
      if (accessCtx.workspaceObjectId) {
        tenantOr.push({ workspaceId: accessCtx.workspaceObjectId });
      }
      // No resolvable tenant identity for a non-HOUSE caller — fail closed
      // rather than skip the gate.
      andClauses.push(tenantOr.length ? { $or: tenantOr } : { _id: { $in: [] } });
    }

    if (!isAllScope) {
      const scopeOr = [
        { createdBy: selfId },
        { workspaceId: new mongoose.Types.ObjectId(HOUSE_CUSTOMER_ID), assignmentStatus: "PENDING_TO_ASSIGN" },
        // Once a HOUSE intake row is ASSIGNED, assignmentStatus no longer
        // matches the clause above and createdBy is still the System Intake
        // User (never the assignee) — without this, the assignee loses their
        // own assigned booking from the list the moment it's assigned to them.
        { workspaceId: new mongoose.Types.ObjectId(HOUSE_CUSTOMER_ID), assignPerson: new mongoose.Types.ObjectId(selfId) },
      ];
      andClauses.push({ $or: scopeOr });
    }

    if (andClauses.length) {
      filter.$and = [...(filter.$and || []), ...andClauses];
    }

    // Soft delete filter — hide deleted rows unless SuperAdmin requests them
    const isSuperAdmin = Array.isArray(req.user.roles) && req.user.roles.includes("SUPERADMIN");
    if (req.query.showDeleted === "true" && isSuperAdmin) {
      filter.isActive = false;
    } else {
      filter.isActive = { $ne: false };
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
      // Bug 4 fix: aggregate over the full filtered set, not just the current page.
      // Six-metric financial summary — identical formulas to /admin/reports so both
      // pages show the same numbers for the same dataset. grandTotal is always the
      // full GST-inclusive client payment (see ManualBooking pre-save hook), so
      // netSales = grandTotal − gstAmount = sell-ex-GST in both GST modes.
      ManualBooking.aggregate([
        { $match: filter },
        { $group: {
          _id: null,
          grossSales:      { $sum: { $ifNull: [ "$pricing.grandTotal",
                             { $ifNull: [ "$pricing.totalWithGST", "$pricing.quotedPrice" ] } ] } },
          gstPayable:      { $sum: "$pricing.gstAmount" },
          netProfit:       { $sum: "$pricing.basePrice" },
          pendingInvoices: { $sum: { $cond: [{ $ne: ["$status", "INVOICED"] }, 1, 0] } },
        }},
      ]),
    ]);

    const aggStats = statsAgg[0] ?? { grossSales: 0, gstPayable: 0, netProfit: 0, pendingInvoices: 0 };
    const grossSales = aggStats.grossSales ?? 0;
    const gstPayable = aggStats.gstPayable ?? 0;
    const netProfit  = aggStats.netProfit  ?? 0;
    const netSales   = grossSales - gstPayable;
    const avgMargin  = netSales > 0 ? parseFloat(((netProfit / netSales) * 100).toFixed(2)) : 0;

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
      // panNo/passportNo masked to last-4 unless the caller is SUPERADMIN —
      // this list is reachable by any manualBookings:READ holder, not just
      // the staff actually servicing the booking (see docs/audits/
      // traveller-profiles-scoping.md §4.2).
      passengers: accessCtx.isSuperAdmin ? b.passengers : maskPassengerPII(b.passengers),
    }));

    console.log('[manualBookings GET] enriched[0].clientName:', enriched?.[0]?.clientName);
    res.json({
      ok: true,
      docs: enriched,
      total,
      page,
      pages: Math.ceil(total / limit),
      stats: {
        grossSales,
        netSales,
        gstPayable,
        netProfit,
        bookingCount:    total,
        avgMargin,
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

    // Column widths (46 cols: Booking Date at pos 2, Ref No. at pos 3, Traveler ID after Pax Name;
    // cols 32-40 are the appended per-type detail columns; col 41 is Line Items;
    // cols 42-46 are the Transfer/Cab + Visa detail columns appended after that)
    const colWidths = [7, 14, 16, 22, 14, 18, 16, 12, 28, 14, 22, 16, 10, 18, 14, 14, 14, 14, 12, 10, 12, 14, 12, 22, 25, 20, 14, 14, 16, 12, 16, 16, 16, 12, 24, 18, 9, 8, 30, 22, 40, 20, 20, 16, 16, 16];
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
      ManualBooking.find({ source: "SBT", type: { $ne: "HOTEL" }, isDemo: { $ne: true } }).distinct("sourceBookingId"),
      ManualBooking.find({ source: "SBT", type: "HOTEL", isDemo: { $ne: true } }).distinct("sourceBookingId"),
    ]);
    const importedSet = new Set(importedRaw.map((id: any) => id.toString()));
    const importedHotelSet = new Set(importedHotelRaw.map((id: any) => id.toString()));

    const [flights, hotels] = await Promise.all([
      SBTBooking.find({
        status: { $in: ["CONFIRMED", "PENDING", "CANCELLED"] },
        isDemo: { $ne: true },
      })
        .populate("workspaceId", "name companyName customerId")
        .sort({ createdAt: -1 })
        .limit(200)
        .lean(),
      SBTHotelBooking.find({
        status: { $in: ["CONFIRMED", "PENDING", "HELD", "CANCELLED"] },
        isDemo: { $ne: true },
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
          isDemo: { $ne: true },
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
      ["type", "YES", "FLIGHT, HOTEL, VISA, TRANSFER, OTHER, CAB, FOREX, ESIM, HOLIDAYS, EVENTS, DUMMY_FLIGHT, DUMMY_HOTEL, TRAIN, FLIGHT_RESCHEDULE, TROPHY, GIFT, STATIONERY"],
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
  "FLIGHT_RESCHEDULE", "TROPHY", "GIFT", "STATIONERY",
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

      // Required-field mirror (imports enforce supplier + hotel-city only).
      if (!trimStr(cell(r, "suppliername"))) errs.push({ field: "supplierName", error: "required" });
      if (HOTEL_TYPES.includes(type) && !cell(r, "destination").trim())
        errs.push({ field: "destination", error: "city/destination is required for HOTEL bookings" });

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
          // Demo Platform — bulk-imported under impersonation
          isDemo: req.user?.isDemoUser === true,
          createdByDemoUser: req.user?.isDemoUser === true,
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
      { $match: { createdBy: { $exists: true, $nin: [null, ""] }, isDemo: { $ne: true } } },
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

    if (!canAccessBooking(bookingAccessContextFromReq(req), booking, "READ")) {
      return res.status(403).json({ success: false, message: "Not found" });
    }

    // NOT masked here, unlike the list view — ManualBookingForm.tsx prefills
    // its edit form straight from this response (line ~433) and PUTs the
    // passengers array back unchanged for untouched fields; masking would
    // silently overwrite real passport/PAN numbers with "****1234" on save.
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

    if (!canAccessBooking(bookingAccessContextFromReq(req), booking, "WRITE")) {
      return res.status(403).json({ success: false, message: "Not found" });
    }

    if (booking.status === "INVOICED") {
      return res.status(400).json({ message: "Cannot edit an invoiced booking" });
    }

    // Snapshot the pre-update document so we can tell which required fields
    // were already present (Option B: enforce only those — don't force legacy
    // bookings to backfill fields they never had).
    const before = booking.toObject();
    Object.assign(booking, req.body);

    const vErrors = validateBookingRequiredForUpdate(booking, before);
    if (vErrors.length) {
      return res.status(400).json({ error: vErrors.join("; "), details: vErrors });
    }

    await booking.save();
    res.json({ ok: true, booking });
  } catch (err: any) {
    console.error("[ManualBookings PUT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/manual-bookings/:id/cancel
router.post("/:id/cancel", requirePermission("manualBookings", "FULL"), async (req: any, res: any) => {
  try {
    const VALID_REASONS = ["DUPLICATE_ENTRY", "WRONG_CUSTOMER", "CUSTOMER_CANCELLED", "WRONG_DETAILS", "OTHER"];
    const { reason, reasonNote } = req.body || {};

    if (!reason || !VALID_REASONS.includes(reason)) {
      return res.status(400).json({ error: "Valid reason is required", validReasons: VALID_REASONS });
    }
    if (reason === "OTHER" && !String(reasonNote || "").trim()) {
      return res.status(400).json({ error: "reasonNote is required when reason is OTHER" });
    }

    const booking: any = await ManualBooking.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    if (!canAccessBooking(bookingAccessContextFromReq(req), booking, "WRITE")) {
      return res.status(403).json({ success: false, message: "Not found" });
    }

    if (booking.status === "CANCELLED") return res.status(400).json({ error: "Already cancelled" });
    if (booking.isActive === false) return res.status(400).json({ error: "Cannot cancel a deleted booking" });

    const invoiceCount = await Invoice.countDocuments({
      bookingIds: booking._id,
      status: { $ne: "CANCELLED" },
    });
    if (invoiceCount > 0) {
      return res.status(409).json({
        error: "INVOICE_EXISTS",
        message: "Invoice already generated for this booking. Cancellation not allowed. Reverse the invoice first.",
        invoiceCount,
      });
    }

    booking.status = "CANCELLED";
    booking.cancelledAt = new Date();
    booking.cancelledBy = req.user._id;
    booking.cancellationReason = reason;
    booking.cancellationNote = reasonNote ? String(reasonNote).trim() : undefined;
    await booking.save();

    res.json({ ok: true, booking });
  } catch (err: any) {
    console.error("[ManualBookings CANCEL]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/manual-bookings/:id  (soft delete — SuperAdmin only)
router.delete("/:id", requirePermission("manualBookings", "FULL"), async (req: any, res: any) => {
  try {
    const isSuperAdmin = Array.isArray(req.user.roles) && req.user.roles.includes("SUPERADMIN");
    if (!isSuperAdmin) {
      return res.status(403).json({ error: "Only SuperAdmin can delete bookings" });
    }

    const VALID_REASONS = ["DUPLICATE_ENTRY", "WRONG_CUSTOMER", "CUSTOMER_CANCELLED", "WRONG_DETAILS", "OTHER"];
    const { reason, reasonNote } = req.body || {};

    if (!reason || !VALID_REASONS.includes(reason)) {
      return res.status(400).json({ error: "Valid reason is required", validReasons: VALID_REASONS });
    }
    if (reason === "OTHER" && !String(reasonNote || "").trim()) {
      return res.status(400).json({ error: "reasonNote is required when reason is OTHER" });
    }

    const booking: any = await ManualBooking.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    // Defense-in-depth — isSuperAdmin already gates entry above, so this is
    // always a no-op today (canAccessBooking short-circuits true for
    // ctx.isSuperAdmin), but keeps this route consistent with the others if
    // the SuperAdmin-only requirement above is ever relaxed.
    if (!canAccessBooking(bookingAccessContextFromReq(req), booking, "WRITE")) {
      return res.status(403).json({ success: false, message: "Not found" });
    }

    if (booking.isActive === false) return res.status(400).json({ error: "Already deleted" });

    const invoiceCount = await Invoice.countDocuments({
      bookingIds: booking._id,
      status: { $ne: "CANCELLED" },
    });
    if (invoiceCount > 0) {
      return res.status(409).json({
        error: "INVOICE_EXISTS",
        message: "Invoice already generated for this booking. Deletion not allowed. Reverse the invoice first.",
        invoiceCount,
      });
    }

    booking.isActive = false;
    booking.deletedAt = new Date();
    booking.deletedBy = req.user._id;
    booking.deletionReason = reason;
    booking.deletionNote = reasonNote ? String(reasonNote).trim() : undefined;
    await booking.save();

    res.json({ ok: true, success: true });
  } catch (err: any) {
    console.error("[ManualBookings DELETE]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/manual-bookings/:id/restore  (SuperAdmin only)
router.post("/:id/restore", requirePermission("manualBookings", "FULL"), async (req: any, res: any) => {
  try {
    const isSuperAdmin = Array.isArray(req.user.roles) && req.user.roles.includes("SUPERADMIN");
    if (!isSuperAdmin) {
      return res.status(403).json({ error: "Only SuperAdmin can restore bookings" });
    }

    const booking: any = await ManualBooking.findOne({ _id: req.params.id, isActive: false });
    if (!booking) return res.status(404).json({ error: "Deleted booking not found" });

    booking.isActive = true;
    booking.deletedAt = undefined;
    booking.deletedBy = undefined;
    booking.deletionReason = undefined;
    booking.deletionNote = undefined;
    await booking.save();

    res.json({ ok: true, booking });
  } catch (err: any) {
    console.error("[ManualBookings RESTORE]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Attachments (ticket/voucher/other) ─────────────────────────────
 * infra/audit/manual-bookings-voucher-upload-audit.md. Every route below
 * uses the SAME two-tier gate: requirePermission() as the coarse module
 * check (matches whatever level view/upload/delete needs), then
 * canAccessBooking() as the per-record check — not the raw requirePermission-
 * only gate the old (pre-fix) PUT /:id used. 403 on deny, same as GET/PUT/:id.
 * ──────────────────────────────────────────────────────────────────── */

// POST /api/admin/manual-bookings/:id/attachments
router.post(
  "/:id/attachments",
  requirePermission("manualBookings", "READ"),
  attachmentUpload.single("file"),
  async (req: any, res: any) => {
    try {
      const booking: any = await ManualBooking.findById(req.params.id);
      if (!booking) return res.status(404).json({ error: "Booking not found" });

      if (!canAccessBooking(bookingAccessContextFromReq(req), booking, "READ")) {
        return res.status(403).json({ success: false, message: "Not found" });
      }

      const file = req.file;
      if (!file || !file.buffer) {
        return res.status(400).json({ error: "File is required" });
      }

      const type = String(req.body?.type || "").toLowerCase();
      if (!["ticket", "voucher", "other"].includes(type)) {
        return res.status(400).json({ error: "type must be one of: ticket, voucher, other" });
      }

      const uploaderId = String(req.user._id || req.user.id || req.user.sub);
      const uploaded = await uploadBufferToS3({
        buffer: file.buffer,
        mime: file.mimetype,
        originalName: file.originalname,
        customerId: String(booking.workspaceId),
        createdBy: uploaderId,
        keyPrefix: `bookings/attachments/${booking._id}`,
      });

      booking.attachments.push({
        type,
        originalFilename: file.originalname,
        s3Key: uploaded.key,
        size: file.size,
        mimeType: file.mimetype,
        uploadedBy: req.user._id,
        uploadedAt: new Date(),
      });
      await booking.save();

      const created = booking.attachments[booking.attachments.length - 1];
      res.status(201).json({ ok: true, attachment: created });
    } catch (err: any) {
      console.error("[ManualBookings ATTACHMENTS upload]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// GET /api/admin/manual-bookings/:id/attachments
router.get(
  "/:id/attachments",
  requirePermission("manualBookings", "READ"),
  async (req: any, res: any) => {
    try {
      const booking: any = await ManualBooking.findById(req.params.id)
        .select("workspaceId createdBy assignPerson assignmentStatus attachments")
        .lean();
      if (!booking) return res.status(404).json({ error: "Booking not found" });

      if (!canAccessBooking(bookingAccessContextFromReq(req), booking, "READ")) {
        return res.status(403).json({ success: false, message: "Not found" });
      }

      res.json({ ok: true, attachments: booking.attachments || [] });
    } catch (err: any) {
      console.error("[ManualBookings ATTACHMENTS list]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// GET /api/admin/manual-bookings/:id/attachments/:attId/url
router.get(
  "/:id/attachments/:attId/url",
  requirePermission("manualBookings", "READ"),
  async (req: any, res: any) => {
    try {
      const booking: any = await ManualBooking.findById(req.params.id)
        .select("workspaceId createdBy assignPerson assignmentStatus attachments")
        .lean();
      if (!booking) return res.status(404).json({ error: "Booking not found" });

      if (!canAccessBooking(bookingAccessContextFromReq(req), booking, "READ")) {
        return res.status(403).json({ success: false, message: "Not found" });
      }

      const attachment = (booking.attachments || []).find(
        (a: any) => String(a._id) === req.params.attId,
      );
      if (!attachment) return res.status(404).json({ error: "Attachment not found" });

      // ?view=1 — same route, same access check, same short TTL as Download;
      // only the presign call differs (see s3Presign.ts).
      const view = req.query.view === "1" || req.query.view === "true";
      const url = await presignGetObject({
        bucket: env.S3_BUCKET,
        key: attachment.s3Key,
        filename: attachment.originalFilename,
        expiresInSeconds: env.PRESIGN_TTL,
        view,
        contentType: attachment.mimeType,
      });

      res.json({ ok: true, url, expiresIn: env.PRESIGN_TTL });
    } catch (err: any) {
      console.error("[ManualBookings ATTACHMENTS url]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// DELETE /api/admin/manual-bookings/:id/attachments/:attId
router.delete(
  "/:id/attachments/:attId",
  requirePermission("manualBookings", "WRITE"),
  async (req: any, res: any) => {
    try {
      const booking: any = await ManualBooking.findById(req.params.id);
      if (!booking) return res.status(404).json({ error: "Booking not found" });

      if (!canAccessBooking(bookingAccessContextFromReq(req), booking, "WRITE")) {
        return res.status(403).json({ success: false, message: "Not found" });
      }

      const attachment = booking.attachments.id(req.params.attId);
      if (!attachment) return res.status(404).json({ error: "Attachment not found" });

      // No shared delete helper exists in utils/s3Upload.ts — inline
      // DeleteObjectCommand, same pattern as workspace.branding.ts / users.ts.
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: attachment.s3Key }));
      } catch (s3Err: any) {
        console.warn("[ManualBookings ATTACHMENTS delete] S3 object delete failed (continuing)", s3Err?.message);
      }

      attachment.deleteOne();
      await booking.save();

      res.json({ ok: true });
    } catch (err: any) {
      console.error("[ManualBookings ATTACHMENTS delete]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

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
            // Demo Platform — SBT→Manual import inherits the SBT booking's demo flag
            isDemo: !!sbtDoc.isDemo || req.user?.isDemoUser === true,
            createdByDemoUser: req.user?.isDemoUser === true,
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
            // Demo Platform — SBT→Manual import inherits the SBT booking's demo flag
            isDemo: !!sbtDoc.isDemo || req.user?.isDemoUser === true,
            createdByDemoUser: req.user?.isDemoUser === true,
          };
        }

        const importErrors = validateImportRequired(data);
        if (importErrors.length) {
          failed++;
          details.push({ bookingId, status: "failed", error: importErrors.join("; ") });
          continue;
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
