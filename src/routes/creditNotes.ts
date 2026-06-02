import express from "express";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import CreditNote from "../models/CreditNote.js";
import CreditNoteReason from "../models/CreditNoteReason.js";
import Invoice from "../models/Invoice.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { getCompanySettings } from "../models/CompanySettings.js";
import { calculateGSTAmounts, type GSTType } from "../utils/gstDetection.js";
import { env } from "../config/env.js";
import { triggerTaskAutomation } from "../services/taskAutomation.js";

/* ── Shared helpers ──────────────────────────────────────────────── */

// Demo Platform — demo admins/users see only demo data; real users protected.
function demoClause(req: any): Record<string, any> {
  return req.user?.isDemoUser ? { isDemo: true } : { isDemo: { $ne: true } };
}

const r2 = (n: number): number => parseFloat((Number.isFinite(n) ? n : 0).toFixed(2));

// GST reason-code → text (mirrors the CreditNoteReason master; 05/06 are
// override-only codes not used by any seeded reason but valid for overrides).
const GST_REASON_TEXT: Record<string, string> = {
  "01": "Sales Return",
  "02": "Post-Supply Discount",
  "03": "Deficiency in Service",
  "04": "Correction in Invoice",
  "05": "Change in POS",
  "06": "Finalization of Provisional Assessment",
  "07": "Others",
};

// Render + upload a PDF to S3 and return a presigned inline URL (1h). Mirrors the
// inline S3 mechanism in invoices.ts POST /:id/pdf — no shared util exists.
async function uploadAndPresign(key: string, body: Buffer, filename: string): Promise<string> {
  const s3 = new S3Client({
    region: env.AWS_REGION,
    credentials:
      env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
        : undefined,
  });
  await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: "application/pdf" }));
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ResponseContentDisposition: `inline; filename="${filename}"` }),
    { expiresIn: 3600 },
  );
}

