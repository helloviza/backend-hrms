import express from "express";
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

/* ── Workspace router (no requireAdmin — separate mount) ──────────── */
// Mounted at: /api/invoices/workspace
// Accessible to WORKSPACE_LEADER, TENANT_ADMIN, CUSTOMER with a valid workspace

export const workspaceRouter = express.Router();

workspaceRouter.use(requireAuth);
workspaceRouter.use(requireWorkspace);

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

import ManualBooking from "../models/ManualBooking.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import Customer from "../models/Customer.js";
import CreditNote from "../models/CreditNote.js";
import { generateInvoicePdf, prefetchInvoiceAssets } from "../utils/invoicePdf.js";
import { getCompanySettings } from "../models/CompanySettings.js";
import { buildLineItemsForBooking, buildCombinedLineItems } from "../utils/invoiceLineItems.js";
import { detectGSTType, calculateGSTAmounts, GST_STATE_CODES, type GSTType } from "../utils/gstDetection.js";
import { env } from "../config/env.js";
import { triggerTaskAutomation } from "../services/taskAutomation.js";

const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

/* ── GST helpers ─────────────────────────────────────────────────── */

function resolveCustomerState(cust: any): { state: string; country: string } {
  const state =
    cust?.gstRegisteredState ||
    cust?.address?.state ||
    cust?.shippingAddress?.state ||
    "";
  const country =
    cust?.address?.country ||
    cust?.shippingAddress?.country ||
    "India";
  return { state, country };
}

function buildAddressStr(o: {
  addressLine1?: string; addressLine2?: string;
  city?: string; state?: string; country?: string; pincode?: string;
}): string {
  return [o.addressLine1, o.addressLine2, o.city, o.state, o.country, o.pincode]
    .filter(Boolean).join(", ");
}

