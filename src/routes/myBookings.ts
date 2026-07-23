// apps/backend/src/routes/myBookings.ts
//
// Customer-facing, READ-ONLY booking history endpoint.
//
// Mounted at /api/my-bookings with requireAuth + requireWorkspace ONLY —
// deliberately NO requireFeature gate. Viewing one's own past bookings is a
// read-only history view and must not depend on the sbtEnabled / flightBookingEnabled
// transaction-capability flags. This is why it lives in its own router instead of
// under /api/admin/* (carries requireFeature("sbtEnabled")) or inside the
// sbt.flights router (carries requireFeature("flightBookingEnabled")).
//
// Source: the TravelBooking mirror. That schema has NO supplier cost / margin
// fields (only `amount`, the customer-facing sell price), so it structurally
// cannot leak cost. We additionally return an EXPLICIT ALLOWLIST — anything not
// listed here (including the Mixed `metadata` blob) is dropped.

import { Router } from "express";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import TravelBooking from "../models/TravelBooking.js";
import ManualBooking from "../models/ManualBooking.js";
import { canCustomerAccessBookingAttachments } from "../utils/bookingCustomerAccess.js";
import { presignGetObject } from "../utils/s3Presign.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";

const router = Router();

/* ── Role-based access scope ──────────────────────────────────────────
 * Mirrors the resolveAccessScope precedent in admin.unified.billing.ts.
 * The workspaceScope plugin does NOT auto-apply on find()/aggregate() here
 * (no _workspaceId option is set), so the scope filter below is the ONLY
 * thing constraining the query — it must be explicit.
 *
 *   ORG  – WORKSPACE_LEADER / approver (+ staff admin): all bookings for
 *          their org, scoped by { tenantId: customerId }.
 *   OWN  – plain member / requester: only their own, scoped by { userId }.
 * ──────────────────────────────────────────────────────────────────── */
function norm(v: unknown): string {
  return String(v ?? "").toUpperCase().replace(/[\s_-]+/g, "");
}

/* ── THE single source of truth for "is this caller ORG-scope" ────────
 * WORKSPACE_LEADER / approver / staff-admin see the whole tenant; everyone
 * else is OWN-scope (their own bookings only). Every scope decision in this
 * router — the TravelBooking-mirror list below, the ManualBooking-based
 * /manual list + export, /stats, and the attachment access checks — MUST
 * call this one function rather than re-deriving the role checks locally.
 * Two copies of this logic (one here, one in resolveScopeFilter) is exactly
 * how /manual and /stats were able to silently drift apart before; keeping
 * one function is what prevents that recurring — same rationale as
 * resolveWorkspaceForUser in requireWorkspace.ts. */
function isOrgScopeUser(user: any): boolean {
  const roles: string[] = (Array.isArray(user?.roles) ? user.roles : []).map(norm);
  const accessRole = norm(user?.hrmsAccessRole);
  const memberRole = norm(user?.customerMemberRole);

  const isLeader = roles.includes("WORKSPACELEADER") || memberRole === "WORKSPACELEADER";
  const isApprover =
    roles.includes("CUSTOMERAPPROVER") ||
    roles.includes("CUSTOMERADMIN") ||
    accessRole === "L0" ||
    accessRole === "L2";
  const isStaffAdmin =
    roles.includes("ADMIN") || roles.includes("SUPERADMIN") || roles.includes("HR");

  return isLeader || isApprover || isStaffAdmin;
}

function resolveScopeFilter(req: Request): { filter: Record<string, any>; scope: "ORG" | "OWN" } {
  const user: any = (req as any).user;

  // tenantId on TravelBooking is the customer id string; the workspace was
  // resolved via the same customerId, so prefer it as a stable fallback.
  const tenantId: string | null =
    user?.customerId || user?.businessId || (req as any).workspace?.customerId || null;

  if (isOrgScopeUser(user) && tenantId) {
    return { filter: { tenantId: String(tenantId) }, scope: "ORG" };
  }

  // OWN — userId on TravelBooking is an ObjectId; cast the JWT string id.
  const uid = user?._id || user?.id || user?.sub;
  const userId =
    uid && mongoose.isValidObjectId(uid) ? new mongoose.Types.ObjectId(String(uid)) : uid;
  return { filter: { userId }, scope: "OWN" };
}