// Phase 3 will replace this with the real generateCreditNotePdf(creditNote).
// For now it throws a typed error so the route plumbing is fully wired without
// shipping a bogus document: issue/pdf handlers catch it and degrade gracefully
// (issue still transitions + persists; pdfUrl is populated when Phase 3 lands).
class PdfPendingError extends Error {
  constructor() {
    super("Credit note PDF generation ships in Phase 3");
    this.name = "PdfPendingError";
  }
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function placeholderRenderPdf(_creditNote: any): Promise<Buffer> {
  throw new PdfPendingError();
}

/**
 * Authoritative remaining-creditable balance for an invoice.
 * Sums grandTotal of all ISSUED credit notes against the invoice (DRAFT and
 * CANCELLED do NOT lock balance) and subtracts from the invoice grandTotal.
 * The Invoice.creditedAmount denormalized field is a convenience only — this
 * aggregation is the source of truth.
 */
async function getRemainingCreditableAmount(invoiceId: string): Promise<number> {
  const result = await CreditNote.aggregate([
    { $match: { originalInvoiceId: new mongoose.Types.ObjectId(invoiceId), status: "ISSUED" } },
    { $group: { _id: null, total: { $sum: "$grandTotal" } } },
  ]);
  const alreadyIssued = result[0]?.total || 0;
  const invoice = await Invoice.findById(invoiceId).select("grandTotal").lean();
  if (!invoice) throw new HttpError(404, "Original invoice not found");
  return Math.max(0, (invoice.grandTotal ?? 0) - alreadyIssued);
}

async function validateCreditableAmount(invoiceId: string, requestedAmount: number): Promise<void> {
  const remaining = await getRemainingCreditableAmount(invoiceId);
  if (r2(requestedAmount) > r2(remaining) + 0.01) {
    throw new HttpError(
      400,
      `Requested credit ₹${r2(requestedAmount)} exceeds remaining creditable balance ₹${r2(remaining)} on this invoice`,
    );
  }
}

// Resolve the GST reason code/text from the reason master, applying an optional
// override (logged via gstReasonOverrideReason). Returns the stored shape.
function deriveGstFromReason(
  reason: any,
  overrideCode?: string,
  overrideReason?: string,
): { gstReasonCode: string; gstReasonText: string; gstReasonOverridden: boolean; gstReasonOverrideReason?: string } {
  if (overrideCode && overrideCode !== reason.gstReasonCode) {
    return {
      gstReasonCode: overrideCode,
      gstReasonText: GST_REASON_TEXT[overrideCode] ?? reason.gstReasonText,
      gstReasonOverridden: true,
      gstReasonOverrideReason: overrideReason || "",
    };
  }
  return { gstReasonCode: reason.gstReasonCode, gstReasonText: reason.gstReasonText, gstReasonOverridden: false };
}

// Build credited line items + reconciled totals. Full credit mirrors the
// invoice lines 1:1; partial credit uses the caller's per-line creditedAmount
// and pro-rates the GST from the matched original line (amount = Rate×Qty+GST
// contract preserved: per CN line, amount = creditedAmount, igst = pro-rated).
function buildCreditedLineItems(
  invoice: any,
  body: any,
): { lines: any[]; subtotal: number; totalGST: number; grandTotal: number } {
  const invLines: any[] = invoice.lineItems ?? [];
  const out: any[] = [];

  if (body.isFullCredit) {
    for (const li of invLines) {
      const amount = r2(li.amount ?? 0);
      out.push({
        bookingRef: li.bookingRef ?? "",
        rowType: li.rowType === "SERVICE_FEE" ? "SERVICE_FEE" : "COST",
        description: li.description ?? "",
        subDescription: li.subDescription ?? "",
        qty: Number(li.qty ?? 1),
        rate: r2(li.rate ?? 0),
        igst: r2(li.igst ?? 0),
        amount,
        passengerNames: Array.isArray(li.passengerNames) ? li.passengerNames : [],
        travelDate: li.travelDate,
        type: li.type ?? "",
        originalAmount: amount,
        creditedAmount: amount,
      });
    }
  } else {
    // Index invoice lines by composite key, consumed in order (a bookingRef can
    // have both a COST and a SERVICE_FEE row).
    const pool = new Map<string, any[]>();
    for (const li of invLines) {
      const k = `${li.bookingRef}|${li.rowType}|${li.description}`;
      if (!pool.has(k)) pool.set(k, []);
      pool.get(k)!.push(li);
    }
    for (const b of (body.lineItems ?? []) as any[]) {
      const k = `${b.bookingRef}|${b.rowType}|${b.description}`;
      const match = (pool.get(k) || []).shift() || null;
      const origAmount = r2(match?.amount ?? b.originalAmount ?? b.amount ?? 0);
      const origIgst = r2(match?.igst ?? b.igst ?? 0);
      const credited = r2(Number(b.creditedAmount ?? 0));
      const prop = origAmount > 0 ? credited / origAmount : 0;
      const creditedIgst = r2(origIgst * prop);
      out.push({
        bookingRef: b.bookingRef ?? match?.bookingRef ?? "",
        rowType: b.rowType === "SERVICE_FEE" ? "SERVICE_FEE" : "COST",
        description: b.description ?? match?.description ?? "",
        subDescription: b.subDescription ?? match?.subDescription ?? "",
        qty: Number(b.qty ?? match?.qty ?? 1),
        rate: r2(Number(b.rate ?? match?.rate ?? 0)),
        igst: creditedIgst,
        amount: credited,
        passengerNames: Array.isArray(b.passengerNames) ? b.passengerNames : (match?.passengerNames ?? []),
        travelDate: b.travelDate ?? match?.travelDate,
        type: b.type ?? match?.type ?? "",
        originalAmount: origAmount,
        creditedAmount: credited,
      });
    }
  }

  const grandTotal = r2(out.reduce((s, l) => s + (l.amount ?? 0), 0));
  const totalGST = r2(out.reduce((s, l) => s + (l.igst ?? 0), 0));
  const subtotal = r2(grandTotal - totalGST);
  return { lines: out, subtotal, totalGST, grandTotal };
}

/**
 * Validate the request and assemble the (unsaved) credit note payload from the
 * original invoice. Used by POST / (then saved) and POST /preview (returned as-is).
 * Validation order: invoice exists → invoice status → reason exists/active →
 * per-line amount math → aggregate creditable amount.
 */
async function validateAndBuild(req: any, body: any): Promise<{ payload: Partial<any>; invoice: any; reason: any }> {
  const { originalInvoiceId, reasonId } = body as { originalInvoiceId?: string; reasonId?: string };

  if (!originalInvoiceId || !mongoose.Types.ObjectId.isValid(originalInvoiceId)) {
    throw new HttpError(400, "originalInvoiceId is required");
  }
  if (!reasonId || !mongoose.Types.ObjectId.isValid(reasonId)) {
    throw new HttpError(400, "reasonId is required");
  }
  if (typeof body.isFullCredit !== "boolean") {
    throw new HttpError(400, "isFullCredit (boolean) is required");
  }

  // Invoice exists
  const invoice = await Invoice.findById(originalInvoiceId).lean();
  if (!invoice) throw new HttpError(404, "Original invoice not found");

  // Invoice status — only SENT or PAID invoices can be credited
  if (invoice.status !== "SENT" && invoice.status !== "PAID") {
    throw new HttpError(400, `Cannot credit an invoice in ${invoice.status} status. Only SENT or PAID invoices can be credited.`);
  }

  // Reason exists + active
  const reason = await CreditNoteReason.findById(reasonId).lean();
  if (!reason) throw new HttpError(400, "Credit note reason not found");
  if (!(reason as any).isActive) throw new HttpError(400, "Credit note reason is inactive");

  // reasonNote length guard
  const reasonNote = body.reasonNote ? String(body.reasonNote).slice(0, 500) : undefined;

  // Build lines + totals
  if (!body.isFullCredit && (!Array.isArray(body.lineItems) || body.lineItems.length === 0)) {
    throw new HttpError(400, "lineItems are required for a partial credit");
  }
  const { lines, subtotal, totalGST, grandTotal } = buildCreditedLineItems(invoice, body);

  if (lines.length === 0 || grandTotal <= 0) {
    throw new HttpError(400, "Credit note must have at least one line with a positive credited amount");
  }

  // Per-line: creditedAmount cannot exceed the original line amount
  for (const l of lines) {
    if (r2(l.creditedAmount) > r2(l.originalAmount) + 0.01) {
      throw new HttpError(
        400,
        `Credited amount ₹${r2(l.creditedAmount)} exceeds original line amount ₹${r2(l.originalAmount)} for "${l.description}"`,
      );
    }
  }

  // Aggregate: total credited cannot exceed remaining creditable on the invoice
  await validateCreditableAmount(originalInvoiceId, grandTotal);

  // GST reason resolution (master + optional override)
  const gst = deriveGstFromReason(reason, body.gstReasonCodeOverride, body.gstReasonOverrideReason);

  // supplyType: mirror the invoice unless a type override is supplied
  const allowedTypes: GSTType[] = ["CGST_SGST", "CGST_UTGST", "IGST", "EXPORT", "NONE"];
  const useTypeOverride = body.gstTypeOverride && allowedTypes.includes(body.gstTypeOverride);
  if (useTypeOverride && !body.gstOverrideReason?.trim()) {
    throw new HttpError(400, "gstOverrideReason is required when using gstTypeOverride");
  }
  const supplyType: GSTType = (useTypeOverride ? body.gstTypeOverride : (invoice.supplyType as GSTType)) || "IGST";

  // GST bypass (mirrors invoices — audit trail kept separate from type override)
  const gstBypass = body.gstBypass === true;
  const gstBypassReason = (body.gstBypassReason || "").trim();
  if (gstBypass && !gstBypassReason) {
    throw new HttpError(400, "gstBypassReason is required when gstBypass is true");
  }

  const gstAmounts = calculateGSTAmounts(totalGST, supplyType);

  // Issuer snapshot (live company settings) + client snapshot (from the invoice)
  const companySettings = await getCompanySettings();
  const issuerState = companySettings.supplierState || companySettings.state || process.env.COMPANY_STATE || "Karnataka";
  const issuerDetails = {
    companyName: companySettings.companyName || process.env.COMPANY_NAME,
    gstin: companySettings.gstin || process.env.COMPANY_GSTIN,
    address: companySettings.address || process.env.COMPANY_ADDRESS,
    addressLine1: (companySettings as any).addressLine1 || "",
    addressLine2: (companySettings as any).addressLine2 || "",
    city: (companySettings as any).city || "",
    country: (companySettings as any).country || "India",
    pincode: (companySettings as any).pincode || "",
    email: companySettings.email || process.env.COMPANY_EMAIL,
    phone: companySettings.phone || process.env.COMPANY_PHONE,
    website: companySettings.website || process.env.COMPANY_WEBSITE,
    state: issuerState,
  };

  const payload: Partial<any> = {
    workspaceId: invoice.workspaceId,

    originalInvoiceId: invoice._id,
    originalInvoiceNo: invoice.invoiceNo,
    originalInvoiceDate: invoice.invoiceDate ?? invoice.generatedAt,
    originalInvoiceAmount: invoice.grandTotal ?? 0,

    serviceCategory: (reason as any).category,
    reasonId: reason._id,
    reasonText: (reason as any).reason,
    reasonNote,

    gstReasonCode: gst.gstReasonCode,
    gstReasonText: gst.gstReasonText,
    gstReasonOverridden: gst.gstReasonOverridden,
    gstReasonOverrideBy: gst.gstReasonOverridden ? req.user._id : undefined,
    gstReasonOverrideReason: gst.gstReasonOverrideReason,

    isFullCredit: body.isFullCredit,
    lineItems: lines,

    subtotal,
    totalGST,
    grandTotal,

    supplyType,
    cgstAmount: gstAmounts.cgst,
    sgstAmount: gstAmounts.sgst,
    utgstAmount: gstAmounts.utgst,
    igstAmount: gstAmounts.igst,

    gstTypeAutoDetected: invoice.supplyType,
    gstTypeOverridden: !!useTypeOverride,
    gstOverrideReason: useTypeOverride ? body.gstOverrideReason : undefined,
    gstOverrideBy: useTypeOverride ? req.user._id : undefined,
    gstBypass,
    gstBypassType: gstBypass ? (supplyType as "CGST_SGST" | "CGST_UTGST") : null,
    gstBypassReason: gstBypass ? gstBypassReason : "",

    placeOfSupply: invoice.placeOfSupply,
    issuerState,
    clientState: invoice.clientState,
    issuerDetails,
    clientDetails: invoice.clientDetails,

    terms: body.terms,
    notes: body.notes,
    showInclusiveTaxNote: body.showInclusiveTaxNote === true,

    // Demo Platform — propagate isolation flag from the original invoice.
    isDemo: !!invoice.isDemo,

    createdBy: req.user._id,
  };

  return { payload, invoice, reason };
}

/* ── Typed HTTP error (maps to a status code in handlers) ─────────── */
class HttpError extends Error {
  constructor(public httpStatus: number, message: string) {
    super(message);
  }
}

/* ════════════════════════════════════════════════════════════════════
   WORKSPACE ROUTER — mounted at /api/credit-notes/workspace
   Accessible to WORKSPACE_LEADER / TENANT_ADMIN / CUSTOMER with a workspace.
═══════════════════════════════════════════════════════════════════════ */

export const workspaceRouter = express.Router();

workspaceRouter.use(requireAuth);
workspaceRouter.use(requireWorkspace);

// GET /api/credit-notes/workspace/mine
workspaceRouter.get("/mine", async (req: any, res: any) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, parseInt(req.query.pageSize) || 25);

