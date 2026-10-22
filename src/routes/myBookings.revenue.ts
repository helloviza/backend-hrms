/* ═════════════════════════════════════════════════════════════════════
 * /api/my-bookings/revenue — the partner's own revenue-share dashboard.
 *
 * GATE: requireRevenueShareView (below) + requireInvoiceAccess (workspace
 * leader, or canViewBilling on the caller's own customer — the invoice
 * domain's rule, middleware/requireInvoiceAccess.ts, also used by the Rewards
 * router). requireAuth/requireWorkspace are applied
 * at the mount (server.ts), same as /api/my-bookings.
 *
 * The flag is the caller's own workspace's config.features.revenueShareEnabled,
 * set ONLY from Workspace Manager. Unlike requireFeature there is NO SuperAdmin,
 * HOUSE or tbocert bypass: the Client Portal's Revenue tab
 * (components/clientPortal/RevenueTab.tsx canSeeRevenueTab) shows on the flag
 * alone, and the server must say the same thing.
 *
 * SCOPE: req.workspace.customerId — the Customer._id that
 * ManualBooking.workspaceId holds. Never req.workspaceObjectId (that is the
 * CustomerWorkspace._id the partner config is keyed on). The invoices, credit
 * notes and combined-line bookings read for the credit maths are filtered to
 * the same company too (companyDocIds: CustomerWorkspace._id or Customer._id).
 *
 * MONEY SOURCE: the snapshot frozen on each booking at invoicing
 * (ManualBooking.partnerShare, services/partnerRevenue.ts), minus ISSUED credit
 * notes on the booking's current invoice. Never the current config.
 *
 * COST SAFETY: every pipeline's first stage after $match is a $project
 * allowlist. Cost (actualPrice, supplierCost, basePrice, diff, markupAmount,
 * profitMargin, line-item actualRate/actualAmount) never passes it; cost
 * presence crosses only as the boolean `_hasCost`. Of the snapshot only the
 * two amounts pass (credit notes reduce them proportionally, so the percents
 * are never needed here) — the partner sees bakedIn/share totals and
 * per-booking revenueEarned only.
 *
 * EXCLUDED: CANCELLED bookings, isActive:false, and any snapshot whose invoice
 * is CANCELLED (PUT /admin/invoices/:id/status can cancel an invoice without
 * unlinking its bookings, so the snapshot alone is not enough).
 *
 * /my-bookings/stats and /my-bookings/manual are untouched; this router only
 * reuses their exported helpers so the cards cannot drift from the customer's.
 * ═════════════════════════════════════════════════════════════════════ */
import { Router } from "express";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import ManualBooking from "../models/ManualBooking.js";
import Invoice from "../models/Invoice.js";
import Customer from "../models/Customer.js";
import CustomerMember from "../models/CustomerMember.js";
import { requireInvoiceAccess } from "../middleware/requireInvoiceAccess.js";
import ExcelJS from "exceljs";
import {
  customerBookingFields,
  customerBookingRow,
  CUSTOMER_BOOKING_COLUMNS,
  csvRow,
  STATS_SERVICE_BUCKETS,
  SERVICE_BUCKET_EXPR,
  STATS_AMOUNT_EXPR,
  TRAVELLER_KEY_EXPR,
  parseDayStart,
  parseDayEnd,
} from "./myBookings.js";
import { companyDocIds, creditRatioForBooking, combinedLineTotals, issuedCreditNotesFor, netOfCredit } from "../services/partnerRevenue.js";
import logger from "../utils/logger.js";

const router = Router();

/** The caller's own ACTIVE workspace has revenueShareEnabled === true. No bypass. */
function requireRevenueShareView(req: Request, res: Response, next: () => void) {
  const ws = (req as any).workspace;
  if (!ws || ws.status !== "ACTIVE" || ws.config?.features?.revenueShareEnabled !== true) {
    res.status(403).json({ success: false, error: "Feature 'revenueShareEnabled' not enabled for this workspace" });
    return;
  }
  next();
}

