// apps/backend/src/routes/expenses.ts
//
// Expense Management — Sprint 3a. Read API + export over the confirmed Expense
// records created by the WhatsApp capture flow (Sprint 1/2).
//
// Mounted at /api/expenses behind requireAuth + requireWorkspace (see server.ts).
//
// Scoping rules (NON-NEGOTIABLE):
//   • Every query AND the export sets `workspaceId` explicitly — the
//     workspaceScope plugin is NOT ambient (it only injects when a query carries
//     `_workspaceId` in its options), so a missing workspaceId would leak across
//     tenants. buildExpenseFilter() is the single place this is guaranteed.
//   • Finance/Admin (requireAdmin role set) see ALL workspace expenses and MAY
//     narrow by ?employeeId. Everyone else is FORCED to their own employeeId and
//     any ?employeeId param is ignored.
//
// Mirrors the invoices (list) and sbt.bookingRegister (export) patterns.

import express from "express";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import multer from "multer";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import { presignGetObject } from "../utils/s3Presign.js";
import { csvRow } from "../utils/exportHelpers.js";
import { parseISTStart, parseISTEnd } from "../utils/dateIST.js";
import { uploadExpenseReceiptToS3 } from "../utils/s3Upload.js";
import { extractReceipt } from "../services/receiptExtractorGemini.js";
import { createExpense } from "../services/expenses.service.js";
import { env } from "../config/env.js";
import Expense from "../models/Expense.js";

const router = express.Router();

/* ── Receipt upload (multipart) — memory storage, 10MB, image + PDF ──── */
const RECEIPT_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
]);

const uploadReceipt = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (RECEIPT_MIMES.has(file.mimetype)) return cb(null, true);
    cb(new Error("Unsupported file type. Allowed: JPEG, PNG, WEBP, HEIC, PDF."));
  },
});

// Wrap multer so file errors return clean JSON (mirrors workspace.branding).
function receiptUploadMw(req: any, res: any, next: any) {
  uploadReceipt.single("file")(req, res, (err: any) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "File too large. Maximum size is 10MB." });
    }
    return res.status(400).json({ error: err?.message || "Upload failed" });
  });
}

/* ── Role gate: who sees all workspace expenses ──────────────────────
 * Mirrors the requireAdmin role set in middleware/rbac.ts, but as a boolean
 * predicate (the middleware itself only short-circuits with 403). */
function norm(v: any) {
  return String(v ?? "").trim().toUpperCase().replace(/[\s\-_]/g, "");
}
const FINANCE_ADMIN_ROLES = [
  "ADMIN",
  "SUPERADMIN",
  "SUPER_ADMIN",
  "HR",
  "HR_ADMIN",
  "OPS",
  "OPS_ADMIN",
  "TENANT_ADMIN",
  "WORKSPACE_ADMIN",
].map(norm);

function seesAllExpenses(req: any): boolean {
  if (isSuperAdmin(req)) return true;
  const user = req.user || {};
  const signals: any[] = [];
  if (Array.isArray(user.roles)) signals.push(...user.roles);
  if (user.role) signals.push(user.role);
  if (user.userType) signals.push(user.userType);
  if (user.accountType) signals.push(user.accountType);
  if (user.hrmsAccessRole) signals.push(user.hrmsAccessRole);
  if (user.hrmsAccessLevel) signals.push(user.hrmsAccessLevel);
  return signals.map(norm).some((r) => FINANCE_ADMIN_ROLES.includes(r));
}

function ownEmployeeId(req: any): string {
  return String(req.user?.id || req.user?._id || req.user?.sub || "");
}

/* ── Shared filter builder — the single guarantee of tenant + own scoping ── */
function buildExpenseFilter(req: any): Record<string, any> {
  const filter: Record<string, any> = {
    workspaceId: req.workspaceObjectId, // NON-NEGOTIABLE explicit tenant scope
  };

  const seesAll = seesAllExpenses(req);
  if (!seesAll) {
    // Employees are forced to their own records; ?employeeId is ignored.
    filter.employeeId = ownEmployeeId(req);
  } else if (req.query.employeeId) {
    // Finance/Admin may narrow to one employee.
    try {
      filter.employeeId = new mongoose.Types.ObjectId(String(req.query.employeeId));
    } catch {
      filter._id = { $in: [] }; // invalid id → empty result, never a leak
    }
  }

  if (req.query.status) filter.status = String(req.query.status);

  if (req.query.category) {
    filter.suggestedCategory = { $regex: String(req.query.category), $options: "i" };
  }

  if (req.query.dateFrom || req.query.dateTo) {
    // YYYY-MM-DD interpreted as an IST calendar day; parseISTEnd is inclusive.
    filter.date = {};
    if (req.query.dateFrom) filter.date.$gte = parseISTStart(String(req.query.dateFrom));
    if (req.query.dateTo) filter.date.$lte = parseISTEnd(String(req.query.dateTo));
  }

  if (req.query.search) {
    const re = new RegExp(String(req.query.search), "i");
    filter.$or = [{ merchant: re }, { ref: re }];
  }

  return filter;
}