    const filter: Record<string, any> = {
      workspaceId: req.workspaceObjectId,
      ...demoClause(req),
    };

    if (req.query.status) filter.status = req.query.status;

    if (req.query.dateFrom || req.query.dateTo) {
      filter.generatedAt = {};
      if (req.query.dateFrom) filter.generatedAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) filter.generatedAt.$lte = new Date(req.query.dateTo);
    }

    if (req.query.search) {
      const rx = { $regex: String(req.query.search), $options: "i" };
      filter.$or = [{ creditNoteNo: rx }, { originalInvoiceNo: rx }, { reasonText: rx }];
    }

    const [items, total] = await Promise.all([
      CreditNote.find(filter)
        .sort({ generatedAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      CreditNote.countDocuments(filter),
    ]);

    res.json({ items, total, page, pageSize });
  } catch (err: any) {
    console.error("[CreditNotes workspace/mine]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/credit-notes/workspace/:id/pdf
workspaceRouter.post("/:id/pdf", async (req: any, res: any) => {
  try {
    const cn = await CreditNote.findOne({
      _id: new mongoose.Types.ObjectId(req.params.id),
      workspaceId: req.workspaceObjectId,
    }).lean();
    if (!cn) return res.status(404).json({ error: "Credit note not found" });

    try {
      const buf = await placeholderRenderPdf(cn);
      const url = await uploadAndPresign(`credit-notes/${cn.creditNoteNo}.pdf`, buf, `${cn.creditNoteNo}.pdf`);
      await CreditNote.collection.updateOne({ _id: cn._id }, { $set: { pdfUrl: url } });
      return res.json({ url, expiresIn: 3600 });
    } catch (e) {
      if (e instanceof PdfPendingError) {
        return res.status(503).json({ error: "PDF_PENDING_PHASE_3", message: e.message });
      }
      throw e;
    }
  } catch (err: any) {
    console.error("[CreditNotes workspace/pdf]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════════
   ADMIN ROUTER — mounted at /api/admin/credit-notes
═══════════════════════════════════════════════════════════════════════ */

const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

/* ── CSV/XLSX export helpers (mirror invoices.ts) ─────────────────── */

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

const CN_COLUMNS = [
  "Credit Note No",
  "Credit Note Date",
  "Status",
  "Original Invoice No",
  "Original Invoice Date",
  "Workspace",
  "Customer",
  "Customer GSTIN",
  "Service Category",
  "Reason",
  "Reason Note",
  "GST Reason Code",
  "GST Reason Text",
  "Subtotal",
  "CGST",
  "SGST",
  "IGST",
  "Total GST",
  "Grand Total",
  "Supply Type",
  "Place of Supply",
  "Issued At",
  "Issued By",
  "Cancelled At",
  "Cancellation Reason",
  "Is Demo",
  "IRN",
  "IRN Generated At",
];

function cnToRow(cn: any, workspaceName: string): (string | number | undefined)[] {
  return [
    cn.creditNoteNo,
    cn.creditNoteDate ? new Date(cn.creditNoteDate).toLocaleDateString("en-IN") : "",
    cn.status,
    cn.originalInvoiceNo,
    cn.originalInvoiceDate ? new Date(cn.originalInvoiceDate).toLocaleDateString("en-IN") : "",
    workspaceName || cn.clientDetails?.companyName || "",
    cn.clientDetails?.companyName || "",
    cn.clientDetails?.gstin || "",
    cn.serviceCategory,
    cn.reasonText,
    cn.reasonNote || "",
    cn.gstReasonCode,
    cn.gstReasonText,
    cn.subtotal ?? 0,
    cn.cgstAmount ?? 0,
    cn.sgstAmount ?? 0,
    cn.igstAmount ?? 0,
    cn.totalGST ?? 0,
    cn.grandTotal ?? 0,
    cn.supplyType,
    cn.placeOfSupply || "",
    cn.issuedAt ? new Date(cn.issuedAt).toLocaleDateString("en-IN") : "",
    cn.issuedBy ? String(cn.issuedBy) : "",
    cn.cancelledAt ? new Date(cn.cancelledAt).toLocaleDateString("en-IN") : "",
    cn.cancellationReason || "",
    cn.isDemo ? "Yes" : "No",
    cn.irn || "",
    cn.irnGeneratedAt ? new Date(cn.irnGeneratedAt).toLocaleDateString("en-IN") : "",
  ];
}

// Batch-resolve workspace display names for a page of credit notes.
async function resolveWorkspaceNames(cns: any[]): Promise<Map<string, string>> {
  const ids = [...new Set(cns.map((c) => String(c.workspaceId)).filter(Boolean))];
  if (!ids.length) return new Map();
  const docs = await CustomerWorkspace.find({ _id: { $in: ids } }).select("companyName").lean();
  return new Map(docs.map((d: any) => [String(d._id), d.companyName || ""]));
}

/* ── Reasons master (issue-modal dropdown) ────────────────────────── */

// GET /api/admin/credit-notes/reasons
router.get("/reasons", requirePermission("creditnotes", "READ"), async (req: any, res: any) => {
  try {
    const filter: Record<string, any> = {};
    if (req.query.category) filter.category = String(req.query.category).toUpperCase();
    const activeOnly = req.query.activeOnly !== "false"; // default true
    if (activeOnly) filter.isActive = true;

    const reasons = await CreditNoteReason.find(filter)
      .sort({ category: 1, displayOrder: 1 })
      .lean();

    res.json({ ok: true, reasons });
  } catch (err: any) {
    console.error("[CreditNotes reasons]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Create (DRAFT) ───────────────────────────────────────────────── */

// POST /api/admin/credit-notes
router.post("/", requirePermission("creditnotes", "WRITE"), async (req: any, res: any) => {
  try {
    const { payload, invoice } = await validateAndBuild(req, req.body || {});

    const creditNote = await CreditNote.create(payload as any);

    // Store lineItems via raw collection write (same pattern as invoices — the
    // schema types lineItems as Mixed and skips per-row validation).
    await CreditNote.collection.updateOne(
      { _id: creditNote._id },
      { $set: { lineItems: payload.lineItems } },
    );

    const complete = await CreditNote.collection.findOne({ _id: creditNote._id });

    // Task automation hook (no balance side-effects on draft creation).
    triggerTaskAutomation("creditnote.created", {
      workspaceId: String(invoice.workspaceId),
      entityType: "CREDIT_NOTE",
      entityId: creditNote._id,
      entityRef: creditNote.creditNoteNo,
      ownerId: req.user._id,
      variables: {
        creditNoteNo: creditNote.creditNoteNo,
        originalInvoiceNo: creditNote.originalInvoiceNo,
        customerName: (payload.clientDetails as any)?.companyName || "",
      },
    }).catch(() => {});

    res.status(201).json({ ok: true, creditNote: complete });
  } catch (err: any) {
    if (err instanceof HttpError) return res.status(err.httpStatus).json({ error: err.message });
    console.error("[CreditNotes create]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Preview (no persistence) ─────────────────────────────────────── */

// POST /api/admin/credit-notes/preview
router.post("/preview", requirePermission("creditnotes", "WRITE"), async (req: any, res: any) => {
  try {
    const { payload } = await validateAndBuild(req, req.body || {});
    res.json({ ok: true, preview: payload });
  } catch (err: any) {
    if (err instanceof HttpError) return res.status(err.httpStatus).json({ error: err.message });
    console.error("[CreditNotes preview]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── List ─────────────────────────────────────────────────────────── */

// GET /api/admin/credit-notes
router.get("/", requirePermission("creditnotes", "READ"), async (req: any, res: any) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, parseInt(req.query.pageSize) || 25);
    const filter: Record<string, any> = { ...demoClause(req) };

    if (req.query.workspaceId) {
      const cws = await CustomerWorkspace.findOne({ customerId: req.query.workspaceId }).select("_id").lean();
      filter.workspaceId = { $in: [req.query.workspaceId, ...(cws ? [cws._id] : [])] };
    }
    if (req.query.originalInvoiceId && mongoose.Types.ObjectId.isValid(req.query.originalInvoiceId)) {
      filter.originalInvoiceId = new mongoose.Types.ObjectId(req.query.originalInvoiceId);
    }
    if (req.query.status) filter.status = req.query.status;
    if (req.query.reasonCategory) filter.serviceCategory = String(req.query.reasonCategory).toUpperCase();
    if (req.query.reasonCode) filter.gstReasonCode = String(req.query.reasonCode);

    if (req.query.dateFrom || req.query.dateTo) {
      filter.generatedAt = {};
      if (req.query.dateFrom) filter.generatedAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) filter.generatedAt.$lte = new Date(req.query.dateTo);
    }

    if (req.query.search) {
      const rx = { $regex: String(req.query.search), $options: "i" };
      filter.$or = [{ creditNoteNo: rx }, { originalInvoiceNo: rx }, { reasonText: rx }];
    }

    const [docs, total] = await Promise.all([
      CreditNote.find(filter).sort({ generatedAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      CreditNote.countDocuments(filter),
    ]);

    const wsNames = await resolveWorkspaceNames(docs);
    const items = docs.map((c: any) => ({
      ...c,
      workspaceName: wsNames.get(String(c.workspaceId)) || c.clientDetails?.companyName || "",
      customerName: c.clientDetails?.companyName || "",
    }));

    res.json({ items, total, page, pageSize });
  } catch (err: any) {
    console.error("[CreditNotes GET list]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Export ───────────────────────────────────────────────────────── */

// GET /api/admin/credit-notes/export
router.get("/export", requirePermission("creditnotes", "READ"), async (req: any, res: any) => {
  try {
    const filter: Record<string, any> = { ...demoClause(req) };
    if (req.query.workspaceId) {
      const cws = await CustomerWorkspace.findOne({ customerId: req.query.workspaceId }).select("_id").lean();
      filter.workspaceId = { $in: [req.query.workspaceId, ...(cws ? [cws._id] : [])] };
    }
    if (req.query.from || req.query.to) {
      filter.generatedAt = {};
      if (req.query.from) filter.generatedAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.generatedAt.$lte = new Date(req.query.to);
    }

    const format = req.query.format === "xlsx" ? "xlsx" : "csv";
    const docs = await CreditNote.find(filter).sort({ generatedAt: -1 }).limit(5000).lean();
    const wsNames = await resolveWorkspaceNames(docs);

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="credit-notes-export.csv"');
      res.write(csvRow(CN_COLUMNS));
      for (const cn of docs) res.write(csvRow(cnToRow(cn, wsNames.get(String(cn.workspaceId)) || "")));
      res.end();
      return;
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Credit Notes");
    const headerRow = sheet.addRow(CN_COLUMNS);
    headerRow.font = { bold: true };
    // Monetary columns: Subtotal=14, CGST=15, SGST=16, IGST=17, Total GST=18, Grand Total=19
    [14, 15, 16, 17, 18, 19].forEach((ci) => { sheet.getColumn(ci).numFmt = "#,##0.00"; });
    for (const cn of docs) sheet.addRow(cnToRow(cn, wsNames.get(String(cn.workspaceId)) || ""));

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="credit-notes-export.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err: any) {
    console.error("[CreditNotes EXPORT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Activity ─────────────────────────────────────────────────────── */

function timeAgo(date: Date): string {
  const diffMs = Date.now() - new Date(date).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 60) return `${diffMins} minutes ago`;
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays === 1) return "Yesterday";
  return `${diffDays} days ago`;
}

// GET /api/admin/credit-notes/activity
router.get("/activity", requirePermission("creditnotes", "READ"), async (req: any, res: any) => {
  try {
    const docs = await CreditNote.find({ ...demoClause(req) }).sort({ updatedAt: -1 }).limit(10).lean();
    const result = docs.map((cn: any) => {
      let action: string;
      let label: string;
      if (cn.status === "CANCELLED") {
        action = "cancelled";
        label = `Credit Note #${cn.creditNoteNo} cancelled`;
      } else if (cn.status === "ISSUED") {
        action = "issued";
        label = `Credit Note #${cn.creditNoteNo} issued`;
      } else {
        action = "created";
        label = `Credit Note #${cn.creditNoteNo} created`;
      }
      return {
        creditNoteId: String(cn._id),
        creditNoteNo: cn.creditNoteNo,
        action,
        label,
        clientName: cn.clientDetails?.companyName || "",
        timeAgo: timeAgo(cn.updatedAt as Date),
        timestamp: cn.updatedAt,
        status: cn.status,
      };
    });
    res.json(result);
  } catch (err: any) {
    console.error("[CreditNotes activity]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Insight ──────────────────────────────────────────────────────── */

// GET /api/admin/credit-notes/insight
router.get("/insight", requirePermission("creditnotes", "READ"), async (req: any, res: any) => {
  try {
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const baseMatch = { ...demoClause(req), status: "ISSUED", issuedAt: { $gte: thisMonthStart } };

    const [issuedAgg, byCategory, byReasonCode] = await Promise.all([
      CreditNote.aggregate([
        { $match: baseMatch },
        { $group: { _id: null, count: { $sum: 1 }, totalAmount: { $sum: "$grandTotal" } } },
      ]),
      CreditNote.aggregate([
        { $match: baseMatch },
        { $group: { _id: "$serviceCategory", count: { $sum: 1 }, amount: { $sum: "$grandTotal" } } },
        { $sort: { count: -1 } },
      ]),
      CreditNote.aggregate([
        { $match: baseMatch },
        { $group: { _id: "$gstReasonCode", count: { $sum: 1 }, amount: { $sum: "$grandTotal" } } },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const totalIssued = issuedAgg[0]?.count ?? 0;
    const totalCreditAmount = issuedAgg[0]?.totalAmount ?? 0;

    let insight: string;
    if (totalIssued === 0) {
      insight = "No credit notes issued this month yet.";
    } else {
      insight = `${totalIssued} credit note(s) issued this month, totalling ₹${r2(totalCreditAmount)}.`;
    }

    res.json({
      totalIssued,
      totalCreditAmount: r2(totalCreditAmount),
      byCategory: byCategory.map((b: any) => ({ category: b._id, count: b.count, amount: r2(b.amount) })),
      byReasonCode: byReasonCode.map((b: any) => ({ gstReasonCode: b._id, count: b.count, amount: r2(b.amount) })),
      insight,
    });
  } catch (err: any) {
    console.error("[CreditNotes insight]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Issue (DRAFT → ISSUED) ──────────────────────────────────────── */

// POST /api/admin/credit-notes/:id/issue
router.post("/:id/issue", requirePermission("creditnotes", "FULL"), async (req: any, res: any) => {
  try {
    const cn = await CreditNote.findById(req.params.id);
    if (!cn) return res.status(404).json({ error: "Credit note not found" });
    if (cn.status !== "DRAFT") {
      return res.status(400).json({ error: `Only DRAFT credit notes can be issued (current: ${cn.status}).` });
    }

    // Re-validate the creditable balance at issue time (a sibling CN may have
    // been issued since this draft was created).
    await validateCreditableAmount(String(cn.originalInvoiceId), cn.grandTotal ?? 0);

    const now = new Date();
    cn.status = "ISSUED";
    (cn as any).issuedAt = now;
    (cn as any).issuedBy = req.user._id;
    const iv = cn as any;
    iv.editedAt = now;
    iv.editedBy = req.user._id;
    if (!iv.editHistory) iv.editHistory = [];
    iv.editHistory.push({
      editedAt: now,
      editedBy: req.user._id,
      fieldsChanged: ["status"],
      oldValues: { status: "DRAFT" },
      newValues: { status: "ISSUED", issuedAt: now },
    });
    await cn.save();

    // Increment the original invoice's denormalized creditedAmount counter.
    // Raw collection write with $inc — no Invoice schema change (deferred to
    // Phase 5); existing invoices without the field are treated as 0 by $inc.
    await Invoice.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(cn.originalInvoiceId)) },
      { $inc: { creditedAmount: cn.grandTotal ?? 0 } },
    );

    // Generate + upload the PDF. Phase 3 supplies the real renderer; until then
    // the placeholder throws PdfPendingError and we leave pdfUrl unset — the
    // issue transition itself is already persisted above.
    let pdfUrl: string | null = null;
    try {
      const buf = await placeholderRenderPdf(cn.toObject());
      pdfUrl = await uploadAndPresign(`credit-notes/${cn.creditNoteNo}.pdf`, buf, `${cn.creditNoteNo}.pdf`);
      await CreditNote.collection.updateOne({ _id: cn._id }, { $set: { pdfUrl } });
    } catch (e) {
      if (!(e instanceof PdfPendingError)) throw e;
      // PDF pending Phase 3 — issue succeeds without a document.
    }

    triggerTaskAutomation("creditnote.issued", {
      workspaceId: String(cn.workspaceId),
      entityType: "CREDIT_NOTE",
      entityId: cn._id,
      entityRef: cn.creditNoteNo,
      ownerId: req.user._id,
      variables: {
        creditNoteNo: cn.creditNoteNo,
        originalInvoiceNo: cn.originalInvoiceNo,
        amount: String(cn.grandTotal ?? 0),
      },
    }).catch(() => {});

    res.json({ ok: true, creditNote: cn.toObject(), pdfUrl });
  } catch (err: any) {
    if (err instanceof HttpError) return res.status(err.httpStatus).json({ error: err.message });
    console.error("[CreditNotes issue]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Cancel (ISSUED → CANCELLED) ─────────────────────────────────── */

// POST /api/admin/credit-notes/:id/cancel
router.post("/:id/cancel", requirePermission("creditnotes", "FULL"), async (req: any, res: any) => {
  try {
    const { reason, note } = req.body as { reason?: string; note?: string };
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: "Cancellation reason is required" });
    }

    const cn = await CreditNote.findById(req.params.id);
    if (!cn) return res.status(404).json({ error: "Credit note not found" });
    if (cn.status === "CANCELLED") return res.status(400).json({ error: "Credit note is already cancelled" });
    if (cn.status !== "ISSUED") {
      return res.status(400).json({ error: "Only ISSUED credit notes can be cancelled. Delete or edit a DRAFT instead." });
    }

    const now = new Date();
    cn.status = "CANCELLED";
    (cn as any).cancelledAt = now;
    (cn as any).cancelledBy = req.user._id;
    (cn as any).cancellationReason = String(reason).trim();
    if (note && String(note).trim()) (cn as any).cancellationNote = String(note).trim();
    const iv = cn as any;
    iv.editedAt = now;
    iv.editedBy = req.user._id;
    if (!iv.editHistory) iv.editHistory = [];
    iv.editHistory.push({
      editedAt: now,
      editedBy: req.user._id,
      fieldsChanged: ["status"],
      oldValues: { status: "ISSUED" },
      newValues: { status: "CANCELLED", cancellationReason: String(reason).trim() },
    });
    await cn.save();

    // Decrement the original invoice's denormalized creditedAmount counter.
    // Raw collection write with $inc — no Invoice schema change (deferred to
    // Phase 5); existing invoices without the field are treated as 0 by $inc.
    await Invoice.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(cn.originalInvoiceId)) },
      { $inc: { creditedAmount: -(cn.grandTotal ?? 0) } },
    );

    triggerTaskAutomation("creditnote.cancelled", {
      workspaceId: String(cn.workspaceId),
      entityType: "CREDIT_NOTE",
      entityId: cn._id,
      entityRef: cn.creditNoteNo,
      ownerId: req.user._id,
      variables: { creditNoteNo: cn.creditNoteNo, reason: String(reason).trim() },
    }).catch(() => {});

    res.json({ ok: true, creditNote: cn.toObject() });
  } catch (err: any) {
    console.error("[CreditNotes cancel]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Edit Draft ───────────────────────────────────────────────────── */

// PATCH /api/admin/credit-notes/:id
router.patch("/:id", requirePermission("creditnotes", "WRITE"), async (req: any, res: any) => {
  try {
    const cn = await CreditNote.findById(req.params.id);
    if (!cn) return res.status(404).json({ error: "Credit note not found" });
    if (cn.status !== "DRAFT") {
      return res.status(400).json({ error: "Cannot edit a non-draft credit note. Cancel + reissue instead." });
    }

    const body = req.body || {};
    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};
    const fieldsChanged: string[] = [];

    // Simple fields
    if (body.reasonNote !== undefined) {
      const trimmed = String(body.reasonNote).slice(0, 500);
      if (trimmed !== (cn.reasonNote ?? "")) {
        oldValues.reasonNote = cn.reasonNote ?? "";
        newValues.reasonNote = trimmed;
        fieldsChanged.push("reasonNote");
        cn.reasonNote = trimmed;
      }
    }
    if (body.notes !== undefined) {
      const trimmed = String(body.notes).slice(0, 1000);
      if (trimmed !== (cn.notes ?? "")) {
        oldValues.notes = cn.notes ?? "";
        newValues.notes = trimmed;
        fieldsChanged.push("notes");
        cn.notes = trimmed;
      }
    }
    if (body.terms !== undefined && body.terms !== cn.terms) {
      oldValues.terms = cn.terms ?? "";
      newValues.terms = body.terms;
      fieldsChanged.push("terms");
      cn.terms = body.terms;
    }

    // Reason change (re-derives GST reason code/text from the master)
    if (body.reasonId !== undefined && String(body.reasonId) !== String(cn.reasonId)) {
      if (!mongoose.Types.ObjectId.isValid(body.reasonId)) {
        return res.status(400).json({ error: "Invalid reasonId" });
      }
      const reason = await CreditNoteReason.findById(body.reasonId).lean();
      if (!reason) return res.status(400).json({ error: "Credit note reason not found" });
      if (!(reason as any).isActive) return res.status(400).json({ error: "Credit note reason is inactive" });
      const gst = deriveGstFromReason(reason, body.gstReasonCodeOverride, body.gstReasonOverrideReason);
      oldValues.reasonId = String(cn.reasonId);
      newValues.reasonId = String(reason._id);
      fieldsChanged.push("reasonId");
      cn.reasonId = reason._id as any;
      cn.reasonText = (reason as any).reason;
      cn.serviceCategory = (reason as any).category;
      cn.gstReasonCode = gst.gstReasonCode as any;
      cn.gstReasonText = gst.gstReasonText;
      cn.gstReasonOverridden = gst.gstReasonOverridden;
      if (gst.gstReasonOverridden) {
        cn.gstReasonOverrideBy = req.user._id;
        cn.gstReasonOverrideReason = gst.gstReasonOverrideReason;
      }
    } else if (body.gstReasonCodeOverride !== undefined) {
      // Override on the existing reason without changing the reason itself
      const reason = await CreditNoteReason.findById(cn.reasonId).lean();
      if (reason) {
        const gst = deriveGstFromReason(reason, body.gstReasonCodeOverride, body.gstReasonOverrideReason);
        if (gst.gstReasonCode !== cn.gstReasonCode) {
          oldValues.gstReasonCode = cn.gstReasonCode;
          newValues.gstReasonCode = gst.gstReasonCode;
          fieldsChanged.push("gstReasonCode");
          cn.gstReasonCode = gst.gstReasonCode as any;
          cn.gstReasonText = gst.gstReasonText;
          cn.gstReasonOverridden = gst.gstReasonOverridden;
          cn.gstReasonOverrideBy = gst.gstReasonOverridden ? req.user._id : undefined;
          cn.gstReasonOverrideReason = gst.gstReasonOverrideReason;
        }
      }
    }

    // GST bypass fields
    if (body.gstBypass !== undefined) {
      const gstBypass = body.gstBypass === true;
      const gstBypassReason = (body.gstBypassReason || "").trim();
      if (gstBypass && !gstBypassReason) {
        return res.status(400).json({ error: "gstBypassReason is required when gstBypass is true" });
      }
      oldValues.gstBypass = cn.gstBypass ?? false;
      newValues.gstBypass = gstBypass;
      fieldsChanged.push("gstBypass");
      cn.gstBypass = gstBypass;
      cn.gstBypassReason = gstBypass ? gstBypassReason : "";
      cn.gstBypassType = gstBypass ? (cn.supplyType as "CGST_SGST" | "CGST_UTGST") : null;
    }

    // Structural: isFullCredit / lineItems change → recompute totals
    const wantsLineEdit = body.lineItems !== undefined || body.isFullCredit !== undefined;
    if (wantsLineEdit) {
      const invoice = await Invoice.findById(cn.originalInvoiceId).lean();
      if (!invoice) return res.status(404).json({ error: "Original invoice not found" });

      const isFullCredit = body.isFullCredit !== undefined ? body.isFullCredit === true : cn.isFullCredit;
      const built = buildCreditedLineItems(invoice, {
        isFullCredit,
        lineItems: body.lineItems ?? cn.lineItems,
      });

      if (built.lines.length === 0 || built.grandTotal <= 0) {
        return res.status(400).json({ error: "Credit note must keep at least one line with a positive credited amount" });
      }
      for (const l of built.lines) {
        if (r2(l.creditedAmount) > r2(l.originalAmount) + 0.01) {
          return res.status(400).json({ error: `Credited amount ₹${r2(l.creditedAmount)} exceeds original line amount ₹${r2(l.originalAmount)} for "${l.description}"` });
        }
      }
      await validateCreditableAmount(String(cn.originalInvoiceId), built.grandTotal);

      const gstAmounts = calculateGSTAmounts(built.totalGST, cn.supplyType as GSTType);

      oldValues.totals = { subtotal: cn.subtotal, totalGST: cn.totalGST, grandTotal: cn.grandTotal };
      newValues.totals = { subtotal: built.subtotal, totalGST: built.totalGST, grandTotal: built.grandTotal };
      fieldsChanged.push("lineItems", "totals");

      cn.isFullCredit = isFullCredit;
      cn.lineItems = built.lines as any;
      cn.markModified("lineItems");
      cn.subtotal = built.subtotal;
      cn.totalGST = built.totalGST;
      cn.grandTotal = built.grandTotal;
      cn.cgstAmount = gstAmounts.cgst;
      cn.sgstAmount = gstAmounts.sgst;
      cn.utgstAmount = gstAmounts.utgst;
      cn.igstAmount = gstAmounts.igst;
    }

    if (!fieldsChanged.length) {
      return res.json({ ok: true, creditNote: cn.toObject() });
    }

    const now = new Date();
    const iv = cn as any;
    iv.editedAt = now;
    iv.editedBy = req.user._id;
    if (!iv.editHistory) iv.editHistory = [];
    iv.editHistory.push({ editedAt: now, editedBy: req.user._id, fieldsChanged, oldValues, newValues });
    await cn.save();

    res.json({ ok: true, creditNote: cn.toObject() });
  } catch (err: any) {
    if (err instanceof HttpError) return res.status(err.httpStatus).json({ error: err.message });
    console.error("[CreditNotes PATCH]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── PDF (admin) ──────────────────────────────────────────────────── */

// GET /api/admin/credit-notes/:id/pdf
router.get("/:id/pdf", requirePermission("creditnotes", "READ"), async (req: any, res: any) => {
  try {
    const cn = await CreditNote.findById(req.params.id).lean();
    if (!cn) return res.status(404).json({ error: "Credit note not found" });

    try {
      const buf = await placeholderRenderPdf(cn);
      const url = await uploadAndPresign(`credit-notes/${cn.creditNoteNo}.pdf`, buf, `${cn.creditNoteNo}.pdf`);
      await CreditNote.collection.updateOne({ _id: cn._id }, { $set: { pdfUrl: url } });
      return res.json({ url, expiresIn: 3600 });
    } catch (e) {
      if (e instanceof PdfPendingError) {
        return res.status(503).json({ error: "PDF_PENDING_PHASE_3", message: e.message });
      }
      throw e;
    }
  } catch (err: any) {
    console.error("[CreditNotes PDF]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Single (with cross-reference) ────────────────────────────────── */

// GET /api/admin/credit-notes/:id
router.get("/:id", requirePermission("creditnotes", "READ"), async (req: any, res: any) => {
  try {
    const cn = await CreditNote.findById(req.params.id).lean();
    if (!cn) return res.status(404).json({ error: "Credit note not found" });

    const [originalInvoiceDoc, siblings] = await Promise.all([
      Invoice.findById(cn.originalInvoiceId).select("invoiceNo invoiceDate grandTotal status").lean(),
      CreditNote.find({ originalInvoiceId: cn.originalInvoiceId, _id: { $ne: cn._id } })
        .select("creditNoteNo status grandTotal reasonText issuedAt createdAt isDemo")
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    const originalInvoice = originalInvoiceDoc
      ? {
          _id: originalInvoiceDoc._id,
          invoiceNo: originalInvoiceDoc.invoiceNo,
          invoiceDate: (originalInvoiceDoc as any).invoiceDate,
          grandTotal: originalInvoiceDoc.grandTotal,
          status: originalInvoiceDoc.status,
        }
      : null;

    res.json({ ok: true, creditNote: cn, originalInvoice, siblingCreditNotes: siblings });
  } catch (err: any) {
    console.error("[CreditNotes GET one]", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