// Merges stored clientDetails snapshot with live Customer/Workspace data.
// Snapshot wins for any non-empty field (preserves audit trail).
// Live data fills gaps — handles old invoices where some fields were not
// snapshotted, and the Molnlycke-pattern where address only exists on CWS.
async function enrichClientDetails(invoice: any): Promise<any> {
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
    const { customerId } = req.query as { customerId?: string };
    if (!customerId) return res.status(400).json({ error: "customerId is required" });

    const [customer, companySettings] = await Promise.all([
      Customer.findOne({ _id: customerId, workspaceId: req.workspaceObjectId }).lean(),
      getCompanySettings(),
    ]);

    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const supplierState = companySettings.supplierState || companySettings.state || "Karnataka";
    const { state: customerState, country: customerCountry } = resolveCustomerState(customer);

    const detection = detectGSTType({ supplierState, customerState, customerCountry });

    res.json({
      ok: true,
      supplierState,
      customerState: detection.customerState,
      placeOfSupply: detection.placeOfSupply,
      detectedGstType: detection.gstType,
      supplierStateCode: detection.supplierStateCode,
      customerStateCode: detection.customerStateCode,
      canCalculate: detection.canCalculate,
      reason: detection.reason ?? null,
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

/* ── GST Bypass helper ──────────────────────────────────────────── */

// Bypass-mode UT list (per spec). Distinct from gstDetection's UNION_TERRITORIES
// set, which uses the combined "Dadra and Nagar Haveli and Daman and Diu" entry.
const BYPASS_UT_LIST = new Set<string>([
  "Andaman and Nicobar Islands",
  "Chandigarh",
  "Dadra and Nagar Haveli",
  "Daman and Diu",
  "Lakshadweep",
  "Delhi",
  "Puducherry",
  "Jammu and Kashmir",
  "Ladakh",
]);

interface GstResolution {
  ok: boolean;
  gstType?: GSTType;
  detection?: {
    gstType: GSTType;
    supplierState: string;
    customerState: string;
    supplierStateCode: string;
    customerStateCode: string;
    placeOfSupply: string;
    canCalculate: true;
    bypassed: boolean;
    bypassReason?: string;
  };
  bypassed?: boolean;
  reason?: string;
  missingField?: string;
}

function resolveGstWithBypass(input: {
  gstBypass: boolean;
  gstBypassReason: string;
  supplierState: string;
  customerState: string;
  customerCountry: string;
}): GstResolution {
  if (input.gstBypass) {
    const gstType: GSTType = BYPASS_UT_LIST.has(input.supplierState)
      ? "CGST_UTGST"
      : "CGST_SGST";
    const customerState = input.customerState || "";
    const placeOfSupply = customerState.trim() ? customerState.trim() : input.supplierState;
    return {
      ok: true,
      gstType,
      detection: {
        gstType,
        supplierState: input.supplierState,
        customerState,
        supplierStateCode: GST_STATE_CODES[input.supplierState] || "",
        customerStateCode: customerState ? GST_STATE_CODES[customerState] || "" : "",
        placeOfSupply,
        canCalculate: true,
        bypassed: true,
        bypassReason: input.gstBypassReason,
      },
      bypassed: true,
    };
  }

  const detection = detectGSTType({
    supplierState: input.supplierState,
    customerState: input.customerState,
    customerCountry: input.customerCountry,
  });
  if (!detection.canCalculate) {
    return {
      ok: false,
      reason: detection.reason || "GST detection failed",
      missingField: detection.reason?.includes("state") ? "state" : "unknown",
    };
  }
  return {
    ok: true,
    gstType: detection.gstType,
    detection: {
      gstType: detection.gstType,
      supplierState: detection.supplierState,
      customerState: detection.customerState,
      supplierStateCode: detection.supplierStateCode,
      customerStateCode: detection.customerStateCode,
      placeOfSupply: detection.placeOfSupply,
      canCalculate: true,
      bypassed: false,
    },
    bypassed: false,
  };
}

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
    };

    // Line-item presentation: SEPARATE (default — each booking itemised) or
    // COMBINED (one COST + Transaction Fees line per category). Totals are
    // identical between formats; only presentation differs.
    const invoiceFormat: "SEPARATE" | "COMBINED" =
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

    // Validate bookings — Demo Platform: demo admins invoice only demo bookings,
    // real admins are protected from accidentally invoicing demo data.
    const demoClauseGenerate = req.user?.isDemoUser ? { isDemo: true } : { isDemo: { $ne: true } };
    const bookings = await ManualBooking.find({
      _id: { $in: bookingIds.map((id) => new mongoose.Types.ObjectId(id)) },
      ...demoClauseGenerate,
    }).lean();

    if (bookings.length !== bookingIds.length) {
      return res.status(400).json({ error: "One or more booking IDs not found" });
    }

    // All must belong to same workspace
    const wsIds = [...new Set(bookings.map((b: any) => b.workspaceId.toString()))];
    if (wsIds.length > 1) {
      return res.status(400).json({ error: "All bookings must belong to the same workspace" });
    }

    // None already invoiced
    const alreadyInvoiced = bookings.filter((b: any) => b.status === "INVOICED");
    if (alreadyInvoiced.length) {
      return res.status(400).json({
        error: `${alreadyInvoiced.length} booking(s) are already invoiced`,
        refs: alreadyInvoiced.map((b: any) => b.bookingRef),
      });
    }

    const wsId = wsIds[0].toString()

    // Look up Customer directly — this is where billing data lives
    const customer = await Customer
      .findById(wsId).lean()

    console.log('[Invoice generate] customer found:',
      customer ? (customer as any).legalName
                 || (customer as any).name
               : 'NOT FOUND')
    console.log('[Invoice generate] wsId used:', wsId)

    // Resolve the CustomerWorkspace._id for this customer so workspaceId
    // on the invoice matches what requireWorkspace sets on req.workspaceObjectId.
    // bookings store Customer._id in workspaceId, so we must look up the workspace.
    const resolvedWorkspace = await CustomerWorkspace
      .findOne({ customerId: wsId })
      .lean()
    const invoiceWorkspaceId = resolvedWorkspace?._id ?? wsId

    const companySettings = await getCompanySettings();
    const issuerState = companySettings.supplierState || companySettings.state || process.env.COMPANY_STATE || "Karnataka";

    const cust = (customer || {}) as any;
    const custAddr: any = cust.address ?? {};
    // Workspace address fallback for customers with no structured address (Molnlycke-pattern)
    const addrFallback: any = (!custAddr.street && !custAddr.city)
      ? ((resolvedWorkspace as any)?.address ?? {})
      : {};

    const { state: customerStateRaw, country: customerCountry } = resolveCustomerState(cust);
    const effectiveState   = customerStateRaw   || addrFallback.state   || "";
    const effectiveCountry = customerCountry    || addrFallback.country || "India";

    // GST resolution — bypass branch skips detection; otherwise auto-detect.
    const resolution = resolveGstWithBypass({
      gstBypass,
      gstBypassReason,
      supplierState: issuerState,
      customerState: effectiveState,
      customerCountry: effectiveCountry,
    });
    if (!resolution.ok) {
      return res.status(400).json({
        error: "GST_DETECTION_FAILED",
        message: resolution.reason,
        customerId: cust._id,
        missingField: resolution.missingField,
        hint: "Update customer profile with state before generating invoice",
      });
    }
    const detection = resolution.detection;

    // Validate and apply manual override if provided (independent of bypass).
    const allowedOverrides: GSTType[] = ["CGST_SGST", "CGST_UTGST", "IGST", "EXPORT", "NONE"];
    const useOverride = gstTypeOverride && allowedOverrides.includes(gstTypeOverride);
    if (useOverride && !gstOverrideReason) {
      return res.status(400).json({ error: "gstOverrideReason is required when using gstTypeOverride" });
    }
    const resolvedGstType: GSTType = useOverride ? gstTypeOverride! : resolution.gstType;

    const custAddrLine1 = custAddr.street  || addrFallback.line1   || "";
    const custAddrLine2 = custAddr.street2 || addrFallback.line2   || "";
    const custCity      = custAddr.city    || addrFallback.city    || "";
    const custCountry   = custAddr.country || addrFallback.country || "India";
    const custPincode   = custAddr.pincode  || addrFallback.pincode || "";

    let clientDetails = {
      companyName:    cust.legalName || cust.companyName || cust.name || '',
      gstin:          cust.gstNumber || cust.gstin || '',
      billingAddress: cust.registeredAddress || cust.billingAddress ||
        buildAddressStr({ addressLine1: custAddrLine1, addressLine2: custAddrLine2, city: custCity, state: detection.customerState, country: custCountry, pincode: custPincode }),
      addressLine1:   custAddrLine1,
      addressLine2:   custAddrLine2,
      city:           custCity,
      country:        custCountry,
      pincode:        custPincode,
      contactPerson:  cust.contacts?.primaryContact || cust.contacts?.keyContacts?.[0]?.name || '',
      email:          cust.contacts?.officialEmail || cust.email || '',
      state:          detection.customerState,
    };

    console.log('[Invoice generate] clientDetails built:', JSON.stringify(clientDetails));

    const issuerDetails = {
      companyName:  companySettings.companyName || process.env.COMPANY_NAME,
      gstin:        companySettings.gstin       || process.env.COMPANY_GSTIN,
      address:      companySettings.address     || process.env.COMPANY_ADDRESS,
      addressLine1: (companySettings as any).addressLine1 || "",
      addressLine2: (companySettings as any).addressLine2 || "",
      city:         (companySettings as any).city         || "",
      country:      (companySettings as any).country      || "India",
      pincode:      (companySettings as any).pincode       || "",
      email:        companySettings.email       || process.env.COMPANY_EMAIL,
      phone:        companySettings.phone       || process.env.COMPANY_PHONE,
      website:      companySettings.website     || process.env.COMPANY_WEBSITE,
      state:        issuerState,
    };

    const clientState = detection.customerState;

    // Build line items. SEPARATE: per booking 1 line (ON_FULL) or 2 lines —
    // COST + SERVICE_FEE (ON_MARKUP). COMBINED: one COST + Transaction Fees line
    // per category, summed from the same per-booking lines (totals reconcile).
    const invoiceLineItems: any[] = [];
    if (invoiceFormat === "COMBINED") {
      invoiceLineItems.push(...buildCombinedLineItems(bookings as any[]));
    } else {
      for (const b of bookings as any[]) {
        invoiceLineItems.push(...buildLineItemsForBooking(b));
      }
    }

    // Per-row Amount now = Rate × Qty + GST (customer-payable line total),
    // so Σ amount across all rows equals grandTotal. Subtotal is back-extracted
    // as (Σ amount − Σ GST). pricing-based grandTotal below remains the source
    // of truth and serves as a defensive cross-check.
    const totalAmount = invoiceLineItems.reduce((s, li) => s + (li.amount ?? 0), 0);
    const totalGST   = invoiceLineItems.reduce((s, li) => s + (li.igst ?? 0), 0);
    const subtotal   = parseFloat((totalAmount - totalGST).toFixed(2));
    let grandTotal = 0;
    for (const b of bookings as any[]) {
      const gstMode = b.pricing?.gstMode || "ON_MARKUP";
      if (gstMode === "ON_MARKUP") {
        grandTotal += b.pricing?.quotedPrice ?? 0;
      } else {
        grandTotal += b.pricing?.grandTotal ?? ((b.pricing?.quotedPrice ?? 0) + (b.pricing?.gstAmount ?? 0));
      }
    }
    grandTotal = parseFloat(grandTotal.toFixed(2));

    // Sanity: Σ amount should equal pricing.grandTotal under the new contract.
    const reconciledFromAmounts = parseFloat(totalAmount.toFixed(2));
    if (Math.abs(reconciledFromAmounts - grandTotal) > 1) {
      const bookingRefs = (bookings as any[]).map((b: any) => b.bookingRef).join(",");
      console.warn(
        `[invoice ${bookingRefs}] reconciliation drift: ` +
        `Σ amount=${reconciledFromAmounts} vs pricing.grandTotal=${grandTotal}`
      );
    }

    const rawTotalGST = parseFloat(totalGST.toFixed(2));
    const gstAmounts = calculateGSTAmounts(rawTotalGST, resolvedGstType);

    // DEBUG: confirm invoiceLineItems is still a plain array of objects here
    console.log('lineItems type:', typeof invoiceLineItems, 'isArray:', Array.isArray(invoiceLineItems));
    console.log('lineItems[0] type:', invoiceLineItems[0] ? typeof invoiceLineItems[0] : 'empty');
    console.log('lineItems sample:', JSON.stringify(invoiceLineItems[0]));

    const invoice = await Invoice.create({
      workspaceId: invoiceWorkspaceId,
      billingPeriod,
      bookingIds: bookings.map((b: any) => b._id),
      subtotal: parseFloat(subtotal.toFixed(2)),
      totalGST: rawTotalGST,
      grandTotal,
      supplyType: resolvedGstType,
      cgstAmount: gstAmounts.cgst,
      sgstAmount: gstAmounts.sgst,
      utgstAmount: gstAmounts.utgst,
      igstAmount: gstAmounts.igst,
      gstTypeAutoDetected: detection.gstType,
      gstTypeOverridden: useOverride ? true : false,
      gstOverrideReason: useOverride ? gstOverrideReason : undefined,
      gstOverrideBy: useOverride ? req.user._id : undefined,
      gstBypass,
      gstBypassType: gstBypass ? (resolution.gstType as "CGST_SGST" | "CGST_UTGST") : null,
      gstBypassReason: gstBypass ? gstBypassReason : "",
      placeOfSupply: detection.placeOfSupply,
      issuerState,
      clientState,
      issuerDetails,
      clientDetails,
      terms,
      notes,
      showInclusiveTaxNote: showInclusiveTaxNote === true,
      invoiceDate: resolvedInvoiceDate,
      dueDate: dueDate ? new Date(dueDate) : undefined,
      createdBy: req.user._id,
    });

    console.log('[After rename] invoiceLineItems type:', typeof invoiceLineItems);
    console.log('[After rename] isArray:', Array.isArray(invoiceLineItems));

    await Invoice.collection.updateOne(
      { _id: invoice._id },
      { $set: { lineItems: invoiceLineItems } },
    );

    const completeInvoice = await Invoice.collection.findOne({ _id: invoice._id });

    // Mark bookings as INVOICED and record invoice raised date
    const now = new Date();
    await ManualBooking.updateMany(
      { _id: { $in: bookings.map((b: any) => b._id) } },
      { $set: { status: "INVOICED", invoiceId: invoice._id, invoiceRaisedDate: now } },
    );

    // Task automation hook
    triggerTaskAutomation("invoice.created", {
      workspaceId: String(invoiceWorkspaceId),
      entityType: "INVOICE",
      entityId: invoice._id,
      entityRef: invoice.invoiceNo,
      ownerId: req.user._id,
      variables: {
        invoiceNo: invoice.invoiceNo,
        customerName: clientDetails.companyName || "",
      },
    }).catch(() => {});

    res.status(201).json({ ok: true, invoice: completeInvoice });
  } catch (err: any) {
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
    } = req.body as {
      bookingIds: string[];
      invoiceDate?: string;
      dueDate?: string;
      notes?: string;
      gstApplied?: boolean;
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

    // Fetch all bookings upfront and validate same workspace.
    // Demo Platform: demo admins invoice only demo bookings; real admins protected.
    const demoClauseBulk = req.user?.isDemoUser ? { isDemo: true } : { isDemo: { $ne: true } };
    const allBookings = await ManualBooking.find({
      _id: { $in: bookingIds.map((id) => new mongoose.Types.ObjectId(id)) },
      ...demoClauseBulk,
    }).lean();

    if (allBookings.length !== bookingIds.length) {
      return res.status(400).json({ error: "One or more booking IDs not found" });
    }

    const wsIds = [...new Set(allBookings.map((b: any) => b.workspaceId.toString()))];
    if (wsIds.length > 1) {
      return res.status(400).json({ error: "All bookings must belong to the same workspace" });
    }

    const wsId = wsIds[0];

    // Resolve billing details once for the whole batch
    const customer = await Customer.findById(wsId).lean() as any;
    const resolvedWorkspace = await CustomerWorkspace.findOne({ customerId: wsId }).lean();
    const invoiceWorkspaceId = resolvedWorkspace?._id ?? wsId;

    const companySettings = await getCompanySettings();
    const issuerState = companySettings.supplierState || companySettings.state || process.env.COMPANY_STATE || "Karnataka";

    const cust = (customer || {}) as any;
    const { state: customerStateRaw, country: customerCountry } = resolveCustomerState(cust);

    const resolution = resolveGstWithBypass({
      gstBypass,
      gstBypassReason,
      supplierState: issuerState,
      customerState: customerStateRaw,
      customerCountry,
    });
    if (!resolution.ok) {
      return res.status(400).json({
        error: "GST_DETECTION_FAILED",
        message: resolution.reason,
        customerId: cust._id,
        missingField: resolution.missingField,
        hint: "Update customer profile with state before generating invoice",
      });
    }
    const detection = resolution.detection;

    const resolvedGstType: GSTType = resolution.gstType;
    const clientState = detection.customerState;

    const bulkAddrLine1 = (cust.address as any)?.street  || "";
    const bulkAddrLine2 = (cust.address as any)?.street2 || "";
    const bulkCity      = (cust.address as any)?.city    || "";
    const bulkCountry   = (cust.address as any)?.country || "India";
    const bulkPincode   = (cust.address as any)?.pincode  || "";

    const clientDetails = {
      companyName:    cust.legalName || cust.companyName || cust.name || "",
      gstin:          cust.gstNumber || cust.gstin || "",
      billingAddress: cust.registeredAddress || cust.billingAddress ||
        buildAddressStr({ addressLine1: bulkAddrLine1, addressLine2: bulkAddrLine2, city: bulkCity, state: clientState, country: bulkCountry, pincode: bulkPincode }),
      addressLine1:   bulkAddrLine1,
      addressLine2:   bulkAddrLine2,
      city:           bulkCity,
      country:        bulkCountry,
      pincode:        bulkPincode,
      contactPerson:  cust.contacts?.primaryContact || cust.contacts?.keyContacts?.[0]?.name || "",
      email:          cust.contacts?.officialEmail || cust.email || "",
      state:          clientState,
    };

    const issuerDetails = {
      companyName:  companySettings.companyName || process.env.COMPANY_NAME,
      gstin:        companySettings.gstin       || process.env.COMPANY_GSTIN,
      address:      companySettings.address     || process.env.COMPANY_ADDRESS,
      addressLine1: (companySettings as any).addressLine1 || "",
      addressLine2: (companySettings as any).addressLine2 || "",
      city:         (companySettings as any).city         || "",
      country:      (companySettings as any).country      || "India",
      pincode:      (companySettings as any).pincode       || "",
      email:        companySettings.email       || process.env.COMPANY_EMAIL,
      phone:        companySettings.phone       || process.env.COMPANY_PHONE,
      website:      companySettings.website     || process.env.COMPANY_WEBSITE,
      state:        issuerState,
    };

    const generated: { bookingId: string; invoiceId: string; invoiceNo: string }[] = [];
    const failed: { bookingId: string; bookingRef: string; error: string }[] = [];

    // Process bookings SEQUENTIALLY to maintain invoice number order
    for (const booking of allBookings as any[]) {
      const bookingId = booking._id.toString();

      // Per-booking validation
      if (booking.invoiceId) {
        failed.push({ bookingId, bookingRef: booking.bookingRef, error: "Already invoiced" });
        continue;
      }
      if (booking.status === "INVOICED") {
        failed.push({ bookingId, bookingRef: booking.bookingRef, error: "Status is already INVOICED" });
        continue;
      }
      if (booking.status === "CANCELLED") {
        failed.push({ bookingId, bookingRef: booking.bookingRef, error: "Booking is CANCELLED" });
        continue;
      }

      try {
        const lineItems = buildLineItemsForBooking(booking);

        const subtotal = lineItems.reduce((s: number, li: any) => s + (li.amount ?? 0), 0);
        const rawTotalGST = parseFloat(lineItems.reduce((s: number, li: any) => s + (li.igst ?? 0), 0).toFixed(2));
        const gstAmounts = calculateGSTAmounts(rawTotalGST, resolvedGstType);

        const gstMode = booking.pricing?.gstMode || "ON_MARKUP";
        const grandTotal = parseFloat(
          (gstMode === "ON_MARKUP"
            ? (booking.pricing?.quotedPrice ?? 0)
            : (booking.pricing?.grandTotal ?? ((booking.pricing?.quotedPrice ?? 0) + (booking.pricing?.gstAmount ?? 0)))
          ).toFixed(2),
        );

        const invoice = await Invoice.create({
          workspaceId: invoiceWorkspaceId,
          billingPeriod,
          bookingIds: [booking._id],
          subtotal: parseFloat(subtotal.toFixed(2)),
          totalGST: rawTotalGST,
          grandTotal,
          supplyType: resolvedGstType,
          cgstAmount: gstAmounts.cgst,
          sgstAmount: gstAmounts.sgst,
          utgstAmount: gstAmounts.utgst,
          igstAmount: gstAmounts.igst,
          gstTypeAutoDetected: detection.gstType,
          gstTypeOverridden: false,
          gstBypass,
          gstBypassType: gstBypass ? (resolution.gstType as "CGST_SGST" | "CGST_UTGST") : null,
          gstBypassReason: gstBypass ? gstBypassReason : "",
          placeOfSupply: detection.placeOfSupply,
          issuerState,
          clientState,
          issuerDetails,
          clientDetails,
          notes: notes || undefined,
          invoiceDate: resolvedInvoiceDate,
          dueDate: resolvedDueDate,
          createdBy: req.user._id,
        });

        // Store lineItems bypassing mongoose validation (same pattern as /generate)
        await Invoice.collection.updateOne(
          { _id: invoice._id },
          { $set: { lineItems } },
        );

        await ManualBooking.updateOne(
          { _id: booking._id },
          { $set: { status: "INVOICED", invoiceId: invoice._id, invoiceRaisedDate: new Date() } },
        );

        // Task automation hook per invoice
        triggerTaskAutomation("invoice.created", {
          workspaceId: String(invoiceWorkspaceId),
          entityType: "INVOICE",
          entityId: invoice._id,
          entityRef: invoice.invoiceNo,
          ownerId: req.user._id,
          variables: {
            invoiceNo: invoice.invoiceNo,
            customerName: clientDetails.companyName || "",
          },
        }).catch(() => {});

        generated.push({ bookingId, invoiceId: invoice._id.toString(), invoiceNo: invoice.invoiceNo });
      } catch (err: any) {
        console.error(`[Invoices bulk-generate] booking ${booking.bookingRef}:`, err.message);
        failed.push({ bookingId, bookingRef: booking.bookingRef, error: err.message });
      }
    }

    res.status(201).json({ ok: true, generated, failed });
  } catch (err: any) {
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

    if (invoice.status === "PAID" || invoice.status === "CANCELLED") {
      return res.status(400).json({ error: "Cannot add bookings to a PAID or CANCELLED invoice" });
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
        Invoice.aggregate([
          { $match: { status: { $in: ["DRAFT", "SENT"] } } },
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
router.put("/:id/status", requirePermission("invoices", "WRITE"), async (req: any, res: any) => {
  try {
    const { status, sentAt, paidAt, paymentRef } = req.body as {
      status: "SENT" | "PAID" | "CANCELLED";
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

// POST /api/admin/invoices/:id/revert-to-sent  (PAID -> SENT, reason required)
router.post("/:id/revert-to-sent", requirePermission("invoices", "WRITE"), async (req: any, res: any) => {
  try {
    const { reason } = req.body as { reason?: string };
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: "Reason is required" });
    }
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    if (invoice.status !== "PAID") {
      return res.status(400).json({ error: "Only PAID invoices can be reverted to SENT." });
    }

    const now = new Date();
    const oldPaidAt = invoice.paidAt;
    invoice.status = "SENT";
    invoice.paidAt = undefined;
    const iv = invoice as any;
    iv.editedAt = now;
    iv.editedBy = req.user._id;
    if (!iv.editHistory) iv.editHistory = [];
    iv.editHistory.push({
      editedAt: now, editedBy: req.user._id, fieldsChanged: ["status"],
      oldValues: { status: "PAID", paidAt: oldPaidAt }, newValues: { status: "SENT", reason: String(reason).trim() },
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