function employeeNameOf(emp: any): string {
  if (!emp || typeof emp !== "object") return "";
  const full = [emp.firstName, emp.lastName].filter(Boolean).join(" ").trim();
  return full || emp.name || emp.email || "";
}

/* ── Export columns (single source of truth for CSV + XLSX) ─────────── */
type Col = { key: string; label: string; money?: boolean };
const EXPORT_COLUMNS: Col[] = [
  { key: "date", label: "Date" },
  { key: "employee", label: "Employee" },
  { key: "merchant", label: "Merchant" },
  { key: "category", label: "Category" },
  { key: "amount", label: "Amount", money: true },
  { key: "tax", label: "Tax", money: true },
  { key: "currency", label: "Currency" },
  { key: "gstin", label: "GSTIN" },
  { key: "status", label: "Status" },
  { key: "ref", label: "Ref" },
  { key: "created", label: "Created" },
  { key: "receipt", label: "Receipt" },
];

function fmtDate(d: any): string {
  return d ? new Date(d).toLocaleDateString("en-IN") : "";
}

function expenseToExportRow(d: any): Record<string, any> {
  return {
    date: fmtDate(d.date),
    employee: employeeNameOf(d.employeeId),
    merchant: d.merchant || "",
    category: d.suggestedCategory || "",
    amount: d.amount ?? 0,
    tax: d.taxAmount ?? 0,
    currency: d.currency || "",
    gstin: d.gstin || "",
    status: d.status || "",
    ref: d.ref || "",
    created: fmtDate(d.createdAt),
    receipt: d.imageKey ? "Yes" : "No",
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expenses
 * Filters: dateFrom, dateTo (on `date`), employeeId (admin only), status,
 *   category (→ suggestedCategory), search (merchant + ref). page, limit.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/", async (req: any, res: any) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 25);
    const filter = buildExpenseFilter(req);

    const [docs, total] = await Promise.all([
      Expense.find(filter)
        .select("-rawExtraction -perFieldConfidence")
        .populate("employeeId", "firstName lastName email name")
        .sort({ date: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Expense.countDocuments(filter),
    ]);

    const enriched = docs.map((d: any) => {
      const emp = d.employeeId;
      return {
        ...d,
        employeeId: emp && typeof emp === "object" ? emp._id : emp,
        employeeName: employeeNameOf(emp),
        hasReceipt: !!d.imageKey,
      };
    });

    res.json({ ok: true, docs: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (err: any) {
    console.error("[Expenses GET list]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to list expenses" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expenses/export?format=csv|xlsx
 * Same filter + scoping as the list; NO pagination (full filtered set).
 * Receipt is a has-receipt flag, never a presigned URL.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/export", async (req: any, res: any) => {
  try {
    const format = req.query.format === "xlsx" ? "xlsx" : "csv";
    const filter = buildExpenseFilter(req);

    const docs = await Expense.find(filter)
      .select("-rawExtraction -perFieldConfidence")
      .populate("employeeId", "firstName lastName email name")
      .sort({ date: -1, createdAt: -1 })
      .lean();

    const rows = docs.map(expenseToExportRow);
    const header = EXPORT_COLUMNS.map((c) => c.label);

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="expenses-export.csv"');
      res.write(csvRow(header));
      rows.forEach((r) => res.write(csvRow(EXPORT_COLUMNS.map((c) => r[c.key]))));
      return res.end();
    }

    // XLSX — mirror the booking-register ExcelJS pattern.
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Expenses");
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    const headerRow = sheet.addRow(header);
    headerRow.font = { bold: true };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF0" } };
    EXPORT_COLUMNS.forEach((c, i) => {
      if (c.money) sheet.getColumn(i + 1).numFmt = "#,##0.00";
    });
    rows.forEach((r) => sheet.addRow(EXPORT_COLUMNS.map((c) => r[c.key])));

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", 'attachment; filename="expenses-export.xlsx"');
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err: any) {
    console.error("[Expenses export]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to export expenses" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expenses/:id/receipt-url
 * Fresh presigned GET URL for one expense's receipt. Same workspace + own/admin
 * gate as the list — an employee can only presign their own receipt.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/:id/receipt-url", async (req: any, res: any) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: "Expense not found" });
    }

    const filter: Record<string, any> = {
      _id: new mongoose.Types.ObjectId(id),
      workspaceId: req.workspaceObjectId, // NON-NEGOTIABLE explicit tenant scope
    };
    if (!seesAllExpenses(req)) {
      filter.employeeId = ownEmployeeId(req);
    }

    const expense: any = await Expense.findOne(filter)
      .select("imageKey s3Bucket ref")
      .lean();
    if (!expense) return res.status(404).json({ error: "Expense not found" });
    if (!expense.imageKey) return res.status(404).json({ error: "No receipt on file" });

    const url = await presignGetObject({
      bucket: expense.s3Bucket || env.S3_BUCKET,
      key: expense.imageKey,
      filename: `receipt-${expense.ref}.jpg`,
    });

    res.json({ ok: true, url });
  } catch (err: any) {
    console.error("[Expenses receipt-url]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to presign receipt" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expenses/upload  (multipart, field "file")
 * Store the bill to S3, run extractReceipt synchronously, return a DRAFT for
 * review. Does NOT persist an Expense. Mirrors the /vouchers/extract flow.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/upload", receiptUploadMw, async (req: any, res: any) => {
  try {
    const file = req.file as Express.Multer.File | undefined;
    if (!file?.buffer?.length) {
      return res.status(400).json({ error: "file is required" });
    }

    const workspaceId = String(req.workspaceId || "");
    const employeeId = ownEmployeeId(req);
    if (!workspaceId || !employeeId) {
      return res.status(400).json({ error: "Missing workspace or user context" });
    }

    // Store first so the receipt is retained even if extraction is unusable.
    const { bucket, key } = await uploadExpenseReceiptToS3({
      buffer: file.buffer,
      mime: file.mimetype,
      workspaceId,
      employeeId,
      sourceChannel: "web",
    });

    // Extraction is best-effort: on failure (e.g. no amount found) we still
    // return the stored imageKey so the user can fill the draft manually.
    let draft: Record<string, any> = {
      merchant: null,
      date: null,
      amount: null,
      currency: "INR",
      taxAmount: null,
      gstin: null,
      suggestedCategory: null,
    };
    let perFieldConfidence: any = {};
    let extractionModel: string | undefined;
    let rawExtraction: any = undefined;
    let extractionError: string | undefined;

    try {
      const result = await extractReceipt({ buffer: file.buffer, mime: file.mimetype });
      const { perFieldConfidence: pfc, ...fields } = result.fields;
      draft = fields;
      perFieldConfidence = pfc;
      extractionModel = result.raw.model;
      rawExtraction = result.raw.raw_candidate;
    } catch (exErr: any) {
      extractionError = exErr?.message || "Extraction failed";
      console.warn("[Expenses upload] extraction failed", extractionError);
    }

    res.json({
      ok: true,
      draft,
      perFieldConfidence,
      extractionModel,
      rawExtraction,
      imageKey: key,
      s3Bucket: bucket,
      ...(extractionError ? { extractionError } : {}),
    });
  } catch (err: any) {
    console.error("[Expenses upload]", err?.message);
    res.status(500).json({ error: err?.message || "Upload failed" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expenses  (JSON)
 * Persist a reviewed draft via the shared createExpense(). sourceChannel "web",
 * employeeId forced to the caller. Idempotent on (workspaceId, imageKey).
 * ───────────────────────────────────────────────────────────────────── */
router.post("/", async (req: any, res: any) => {
  try {
    const workspaceObjectId = req.workspaceObjectId;
    const workspaceId = String(req.workspaceId || "");
    const employeeId = ownEmployeeId(req);
    if (!workspaceObjectId || !employeeId) {
      return res.status(400).json({ error: "Missing workspace or user context" });
    }

    const b = req.body || {};
    if (b.amount == null || Number.isNaN(Number(b.amount))) {
      return res.status(400).json({ error: "amount is required" });
    }

    const imageKey = b.imageKey ? String(b.imageKey) : undefined;
    if (imageKey) {
      // Defensive: the key must belong to THIS user in THIS workspace.
      const expectedPrefix = `hrms/expenses/${workspaceId}/${employeeId}/`;
      if (!imageKey.startsWith(expectedPrefix)) {
        return res.status(403).json({ error: "imageKey does not belong to this user/workspace" });
      }
      // Idempotency: a re-submitted draft (same upload) returns the existing
      // expense instead of inserting a duplicate. Explicit workspaceId scope.
      const existing = await Expense.findOne({ workspaceId: workspaceObjectId, imageKey }).lean();
      if (existing) return res.json({ ok: true, expense: existing, deduped: true });
    }

    const expense = await createExpense({
      workspaceId: workspaceObjectId,
      employeeId,
      sourceChannel: "web",
      merchant: b.merchant ?? null,
      date: b.date ?? null,
      amount: Number(b.amount),
      currency: b.currency,
      taxAmount: b.taxAmount ?? null,
      gstin: b.gstin ?? null,
      suggestedCategory: b.suggestedCategory ?? null,
      imageKey,
      s3Bucket: b.s3Bucket,
      rawExtraction: b.rawExtraction,
      perFieldConfidence: b.perFieldConfidence,
      extractionModel: b.extractionModel,
    });

    res.status(201).json({ ok: true, expense });
  } catch (err: any) {
    console.error("[Expenses create]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to create expense" });
  }
});

export default router;