router.use(requireRevenueShareView);
router.use(requireInvoiceAccess);

type AnyObj = Record<string, any>;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Snapshot fields the server may read; none of them is ever returned as-is. */
const SNAPSHOT_PROJECTION = {
  "partnerShare.bakedIn": 1,
  "partnerShare.share": 1,
} as const;

function baseMatch(req: Request, customerId: string): AnyObj {
  const user: any = (req as any).user;
  return {
    workspaceId: new mongoose.Types.ObjectId(customerId),
    isActive: { $ne: false },
    status: { $ne: "CANCELLED" },
    isDemo: user?.isDemoUser ? true : { $ne: true },
  };
}

function customerIdOf(req: Request): string | null {
  const id = (req as any).workspace?.customerId ?? null;
  return id && mongoose.isValidObjectId(id) ? String(id) : null;
}

/**
 * Everything the credit maths needs for a page of bookings: their invoices
 * (status for the cancelled-invoice guard; lines for the weighting — read
 * here, never returned), the ISSUED credit notes on them, and the grand totals
 * that weight combined lines.
 */
interface CreditCtx {
  invoices: Map<string, AnyObj>;
  creditNotes: AnyObj[];
  totals: Map<string, number>;
}

async function creditContext(req: Request, customerId: string, ids: unknown[]): Promise<CreditCtx> {
  const valid = [...new Set(ids.filter(Boolean).map(String))].filter((id) => mongoose.isValidObjectId(id));
  const company = companyDocIds((req as any).workspace?._id, customerId);
  if (!valid.length || !company.length) return { invoices: new Map(), creditNotes: [], totals: new Map() };
  // Only this company's invoices — a booking whose invoiceId points elsewhere
  // reads as "invoice missing" (earns 0, no invoice number), never as another's.
  const rows = (await Invoice.find({ _id: { $in: valid.map((id) => new mongoose.Types.ObjectId(id)) }, workspaceId: { $in: company } })
    .select("invoiceNo invoiceDate status lineItems.bookingRef lineItems.rowType lineItems.description lineItems.amount")
    .lean()) as AnyObj[];
  const own = rows.map((r) => r._id);
  const [creditNotes, totals] = await Promise.all([issuedCreditNotesFor(own, company), combinedLineTotals(rows, customerId)]);
  return { invoices: new Map(rows.map((r) => [String(r._id), r])), creditNotes, totals };
}

/**
 * Net bakedIn/share per booking: snapshot minus credit, 0 when the booking's
 * invoice is cancelled. Returns null for a booking with no snapshot.
 */
function netFor(b: AnyObj, ctx: CreditCtx): { bakedIn: number; share: number } | null {
  const snap = b.partnerShare;
  if (!snap || typeof snap.share !== "number") return null;
  const inv = b.invoiceId ? ctx.invoices.get(String(b.invoiceId)) : null;
  if (!inv || inv.status === "CANCELLED") return { bakedIn: 0, share: 0 };
  return netOfCredit(snap, creditRatioForBooking(b, inv, ctx.creditNotes, ctx.totals));
}