/* ── Customer-safe allowlist projection ──────────────────────────────
 * Explicit pick — never spread the document. Drops tenantId, workspaceId,
 * source, reference*, and the Mixed `metadata` blob (which could hold cost).
 * `amount` is the customer-facing sell price, NOT supplier cost. */
function toSafeRow(doc: any) {
  const pop = doc.userId && typeof doc.userId === "object" ? doc.userId : null;
  // Prefer the explicit traveller (manual-booking passenger); fall back to the
  // populated userId (SBT rows, which leave travellerName unset, are unaffected).
  const name =
    doc.travellerName ||
    (pop ? pop.name || [pop.firstName, pop.lastName].filter(Boolean).join(" ") || "" : "");
  const email = doc.travellerEmail || (pop ? pop.email || "" : "");
  return {
    _id: String(doc._id),
    service: doc.service,
    type: String(doc.service || "").toLowerCase(),
    amount: doc.amount, // customer-facing sell price — never cost/margin
    status: doc.status,
    paymentMode: doc.paymentMode,
    origin: doc.origin || "",
    destination: doc.destination || "",
    travelDate: doc.travelDate,
    travelDateEnd: doc.travelDateEnd,
    bookedAt: doc.bookedAt,
    // Plucked deliberately (not a metadata spread) — the ManualBooking
    // reference string, non-sensitive, needed by the client to call
    // GET /api/my-bookings/:bookingRef/attachments*. Unset for SBT-sourced
    // rows (no ManualBooking backs them, so there's nothing to attach).
    bookingRef: (doc.metadata as any)?.bookingRef || null,
    _user: { name, email },
  };
}

/* ═════════════════════════════════════════════════════════════════════
 * GET /api/my-bookings
 *   ?from=YYYY-MM-DD  ?to=YYYY-MM-DD   — bookedAt date range
 *   ?service=FLIGHT,HOTEL              — optional service filter
 *   ?limit=N                          — cap (default 100, max 200)
 * Works for SBT-opted and non-SBT customers alike (no feature gate).
 * ═════════════════════════════════════════════════════════════════════ */
router.get("/", async (req: Request, res: Response) => {
  try {
    const { filter, scope } = resolveScopeFilter(req);
    const match: Record<string, any> = { ...filter };

    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    if (from || to) {
      match.bookedAt = {};
      if (from) match.bookedAt.$gte = new Date(from);
      if (to) match.bookedAt.$lte = new Date(`${to}T23:59:59.999Z`);
    }

    const service = String(req.query.service || "").trim();
    if (service) {
      match.service = { $in: service.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) };
    }

    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string, 10) || 100));

    // Demo Platform — demo users see only demo bookings (their seeded universe);
    // real users see only real bookings. Mirrors the conditional pattern used
    // across user-facing SBT endpoints.
    if ((req as any).user?.isDemoUser) {
      match.isDemo = true;
    } else {
      match.isDemo = { $ne: true };
    }

    const docs = await TravelBooking.find(match)
      .populate("userId", "name firstName lastName email")
      .sort({ bookedAt: -1 })
      .limit(limit)
      .lean()
      .exec();

    res.json({ ok: true, scope, bookings: docs.map(toSafeRow) });
  } catch (err: any) {
    logger.error("my-bookings failed", {
      userId: (req as any).user?.sub || (req as any).user?._id,
      error: err?.message,
    });
    res.status(500).json({ ok: false, error: "Failed to load bookings" });
  }
});

/* ═════════════════════════════════════════════════════════════════════
 * Customer-facing booking attachments (view/download only).
 *
 * Reads ManualBooking directly (NOT the TravelBooking mirror, which has no
 * attachments field and deliberately strips `metadata`) — see
 * infra/audit/booking-attachments-customer-access-audit.md, sections B2/C2.
 * Access is governed by canCustomerAccessBookingAttachments(), a NEW
 * customer-specific predicate — NOT canAccessBooking() (staff RBAC/creator/
 * HOUSE semantics that don't model a customer at all) and NOT
 * requirePermission() (customers have no UserPermission record). Both routes
 * 404 uniformly for "booking not found" and "access denied" so a customer
 * can't distinguish a real booking they don't own from a nonexistent one.
 * ═════════════════════════════════════════════════════════════════════ */

