import express from "express";
import type { Request, Response, NextFunction } from "express";
import ExcelJS from "exceljs";
import archiver from "archiver";
import mongoose from "mongoose";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import Invoice from "../models/Invoice.js";
import User from "../models/User.js";

/* ── Workspace router (no requireAdmin — separate mount) ──────────── */
// Mounted at: /api/invoices/workspace
// Accessible to WORKSPACE_LEADER, TENANT_ADMIN, CUSTOMER with a valid workspace

export const workspaceRouter = express.Router();

workspaceRouter.use(requireAuth);
workspaceRouter.use(requireWorkspace);

/* Same shape as admin.billing.ts's requireAdminOrSBT (role detection +
 * workspace-ownership check + canViewBilling gate) — this is the invoice
 * domain's version of that same rule, not a new pattern: admin bypasses,
 * WORKSPACE_LEADER bypasses (matches admin.billing.ts's "WL bypasses
 * canViewBilling" comment), everyone else needs User.canViewBilling===true.
 * Deliberately does NOT check sbtEnabled — that flag is about SBT flight/
 * hotel booking capability, unrelated to invoice/billing visibility.
 *
 * This is the actual access boundary. The frontend hiding the Invoices tab
 * (MyProfileCustomer.tsx / Sidebar.tsx) is convenience UI on top of this,
 * not a substitute for it — before this change, /mine had no check beyond
 * "authenticated workspace member", so any REQUESTER-role member with
 * canViewBilling never granted could call the API directly and read every
 * invoice for the tenant. */
async function requireInvoiceAccess(req: Request, res: Response, next: NextFunction) {
  const user: any = (req as any).user;
  const roles: string[] = [
    ...(Array.isArray(user?.roles) ? user.roles : []),
    ...(user?.role ? [user.role] : []),
  ].map((r: string) => String(r).toUpperCase().replace(/[\s_-]/g, ""));

  const adminRoles = ["ADMIN", "SUPERADMIN", "HR", "HRADMIN", "OPS"];
  if (roles.some((r) => adminRoles.includes(r))) return next();

  const isWL =
    roles.includes("WORKSPACELEADER") ||
    String(user?.customerMemberRole || "").toUpperCase().replace(/[\s_-]/g, "") === "WORKSPACELEADER";
  if (isWL) return next();

  const sub = String(user?.sub || user?._id || user?.id || "");
  if (!sub) return res.status(403).json({ error: "Access denied" });

  const dbUser: any = await User.findById(sub).select("customerId canViewBilling").lean();

  // Verify this user belongs to the current workspace before trusting their
  // own canViewBilling flag against it.
  const wsCustomerId = (req as any).workspace?.customerId;
  if (dbUser?.customerId && wsCustomerId && String(dbUser.customerId) !== String(wsCustomerId)) {
    return res.status(403).json({ error: "Access denied" });
  }

  if (dbUser?.canViewBilling === true) return next();

  return res.status(403).json({
    error: "Billing access not enabled for your account.",
    code: "BILLING_ACCESS_DENIED",
  });
}

workspaceRouter.use(requireInvoiceAccess);