async function periodStats(req: Request, customerId: string, match: AnyObj, from: Date, to: Date) {
  const pipeline = [
    { $match: { ...match, bookingDate: { $gte: from, $lte: to } } },
    {
      $project: {
        type: 1,
        "pricing.grandTotal": 1,
        "pricing.totalWithGST": 1,
        "pricing.quotedPrice": 1,
        "passengers.name": 1,
        "passengers.email": 1,
        bookingRef: 1,
        invoiceId: 1,
        ...SNAPSHOT_PROJECTION,
      },
    },
    {
      $facet: {
        totals: [
          { $addFields: { _amount: STATS_AMOUNT_EXPR } },
          { $group: { _id: null, totalTrips: { $sum: 1 }, totalSpend: { $sum: "$_amount" } } },
        ],
        byService: [
          { $addFields: { _amount: STATS_AMOUNT_EXPR, _bucket: SERVICE_BUCKET_EXPR } },
          { $group: { _id: "$_bucket", count: { $sum: 1 }, spend: { $sum: "$_amount" } } },
        ],
        travellers: [
          { $unwind: "$passengers" },
          { $addFields: { _travellerKey: TRAVELLER_KEY_EXPR } },
          { $match: { _travellerKey: { $ne: null } } },
          { $group: { _id: "$_travellerKey" } },
          { $count: "n" },
        ],
        earning: [
          { $match: { "partnerShare.share": { $exists: true } } },
          { $project: { bookingRef: 1, invoiceId: 1, partnerShare: 1 } },
        ],
      },
    },
  ];
  const [result] = await ManualBooking.aggregate(pipeline as any);

  const earning: AnyObj[] = result?.earning || [];
  const invoiceIds = earning.map((b) => b.invoiceId);
  const ctx = await creditContext(req, customerId, invoiceIds);
  let totalBakedIn = 0;
  let totalShare = 0;
  for (const b of earning) {
    const net = netFor(b, ctx);
    if (!net) continue;
    totalBakedIn += net.bakedIn;
    totalShare += net.share;
  }

  const totals = result?.totals?.[0] || { totalTrips: 0, totalSpend: 0 };
  const byService: AnyObj[] = result?.byService || [];
  const breakdown = STATS_SERVICE_BUCKETS.map((service) => {
    const row = byService.find((r) => r._id === service);
    return { service, count: row?.count || 0, spend: row?.spend || 0 };
  });
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    totalTrips: totals.totalTrips || 0,
    totalSpend: totals.totalSpend || 0,
    activeTravellers: result?.travellers?.[0]?.n || 0,
    breakdown,
    totalBakedIn: round2(totalBakedIn),
    totalShare: round2(totalShare),
  };
}

// GET /api/my-bookings/revenue/stats?from&to&compareFrom&compareTo
router.get("/stats", async (req: Request, res: Response) => {
  try {
    const customerId = customerIdOf(req);
    if (!customerId) return res.status(400).json({ ok: false, error: "No workspace" });
    const now = new Date();
    const from = parseDayStart(req.query.from) || new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = parseDayEnd(req.query.to) || now;
    const compareFrom = parseDayStart(req.query.compareFrom);
    const compareTo = parseDayEnd(req.query.compareTo);
    const match = baseMatch(req, customerId);
    const [primary, compare] = await Promise.all([
      periodStats(req, customerId, match, from, to),
      compareFrom && compareTo ? periodStats(req, customerId, match, compareFrom, compareTo) : Promise.resolve(null),
    ]);
    res.json({ ok: true, primary, compare });
  } catch (err: any) {
    logger.error("my-bookings revenue stats failed", { userId: (req as any).user?.sub || (req as any).user?._id, error: err?.message });
    res.status(500).json({ ok: false, error: "Failed to load revenue stats" });
  }
});

// Partner Bookings — shared by the JSON list and the export. Each item is the
// enriched booking customerBookingFields / customerBookingRow expect (the same
// 40 customer-safe fields as /my-bookings/manual) plus revenueEarned:
//   a number  — the snapshot share net of credit notes
//   "PENDING" — not invoiced yet
//   null      — no cost price (it can't earn), or invoiced while the
//               workspace was not an enabled partner
type RevenueEarned = number | "PENDING" | null;