interface AttachmentAccessResult {
  booking: any;
  denied: boolean;
}

async function loadBookingForCustomer(req: Request, bookingRef: string): Promise<AttachmentAccessResult | null> {
  const booking: any = await ManualBooking.findOne({ bookingRef })
    .select("workspaceId passengers attachments")
    .lean();
  if (!booking) return null;

  const user: any = (req as any).user;
  const ctx = {
    customerId: (req as any).workspace?.customerId ?? null,
    isOrgScope: isOrgScopeUser(user),
    email: user?.email ?? null,
  };
  const denied = !canCustomerAccessBookingAttachments(ctx, booking);
  return { booking, denied };
}

// GET /api/my-bookings/:bookingRef/attachments — list metadata (no s3Key/uploadedBy leak).
router.get("/:bookingRef/attachments", async (req: Request, res: Response) => {
  try {
    const bookingRef = String(req.params.bookingRef || "").trim();
    if (!bookingRef) return res.status(400).json({ ok: false, error: "bookingRef required" });

    const result = await loadBookingForCustomer(req, bookingRef);
    if (!result || result.denied) {
      return res.status(404).json({ ok: false, error: "Booking not found" });
    }

    const attachments = (result.booking.attachments || []).map((a: any) => ({
      _id: String(a._id),
      type: a.type,
      originalFilename: a.originalFilename,
      size: a.size,
      mimeType: a.mimeType,
      uploadedAt: a.uploadedAt,
    }));

    res.json({ ok: true, attachments });
  } catch (err: any) {
    logger.error("my-bookings attachments list failed", {
      userId: (req as any).user?.sub || (req as any).user?._id,
      error: err?.message,
    });
    res.status(500).json({ ok: false, error: "Failed to load attachments" });
  }
});

// GET /api/my-bookings/:bookingRef/attachments/:attId/url — presigned GET.
router.get("/:bookingRef/attachments/:attId/url", async (req: Request, res: Response) => {
  try {
    const bookingRef = String(req.params.bookingRef || "").trim();
    if (!bookingRef) return res.status(400).json({ ok: false, error: "bookingRef required" });

    const result = await loadBookingForCustomer(req, bookingRef);
    if (!result || result.denied) {
      return res.status(404).json({ ok: false, error: "Booking not found" });
    }

    const attachment = (result.booking.attachments || []).find(
      (a: any) => String(a._id) === req.params.attId,
    );
    if (!attachment) return res.status(404).json({ ok: false, error: "Attachment not found" });

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
    logger.error("my-bookings attachment url failed", {
      userId: (req as any).user?.sub || (req as any).user?._id,
      error: err?.message,
    });
    res.status(500).json({ ok: false, error: "Failed to get download url" });
  }
});

/* ═════════════════════════════════════════════════════════════════════
 * Customer-facing Manual (concierge) bookings table + export.
 *
 * Reads ManualBooking DIRECTLY (NOT the TravelBooking mirror — see
 * infra/audit/customer-bookings-export-audit.md, sections A/B: the mirror is
 * lossy/missing 8 of these 12 columns: Invoice Date/Number, Req Date, Given
 * By, exact Type, and Sector never reach it or its API allowlist at all).
 * SBT-sourced bookings have no ManualBooking row, so this view is inherently
 * concierge/manual-only, by construction — not a filter applied on top.
 *
 * ACCESS: same predicate as the attachment routes above,
 * canCustomerAccessBookingAttachments() — UNCHANGED, not the list endpoint's
 * (GET /) userId-based OWN-scope filter, which the audit found matches
 * ManualBooking.bookedBy (the staff creator), not the customer (see
 * ManualBooking.ts:537's own comment: "NOT the displayed traveller"). Every
 * candidate row is re-checked against the predicate in-process after a
 * tenant-scoped fetch — never trusted from the Mongo filter alone (audit,
 * section D: defense-in-depth against the documented wrong-id-space class of
 * bug in ManualBooking.workspaceId).
 * ═════════════════════════════════════════════════════════════════════ */

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

