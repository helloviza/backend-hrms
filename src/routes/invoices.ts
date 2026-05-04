import express from "express";
import ExcelJS from "exceljs";
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
import { generateInvoicePdf } from "../utils/invoicePdf.js";
import { getCompanySettings } from "../models/CompanySettings.js";
import { buildLineItemsForBooking } from "../utils/invoiceLineItems.js";
import { detectGSTType, calculateGSTAmounts, type GSTType } from "../utils/gstDetection.js";
import { env } from "../config/env.js";
import { triggerTaskAutomation } from "../services/taskAutomation.js";

const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);
router.use(requireWorkspace);

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

    if (!Array.isArray(bookingIds) || !bookingIds.length) {
      return res.status(400).json({ error: "bookingIds array is required" });
    }

    // Resolve invoiceDate — no restrictions, default to today if omitted
    const resolvedInvoiceDate = invoiceDate ? new Date(invoiceDate) : new Date();
    resolvedInvoiceDate.setHours(0, 0, 0, 0);

    // Validate bookings
    const bookings = await ManualBooking.find({
      _id: { $in: bookingIds.map((id) => new mongoose.Types.ObjectId(id)) },
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

    // GST detection
    const detection = detectGSTType({ supplierState: issuerState, customerState: effectiveState, customerCountry: effectiveCountry });
    if (!detection.canCalculate) {
      return res.status(400).json({
        error: "GST_DETECTION_FAILED",
        message: detection.reason,
        customerId: cust._id,
        missingField: "state",
        hint: "Update customer profile with state before generating invoice",
      });
    }

    // Validate and apply override if provided
    const allowedOverrides: GSTType[] = ["CGST_SGST", "CGST_UTGST", "IGST", "EXPORT", "NONE"];
    const useOverride = gstTypeOverride && allowedOverrides.includes(gstTypeOverride);
    if (useOverride && !gstOverrideReason) {
      return res.status(400).json({ error: "gstOverrideReason is required when using gstTypeOverride" });
    }
    const resolvedGstType: GSTType = useOverride ? gstTypeOverride! : detection.gstType;

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

    // Build line items per booking: 1 line (ON_FULL) or 2 lines — COST + SERVICE_FEE (ON_MARKUP)
    const invoiceLineItems: any[] = [];
    for (const b of bookings as any[]) {
      invoiceLineItems.push(...buildLineItemsForBooking(b));
    }

    const subtotal = invoiceLineItems.reduce((s, li) => s + (li.amount ?? 0), 0);
    const totalGST = invoiceLineItems.reduce((s, li) => s + (li.igst ?? 0), 0);
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

    // Fetch all bookings upfront and validate same workspace
    const allBookings = await ManualBooking.find({
      _id: { $in: bookingIds.map((id) => new mongoose.Types.ObjectId(id)) },
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

    const detection = detectGSTType({ supplierState: issuerState, customerState: customerStateRaw, customerCountry });
    if (!detection.canCalculate) {
      return res.status(400).json({
        error: "GST_DETECTION_FAILED",
        message: detection.reason,
        customerId: cust._id,
        missingField: "state",
        hint: "Update customer profile with state before generating invoice",
      });
    }

    const resolvedGstType: GSTType = detection.gstType;
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
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const filter: Record<string, any> = {};

    if (req.workspaceObjectId) filter.workspaceId = req.workspaceObjectId;
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
    if (req.workspaceObjectId) filter.workspaceId = req.workspaceObjectId;
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
      ...(req.workspaceObjectId && { workspaceId: req.workspaceObjectId }),
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    if (invoice.status === "PAID" || invoice.status === "CANCELLED") {
      return res.status(400).json({ error: "Cannot add bookings to a PAID or CANCELLED invoice" });
    }

    // Fetch new bookings
    const newBookings = await ManualBooking.find({
      _id: { $in: bookingIds.map((id) => new mongoose.Types.ObjectId(id)) },
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
      ...(req.workspaceObjectId && { workspaceId: req.workspaceObjectId }),
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
router.get("/activity", requirePermission("invoices", "READ"), async (req: any, res: any) => {
  try {
    const activityFilter: Record<string, any> = {};
    if (req.workspaceObjectId) activityFilter.workspaceId = req.workspaceObjectId;
    const invoices = await Invoice.find(activityFilter)
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
router.get("/insight", requirePermission("invoices", "READ"), async (req: any, res: any) => {
  try {
    const now            = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const wsFilter = req.workspaceObjectId ? { workspaceId: req.workspaceObjectId } : {};

    const [totalThisMonth, paidThisMonth, paidWithin15, outstandingAgg] =
      await Promise.all([
        Invoice.countDocuments({
          ...wsFilter,
          generatedAt: { $gte: thisMonthStart },
          status: { $ne: "CANCELLED" },
        }),
        Invoice.countDocuments({
          ...wsFilter,
          generatedAt: { $gte: thisMonthStart },
          status: "PAID",
        }),
        Invoice.countDocuments({
          ...wsFilter,
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
          { $match: { ...wsFilter, status: { $in: ["DRAFT", "SENT"] } } },
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

    const invoice = await Invoice.findOne({
      _id: req.params.id,
      ...(req.workspaceObjectId && { workspaceId: req.workspaceObjectId }),
    });
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

// PATCH /api/admin/invoices/:id
router.patch("/:id", requirePermission("invoices", "WRITE"), async (req: any, res: any) => {
  try {
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      ...(req.workspaceObjectId && { workspaceId: req.workspaceObjectId }),
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    if (invoice.status !== "DRAFT") {
      return res.status(400).json({ error: "Cannot edit non-draft invoice. Use cancel + reissue." });
    }

    const { dueDate, notes, supplyType, gstOverrideReason } = req.body as {
      dueDate?: string;
      notes?: string;
      supplyType?: GSTType;
      gstOverrideReason?: string;
    };

    const allowedSupplyTypes: GSTType[] = ["CGST_SGST", "CGST_UTGST", "IGST", "EXPORT", "NONE"];
    if (supplyType && !allowedSupplyTypes.includes(supplyType)) {
      return res.status(400).json({ error: "Invalid supplyType" });
    }

    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};
    const fieldsChanged: string[] = [];

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

    if (supplyType && supplyType !== invoice.supplyType) {
      const isAutoDetected = supplyType === (invoice.gstTypeAutoDetected as GSTType | undefined);
      if (!isAutoDetected && !gstOverrideReason?.trim()) {
        return res.status(400).json({ error: "gstOverrideReason is required when changing GST type" });
      }

      const gstAmounts = calculateGSTAmounts(invoice.totalGST, supplyType);
      oldValues.supplyType = invoice.supplyType;
      newValues.supplyType = supplyType;
      if (!isAutoDetected && gstOverrideReason?.trim()) newValues.gstOverrideReason = gstOverrideReason.trim();
      fieldsChanged.push("supplyType");

      invoice.supplyType = supplyType;
      invoice.cgstAmount = gstAmounts.cgst;
      invoice.sgstAmount = gstAmounts.sgst;
      invoice.utgstAmount = gstAmounts.utgst;
      invoice.igstAmount = gstAmounts.igst;

      if (isAutoDetected) {
        invoice.gstTypeOverridden = false;
        invoice.gstOverrideReason = undefined;
        (invoice as any).gstOverrideBy = undefined;
      } else {
        invoice.gstTypeOverridden = true;
        invoice.gstOverrideReason = gstOverrideReason!.trim();
        invoice.gstOverrideBy = req.user._id;
      }
    }

    if (!fieldsChanged.length) {
      return res.json({ ok: true, invoice });
    }

    const now = new Date();
    const iv = invoice as any;
    iv.editedAt = now;
    iv.editedBy = req.user._id;
    if (!iv.editHistory) iv.editHistory = [];
    iv.editHistory.push({ editedAt: now, editedBy: req.user._id, fieldsChanged, oldValues, newValues });

    await invoice.save();
    res.json({ ok: true, invoice });
  } catch (err: any) {
    console.error("[Invoices PATCH]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Single ───────────────────────────────────────────────────────── */

// GET /api/admin/invoices/:id
router.get("/:id", requirePermission("invoices", "READ"), async (req: any, res: any) => {
  try {
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      ...(req.workspaceObjectId && { workspaceId: req.workspaceObjectId }),
    }).lean();
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
router.put("/:id/status", requirePermission("invoices", "WRITE"), async (req: any, res: any) => {
  try {
    const { status, paidAt } = req.body as {
      status: "SENT" | "PAID" | "CANCELLED";
      paidAt?: string;
    };

    const invoice = await Invoice.findOne({
      _id: req.params.id,
      ...(req.workspaceObjectId && { workspaceId: req.workspaceObjectId }),
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    invoice.status = status;
    if (status === "SENT") invoice.sentAt = new Date();
    if (status === "PAID") invoice.paidAt = paidAt ? new Date(paidAt) : new Date();

    await invoice.save();
    res.json({ ok: true, invoice });
  } catch (err: any) {
    console.error("[Invoices PUT status]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── PDF ──────────────────────────────────────────────────────── */

// POST /api/admin/invoices/:id/pdf
router.post("/:id/pdf", requirePermission("invoices", "WRITE"), async (req: any, res: any) => {
  try {
    const invoice = await Invoice.collection.findOne({
      _id: new mongoose.Types.ObjectId(req.params.id),
      ...(req.workspaceObjectId && { workspaceId: req.workspaceObjectId }),
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