async function loadPartnerBookings(
  req: Request,
  customerId: string,
  opts: { from?: unknown; to?: unknown; limit: number },
): Promise<Array<{ doc: AnyObj; revenueEarned: RevenueEarned }>> {
  const match: AnyObj = baseMatch(req, customerId);
  const from = parseDayStart(opts.from);
  const to = parseDayEnd(opts.to);
  if (from || to) {
    match.bookingDate = {};
    if (from) match.bookingDate.$gte = from;
    if (to) match.bookingDate.$lte = to;
  }

  const docs: AnyObj[] = await ManualBooking.aggregate([
    { $match: match },
    {
      $project: {
        bookingDate: 1, bookingRef: 1, reqDate: 1, sector: 1, type: 1, travelDate: 1, returnDate: 1,
        status: 1, subStatus: 1, priceBenefits: 1, invoiceRaisedDate: 1, bookingWeek: 1, bookingMonth: 1,
        supplierPNR: 1, invoiceId: 1,
        "pricing.grandTotal": 1, "pricing.totalWithGST": 1, "pricing.quotedPrice": 1,
        "passengers.name": 1, "passengers.email": 1,
        "itinerary.origin": 1, "itinerary.destination": 1, "itinerary.hotelName": 1, "itinerary.flightNo": 1,
        "itinerary.airline": 1, "itinerary.trainClass": 1, "itinerary.roomType": 1, "itinerary.nights": 1,
        "itinerary.roomCount": 1, "itinerary.description": 1, "itinerary.pickupLocation": 1,
        "itinerary.dropLocation": 1, "itinerary.vehicleType": 1, "itinerary.visaCountry": 1,
        "itinerary.visaType": 1, "itinerary.tripType": 1, "itinerary.legs": 1,
        // Customer-facing line-item fields only — never actualRate/actualAmount.
        "lineItems.sNo": 1, "lineItems.itemDescription": 1, "lineItems.quantity": 1, "lineItems.quotedRate": 1,
        "lineItems.rate": 1, "lineItems.gstPct": 1, "lineItems.gstAmount": 1, "lineItems.amount": 1,
        ...SNAPSHOT_PROJECTION,
        _hasCost: { $gt: [{ $ifNull: ["$pricing.actualPrice", 0] }, 0] },
      },
    },
    { $sort: { bookingDate: -1 } },
    { $limit: opts.limit },
  ] as any);

  const invoiceIds = docs.map((b) => b.invoiceId);
  const [ctx, customer] = await Promise.all([
    creditContext(req, customerId, invoiceIds),
    Customer.findById(customerId).select("legalName companyName name").lean().catch(() => null),
  ]);
  const wsName = (customer as any)?.legalName || (customer as any)?.companyName || (customer as any)?.name || "";

  const emails = [...new Set(docs.map((b) => String(b.passengers?.[0]?.email || "").toLowerCase()).filter(Boolean))];
  const tidMap: Record<string, string> = {};
  if (emails.length) {
    const members = (await CustomerMember.find({ customerId, email: { $in: emails } }).select("email travelerId").lean()) as AnyObj[];
    for (const m of members) tidMap[String(m.email).toLowerCase()] = String(m.travelerId || "");
  }

  return docs.map((b) => {
    const fullInv = b.invoiceId ? ctx.invoices.get(String(b.invoiceId)) ?? null : null;
    let revenueEarned: RevenueEarned;
    if (!b._hasCost) revenueEarned = null;
    else if (b.partnerShare) revenueEarned = netFor(b, ctx)?.share ?? 0;
    else if (b.status !== "INVOICED") revenueEarned = "PENDING";
    else revenueEarned = null;
    // Strip everything the row builders must never see: the snapshot, the
    // cost flag, and the invoice's lines (only its three columns pass).
    const { partnerShare: _snap, _hasCost: _cost, ...safe } = b;
    const doc = {
      ...safe,
      invoiceId: fullInv ? { invoiceNo: fullInv.invoiceNo, invoiceDate: fullInv.invoiceDate, status: fullInv.status } : null,
      _wsName: wsName,
      _travelerId: tidMap[String(b.passengers?.[0]?.email || "").toLowerCase()] || "",
    };
    return { doc, revenueEarned };
  });
}