/**
 * Generalizes loadBookingForCustomer() (above) from "one booking by ref" to
 * "every ManualBooking this caller may see for their own tenant" — same
 * access predicate, same id-space (Customer._id), same fail-closed-on-no-
 * customerId behavior.
 *
 * Field projection is EXPLICIT and narrow (audit, section D's implementation
 * trap): `passengers.name passengers.email` only — never a bare
 * `"passengers"`, which would pull the whole subdocument (panNo/passportNo
 * included) since Mongoose projects entire array subdocuments unless told
 * otherwise. No pricing field beyond the three Grand-Total fallbacks (all
 * customer-facing sell price, matching the mirror-sync's own formula at
 * ManualBooking.ts:528-529) — never actualPrice/supplierCost/markupAmount/
 * profitMargin. No supplierName/supplierPNR/notes.
 */
async function loadManualBookingsForCustomer(
  req: Request,
  opts: { from?: string; to?: string; limit?: number } = {},
): Promise<any[]> {
  const user: any = (req as any).user;
  const customerId = (req as any).workspace?.customerId ?? null;
  if (!customerId || !mongoose.isValidObjectId(customerId)) return [];

  const ctx = {
    customerId,
    isOrgScope: isOrgScopeUser(user),
    email: user?.email ?? null,
  };

  const filter: Record<string, any> = {
    workspaceId: customerId,
    isActive: { $ne: false },
  };
  if (opts.from || opts.to) {
    filter.bookingDate = {};
    if (opts.from) filter.bookingDate.$gte = new Date(opts.from);
    if (opts.to) filter.bookingDate.$lte = new Date(`${opts.to}T23:59:59.999Z`);
  }
  // Demo Platform — same isDemo scoping convention as GET / above.
  filter.isDemo = user?.isDemoUser ? true : { $ne: true };

  const docs: any[] = await ManualBooking.find(filter)
    .select(
      "workspaceId bookingDate reqDate givenBy sector type travelDate returnDate " +
        "pricing.grandTotal pricing.totalWithGST pricing.quotedPrice " +
        "passengers.name passengers.email " +
        "itinerary.origin itinerary.destination itinerary.hotelName invoiceId",
    )
    .populate("invoiceId", "invoiceNo invoiceDate")
    .sort({ bookingDate: -1 })
    .limit(Math.min(2000, Math.max(1, opts.limit ?? 2000)))
    .lean();

  // Re-run the access predicate per record — the tenant clause in `filter`
  // above is a coarse pre-filter, not the authority (see doc comment above).
  return docs.filter((b) => canCustomerAccessBookingAttachments(ctx, b));
}

const CUSTOMER_BOOKING_COLUMNS = [
  "S. No",
  "Booking Date",
  "Invoice Date",
  "Invoice Number",
  "Req Date",
  "Pax Name",
  "Given By",
  "Type",
  "Sector",
  "Travel Date",
  "Arrival Date",
  "Grand Total",
];

/** The 12 customer-safe fields, keyed — shared by the JSON list and the export row builder. */
function customerBookingFields(b: any) {
  const paxName = (b.passengers || [])
    .map((p: any) => String(p?.name ?? "").trim())
    .filter(Boolean)
    .join(" | ");
  const sector =
    b.sector ||
    (b.itinerary?.origin && b.itinerary?.destination
      ? `${b.itinerary.origin}-${b.itinerary.destination}`
      : b.itinerary?.hotelName || "");

  return {
    bookingDate: fmtDateDMY(b.bookingDate),
    invoiceDate: fmtDateDMY(b.invoiceId?.invoiceDate),
    invoiceNumber: b.invoiceId?.invoiceNo ?? "",
    reqDate: fmtDateDMY(b.reqDate),
    paxName,
    givenBy: b.givenBy ?? "",
    type: b.type ?? "",
    sector,
    travelDate: fmtDateDMY(b.travelDate),
    arrivalDate: fmtDateDMY(b.returnDate),
    // Customer-facing sell price only — same fallback chain the mirror sync
    // itself uses (ManualBooking.ts:528-529) — never cost/margin.
    grandTotal: b.pricing?.grandTotal ?? b.pricing?.totalWithGST ?? b.pricing?.quotedPrice ?? 0,
  };
}