// GET /api/invoices/workspace/mine
workspaceRouter.get("/mine", async (req: any, res: any) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);

    const filter: Record<string, any> = {
      workspaceId: req.workspaceObjectId,
    };

    if (req.query.status) filter.status = req.query.status;

    if (req.query.dateFrom || req.query.dateTo) {
      filter.generatedAt = {};
      if (req.query.dateFrom) filter.generatedAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo)   filter.generatedAt.$lte = new Date(req.query.dateTo);
    }

    if (req.query.search) {
      filter.invoiceNo = { $regex: req.query.search, $options: "i" };
    }

    const [invoices, total] = await Promise.all([
      Invoice.find(filter)
        .sort({ generatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Invoice.countDocuments(filter),
    ]);

    res.json({ ok: true, invoices, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err: any) {
    console.error("[Invoices workspace/mine]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/invoices/workspace/:id/pdf
// Workspace-scoped PDF generation — no requireAdmin needed.
// Invoice must belong to req.workspaceObjectId.
workspaceRouter.post("/:id/pdf", async (req: any, res: any) => {
  try {
    const invoice = await Invoice.collection.findOne({
      _id: new mongoose.Types.ObjectId(req.params.id),
      workspaceId: req.workspaceObjectId,
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const enrichedClient = await enrichClientDetails(invoice);
    const pdfBuffer = await generateInvoicePdf({ ...invoice, clientDetails: enrichedClient } as any);

    const s3 = new S3Client({
      region: env.AWS_REGION,
      credentials:
        env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
          ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
          : undefined,
    });

    const key    = `invoices/${invoice.invoiceNo}.pdf`;
    const bucket = env.S3_BUCKET;

    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: pdfBuffer, ContentType: "application/pdf" }));

    const pdfUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: `inline; filename="${invoice.invoiceNo}.pdf"` }),
      { expiresIn: 3600 },
    );

    await Invoice.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(req.params.id) },
      { $set: { pdfUrl } },
    );

    res.json({ ok: true, pdfUrl });
  } catch (err: any) {
    console.error("[Invoices workspace/pdf]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/invoices/workspace/:id/declare-payment
// Customer-only transition: SENT -> PAYMENT_DECLARED, nothing else. This is
// a CLAIM ("I've paid"), not a receipt — finance still confirms it into PAID
// via the existing staff PUT /admin/invoices/:id/status route (unchanged;
// its only guards are "no re-marking CANCELLED" and "no DRAFT->PAID", so
// PAYMENT_DECLARED->PAID already works there with zero code change).
// Workspace-scoped (invoice must belong to req.workspaceObjectId, same as
// the /pdf route above) and gated by requireInvoiceAccess (applied to the
// whole workspaceRouter above) — canViewBilling or WorkspaceLeader, same as
// viewing the list. A customer can never set DRAFT/CANCELLED/PAID directly,
// and can never move a DRAFT, PAYMENT_DECLARED, PAID, or CANCELLED invoice
// through this route — only a SENT one.
workspaceRouter.put("/:id/declare-payment", async (req: any, res: any) => {
  try {
    const invoice: any = await Invoice.findOne({
      _id: req.params.id,
      workspaceId: req.workspaceObjectId,
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    if (invoice.status !== "SENT") {
      return res.status(400).json({
        error: `Only a SENT invoice can be marked as paid (current status: ${invoice.status}).`,
      });
    }

    const now = new Date();
    const oldValues = { status: "SENT" };
    const newValues: Record<string, unknown> = { status: "PAYMENT_DECLARED", paymentDeclaredAt: now };

    invoice.status = "PAYMENT_DECLARED";
    invoice.paymentDeclaredAt = now;
    invoice.paymentDeclaredBy = req.user._id;
    invoice.editedAt = now;
    invoice.editedBy = req.user._id;
    if (!invoice.editHistory) invoice.editHistory = [];
    invoice.editHistory.push({
      editedAt: now,
      editedBy: req.user._id,
      fieldsChanged: ["status"],
      oldValues,
      newValues,
      source: "customer_portal",
    });

    await invoice.save();
    res.json({ ok: true, invoice });
  } catch (err: any) {
    console.error("[Invoices workspace/declare-payment]", err.message);
    res.status(500).json({ error: err.message });
  }
});

import ManualBooking from "../models/ManualBooking.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import Customer from "../models/Customer.js";
import CreditNote from "../models/CreditNote.js";
import { generateInvoicePdf, prefetchInvoiceAssets } from "../utils/invoicePdf.js";
import { getCompanySettings } from "../models/CompanySettings.js";
import { buildLineItemsForBooking } from "../utils/invoiceLineItems.js";
import { detectGSTType, calculateGSTAmounts, type GSTType } from "../utils/gstDetection.js";
import { env } from "../config/env.js";
import { resolveCustomerState, buildAddressStr } from "../utils/invoiceClient.js";
import { createInvoiceFromBookings, InvoiceGenerationError } from "../services/invoiceGeneration.service.js";
import { resolveSellerGstProfile, SellerGstinNotFoundError } from "../utils/sellerGstResolver.js";

const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

/* ── GST helpers ─────────────────────────────────────────────────── */
// resolveCustomerState + buildAddressStr now live in utils/invoiceClient.ts
// (shared with the invoice-generation service). Imported above.

// Merges stored clientDetails snapshot with live Customer/Workspace data.
// Snapshot wins for any non-empty field (preserves audit trail).
// Live data fills gaps — handles old invoices where some fields were not
// snapshotted, and the Molnlycke-pattern where address only exists on CWS.
export async function enrichClientDetails(invoice: any): Promise<any> {
  const snap = invoice.clientDetails ?? {};
  const wsIdStr = invoice.workspaceId?.toString();

  let liveCustomer: any = null;
  let cwsAddrRaw: any = {};

  if (wsIdStr) {
    // invoice.workspaceId is CustomerWorkspace._id in new invoices
    const cws = await CustomerWorkspace.findById(wsIdStr).lean() as any;
    if (cws?.customerId) {
      liveCustomer = await Customer.findById(cws.customerId).lean();
      cwsAddrRaw = cws.address ?? {};
    } else {
      // Legacy: workspaceId stored as Customer._id directly
      liveCustomer = await Customer.findById(wsIdStr).lean();
      if (liveCustomer) {
        const linkedCws = await CustomerWorkspace.findOne({
          customerId: (liveCustomer as any)._id.toString(),
        }).lean() as any;
        cwsAddrRaw = linkedCws?.address ?? {};
      }
    }
  }

  const custAddr: any = (liveCustomer as any)?.address ?? {};
  // Only fall back to workspace address when Customer has no structured address
  const addrSrc: any = (!custAddr.street && !custAddr.city) ? cwsAddrRaw : {};

  const merged: any = {
    companyName:    snap.companyName    || (liveCustomer as any)?.legalName    || (liveCustomer as any)?.companyName || (liveCustomer as any)?.name || "",
    gstin:          snap.gstin          || (liveCustomer as any)?.gstNumber    || (liveCustomer as any)?.gstin || "",
    state:          snap.state          || (liveCustomer as any)?.gstRegisteredState || custAddr.state || addrSrc.state  || "",
    addressLine1:   snap.addressLine1   || custAddr.street  || addrSrc.line1   || "",
    addressLine2:   snap.addressLine2   || custAddr.street2 || addrSrc.line2   || "",
    city:           snap.city           || custAddr.city    || addrSrc.city    || "",
    pincode:        snap.pincode        || custAddr.pincode  || addrSrc.pincode || "",
    country:        snap.country        || custAddr.country || addrSrc.country || "India",
    email:          snap.email          || (liveCustomer as any)?.contacts?.officialEmail || (liveCustomer as any)?.email || "",
    contactPerson:  snap.contactPerson  || "",
    billingAddress: snap.billingAddress || (liveCustomer as any)?.registeredAddress || "",
  };

  // Build billingAddress from structured fields when still empty (Loom Solar pattern:
  // has address.street but no registeredAddress)
  if (!merged.billingAddress && (merged.addressLine1 || merged.city)) {
    merged.billingAddress = buildAddressStr({
      addressLine1: merged.addressLine1,
      addressLine2: merged.addressLine2,
      city:         merged.city,
      state:        merged.state,
      country:      merged.country,
      pincode:      merged.pincode,
    });
  }

  return merged;
}

/* ── GST Preview ─────────────────────────────────────────────────── */

// GET /api/admin/invoices/gst-preview?customerId=X
router.get("/gst-preview", requireWorkspace, requirePermission("invoices", "READ"), async (req: any, res: any) => {
  try {
    const { customerId, sellerGstin, customerStateOverride } = req.query as {
      customerId?: string;
      sellerGstin?: string;
      customerStateOverride?: string;
    };
    if (!customerId) return res.status(400).json({ error: "customerId is required" });

    const [customer, companySettings] = await Promise.all([
      // Workspace-scoped by design (tenant isolation — see
      // infra/audit/admin-bookings-invoices-audit.md). NOT broadened here:
      // HOUSE-scoped manual-booking customers can legitimately miss this
      // filter for some staff callers, and that's handled below by degrading
      // gracefully rather than changing the filter.
      Customer.findOne({ _id: customerId, workspaceId: req.workspaceObjectId }).lean(),
      getCompanySettings(),
    ]);

    // Seller-side resolution + activeGstProfiles derive ONLY from
    // CompanySettings, never from the customer — so they're computed (and
    // returned) unconditionally, whether or not the customer lookup above
    // found anything. Only the customer-dependent fields (place of supply,
    // GST-type detection) degrade to null on a miss.
    let sellerProfile;
    try {
      sellerProfile = resolveSellerGstProfile({
        overrideGstin: sellerGstin || undefined,
        customerDefaultGstin: undefined, // step 4: per-customer default GSTIN
        companySettings,
      });
    } catch (err: any) {
      if (err instanceof SellerGstinNotFoundError) {
        return res.status(400).json({ error: "SELLER_GSTIN_NOT_FOUND", message: err.message });
      }
      throw err;
    }

    const activeGstProfiles = ((companySettings.gstProfiles || []) as any[])
      .filter((p) => p.active)
      .map((p) => ({ gstin: p.gstin, state: p.state, stateCode: p.stateCode, legalName: p.legalName, isDefault: p.isDefault }));

    const supplierState = sellerProfile.state;

    if (!customer) {
      return res.json({
        ok: true,
        customerFound: false,
        supplierState,
        supplierGstin: sellerProfile.gstin,
        supplierStateCode: sellerProfile.stateCode,
        activeGstProfiles,
        customerState: null,
        placeOfSupply: null,
        detectedGstType: null,
        customerStateCode: null,
        canCalculate: false,
        reason: "Customer not found in this workspace scope",
      });
    }

    const { state: customerStateAuto, country: customerCountry } = resolveCustomerState(customer);
    const customerState = (customerStateOverride && customerStateOverride.trim()) || customerStateAuto;

    const detection = detectGSTType({ supplierState, customerState, customerCountry });

    res.json({
      ok: true,
      customerFound: true,
      supplierState,
      supplierGstin: sellerProfile.gstin,
      customerState: detection.customerState,
      placeOfSupply: detection.placeOfSupply,
      detectedGstType: detection.gstType,
      supplierStateCode: detection.supplierStateCode,
      customerStateCode: detection.customerStateCode,
      canCalculate: detection.canCalculate,
      reason: detection.reason ?? null,
      activeGstProfiles,
    });
  } catch (err: any) {
    console.error("[Invoices gst-preview]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Helpers ─────────────────────────────────────────────────────── */

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

const INVOICE_COLUMNS = [
  "Invoice No",
  "Billing Period",
  "Client",
  "Client GSTIN",
  "Client Address",
  "Our GSTIN",
  "Bookings Count",
  "Subtotal",
  "Total GST",
  "Grand Total",
  "Status",
  "Generated At",
  "Due Date",
  "Paid At",
  "Terms",
  "Notes",
];

function invoiceToRow(inv: any): (string | number | undefined)[] {
  return [
    inv.invoiceNo,
    inv.billingPeriod,
    inv.clientDetails?.companyName,
    inv.clientDetails?.gstin || "",
    inv.clientDetails?.billingAddress || "",
    inv.issuerDetails?.gstin || "",
    inv.bookingIds?.length ?? 0,
    inv.subtotal ?? 0,
    inv.totalGST ?? 0,
    inv.grandTotal ?? 0,
    inv.status,
    inv.generatedAt ? new Date(inv.generatedAt).toLocaleDateString("en-IN") : "",
    inv.dueDate ? new Date(inv.dueDate).toLocaleDateString("en-IN") : "",
    inv.paidAt ? new Date(inv.paidAt).toLocaleDateString("en-IN") : "",
    inv.terms || "Due on Receipt",
    inv.notes || "",
  ];
}

// GST bypass resolution (BYPASS_UT_LIST / resolveGstWithBypass) now lives in
// services/invoiceGeneration.service.ts alongside the generation logic.

/* ── Generate Invoice ───────────────────────────────────────────── */

// POST /api/admin/invoices/generate
router.post("/generate", requirePermission("invoices", "WRITE"), async (req: any, res: any) => {
  try {
    const {
      bookingIds,
      billingPeriod,
      dueDate,
      notes,
      terms,
      showInclusiveTaxNote,
      invoiceDate,
      gstTypeOverride,
      gstOverrideReason,
      sellerGstin,
      customerStateOverride,
    } = req.body as {
      bookingIds: string[];
      billingPeriod?: string;
      dueDate?: string;
      notes?: string;
      terms?: string;
      showInclusiveTaxNote?: boolean;
      invoiceDate?: string;
      gstTypeOverride?: GSTType;
      gstOverrideReason?: string;
      sellerGstin?: string;
      customerStateOverride?: string;
    };

    // Line-item presentation: SEPARATE (default — each booking itemised) or
    // COMBINED (one COST + Transaction Fees line per category). Totals are
    // identical between formats; only presentation differs. This is a SINGLE
    // invoice either way (service format 'COMBINED'); `lineItemStyle` carries
    // the presentation choice.
    const lineItemStyle: "SEPARATE" | "COMBINED" =
      req.body?.invoiceFormat === "COMBINED" ? "COMBINED" : "SEPARATE";

    // GST bypass payload (separate from gstTypeOverride — distinct audit trail)
    const gstBypass = req.body?.gstBypass === true;
    const gstBypassReason = (req.body?.gstBypassReason || "").trim();
    if (gstBypass && !gstBypassReason) {
      return res.status(400).json({
        error: "BYPASS_REASON_REQUIRED",
        message: "gstBypassReason is required when gstBypass is true",
      });
    }

    if (!Array.isArray(bookingIds) || !bookingIds.length) {
      return res.status(400).json({ error: "bookingIds array is required" });
    }

    // Resolve invoiceDate — no restrictions, default to today if omitted
    const resolvedInvoiceDate = invoiceDate ? new Date(invoiceDate) : new Date();
    resolvedInvoiceDate.setHours(0, 0, 0, 0);

    const created = await createInvoiceFromBookings(bookingIds, {
      format: "COMBINED",
      lineItemStyle,
      billingPeriod,
      invoiceDate: resolvedInvoiceDate,
      dueDate: dueDate ? new Date(dueDate) : undefined,
      notes,
      terms,
      showInclusiveTaxNote,
      gstTypeOverride,
      gstOverrideReason,
      gstBypass,
      gstBypassReason,
      sellerGstin: sellerGstin || undefined,
      customerStateOverride: customerStateOverride || undefined,
      createdBy: req.user._id,
      isDemoUser: req.user?.isDemoUser === true,
      workspaceScope: req.workspaceObjectId ?? null,
    });

    res.status(201).json({ ok: true, invoice: created[0] });
  } catch (err: any) {
    if (err instanceof InvoiceGenerationError) {
      return res.status(err.httpStatus).json(err.body);
    }
    console.error("[Invoices generate]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Bulk Generate (one invoice per booking) ────────────────────── */

// POST /api/admin/invoices/bulk-generate
router.post("/bulk-generate", requirePermission("invoices", "WRITE"), async (req: any, res: any) => {
  try {
    const {
      bookingIds,
      invoiceDate,
      dueDate,
      notes,
      gstTypeOverride,
      gstOverrideReason,
      sellerGstin,
      customerStateOverride,
    } = req.body as {
      bookingIds: string[];
      invoiceDate?: string;
      dueDate?: string;
      notes?: string;
      gstApplied?: boolean;
      gstTypeOverride?: GSTType;
      gstOverrideReason?: string;
      sellerGstin?: string;
      customerStateOverride?: string;
    };

    if (!Array.isArray(bookingIds) || !bookingIds.length) {
      return res.status(400).json({ error: "bookingIds array is required" });
    }

    // GST bypass payload — applies to all invoices in the batch.
    const gstBypass = req.body?.gstBypass === true;
    const gstBypassReason = (req.body?.gstBypassReason || "").trim();
    if (gstBypass && !gstBypassReason) {
      return res.status(400).json({
        error: "BYPASS_REASON_REQUIRED",
        message: "gstBypassReason is required when gstBypass is true",
      });
    }

    const resolvedInvoiceDate = invoiceDate ? new Date(invoiceDate) : new Date();
    resolvedInvoiceDate.setHours(0, 0, 0, 0);

    const resolvedDueDate = dueDate
      ? new Date(dueDate)
      : new Date(resolvedInvoiceDate.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Auto-compute billing period from invoice date (e.g. "April 2026")
    const billingPeriod = resolvedInvoiceDate.toLocaleDateString("en-IN", {
      month: "long",
      year: "numeric",
    });

    const isDemoUser = req.user?.isDemoUser === true;

    // SEPARATE → one invoice per booking. The service skips ineligible bookings
    // (already invoiced / cancelled) and returns the created invoices.
    const created = await createInvoiceFromBookings(bookingIds, {
      format: "SEPARATE",
      billingPeriod,
      invoiceDate: resolvedInvoiceDate,
      dueDate: resolvedDueDate,
      notes: notes || undefined,
      gstTypeOverride,
      gstOverrideReason,
      gstBypass,
      gstBypassReason,
      sellerGstin: sellerGstin || undefined,
      customerStateOverride: customerStateOverride || undefined,
      createdBy: req.user._id,
      isDemoUser,
      workspaceScope: req.workspaceObjectId ?? null,
    });

    const generated = created.map((inv: any) => ({
      bookingId: String(inv.bookingIds?.[0]),
      invoiceId: String(inv._id),
      invoiceNo: inv.invoiceNo,
    }));

    // Derive the per-booking failure breakdown (preserving the existing response
    // shape) from the bookings that did NOT produce an invoice.
    const generatedBookingIds = new Set(
      created.flatMap((inv: any) => (inv.bookingIds || []).map((id: any) => String(id))),
    );
    const remainingIds = bookingIds.filter((id) => !generatedBookingIds.has(String(id)));

    let failed: { bookingId: string; bookingRef: string; error: string }[] = [];
    if (remainingIds.length) {
      const demoClause = isDemoUser ? { isDemo: true } : { isDemo: { $ne: true } };
      const skipped = await ManualBooking.find({
        _id: { $in: remainingIds.map((id) => new mongoose.Types.ObjectId(id)) },
        ...demoClause,
      }).select("_id bookingRef status invoiceId").lean();
      const byId = new Map(skipped.map((b: any) => [String(b._id), b]));
      failed = remainingIds.map((id) => {
        const b: any = byId.get(String(id));
        const error = !b
          ? "Booking not found"
          : b.invoiceId
          ? "Already invoiced"
          : b.status === "INVOICED"
          ? "Status is already INVOICED"
          : b.status === "CANCELLED"
          ? "Booking is CANCELLED"
          : "Generation skipped";
        return { bookingId: String(id), bookingRef: b?.bookingRef ?? "", error };
      });
    }

    res.status(201).json({ ok: true, generated, failed });
  } catch (err: any) {
    if (err instanceof InvoiceGenerationError) {
      return res.status(err.httpStatus).json(err.body);
    }
    console.error("[Invoices bulk-generate]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── List ─────────────────────────────────────────────────────────── */

// GET /api/admin/invoices
router.get("/", requirePermission("invoices", "READ"), async (req: any, res: any) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 20);
    const filter: Record<string, any> = {};

    if (req.query.workspaceId) {
      const cws = await CustomerWorkspace
        .findOne({ customerId: req.query.workspaceId })
        .select("_id")
        .lean();
      filter.workspaceId = { $in: [req.query.workspaceId, ...(cws ? [cws._id] : [])] };
    }
    if (req.query.status) filter.status = req.query.status;

    if (req.query.dateFrom || req.query.dateTo) {
      filter.generatedAt = {};
      if (req.query.dateFrom) filter.generatedAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) filter.generatedAt.$lte = new Date(req.query.dateTo);
    }

    const [docs, total] = await Promise.all([
      Invoice.find(filter).sort({ generatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Invoice.countDocuments(filter),
    ]);

    res.json({ ok: true, docs, total, page, pages: Math.ceil(total / limit) });
  } catch (err: any) {
    console.error("[Invoices GET list]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Export ───────────────────────────────────────────────────────── */

// GET /api/admin/invoices/export
router.get("/export", requirePermission("invoices", "READ"), async (req: any, res: any) => {
  try {
    const filter: Record<string, any> = {};
    if (req.query.workspaceId) {
      const cws = await CustomerWorkspace
        .findOne({ customerId: req.query.workspaceId })
        .select("_id")
        .lean();
      filter.workspaceId = { $in: [req.query.workspaceId, ...(cws ? [cws._id] : [])] };
    }
    if (req.query.status) filter.status = req.query.status;
    if (req.query.dateFrom || req.query.dateTo) {
      filter.generatedAt = {};
      if (req.query.dateFrom) filter.generatedAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) filter.generatedAt.$lte = new Date(req.query.dateTo);
    }

    const format = req.query.format === "xlsx" ? "xlsx" : "csv";
    const docs = await Invoice.find(filter).sort({ generatedAt: -1 }).lean();

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="invoices-export.csv"');
      res.write(csvRow(INVOICE_COLUMNS));
      for (const inv of docs) res.write(csvRow(invoiceToRow(inv)));
      res.end();
      return;
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Invoices");

    const headerRow = sheet.addRow(INVOICE_COLUMNS);
    headerRow.font = { bold: true };

    const colWidths = [18, 15, 25, 20, 30, 20, 14, 14, 12, 14, 12, 15, 14, 14, 18, 25];
    colWidths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });

    // Monetary columns: Subtotal=8, Total GST=9, Grand Total=10
    [8, 9, 10].forEach((ci) => { sheet.getColumn(ci).numFmt = "#,##0.00"; });

    for (const inv of docs) sheet.addRow(invoiceToRow(inv));

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", 'attachment; filename="invoices-export.xlsx"');

    await workbook.xlsx.write(res);
    res.end();
  } catch (err: any) {
    console.error("[Invoices EXPORT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Bulk PDF (zip) ───────────────────────────────────────────────── */

// GET /api/admin/invoices/bulk-pdf
// Streams a zip of FRESHLY re-rendered PDFs for every invoice matching the
// current filter (same selection as the export handler above). Each PDF is
// rendered in-process from current DB state — the stored pdfUrl/S3 object is
// never read — so the zip can never ship a stale document. Hard-capped at 250
// invoices to stay within the App Runner synchronous request window. Must be
// registered before the GET "/:id" route so the literal path is matched.
router.get("/bulk-pdf", requirePermission("invoices", "READ"), async (req: any, res: any) => {
  try {
    // Filter block — kept identical to the export handler (~956).
    const filter: Record<string, any> = {};
    if (req.query.workspaceId) {
      const cws = await CustomerWorkspace
        .findOne({ customerId: req.query.workspaceId })
        .select("_id")
        .lean();
      filter.workspaceId = { $in: [req.query.workspaceId, ...(cws ? [cws._id] : [])] };
    }
    if (req.query.status) filter.status = req.query.status;
    if (req.query.dateFrom || req.query.dateTo) {
      filter.generatedAt = {};
      if (req.query.dateFrom) filter.generatedAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) filter.generatedAt.$lte = new Date(req.query.dateTo);
    }

    const invoices = await Invoice.find(filter).sort({ generatedAt: -1 }).lean();

    if (invoices.length === 0) {
      return res.status(404).json({ error: "No invoices match the current filter" });
    }
    if (invoices.length > 250) {
      return res.status(413).json({
        error: `Too many invoices (${invoices.length}). Narrow the filter (client + date range) to 250 or fewer.`,
      });
    }

    // Hoist the per-render network cost: company settings + logo fetched ONCE,
    // then injected into every render so no invoice refetches them.
    const prefetch = await prefetchInvoiceAssets();

    // Filename: invoices-<clientNameOrAll>-<yyyymmdd>.zip
    let clientLabel = "all";
    if (req.query.workspaceId) {
      clientLabel = "client";
      const cust = await Customer
        .findById(req.query.workspaceId)
        .select("legalName companyName name")
        .lean() as any;
      const nm = cust?.legalName || cust?.companyName || cust?.name;
      if (nm) {
        const slug = String(nm).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
        if (slug) clientLabel = slug;
      }
    }
    const now = new Date();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    const zipName = `invoices-${clientLabel}-${ymd}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err: any) => {
      console.error("[Invoices bulk-pdf] archive error:", err.message);
      if (!res.headersSent) res.status(500).json({ error: "Failed to build zip" });
      else res.destroy(err);
    });
    archive.pipe(res);

    for (const inv of invoices) {
      const enrichedClient = await enrichClientDetails(inv);
      const buf = await generateInvoicePdf({ ...inv, clientDetails: enrichedClient } as any, prefetch);
      archive.append(buf, { name: `${inv.invoiceNo}.pdf` });
    }

    await archive.finalize();
  } catch (err: any) {
    console.error("[Invoices bulk-pdf]", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy(err);
  }
});

/* ── Add Bookings to Invoice ──────────────────────────────────────── */

// POST /api/admin/invoices/:id/add-bookings
router.post("/:id/add-bookings", requirePermission("invoices", "WRITE"), async (req: any, res: any) => {
  try {
    const { bookingIds } = req.body as { bookingIds: string[] };

    if (!Array.isArray(bookingIds) || !bookingIds.length) {
      return res.status(400).json({ error: "bookingIds array is required" });
    }

    const invoice = await Invoice.collection.findOne({
      _id: new mongoose.Types.ObjectId(req.params.id),
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    if (invoice.status === "PAID" || invoice.status === "CANCELLED" || invoice.status === "PAYMENT_DECLARED") {
      return res.status(400).json({ error: "Cannot add bookings to a PAID, PAYMENT_DECLARED, or CANCELLED invoice" });
    }

    // Fetch new bookings — Demo Platform: demo admins isolated to demo bookings.
    const demoClauseAdd = req.user?.isDemoUser ? { isDemo: true } : { isDemo: { $ne: true } };
    const newBookings = await ManualBooking.find({
      _id: { $in: bookingIds.map((id) => new mongoose.Types.ObjectId(id)) },
      ...demoClauseAdd,
    }).lean();

    if (newBookings.length !== bookingIds.length) {
      return res.status(400).json({ error: "One or more booking IDs not found" });
    }

    // All must belong to same workspaceId as invoice
    const badWs = (newBookings as any[]).filter(
      (b) => b.workspaceId?.toString() !== invoice.workspaceId?.toString(),
    );
    if (badWs.length) {
      return res.status(400).json({
        error: "All bookings must belong to the same workspace as the invoice",
      });
    }

    // None already INVOICED
    const alreadyInvoiced = (newBookings as any[]).filter((b) => b.status === "INVOICED");
    if (alreadyInvoiced.length) {
      return res.status(400).json({
        error: `${alreadyInvoiced.length} booking(s) are already invoiced`,
        refs: alreadyInvoiced.map((b: any) => b.bookingRef),
      });
    }

    // Build new line items (same two-row pattern as /generate)
    const newLineItems: any[] = [];
    for (const b of newBookings as any[]) {
      newLineItems.push(...buildLineItemsForBooking(b));
    }

    // Recalculate totals
    const newSubtotal = newLineItems.reduce((s, li) => s + (li.amount ?? 0), 0);
    const newTotalGST = newLineItems.reduce((s, li) => s + (li.igst ?? 0), 0);
    let newGrandTotal = 0;
    for (const b of newBookings as any[]) {
      // Group Booking with lineItems[]: pricing.grandTotal is always the
      // authoritative Σ line-amount total regardless of gstMode — see
      // services/invoiceGeneration.service.ts's identical guard and
      // infra/audit/events-line-items-audit.md.
      if (Array.isArray(b.lineItems) && b.lineItems.length > 0) {
        newGrandTotal += b.pricing?.grandTotal ?? 0;
        continue;
      }
      const gstMode = b.pricing?.gstMode || "ON_MARKUP";
      if (gstMode === "ON_MARKUP") {
        newGrandTotal += b.pricing?.quotedPrice ?? 0;
      } else {
        newGrandTotal +=
          b.pricing?.grandTotal ??
          (b.pricing?.quotedPrice ?? 0) + (b.pricing?.gstAmount ?? 0);
      }
    }

    const updatedSubtotal  = parseFloat(((invoice.subtotal  ?? 0) + newSubtotal).toFixed(2));
    const updatedTotalGST  = parseFloat(((invoice.totalGST  ?? 0) + newTotalGST).toFixed(2));
    const updatedGrandTotal = parseFloat(((invoice.grandTotal ?? 0) + newGrandTotal).toFixed(2));

    await Invoice.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(req.params.id) },
      {
        $push: { lineItems: { $each: newLineItems } },
        $addToSet: {
          bookingIds: {
            $each: bookingIds.map((id) => new mongoose.Types.ObjectId(id)),
          },
        },
        $set: {
          subtotal:   updatedSubtotal,
          totalGST:   updatedTotalGST,
          grandTotal: updatedGrandTotal,
        },
      } as any,
    );

    // Mark new bookings as INVOICED
    const now = new Date();
    await ManualBooking.updateMany(
      { _id: { $in: (newBookings as any[]).map((b) => b._id) } },
      {
        $set: {
          status: "INVOICED",
          invoiceId: new mongoose.Types.ObjectId(req.params.id),
          invoiceRaisedDate: now,
        },
      },
    );

    const updatedInvoice = await Invoice.collection.findOne({
      _id: new mongoose.Types.ObjectId(req.params.id),
    });

    res.json({ ok: true, invoice: updatedInvoice });
  } catch (err: any) {
    console.error("[Invoices add-bookings]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Activity ─────────────────────────────────────────────────────── */

function timeAgo(date: Date): string {
  const diffMs    = Date.now() - new Date(date).getTime();
  const diffMins  = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays  = Math.floor(diffMs / 86400000);
  if (diffMins  < 60) return `${diffMins} minutes ago`;
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays  === 1) return "Yesterday";
  return `${diffDays} days ago`;
}

// GET /api/admin/invoices/activity
router.get("/activity", requirePermission("invoices", "READ"), async (_req: any, res: any) => {
  try {
    const invoices = await Invoice.find({})
      .sort({ updatedAt: -1 })
      .limit(10)
      .lean();

    const result = invoices.map((inv: any) => {
      let action: string;
      let label: string;
      if (inv.paidAt) {
        action = "paid";
        label  = `Invoice #${inv.invoiceNo} paid`;
      } else if (inv.paymentDeclaredAt) {
        // Checked before sentAt — a PAYMENT_DECLARED invoice still has an
        // (older) sentAt from when it was first sent, which would otherwise
        // stale-label it as just "sent".
        action = "payment_declared";
        label  = `Invoice #${inv.invoiceNo} marked paid by customer, awaiting confirmation`;
      } else if (inv.sentAt) {
        action = "sent";
        label  = `Invoice #${inv.invoiceNo} sent`;
      } else if (inv.status === "CANCELLED") {
        action = "cancelled";
        label  = `Invoice #${inv.invoiceNo} cancelled`;
      } else {
        action = "generated";
        label  = `Invoice #${inv.invoiceNo} generated`;
      }

      return {
        invoiceId:  (inv._id as any).toString(),
        invoiceNo:  inv.invoiceNo,
        action,
        label,
        clientName: inv.clientDetails?.companyName || "",
        timeAgo:    timeAgo(inv.updatedAt as Date),
        timestamp:  inv.updatedAt,
        status:     inv.status,
      };
    });

    res.json(result);
  } catch (err: any) {
    console.error("[Invoices activity]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Insight ──────────────────────────────────────────────────────── */

// GET /api/admin/invoices/insight
router.get("/insight", requirePermission("invoices", "READ"), async (_req: any, res: any) => {
  try {
    const now            = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalThisMonth, paidThisMonth, paidWithin15, outstandingAgg] =
      await Promise.all([
        Invoice.countDocuments({
          generatedAt: { $gte: thisMonthStart },
          status: { $ne: "CANCELLED" },
        }),
        Invoice.countDocuments({
          generatedAt: { $gte: thisMonthStart },
          status: "PAID",
        }),
        Invoice.countDocuments({
          generatedAt: { $gte: thisMonthStart },
          status: "PAID",
          $expr: {
            $lte: [
              { $subtract: ["$paidAt", "$generatedAt"] },
              15 * 24 * 60 * 60 * 1000,
            ],
          },
        }),
        // PAYMENT_DECLARED is still outstanding — it's a customer claim, not
        // finance-confirmed receipt (see Invoice.ts's status doc comment).
        // Omitting it here would make this figure silently shrink the
        // moment invoices start entering that state, before any money is
        // actually confirmed received.
        Invoice.aggregate([
          { $match: { status: { $in: ["DRAFT", "SENT", "PAYMENT_DECLARED"] } } },
          { $group: { _id: null, total: { $sum: "$grandTotal" } } },
        ]),
      ]);

    const outstandingAmount = outstandingAgg[0]?.total ?? 0;
    const clearanceRate = totalThisMonth > 0
      ? Math.round((paidThisMonth / totalThisMonth) * 100)
      : 0;
    const within15Rate = paidThisMonth > 0
      ? Math.round((paidWithin15 / paidThisMonth) * 100)
      : 0;

    let insight: string;
    if (totalThisMonth === 0) {
      insight = "No invoices generated this month yet.";
    } else if (clearanceRate === 100) {
      insight = "All invoices for this month have been cleared.";
    } else if (within15Rate > 0) {
      insight = `${within15Rate}% of invoices this month were cleared within 15 days of issuance.`;
    } else {
      insight = `${clearanceRate}% of invoices this month have been cleared. ${totalThisMonth - paidThisMonth} pending.`;
    }

    res.json({
      totalThisMonth,
      paidThisMonth,
      clearanceRate,
      within15Rate,
      insight,
      outstandingAmount,
    });
  } catch (err: any) {
    console.error("[Invoices insight]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Cancel Invoice ───────────────────────────────────────────────── */

// POST /api/admin/invoices/:id/cancel
router.post("/:id/cancel", requirePermission("invoices", "FULL"), async (req: any, res: any) => {
  try {
    const { reason, reasonNote } = req.body as { reason?: string; reasonNote?: string };

    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: "Cancellation reason is required" });
    }

    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    if (invoice.status === "CANCELLED") {
      return res.status(400).json({ error: "Invoice is already cancelled" });
    }

    if (invoice.status === "PAID") {
      return res.status(400).json({
        error: "Cannot cancel a paid invoice. Use credit note flow instead.",
      });
    }

    invoice.status = "CANCELLED";
    (invoice as any).cancelledAt = new Date();
    (invoice as any).cancelledBy = req.user._id;
    (invoice as any).cancellationReason = String(reason).trim();
    if (reasonNote && String(reasonNote).trim()) {
      (invoice as any).cancellationNote = String(reasonNote).trim();
    }
    await invoice.save();

    // Unlink bookings so they can be re-invoiced
    if (invoice.bookingIds?.length) {
      await ManualBooking.updateMany(
        { _id: { $in: invoice.bookingIds } },
        { $set: { status: "CONFIRMED", invoiceId: null, invoiceRaisedDate: null } },
      );
    }

    const updated = await Invoice.findById(req.params.id).lean();
    res.json({ ok: true, invoice: updated });
  } catch (err: any) {
    console.error("[Invoices cancel]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Edit Draft Invoice ───────────────────────────────────────────── */

// Typed error so we can throw inside the transaction and map to a status code.
class HttpError extends Error {
  constructor(public httpStatus: number, message: string) {
    super(message);
  }
}

// Coerce a (possibly client-sent) line item to the stored shape. `amount` is a
// legitimate line field (scope allows editing rate/amount) but is sanitised to
// a number; the invoice TOTALS are always re-derived server-side from the lines
// — client-sent subtotal/totalGST/grandTotal are never read.
function sanitizeLineItem(li: any): any {
  const qtyN = Number(li?.qty);
  const rateN = Number(li?.rate);
  const igstN = Number(li?.igst);
  const qty = Number.isFinite(qtyN) ? qtyN : 1;
  const rate = Number.isFinite(rateN) ? rateN : 0;
  const igst = Number.isFinite(igstN) ? igstN : 0;
  let amount = Number(li?.amount);
  if (!Number.isFinite(amount)) amount = rate * qty + igst;
  return {
    bookingRef: String(li?.bookingRef ?? ""),
    rowType: li?.rowType === "SERVICE_FEE" ? "SERVICE_FEE" : "COST",
    description: String(li?.description ?? "").slice(0, 300),
    subDescription: String(li?.subDescription ?? "").slice(0, 500),
    qty: parseFloat(qty.toFixed(2)),
    rate: parseFloat(rate.toFixed(2)),
    igst: parseFloat(igst.toFixed(2)),
    amount: parseFloat(amount.toFixed(2)),
    passengerNames: Array.isArray(li?.passengerNames) ? li.passengerNames.map((s: any) => String(s)) : [],
    travelDate: li?.travelDate ? new Date(li.travelDate) : undefined,
    type: String(li?.type ?? ""),
  };
}

// Compact line shape for the audit trail (avoids bloating editHistory).
function compactLine(li: any) {
  return { bookingRef: li.bookingRef, description: li.description, qty: li.qty, rate: li.rate, igst: li.igst, amount: li.amount };
}

// The set of Customer._id values that count as "the same client" as this
// invoice. Invoice.workspaceId is normally a CustomerWorkspace._id (resolved at
// generation), but falls back to the Customer._id when no workspace exists, so
// we accept both. ManualBooking.workspaceId always stores the Customer._id.
async function invoiceCustomerIds(invoice: any, session: any): Promise<Set<string>> {
  const ids = new Set<string>([String(invoice.workspaceId)]);
  try {
    const ws: any = await CustomerWorkspace.findById(invoice.workspaceId).session(session).lean();
    if (ws?.customerId) ids.add(String(ws.customerId));
  } catch {
    /* invoice.workspaceId may itself be a Customer._id (fallback) — already added */
  }
  return ids;
}

// PATCH /api/admin/invoices/:id  — DRAFT-only edit of fields, line items, and
// add/remove bookings. Booking state re-sync + invoice mutation run in ONE
// transaction (no half-applied state). Totals are re-derived from the lines.
router.patch("/:id", requirePermission("invoices", "WRITE"), async (req: any, res: any) => {
  const session = await mongoose.startSession();
  try {
    const {
      dueDate, notes, supplyType, gstOverrideReason,
      lineItems, bookingsToAdd, bookingsToRemove,
    } = req.body as {
      dueDate?: string;
      notes?: string;
      supplyType?: GSTType;
      gstOverrideReason?: string;
      lineItems?: any[];
      bookingsToAdd?: string[];
      bookingsToRemove?: string[];
    };

    const allowedSupplyTypes: GSTType[] = ["CGST_SGST", "CGST_UTGST", "IGST", "EXPORT", "NONE"];
    if (supplyType && !allowedSupplyTypes.includes(supplyType)) {
      return res.status(400).json({ error: "Invalid supplyType" });
    }

    const addIds = Array.isArray(bookingsToAdd) ? [...new Set(bookingsToAdd.map(String).filter(Boolean))] : [];
    const removeIds = Array.isArray(bookingsToRemove) ? [...new Set(bookingsToRemove.map(String).filter(Boolean))] : [];
    const hasLineEdit = Array.isArray(lineItems);
    const hasStructuralEdit = hasLineEdit || addIds.length > 0 || removeIds.length > 0;

    let responseInvoice: any = null;

    await session.withTransaction(async () => {
      const invoice = await Invoice.findById(req.params.id).session(session);
      if (!invoice) throw new HttpError(404, "Invoice not found");
      if (invoice.status !== "DRAFT") {
        throw new HttpError(400, "Cannot edit non-draft invoice. Use cancel + reissue.");
      }

      const oldValues: Record<string, unknown> = {};
      const newValues: Record<string, unknown> = {};
      const fieldsChanged: string[] = [];

      // ── Simple fields ───────────────────────────────────────────────
      if (dueDate !== undefined) {
        const newDate = dueDate ? new Date(dueDate) : undefined;
        const oldStr = invoice.dueDate ? new Date(invoice.dueDate).toISOString().slice(0, 10) : "";
        const newStr = newDate ? newDate.toISOString().slice(0, 10) : "";
        if (oldStr !== newStr) {
          oldValues.dueDate = invoice.dueDate ?? null;
          newValues.dueDate = newDate ?? null;
          fieldsChanged.push("dueDate");
          invoice.dueDate = newDate;
        }
      }

      if (notes !== undefined) {
        const trimmed = notes.slice(0, 1000);
        if (trimmed !== (invoice.notes ?? "")) {
          oldValues.notes = invoice.notes ?? "";
          newValues.notes = trimmed;
          fieldsChanged.push("notes");
          invoice.notes = trimmed;
        }
      }

      // ── Structural: remove/add bookings + edited line items ─────────
      if (hasStructuralEdit) {
        const beforeTotals = { subtotal: invoice.subtotal, totalGST: invoice.totalGST, grandTotal: invoice.grandTotal };
        const beforeLines = (invoice.lineItems ?? []).map(compactLine);

        // Working line set: the client's full desired array for CURRENT bookings
        // (edits + manual add/remove of lines), or the stored lines if none sent.
        // Added-booking lines are NOT expected here — they're built server-side.
        let workingLines: any[] = hasLineEdit
          ? (lineItems as any[]).map(sanitizeLineItem)
          : (invoice.lineItems ?? []).map((li: any) => sanitizeLineItem(li));

        let bookingIds = (invoice.bookingIds ?? []).map((x: any) => String(x));

        // REMOVE bookings → strip their lines, pull from bookingIds, un-invoice
        if (removeIds.length) {
          const onInvoice = new Set(bookingIds);
          const notOn = removeIds.filter((id) => !onInvoice.has(id));
          if (notOn.length) throw new HttpError(400, `Booking(s) not on this invoice: ${notOn.join(", ")}`);

          // Demo Platform — defensive: scope removal lookup to caller's demo realm.
          const demoClausePatchRemove = req.user?.isDemoUser ? { isDemo: true } : { isDemo: { $ne: true } };
          const toRemove = await ManualBooking.find({
            _id: { $in: removeIds.map((id) => new mongoose.Types.ObjectId(id)) },
            ...demoClausePatchRemove,
          }).session(session);

          const removedRefs = (toRemove as any[]).map((b) => b.bookingRef);

          // Integrity guard: a booking sharing a COMBINED (multi-ref) line can't be
          // cleanly subtracted — un-invoicing it while its cost stays in the merged
          // line would double-bill. Block it; the user edits that line first.
          const mergedConflict = workingLines.find(
            (li) =>
              typeof li.bookingRef === "string" &&
              li.bookingRef.includes(",") &&
              li.bookingRef.split(",").map((r: string) => r.trim()).some((r: string) => removedRefs.includes(r)),
          );
          if (mergedConflict) {
            throw new HttpError(
              400,
              `Cannot remove a booking that is part of a combined line item ("${mergedConflict.description}"). Edit or remove that line manually first.`,
            );
          }

          // Safety net: strip any line whose ref exactly matches a removed booking
          // (the client usually already removed them).
          workingLines = workingLines.filter((li) => !removedRefs.includes(li.bookingRef));
          bookingIds = bookingIds.filter((id) => !removeIds.includes(id));

          // Revert to CONFIRMED (the canonical pre-invoice state, same as the
          // cancel-invoice flow) so the booking is available to invoice again.
          await ManualBooking.updateMany(
            { _id: { $in: (toRemove as any[]).map((b) => b._id) } },
            { $set: { status: "CONFIRMED", invoiceId: null, invoiceRaisedDate: null } },
            { session },
          );

          fieldsChanged.push("bookingsRemoved");
          newValues.bookingsRemoved = removedRefs;
        }

        // ADD bookings → validate eligibility, build lines, mark INVOICED
        if (addIds.length) {
          // Demo Platform — demo admins add demo bookings only; real admins protected.
          const demoClausePatchAdd = req.user?.isDemoUser ? { isDemo: true } : { isDemo: { $ne: true } };
          const toAdd = await ManualBooking.find({
            _id: { $in: addIds.map((id) => new mongoose.Types.ObjectId(id)) },
            ...demoClausePatchAdd,
          }).session(session);

          if (toAdd.length !== addIds.length) throw new HttpError(400, "One or more booking IDs not found");

          const customerIds = await invoiceCustomerIds(invoice, session);
          const badWs = (toAdd as any[]).filter((b) => !customerIds.has(String(b.workspaceId)));
          if (badWs.length) {
            throw new HttpError(400, `Booking(s) belong to a different client: ${badWs.map((b: any) => b.bookingRef).join(", ")}`);
          }

          const onInvoice = new Set(bookingIds);
          const already = (toAdd as any[]).filter((b) => onInvoice.has(String(b._id)));
          if (already.length) {
            throw new HttpError(400, `Booking(s) already on this invoice: ${already.map((b: any) => b.bookingRef).join(", ")}`);
          }

          // A booking can't be on two invoices: reject INVOICED / cancelled /
          // already-linked-elsewhere.
          const ineligible = (toAdd as any[]).filter(
            (b) =>
              b.status === "INVOICED" ||
              b.status === "CANCELLED" ||
              b.isActive === false ||
              (b.invoiceId && String(b.invoiceId) !== String(invoice._id)),
          );
          if (ineligible.length) {
            throw new HttpError(400, `Booking(s) not eligible (already invoiced or cancelled): ${ineligible.map((b: any) => b.bookingRef).join(", ")}`);
          }

          for (const b of toAdd as any[]) {
            workingLines.push(...buildLineItemsForBooking(b).map(sanitizeLineItem));
          }
          bookingIds = [...bookingIds, ...(toAdd as any[]).map((b) => String(b._id))];

          await ManualBooking.updateMany(
            { _id: { $in: (toAdd as any[]).map((b) => b._id) } },
            { $set: { status: "INVOICED", invoiceId: invoice._id, invoiceRaisedDate: new Date() } },
            { session },
          );

          fieldsChanged.push("bookingsAdded");
          newValues.bookingsAdded = (toAdd as any[]).map((b) => b.bookingRef);
        }

        // Empty guard — block emptying the invoice (cancel it instead).
        if (workingLines.length === 0 || bookingIds.length === 0) {
          throw new HttpError(400, "An invoice must keep at least one booking and one line item. Cancel the invoice instead of emptying it.");
        }

        // Authoritative totals derived from the resulting lines.
        const totalAmount = parseFloat(workingLines.reduce((s, li) => s + (li.amount ?? 0), 0).toFixed(2));
        const totalGST = parseFloat(workingLines.reduce((s, li) => s + (li.igst ?? 0), 0).toFixed(2));
        const subtotal = parseFloat((totalAmount - totalGST).toFixed(2));
        const grandTotal = totalAmount;

        invoice.lineItems = workingLines as any;
        invoice.markModified("lineItems");
        invoice.bookingIds = bookingIds.map((id) => new mongoose.Types.ObjectId(id)) as any;
        invoice.subtotal = subtotal;
        invoice.totalGST = totalGST;
        invoice.grandTotal = grandTotal;

        if (hasLineEdit) {
          fieldsChanged.push("lineItems");
          oldValues.lineItems = beforeLines;
          newValues.lineItems = workingLines.map(compactLine);
        }
        fieldsChanged.push("totals");
        oldValues.totals = beforeTotals;
        newValues.totals = { subtotal, totalGST, grandTotal };
      }

      // ── supplyType change (audit + override flags) ──────────────────
      let supplyTypeChanged = false;
      if (supplyType && supplyType !== invoice.supplyType) {
        const isAutoDetected = supplyType === (invoice.gstTypeAutoDetected as GSTType | undefined);
        if (!isAutoDetected && !gstOverrideReason?.trim()) {
          throw new HttpError(400, "gstOverrideReason is required when changing GST type");
        }
        oldValues.supplyType = invoice.supplyType;
        newValues.supplyType = supplyType;
        if (!isAutoDetected && gstOverrideReason?.trim()) newValues.gstOverrideReason = gstOverrideReason.trim();
        fieldsChanged.push("supplyType");

        invoice.supplyType = supplyType;
        if (isAutoDetected) {
          invoice.gstTypeOverridden = false;
          invoice.gstOverrideReason = undefined;
          (invoice as any).gstOverrideBy = undefined;
        } else {
          invoice.gstTypeOverridden = true;
          invoice.gstOverrideReason = gstOverrideReason!.trim();
          invoice.gstOverrideBy = req.user._id;
        }
        supplyTypeChanged = true;
      }

      // Recompute the GST split whenever totalGST OR supplyType changed.
      if (hasStructuralEdit || supplyTypeChanged) {
        const gstAmounts = calculateGSTAmounts(invoice.totalGST, invoice.supplyType as GSTType);
        invoice.cgstAmount = gstAmounts.cgst;
        invoice.sgstAmount = gstAmounts.sgst;
        invoice.utgstAmount = gstAmounts.utgst;
        invoice.igstAmount = gstAmounts.igst;
      }

      if (!fieldsChanged.length) {
        responseInvoice = invoice.toObject();
        return;
      }

      const now = new Date();
      const iv = invoice as any;
      iv.editedAt = now;
      iv.editedBy = req.user._id;
      if (!iv.editHistory) iv.editHistory = [];
      iv.editHistory.push({ editedAt: now, editedBy: req.user._id, fieldsChanged, oldValues, newValues });

      await invoice.save({ session });
      responseInvoice = invoice.toObject();
    });

    res.json({ ok: true, invoice: responseInvoice });
  } catch (err: any) {
    if (err instanceof HttpError) {
      return res.status(err.httpStatus).json({ error: err.message });
    }
    console.error("[Invoices PATCH]", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    session.endSession();
  }
});

// GET /api/admin/invoices/:id/eligible-bookings
// Bookings that can be added to / are currently on this DRAFT invoice. Resolves
// the invoice's client (Customer) so the frontend doesn't need the
// workspace↔customer mapping. `eligible` = CONFIRMED, active, not-yet-invoiced.
router.get("/:id/eligible-bookings", requirePermission("invoices", "READ"), async (req: any, res: any) => {
  try {
    const invoice = await Invoice.findById(req.params.id).lean();
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const customerIds = await invoiceCustomerIds(invoice, null);
    const currentIds = ((invoice as any).bookingIds ?? []).map((x: any) => String(x));

    // Demo Platform — eligible/current scoped to caller's demo realm.
    const demoClauseEligible = req.user?.isDemoUser ? { isDemo: true } : { isDemo: { $ne: true } };

    const current = await ManualBooking.find({
      _id: { $in: currentIds.map((id: string) => new mongoose.Types.ObjectId(id)) },
      ...demoClauseEligible,
    })
      .sort({ travelDate: 1 })
      .lean();

    const eligible = await ManualBooking.find({
      workspaceId: { $in: [...customerIds].map((id) => new mongoose.Types.ObjectId(id)) },
      status: "CONFIRMED",
      isActive: { $ne: false },
      invoiceId: null, // matches both null and missing
      _id: { $nin: currentIds.map((id: string) => new mongoose.Types.ObjectId(id)) },
      ...demoClauseEligible,
    })
      .sort({ travelDate: 1 })
      .limit(200)
      .lean();

    res.json({ ok: true, current, eligible });
  } catch (err: any) {
    console.error("[Invoices eligible-bookings]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Credit Notes against this invoice ────────────────────────────── */

// GET /api/admin/invoices/:id/credit-notes
// Powers the "Credit Notes against this invoice" panel in InvoicePreview.tsx.
// Basic info only, newest first, no pagination (an invoice has few CNs).
router.get("/:id/credit-notes", requirePermission("invoices", "READ"), async (req: any, res: any) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid invoice id" });
    }
    const creditNotes = await CreditNote.find({ originalInvoiceId: req.params.id })
      .select("creditNoteNo status grandTotal reasonText issuedAt createdAt isDemo")
      .sort({ createdAt: -1 })
      .lean();
    res.json({ ok: true, creditNotes });
  } catch (err: any) {
    console.error("[Invoices credit-notes]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Single ───────────────────────────────────────────────────────── */

// GET /api/admin/invoices/:id
router.get("/:id", requirePermission("invoices", "READ"), async (req: any, res: any) => {
  try {
    const invoice = await Invoice.findById(req.params.id).lean();
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    const enrichedClient = await enrichClientDetails(invoice);
    res.json({ ok: true, invoice: { ...invoice, clientDetails: enrichedClient } });
  } catch (err: any) {
    console.error("[Invoices GET one]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Update Status ────────────────────────────────────────────────── */

// PUT /api/admin/invoices/:id/status
// Single-invoice forward mark (DRAFT->SENT->PAID). Lifecycle is strict:
// DRAFT->PAID is rejected (must go via SENT). CANCELLED is immutable here.
// sentAt/paidAt accept an explicit date (no silent auto-stamp); paymentRef is
// recorded in the editHistory entry.
//
// PAYMENT_DECLARED->PAID (finance confirming a customer's portal claim) goes
// through this SAME route with zero logic changes — the only guards above
// are "no re-marking CANCELLED" and "no DRAFT->PAID", neither of which
// blocks this transition. Staff can also set PAYMENT_DECLARED directly here
// (e.g. recording a phone-reported payment on the customer's behalf) since
// this route has staff's normal "invoices:WRITE" permission, not the
// customer-only SENT-only guard the portal's own declare-payment route has.
router.put("/:id/status", requirePermission("invoices", "WRITE"), async (req: any, res: any) => {
  try {
    const { status, sentAt, paidAt, paymentRef } = req.body as {
      status: "SENT" | "PAYMENT_DECLARED" | "PAID" | "CANCELLED";
      sentAt?: string;
      paidAt?: string;
      paymentRef?: string;
    };

    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const prev = invoice.status;

    if (prev === "CANCELLED") {
      return res.status(400).json({ error: "Cancelled invoices cannot be re-marked." });
    }
    if (status === prev) {
      return res.status(400).json({ error: `Already in ${status}.` });
    }
    if (status === "PAID" && prev === "DRAFT") {
      return res.status(400).json({ error: "Cannot mark as PAID directly. Mark as SENT first." });
    }

    const now = new Date();
    const oldValues: Record<string, unknown> = { status: prev };
    const newValues: Record<string, unknown> = { status };

    invoice.status = status;
    if (status === "SENT") {
      invoice.sentAt = sentAt ? new Date(sentAt) : now;
      newValues.sentAt = invoice.sentAt;
    }
    if (status === "PAID") {
      invoice.paidAt = paidAt ? new Date(paidAt) : now;
      newValues.paidAt = invoice.paidAt;
    }
    if (paymentRef && String(paymentRef).trim()) {
      newValues.paymentRef = String(paymentRef).trim();
    }

    const iv = invoice as any;
    iv.editedAt = now;
    iv.editedBy = req.user._id;
    if (!iv.editHistory) iv.editHistory = [];
    iv.editHistory.push({ editedAt: now, editedBy: req.user._id, fieldsChanged: ["status"], oldValues, newValues });

    await invoice.save();
    res.json({ ok: true, invoice });
  } catch (err: any) {
    console.error("[Invoices PUT status]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Bulk status marking + single revert ──────────────────────────── */

const BULK_MARK_CAP = 200;

// POST /api/admin/invoices/bulk-mark-sent
// Forward-marks DRAFT invoices to SENT in a best-effort batch. The frontend has
// already filtered+selected, so we trust the explicit ids (no list-filter
// re-derivation) but validate each invoice's lifecycle. Each save is single-doc
// atomic; one failure does not fail the batch. Returns { updated, skipped, blocked }.
router.post("/bulk-mark-sent", requirePermission("invoices", "WRITE"), async (req: any, res: any) => {
  try {
    const { ids, sentAt, paymentRef } = req.body as { ids?: string[]; sentAt?: string; paymentRef?: string };
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids must be a non-empty array" });
    }
    if (ids.length > BULK_MARK_CAP) {
      return res.status(413).json({ error: `Too many invoices (${ids.length}). Select ${BULK_MARK_CAP} or fewer.` });
    }

    const updated: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    const blocked: Array<{ id: string; reason: string }> = [];

    const invoices = await Invoice.find({ _id: { $in: ids } });
    const found = new Set(invoices.map((i) => String(i._id)));
    for (const id of ids) if (!found.has(String(id))) blocked.push({ id, reason: "not found" });

    const ref = paymentRef && String(paymentRef).trim() ? String(paymentRef).trim() : "";

    for (const invoice of invoices) {
      const id = String(invoice._id);
      try {
        if (invoice.status === "CANCELLED") { skipped.push({ id, reason: "cancelled" }); continue; }
        if (invoice.status === "SENT")      { skipped.push({ id, reason: "already sent" }); continue; }
        if (invoice.status === "PAID")      { blocked.push({ id, reason: "already paid; cannot revert via bulk" }); continue; }

        const now = new Date();
        const prev = invoice.status;
        invoice.status = "SENT";
        invoice.sentAt = sentAt ? new Date(sentAt) : now;
        const newValues: Record<string, unknown> = { status: "SENT", sentAt: invoice.sentAt };
        if (ref) newValues.paymentRef = ref;
        const iv = invoice as any;
        iv.editedAt = now;
        iv.editedBy = req.user._id;
        if (!iv.editHistory) iv.editHistory = [];
        iv.editHistory.push({ editedAt: now, editedBy: req.user._id, fieldsChanged: ["status"], oldValues: { status: prev }, newValues });
        await invoice.save();
        updated.push(id);
      } catch (e: any) {
        blocked.push({ id, reason: `error: ${e?.message || "save failed"}` });
      }
    }

    res.json({ updated, skipped, blocked });
  } catch (err: any) {
    console.error("[Invoices bulk-mark-sent]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/invoices/bulk-mark-paid  (SENT -> PAID only; DRAFT is blocked)
router.post("/bulk-mark-paid", requirePermission("invoices", "WRITE"), async (req: any, res: any) => {
  try {
    const { ids, paidAt, paymentRef } = req.body as { ids?: string[]; paidAt?: string; paymentRef?: string };
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids must be a non-empty array" });
    }
    if (ids.length > BULK_MARK_CAP) {
      return res.status(413).json({ error: `Too many invoices (${ids.length}). Select ${BULK_MARK_CAP} or fewer.` });
    }
    if (!paidAt || !String(paidAt).trim()) {
      return res.status(400).json({ error: "paidAt is required" });
    }

    const updated: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    const blocked: Array<{ id: string; reason: string }> = [];

    const invoices = await Invoice.find({ _id: { $in: ids } });
    const found = new Set(invoices.map((i) => String(i._id)));
    for (const id of ids) if (!found.has(String(id))) blocked.push({ id, reason: "not found" });

    const ref = paymentRef && String(paymentRef).trim() ? String(paymentRef).trim() : "";

    for (const invoice of invoices) {
      const id = String(invoice._id);
      try {
        if (invoice.status === "CANCELLED") { skipped.push({ id, reason: "cancelled" }); continue; }
        if (invoice.status === "PAID")      { skipped.push({ id, reason: "already paid" }); continue; }
        if (invoice.status === "DRAFT")     { blocked.push({ id, reason: "lifecycle violation: mark as SENT first" }); continue; }

        const now = new Date();
        const prev = invoice.status;
        invoice.status = "PAID";
        invoice.paidAt = new Date(paidAt);
        const newValues: Record<string, unknown> = { status: "PAID", paidAt: invoice.paidAt };
        if (ref) newValues.paymentRef = ref;
        const iv = invoice as any;
        iv.editedAt = now;
        iv.editedBy = req.user._id;
        if (!iv.editHistory) iv.editHistory = [];
        iv.editHistory.push({ editedAt: now, editedBy: req.user._id, fieldsChanged: ["status"], oldValues: { status: prev }, newValues });
        await invoice.save();
        updated.push(id);
      } catch (e: any) {
        blocked.push({ id, reason: `error: ${e?.message || "save failed"}` });
      }
    }

    res.json({ updated, skipped, blocked });
  } catch (err: any) {
    console.error("[Invoices bulk-mark-paid]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/invoices/:id/revert-to-sent  (PAID -> SENT, or
// PAYMENT_DECLARED -> SENT — staff rejecting a customer's payment claim
// that never arrived — reason required either way)
router.post("/:id/revert-to-sent", requirePermission("invoices", "WRITE"), async (req: any, res: any) => {
  try {
    const { reason } = req.body as { reason?: string };
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: "Reason is required" });
    }
    const invoice: any = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    if (invoice.status !== "PAID" && invoice.status !== "PAYMENT_DECLARED") {
      return res.status(400).json({ error: "Only PAID or PAYMENT_DECLARED invoices can be reverted to SENT." });
    }

    const now = new Date();
    const prevStatus = invoice.status;
    const oldValues: Record<string, unknown> = { status: prevStatus };

    if (prevStatus === "PAID") {
      oldValues.paidAt = invoice.paidAt;
      invoice.paidAt = undefined;
    } else {
      // PAYMENT_DECLARED -> SENT: this is a REJECTION of the customer's
      // claim (it never arrived), not a cancellation of the invoice itself
      // — the invoice goes back to awaiting payment, same as any other SENT
      // invoice. Clear both declaration fields so the invoice doesn't carry
      // a stale "customer once claimed this" marker.
      oldValues.paymentDeclaredAt = invoice.paymentDeclaredAt;
      oldValues.paymentDeclaredBy = invoice.paymentDeclaredBy;
      invoice.paymentDeclaredAt = undefined;
      invoice.paymentDeclaredBy = undefined;
    }

    invoice.status = "SENT";
    const iv = invoice as any;
    iv.editedAt = now;
    iv.editedBy = req.user._id;
    if (!iv.editHistory) iv.editHistory = [];
    iv.editHistory.push({
      editedAt: now, editedBy: req.user._id, fieldsChanged: ["status"],
      oldValues, newValues: { status: "SENT", reason: String(reason).trim() },
    });
    await invoice.save();
    res.json({ ok: true, invoice });
  } catch (err: any) {
    console.error("[Invoices revert-to-sent]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/invoices/:id/revert-to-draft  (SENT -> DRAFT, reason required)
router.post("/:id/revert-to-draft", requirePermission("invoices", "WRITE"), async (req: any, res: any) => {
  try {
    const { reason } = req.body as { reason?: string };
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: "Reason is required" });
    }
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    if (invoice.status !== "SENT") {
      return res.status(400).json({ error: "Only SENT invoices can be reverted to DRAFT." });
    }

    const now = new Date();
    const oldSentAt = invoice.sentAt;
    invoice.status = "DRAFT";
    invoice.sentAt = undefined;
    const iv = invoice as any;
    iv.editedAt = now;
    iv.editedBy = req.user._id;
    if (!iv.editHistory) iv.editHistory = [];
    iv.editHistory.push({
      editedAt: now, editedBy: req.user._id, fieldsChanged: ["status"],
      oldValues: { status: "SENT", sentAt: oldSentAt }, newValues: { status: "DRAFT", reason: String(reason).trim() },
    });
    await invoice.save();
    res.json({ ok: true, invoice });
  } catch (err: any) {
    console.error("[Invoices revert-to-draft]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── PDF ──────────────────────────────────────────────────────── */

// POST /api/admin/invoices/:id/pdf
router.post("/:id/pdf", requirePermission("invoices", "WRITE"), async (req: any, res: any) => {
  try {
    const invoice = await Invoice.collection.findOne({
      _id: new mongoose.Types.ObjectId(req.params.id),
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const enrichedClient = await enrichClientDetails(invoice);
    const pdfBuffer = await generateInvoicePdf({ ...invoice, clientDetails: enrichedClient } as any);

    const s3 = new S3Client({
      region: env.AWS_REGION,
      credentials:
        env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
          ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
          : undefined,
    });

    const key = `invoices/${invoice.invoiceNo}.pdf`;
    const bucket = env.S3_BUCKET;

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: pdfBuffer,
        ContentType: "application/pdf",
      }),
    );

    const pdfUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: `inline; filename="${invoice.invoiceNo}.pdf"`,
      }),
      { expiresIn: 3600 },
    );

    await Invoice.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(req.params.id) },
      { $set: { pdfUrl } },
    );

    res.json({ ok: true, pdfUrl });
  } catch (err: any) {
    console.error("[Invoices PDF]", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