// GET /api/my-bookings/revenue/bookings?from&to&limit — the /manual row shape + revenueEarned.
router.get("/bookings", async (req: Request, res: Response) => {
  try {
    const customerId = customerIdOf(req);
    if (!customerId) return res.status(400).json({ ok: false, error: "No workspace" });
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit), 10) || 100));
    const items = await loadPartnerBookings(req, customerId, { from: req.query.from, to: req.query.to, limit });
    const bookings = items.map(({ doc, revenueEarned }, idx) => ({ sNo: idx + 1, ...customerBookingFields(doc), revenueEarned }));
    res.json({ ok: true, bookings });
  } catch (err: any) {
    logger.error("my-bookings revenue bookings failed", { userId: (req as any).user?.sub || (req as any).user?._id, error: err?.message });
    res.status(500).json({ ok: false, error: "Failed to load bookings" });
  }
});

/* ── export ─────────────────────────────────────────────────────────────
 * Mirrors GET /my-bookings/manual/export: the same 40 customer-safe columns
 * (CUSTOMER_BOOKING_COLUMNS / customerBookingRow), with "Revenue Earned"
 * inserted right after "Grand Total". Same 2000-row ceiling as that export's
 * loader. The cell is the amount, "Pending", or blank (no cost / not a
 * partner booking). No cost, margin or percentage field is ever written.
 * ──────────────────────────────────────────────────────────────────── */
const GRAND_TOTAL_COL = CUSTOMER_BOOKING_COLUMNS.indexOf("Grand Total");
export const PARTNER_BOOKING_COLUMNS = [
  ...CUSTOMER_BOOKING_COLUMNS.slice(0, GRAND_TOTAL_COL + 1),
  "Revenue Earned",
  ...CUSTOMER_BOOKING_COLUMNS.slice(GRAND_TOTAL_COL + 1),
];
const EXPORT_LIMIT = 2000;

function revenueCell(v: RevenueEarned): string | number {
  if (typeof v === "number") return v;
  return v === "PENDING" ? "Pending" : "";
}

function partnerBookingRow(doc: AnyObj, revenueEarned: RevenueEarned, srNo: number): (string | number)[] {
  const row = customerBookingRow(doc, srNo);
  return [...row.slice(0, GRAND_TOTAL_COL + 1), revenueCell(revenueEarned), ...row.slice(GRAND_TOTAL_COL + 1)];
}

// GET /api/my-bookings/revenue/bookings/export?format=xlsx|csv&from&to
router.get("/bookings/export", async (req: Request, res: Response) => {
  try {
    const customerId = customerIdOf(req);
    if (!customerId) return res.status(400).json({ ok: false, error: "No workspace" });
    const items = await loadPartnerBookings(req, customerId, { from: req.query.from, to: req.query.to, limit: EXPORT_LIMIT });
    const format = req.query.format === "xlsx" ? "xlsx" : "csv";

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="partner-bookings.csv"');
      res.write(csvRow(PARTNER_BOOKING_COLUMNS));
      items.forEach(({ doc, revenueEarned }, idx) => res.write(csvRow(partnerBookingRow(doc, revenueEarned, idx + 1))));
      res.end();
      return;
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Partner Bookings");
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    const headerRow = sheet.addRow(PARTNER_BOOKING_COLUMNS);
    headerRow.font = { bold: true };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF0" } };
    PARTNER_BOOKING_COLUMNS.forEach((h, i) => {
      sheet.getColumn(i + 1).width = Math.min(40, Math.max(10, String(h).length + 4));
    });
    sheet.getColumn(GRAND_TOTAL_COL + 1).numFmt = "#,##0.00"; // Grand Total
    sheet.getColumn(GRAND_TOTAL_COL + 2).numFmt = "#,##0.00"; // Revenue Earned
    items.forEach(({ doc, revenueEarned }, idx) => sheet.addRow(partnerBookingRow(doc, revenueEarned, idx + 1)));

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="partner-bookings.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err: any) {
    logger.error("my-bookings revenue export failed", { userId: (req as any).user?.sub || (req as any).user?._id, error: err?.message });
    res.status(500).json({ ok: false, error: "Failed to export bookings" });
  }
});

export default router;