function customerBookingRow(b: any, srNo: number): (string | number)[] {
  const f = customerBookingFields(b);
  return [
    srNo,
    f.bookingDate,
    f.invoiceDate,
    f.invoiceNumber,
    f.reqDate,
    f.paxName,
    f.givenBy,
    f.type,
    f.sector,
    f.travelDate,
    f.arrivalDate,
    f.grandTotal,
  ];
}

// GET /api/my-bookings/manual — the 12-column table, JSON.
router.get("/manual", async (req: Request, res: Response) => {
  try {
    const docs = await loadManualBookingsForCustomer(req, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      limit: Math.min(200, Math.max(1, parseInt(req.query.limit as string, 10) || 100)),
    });
    const bookings = docs.map((b, idx) => ({ sNo: idx + 1, ...customerBookingFields(b) }));
    res.json({ ok: true, bookings });
  } catch (err: any) {
    logger.error("my-bookings manual list failed", {
      userId: (req as any).user?.sub || (req as any).user?._id,
      error: err?.message,
    });
    res.status(500).json({ ok: false, error: "Failed to load bookings" });
  }
});

// GET /api/my-bookings/manual/export?format=xlsx|csv — same 12 columns, full history (no limit).
router.get("/manual/export", async (req: Request, res: Response) => {
  try {
    const docs = await loadManualBookingsForCustomer(req, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    const format = req.query.format === "xlsx" ? "xlsx" : "csv";

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="my-bookings.csv"');
      res.write(csvRow(CUSTOMER_BOOKING_COLUMNS));
      docs.forEach((b, idx) => res.write(csvRow(customerBookingRow(b, idx + 1))));
      res.end();
      return;
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("My Bookings");
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    const headerRow = sheet.addRow(CUSTOMER_BOOKING_COLUMNS);
    headerRow.font = { bold: true };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF0" } };

    const colWidths = [7, 14, 14, 18, 12, 28, 18, 14, 22, 14, 14, 16];
    colWidths.forEach((width, i) => { sheet.getColumn(i + 1).width = width; });
    sheet.getColumn(12).numFmt = "#,##0.00";

    docs.forEach((b, idx) => sheet.addRow(customerBookingRow(b, idx + 1)));

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", 'attachment; filename="my-bookings.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err: any) {
    logger.error("my-bookings manual export failed", {
      userId: (req as any).user?.sub || (req as any).user?._id,
      error: err?.message,
    });
    res.status(500).json({ ok: false, error: "Failed to export bookings" });
  }
});

/* ═════════════════════════════════════════════════════════════════════
 * GET /api/my-bookings/stats — Overview stat cards, UNCAPPED aggregates.
 *
 * Root cause this replaces: the old Overview computed totalTrips as
 * bookings.length off a 200-row-capped GET / fetch, so any customer with
 * >200 bookings saw exactly 200 — a symptom of deriving "how many exist"
 * from "how many we fetched". This endpoint counts server-side via
 * aggregation ($group/$count) and returns scalars only; it never streams
 * booking rows to the browser and has no .limit() on the result set.
 *
 * SOURCE: ManualBooking directly (NOT the TravelBooking mirror). The mirror
 * skips source==="SBT"/"SBT_AUTO"/sourceBookingId rows (ManualBooking.ts:502)
 * and only updates on post-save, so it is a structurally incomplete copy —
 * see infra/audit/customer-bookings-export-audit.md. ManualBooking is the
 * source of truth the customer's own export already reads
 * (loadManualBookingsForCustomer above).
 *
 * COST SAFETY: the very first pipeline stage after the tenant/access $match
 * is an explicit $project allowlisting exactly six fields — type,
 * pricing.grandTotal, pricing.totalWithGST, pricing.quotedPrice,
 * passengers.name, passengers.email, bookingDate. Every later stage can only
 * ever see those six fields. actualPrice/supplierCost/markupAmount/
 * profitMargin/basePrice/diff, notes, supplierName/supplierPNR, and
 * passengers.panNo/passportNo are structurally unreachable past that stage —
 * not "not selected", but not present in the pipeline at all past stage 1.
 *
 * ACCESS: same ORG/OWN split as loadManualBookingsForCustomer/
 * canCustomerAccessBookingAttachments (bookingCustomerAccess.ts) — tenant
 * gate on workspaceId (a Customer._id), then ORG-scope (leader/approver/
 * staff-admin) sees the whole tenant or OWN-scope is restricted to bookings
 * where the caller's own email matches a passenger. This re-implements that
 * predicate as an aggregation $expr (case-insensitive email-in-passengers)
 * rather than calling the shared function, because aggregation can't invoke
 * arbitrary JS — if bookingCustomerAccess.ts's ORG/OWN rule ever changes,
 * this $expr must change with it.
 * ═════════════════════════════════════════════════════════════════════ */

const STATS_SERVICE_BUCKETS = ["FLIGHT", "HOTEL", "VISA", "CAB", "FOREX", "MICE", "OTHER"] as const;

// Mirrors ManualBooking.ts:457-480's manualTypeToService grouping, collapsed
// to the 7 buckets the Overview breaks out (TRANSFER/ESIM/HOLIDAYS/TRAIN and
// the OTHER-collapsed types all fall into OTHER here — a display
// simplification, not a change to what manualTypeToService itself does for
// the mirror). Keep this switch in sync with that function if either changes.
const SERVICE_BUCKET_EXPR = {
  $switch: {
    branches: [
      { case: { $in: ["$type", ["FLIGHT", "FLIGHT_RESCHEDULE", "DUMMY_FLIGHT"]] }, then: "FLIGHT" },
      { case: { $in: ["$type", ["HOTEL", "DUMMY_HOTEL"]] }, then: "HOTEL" },
      { case: { $eq: ["$type", "VISA"] }, then: "VISA" },
      { case: { $eq: ["$type", "CAB"] }, then: "CAB" },
      { case: { $eq: ["$type", "FOREX"] }, then: "FOREX" },
      { case: { $eq: ["$type", "EVENTS"] }, then: "MICE" },
    ],
    default: "OTHER",
  },
};

// Customer-facing sell price only — identical fallback chain to the mirror
// sync (ManualBooking.ts:528-529) and the /manual export (myBookings.ts:428).
const STATS_AMOUNT_EXPR = {
  $ifNull: [
    "$pricing.grandTotal",
    { $ifNull: ["$pricing.totalWithGST", { $ifNull: ["$pricing.quotedPrice", 0] }] },
  ],
};

// DISTINCT PASSENGER identity, not passengers[0] — fixes "Active Travellers"
// counting the staff booker. Keys on normalized name (trim + lowercase) since
// that's the field ops staff actually fill in; falls back to email only when
// name is blank. A passenger with neither is excluded (has no usable identity).
const TRAVELLER_KEY_EXPR = {
  $let: {
    vars: {
      nm: { $trim: { input: { $toLower: { $ifNull: ["$passengers.name", ""] } } } },
      em: { $trim: { input: { $toLower: { $ifNull: ["$passengers.email", ""] } } } },
    },
    in: {
      $cond: [
        { $ne: ["$$nm", ""] },
        { $concat: ["name:", "$$nm"] },
        { $cond: [{ $ne: ["$$em", ""] }, { $concat: ["email:", "$$em"] }, null] },
      ],
    },
  },
};

// MongoDB rejects a $facet stage nested inside another $facet stage ("$facet
// is not allowed to be used within a $facet stage") — this ALWAYS threw for
// every caller/period/scope, which is why /stats returned a 500 that the
// frontend's useBookingStats hook swallowed (stats stayed null, so every
// card silently defaulted to 0 via `?? 0` — see bookingKpis in
// MyProfileCustomer.tsx). The three sub-aggregations (totals/byService/
// travellers) below used to live inside a $facet nested one level under the
// primary/compare $facet in the /stats handler; they're now three SIBLING
// branches at that same outer level (see the "Totals" / "ByService" /
// "Travellers" suffixes built in the route handler), each a complete,
// independent pipeline starting from the same $project'd/tenant-matched
// documents. shapeFacetResult() is unchanged — the caller reassembles the
// three flat branches back into the {totals, byService, travellers} shape it
// already expects.
function periodTotalsBranch(from: Date, to: Date) {
  return [
    { $match: { bookingDate: { $gte: from, $lte: to } } },
    { $addFields: { _amount: STATS_AMOUNT_EXPR } },
    { $group: { _id: null, totalTrips: { $sum: 1 }, totalSpend: { $sum: "$_amount" } } },
  ];
}

function periodByServiceBranch(from: Date, to: Date) {
  return [
    { $match: { bookingDate: { $gte: from, $lte: to } } },
    { $addFields: { _amount: STATS_AMOUNT_EXPR, _bucket: SERVICE_BUCKET_EXPR } },
    { $group: { _id: "$_bucket", count: { $sum: 1 }, spend: { $sum: "$_amount" } } },
  ];
}

function periodTravellersBranch(from: Date, to: Date) {
  return [
    { $match: { bookingDate: { $gte: from, $lte: to } } },
    { $unwind: "$passengers" },
    { $addFields: { _travellerKey: TRAVELLER_KEY_EXPR } },
    { $match: { _travellerKey: { $ne: null } } },
    { $group: { _id: "$_travellerKey" } },
    { $count: "n" },
  ];
}

// AVG BOOKED IN ADVANCE — bookingDate -> travelDate, days. Rows where
// travelDate is missing are excluded (nothing to compute). Rows where
// travelDate falls BEFORE bookingDate are also excluded — that's not a valid
// "days in advance" value, it's bad data (a backdated correction or entry
// error), and letting it through would drag the average down/negative for a
// reason a customer can't see. Zero-day (same-day booking) rows ARE counted
// — that's a real, legitimate advance value.
function periodAvgAdvanceBranch(from: Date, to: Date) {
  return [
    { $match: { bookingDate: { $gte: from, $lte: to }, travelDate: { $ne: null } } },
    {
      $addFields: {
        _advanceDays: { $divide: [{ $subtract: ["$travelDate", "$bookingDate"] }, 1000 * 60 * 60 * 24] },
      },
    },
    { $match: { _advanceDays: { $gte: 0 } } },
    { $group: { _id: null, avgDays: { $avg: "$_advanceDays" }, n: { $sum: 1 } } },
  ];
}

function parseDayStart(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}
function parseDayEnd(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(`${String(v)}T23:59:59.999Z`);
  return isNaN(d.getTime()) ? null : d;
}

function shapeFacetResult(raw: any): {
  totalTrips: number;
  totalSpend: number;
  flightCount: number;
  hotelCount: number;
  travellerCount: number;
  breakdown: { service: string; count: number; spend: number }[];
  avgDaysAdvance: number | null;
} {
  const totals = raw?.totals?.[0] || { totalTrips: 0, totalSpend: 0 };
  const byService: any[] = raw?.byService || [];
  const breakdown = STATS_SERVICE_BUCKETS.map((service) => {
    const row = byService.find((r) => r._id === service);
    return { service, count: row?.count || 0, spend: row?.spend || 0 };
  });
  const flightCount = breakdown.find((b) => b.service === "FLIGHT")?.count || 0;
  const hotelCount = breakdown.find((b) => b.service === "HOTEL")?.count || 0;
  const travellerCount = raw?.travellers?.[0]?.n || 0;
  // No usable rows this period → null, never 0 (0 reads as "booked same-day
  // on average", which is a different claim than "no data").
  const avgAdvanceRow = raw?.avgAdvance?.[0];
  const avgDaysAdvance = avgAdvanceRow?.n ? Math.round(avgAdvanceRow.avgDays) : null;
  return {
    totalTrips: totals.totalTrips || 0,
    totalSpend: totals.totalSpend || 0,
    flightCount,
    hotelCount,
    travellerCount,
    breakdown,
    avgDaysAdvance,
  };
}

router.get("/stats", async (req: Request, res: Response) => {
  try {
    const user: any = (req as any).user;
    const customerId = (req as any).workspace?.customerId ?? null;
    if (!customerId || !mongoose.isValidObjectId(customerId)) {
      return res.json({ ok: true, primary: shapeFacetResult(null), compare: null });
    }

    const now = new Date();
    const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const from = parseDayStart(req.query.from) || defaultFrom;
    const to = parseDayEnd(req.query.to) || now;
    const compareFrom = parseDayStart(req.query.compareFrom);
    const compareTo = parseDayEnd(req.query.compareTo);
    const hasCompare = Boolean(compareFrom && compareTo);

    const match: Record<string, any> = {
      workspaceId: new mongoose.Types.ObjectId(customerId),
      isActive: { $ne: false },
      isDemo: user?.isDemoUser ? true : { $ne: true },
    };

    // OWN-scope (plain member, non-leader/approver/staff-admin): restrict to
    // bookings where the caller's own login email matches a passenger —
    // mirrors canCustomerAccessBookingAttachments's OWN branch exactly
    // (case-insensitive email-in-passengers[]), NOT the userId/bookedBy
    // pattern GET / uses (that matches the staff booker, not the customer).
    if (!isOrgScopeUser(user)) {
      const email = String(user?.email || "").trim().toLowerCase();
      if (!email) {
        return res.json({ ok: true, primary: shapeFacetResult(null), compare: null });
      }
      match.$expr = {
        $in: [
          email,
          {
            $map: {
              input: { $ifNull: ["$passengers", []] },
              as: "p",
              in: { $toLower: { $ifNull: ["$$p.email", ""] } },
            },
          },
        ],
      };
    }

    // Flat sibling branches, NOT primary/compare each nesting their own
    // $facet — see periodTotalsBranch's doc comment for why (Mongo rejects
    // $facet-within-$facet outright).
    const facet: Record<string, any[]> = {
      primaryTotals: periodTotalsBranch(from, to),
      primaryByService: periodByServiceBranch(from, to),
      primaryTravellers: periodTravellersBranch(from, to),
      primaryAvgAdvance: periodAvgAdvanceBranch(from, to),
    };
    if (hasCompare) {
      facet.compareTotals = periodTotalsBranch(compareFrom as Date, compareTo as Date);
      facet.compareByService = periodByServiceBranch(compareFrom as Date, compareTo as Date);
      facet.compareTravellers = periodTravellersBranch(compareFrom as Date, compareTo as Date);
      facet.compareAvgAdvance = periodAvgAdvanceBranch(compareFrom as Date, compareTo as Date);
    }

    const pipeline = [
      { $match: match },
      // Explicit allowlist — see doc comment above. No cost/margin/PII field
      // exists past this stage for any later $group/$sum to touch. travelDate
      // is the only addition beyond bookingDate — needed for the AVG BOOKED
      // IN ADVANCE branch, itself just a scheduling date (no cost/PII).
      {
        $project: {
          type: 1,
          "pricing.grandTotal": 1,
          "pricing.totalWithGST": 1,
          "pricing.quotedPrice": 1,
          "passengers.name": 1,
          "passengers.email": 1,
          bookingDate: 1,
          travelDate: 1,
        },
      },
      { $facet: facet },
    ];

    const [result] = await ManualBooking.aggregate(pipeline as any);

    // Reassemble the flat primaryTotals/primaryByService/primaryTravellers
    // (and compare* siblings) back into the {totals, byService, travellers}
    // shape shapeFacetResult expects — unchanged from before the flattening.
    const primaryRaw = {
      totals: result?.primaryTotals,
      byService: result?.primaryByService,
      travellers: result?.primaryTravellers,
      avgAdvance: result?.primaryAvgAdvance,
    };
    const compareRaw = hasCompare
      ? {
          totals: result?.compareTotals,
          byService: result?.compareByService,
          travellers: result?.compareTravellers,
          avgAdvance: result?.compareAvgAdvance,
        }
      : null;

    res.json({
      ok: true,
      primary: { from: from.toISOString(), to: to.toISOString(), ...shapeFacetResult(primaryRaw) },
      compare: hasCompare
        ? {
            from: (compareFrom as Date).toISOString(),
            to: (compareTo as Date).toISOString(),
            ...shapeFacetResult(compareRaw),
          }
        : null,
    });
  } catch (err: any) {
    logger.error("my-bookings stats failed", {
      userId: (req as any).user?.sub || (req as any).user?._id,
      error: err?.message,
    });
    res.status(500).json({ ok: false, error: "Failed to load booking stats" });
  }
});

export default router;
