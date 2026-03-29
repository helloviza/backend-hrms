// apps/backend/src/routes/vouchers.ts
import { Router } from "express";
import multer from "multer";
import mongoose from "mongoose";

import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import { scopedFindById } from "../middleware/scopedFindById.js";

import VoucherExtraction from "../models/VoucherExtraction.js";
import type { VoucherType } from "../types/index.js";

import { uploadBufferToS3 } from "../utils/s3Upload.js";
import { presignGetObject } from "../utils/s3Presign.js";
import { env } from "../config/env.js";

import { extractVoucherViaGemini } from "../services/voucherExtractorGemini.js";
import { normalizePlumtripsVoucher } from "../services/voucherNormalize.js";
import { generateTravelPDF } from "../services/pdfService.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
});

/* ───────────────────────── helpers ───────────────────────── */

function getCustomerId(req: any): string {
  return String(
    req.user?.customerId ||
      req.user?.workspaceId ||
      req.user?.workspace?.id ||
      req.headers["x-customer-id"] ||
      "default",
  );
}

function getRequesterId(req: any): string {
  const id = req.user?._id || req.user?.id;
  return String(id || "");
}

function assertVoucherType(v: any): VoucherType {
  if (v === "hotel" || v === "flight") return v;
  throw new Error("voucherType must be 'hotel' or 'flight'");
}

const ALLOWED_STATUS = ["PROCESSING", "SUCCESS", "FAILED"] as const;
type AllowedStatus = (typeof ALLOWED_STATUS)[number];

function isAllowedStatus(v: any): v is AllowedStatus {
  return ALLOWED_STATUS.includes(v);
}

function isRequesterAdmin(req: any): boolean {
  const role = String(req.user?.role || req.user?.userType || "").toUpperCase();
  const roles = Array.isArray(req.user?.roles)
    ? req.user.roles.map((r: any) => String(r).toUpperCase())
    : [];
  return (
    role === "ADMIN" ||
    role === "HR" ||
    role === "HR_ADMIN" ||
    roles.includes("ADMIN") ||
    roles.includes("HR") ||
    roles.includes("HR_ADMIN")
  );
}

function safeStr(x: any): string | null {
  if (x === null || x === undefined) return null;
  const s = String(x).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === "null" || lower === "n/a" || lower === "-") return null;
  return s;
}

function pickKeys(obj: any) {
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj);
}

function truncate(val: any, max = 1200) {
  const s = typeof val === "string" ? val : JSON.stringify(val);
  if (!s) return s;
  return s.length > max ? s.slice(0, max) + "…(truncated)" : s;
}

/**
 * Enterprise validation for render:
 * - blockingMissing => must be present for premium voucher render
 * - warnings => nice-to-have (do NOT block)
 */
function validateForRender(normalized: any, voucherType: VoucherType) {
  const blockingMissing: string[] = [];
  const warnings: string[] = [];

  if (!normalized || typeof normalized !== "object") {
    blockingMissing.push("root_object");
    return { ok: false, blockingMissing, warnings };
  }

  if (!normalized.booking_info) blockingMissing.push("booking_info");
  if (!normalized.policies) blockingMissing.push("policies");
  if (!Array.isArray(normalized?.policies?.important_notes))
    warnings.push("policies.important_notes[]");

  // Premium render wants branding
  if (!safeStr(normalized?.booking_info?.custom_logo))
    blockingMissing.push("booking_info.custom_logo");

  if (normalized.type !== voucherType)
    blockingMissing.push(`type (expected ${voucherType})`);

  if (voucherType === "flight") {
    if (!normalized.flight_details) blockingMissing.push("flight_details");
    if (!Array.isArray(normalized?.flight_details?.segments))
      blockingMissing.push("flight_details.segments[]");

    const segCount = Array.isArray(normalized?.flight_details?.segments)
      ? normalized.flight_details.segments.length
      : 0;
    if (segCount === 0)
      blockingMissing.push("flight_details.segments[] (non-empty)");

    if (!safeStr(normalized?.booking_info?.pnr)) warnings.push("booking_info.pnr");

    if (
      normalized.passengers !== undefined &&
      normalized.passengers !== null &&
      !Array.isArray(normalized.passengers)
    ) {
      blockingMissing.push("passengers[] (must be array)");
    }
  }

  if (voucherType === "hotel") {
    if (!normalized.hotel_details) blockingMissing.push("hotel_details");
    if (!normalized.stay_details) blockingMissing.push("stay_details");
    if (!normalized.room_details) blockingMissing.push("room_details");
    if (!normalized.guest_details) blockingMissing.push("guest_details");

    if (!safeStr(normalized?.hotel_details?.name)) warnings.push("hotel_details.name");
    if (!safeStr(normalized?.stay_details?.check_in_date))
      warnings.push("stay_details.check_in_date");
    if (!safeStr(normalized?.stay_details?.check_out_date))
      warnings.push("stay_details.check_out_date");
  }

  return { ok: blockingMissing.length === 0, blockingMissing, warnings };
}

async function saveErrorDetailsIfSupported(record: any, details: any) {
  try {
    record.errorDetails = details;
  } catch {
    // ignore
  }
}

/**
 * Route-level repair pass (extra safety).
 */
async function repairPassViaGemini(args: {
  buffer: Buffer;
  mimeType: string;
  voucherType: VoucherType;
  customLogoUrl: string | null;
  portalHint: string | null;
  focus: string[];
}) {
  const focusText =
    args.focus && args.focus.length
      ? `REPAIR FOCUS (fill these fields if present in document):\n- ${args.focus.join(
          "\n- ",
        )}`
      : "REPAIR FOCUS: fill missing required blocks.";

  const portalHint = (args.portalHint ? `${args.portalHint} | ` : "") + focusText;

  return extractVoucherViaGemini({
    buffer: args.buffer,
    mimeType: args.mimeType,
    voucherType: args.voucherType,
    customLogoUrl: args.customLogoUrl,
    portalHint,
  });
}

/* ───────────────────────── PDF rendering ───────────────────────── */

/**
 * Generate + upload rendered PDF, persist in schema-backed fields:
 * renderedS3/renderedAt/renderedBy/renderedVersion
 */
async function generateAndStoreRenderedPdf(args: {
  record: any;
  customerId: string;
  actorUserId: string;
  renderedVersion?: string; // template version like "v1"
}) {
  const { record, customerId, actorUserId } = args;
  const renderedVersion = String(args.renderedVersion || record?.renderedVersion || "v1");

  const normalized = record?.extractedJson;
  if (!normalized) throw new Error("Missing extractedJson for render");

  // Generate the PDF using the external service
  const pdfBuffer = await generateTravelPDF(normalized);

  const filename =
    record?.docType === "flight"
      ? `flight_voucher_${String(record._id)}.pdf`
      : `hotel_voucher_${String(record._id)}.pdf`;

  const renderedS3 = await uploadBufferToS3({
    buffer: pdfBuffer,
    mime: "application/pdf",
    originalName: filename,
    customerId,
    createdBy: actorUserId,
  });

  record.renderedS3 = renderedS3;
  record.renderedAt = new Date();
  record.renderedBy = new mongoose.Types.ObjectId(actorUserId);
  record.renderedVersion = renderedVersion;

  await record.save();
  return renderedS3;
}

/* ───────────────────────── Routes ───────────────────────── */

/**
 * POST /api/vouchers/extract
 */
router.post("/extract", requireAuth, upload.single("file"), async (req: any, res) => {
  const correlationId =
    req.headers["x-request-id"] ||
    req.headers["x-correlation-id"] ||
    `vx_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  try {
    const file = req.file;
    if (!file) return res.status(400).json({ message: "file is required", correlationId });

    const voucherType = assertVoucherType(req.body?.voucherType);
    const customLogoUrl = safeStr(req.body?.customLogoUrl) || null;
    const portalHint = safeStr(req.body?.portalHint) || null;

    const customerId = getCustomerId(req);
    const createdBy = getRequesterId(req);
    if (!createdBy) return res.status(401).json({ message: "Unauthenticated", correlationId });

    // 1) Upload original to S3
    const s3 = await uploadBufferToS3({
      buffer: file.buffer,
      mime: file.mimetype,
      originalName: file.originalname,
      customerId,
      createdBy,
    });

    // 2) DB record (processing)
    const record: any = await VoucherExtraction.create({
      customerId,
      createdBy: new mongoose.Types.ObjectId(createdBy),
      s3,
      file: {
        originalName: file.originalname,
        mime: file.mimetype,
        size: file.size,
      },
      docType: voucherType,
      status: "PROCESSING",
    });

    const debug: any = {
      correlationId,
      voucherType,
      file: {
        originalName: file.originalname,
        mime: file.mimetype,
        size: file.size,
      },
      bodyKeys: pickKeys(req.body),
      stages: {},
    };

    try {
      // 3) Extract via model
      debug.stage = "GEMINI_EXTRACT";
      const t0 = Date.now();

      const first = await extractVoucherViaGemini({
        buffer: file.buffer,
        mimeType: file.mimetype,
        voucherType,
        customLogoUrl,
        portalHint,
      });

      debug.stages.gemini = {
        ms: Date.now() - t0,
        parsedTopKeys: pickKeys(first.parsed),
        rawSnippet: truncate(first.raw, 1600),
      };

      // 4) Normalize
      debug.stage = "NORMALIZE";
      const t1 = Date.now();

      let normalized = normalizePlumtripsVoucher(first.parsed, voucherType);

      debug.stages.normalize = {
        ms: Date.now() - t1,
        normalizedTopKeys: pickKeys(normalized),
        normalizedType: normalized?.type,
        segmentCount: normalized?.flight_details?.segments?.length ?? null,
        paxCount: Array.isArray(normalized?.passengers) ? normalized.passengers.length : null,
        hasLogo: !!safeStr(normalized?.booking_info?.custom_logo),
      };

      // 5) Validate
      debug.stage = "VALIDATE";
      let validation = validateForRender(normalized, voucherType);
      debug.stages.validate = validation;

      // 6) Repair pass if blocking missing
      if (!validation.ok) {
        debug.stage = "REPAIR_PASS";
        const t2 = Date.now();

        const repaired = await repairPassViaGemini({
          buffer: file.buffer,
          mimeType: file.mimetype,
          voucherType,
          customLogoUrl,
          portalHint,
          focus: validation.blockingMissing,
        });

        debug.stages.repair = {
          ms: Date.now() - t2,
          parsedTopKeys: pickKeys(repaired.parsed),
          rawSnippet: truncate(repaired.raw, 1400),
        };

        debug.stage = "NORMALIZE_REPAIRED";
        const t3 = Date.now();

        normalized = normalizePlumtripsVoucher(repaired.parsed, voucherType);

        debug.stages.normalize_repaired = {
          ms: Date.now() - t3,
          normalizedTopKeys: pickKeys(normalized),
          normalizedType: normalized?.type,
          segmentCount: normalized?.flight_details?.segments?.length ?? null,
          paxCount: Array.isArray(normalized?.passengers) ? normalized.passengers.length : null,
          hasLogo: !!safeStr(normalized?.booking_info?.custom_logo),
        };

        debug.stage = "VALIDATE_REPAIRED";
        validation = validateForRender(normalized, voucherType);
        debug.stages.validate_repaired = validation;

        if (!validation.ok) {
          const err: any = new Error("Voucher extraction incomplete after repair pass");
          err.status = 422;
          err.details = validation;
          throw err;
        }
      }

      // 7) Save SUCCESS extraction
      debug.stage = "DB_SAVE_SUCCESS";
      record.status = "SUCCESS";
      record.extractedJson = normalized;
      record.rawModelResponse = first.raw;
      record.error = undefined;

      // clear any old rendered info (fresh extraction = new truth)
      record.renderedS3 = undefined;
      record.renderedAt = undefined;
      record.renderedBy = undefined;

      await record.save();

      // ✅ 8) AUTO-RENDER PDF (non-blocking)
      debug.stage = "RENDER_PDF";
      const t4 = Date.now();

      try {
        const renderedS3 = await generateAndStoreRenderedPdf({
          record,
          customerId,
          actorUserId: createdBy,
          renderedVersion: "v1",
        });

        debug.stages.render = {
          ms: Date.now() - t4,
          ok: true,
          renderedKey: renderedS3?.key || null,
        };
      } catch (renderErr: any) {
        const msg = renderErr?.message || "Render failed";

        debug.stages.render = {
          ms: Date.now() - t4,
          ok: false,
          error: msg,
        };

        // Keep extraction SUCCESS; store render failure for troubleshooting
        await saveErrorDetailsIfSupported(record, {
          correlationId,
          stage: "RENDER_PDF_FAILED",
          message: msg,
          debugStages: debug.stages,
        });
        await record.save();
      }

      return res.json({
        id: record._id,
        status: record.status,
        docType: record.docType,
        s3: record.s3,
        renderedS3: record.renderedS3 || null,
        renderedAt: record.renderedAt || null,
        renderedVersion: record.renderedVersion || "v1",
        extractedJson: record.extractedJson,
        createdAt: record.createdAt,
        correlationId,
        warnings: record.renderedS3 ? [] : ["render_failed_or_skipped"],
      });
    } catch (err: any) {
      record.status = "FAILED";
      record.error = err?.message || "Extraction failed";

      const errDetails = {
        correlationId,
        stage: debug.stage || "UNKNOWN",
        message: record.error,
        details: err?.details || null,
        stack: env.NODE_ENV === "production" ? undefined : truncate(err?.stack, 1600),
        debugStages: debug.stages,
      };

      await saveErrorDetailsIfSupported(record, errDetails);
      await record.save();

      return res.status(422).json({
        id: record._id,
        status: record.status,
        docType: record.docType,
        s3: record.s3,
        error: record.error,
        correlationId,
        debug: {
          stage: errDetails.stage,
          blockingMissing: errDetails.details?.blockingMissing || null,
          warnings: errDetails.details?.warnings || null,
          parsedTopKeys: debug?.stages?.gemini?.parsedTopKeys || null,
          normalizedTopKeys:
            debug?.stages?.normalize_repaired?.normalizedTopKeys ||
            debug?.stages?.normalize?.normalizedTopKeys ||
            null,
        },
      });
    }
  } catch (e: any) {
    return res.status(400).json({
      message: e?.message || "Bad request",
      correlationId,
    });
  }
});

/**
 * POST /api/vouchers/:id/render
 * Force regenerate PDF from extractedJson.
 * USER can only render own record; ADMIN can render any.
 */
router.post("/:id/render", requireAuth, async (req: any, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid id" });

  const row: any = await scopedFindById(VoucherExtraction, id, req.workspaceId);
  if (!row) return res.status(404).json({ message: "Not found" });

  const isAdmin = isRequesterAdmin(req);
  const isOwner = String(row.createdBy) === String(req.user?._id || req.user?.id);
  if (!isAdmin && !isOwner) return res.status(403).json({ message: "Forbidden" });

  if (!row.extractedJson) {
    return res.status(422).json({ message: "Cannot render: extractedJson missing" });
  }

  const validation = validateForRender(row.extractedJson, assertVoucherType(row.docType));
  if (!validation.ok) {
    return res.status(422).json({
      message: "Cannot render: missing required fields",
      validation,
    });
  }

  const customerId = String(row.customerId || getCustomerId(req));
  const actorUserId = getRequesterId(req);

  try {
    const renderedS3 = await generateAndStoreRenderedPdf({
      record: row,
      customerId,
      actorUserId,
      renderedVersion: row?.renderedVersion || "v1",
    });

    return res.json({
      id: row._id,
      renderedS3,
      renderedAt: row.renderedAt || null,
      renderedVersion: row.renderedVersion || "v1",
    });
  } catch (e: any) {
    await saveErrorDetailsIfSupported(row, {
      stage: "RENDER_PDF_FAILED_MANUAL",
      message: e?.message || "Render failed",
    });
    await row.save();
    return res.status(500).json({ message: e?.message || "Render failed" });
  }
});

/**
 * GET /api/vouchers/my
 */
router.get("/my", requireAuth, async (req: any, res) => {
  const customerId = getCustomerId(req);
  const createdBy = getRequesterId(req);

  const rows = await VoucherExtraction.find({ customerId, createdBy })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  return res.json(rows);
});

/**
 * GET /api/vouchers (admin)
 */
router.get("/", requireAuth, requireAdmin, async (req: any, res) => {
  const customerId = getCustomerId(req);

  const rows = await VoucherExtraction.find({ customerId })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  return res.json(rows);
});

/**
 * GET /api/vouchers/:id
 * USER can only open own record; ADMIN can open any
 */
router.get("/:id", requireAuth, async (req: any, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid id" });

  const row: any = await VoucherExtraction.findOne({ _id: id, workspaceId: req.workspaceId }).lean();
  if (!row) return res.status(404).json({ message: "Not found" });

  const isAdmin = isRequesterAdmin(req);
  const isOwner = String(row.createdBy) === String(req.user?._id || req.user?.id);
  if (!isAdmin && !isOwner) return res.status(403).json({ message: "Forbidden" });

  return res.json(row);
});

/**
 * GET /api/vouchers/:id/open
 * Signed URL for UPLOADED ORIGINAL voucher file.
 */
router.get("/:id/open", requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid id" });

    const row: any = await VoucherExtraction.findOne({ _id: id, workspaceId: req.workspaceId }).lean();
    if (!row) return res.status(404).json({ message: "Not found" });

    const isAdmin = isRequesterAdmin(req);
    const isOwner = String(row.createdBy) === String(req.user?._id || req.user?.id);
    if (!isAdmin && !isOwner) return res.status(403).json({ message: "Forbidden" });

    const bucket = String(row?.s3?.bucket || env.S3_BUCKET);
    const key = String(row?.s3?.key || "");
    if (!key) return res.status(400).json({ message: "Missing S3 key" });

    const signedUrl = await presignGetObject({
      bucket,
      key,
      filename: row?.file?.originalName || "voucher.pdf",
      expiresInSeconds: env.PRESIGN_TTL,
    });

    return res.json({ url: signedUrl, expiresIn: env.PRESIGN_TTL });
  } catch (e: any) {
    return res.status(400).json({ message: e?.message || "Bad request" });
  }
});

/**
 * ✅ GET /api/vouchers/:id/open-rendered
 * Signed URL for REGENERATED PDF stored in record.renderedS3
 */
router.get("/:id/open-rendered", requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid id" });

    const row: any = await VoucherExtraction.findOne({ _id: id, workspaceId: req.workspaceId }).lean();
    if (!row) return res.status(404).json({ message: "Not found" });

    const isAdmin = isRequesterAdmin(req);
    const isOwner = String(row.createdBy) === String(req.user?._id || req.user?.id);
    if (!isAdmin && !isOwner) return res.status(403).json({ message: "Forbidden" });

    const bucket = String(row?.renderedS3?.bucket || "");
    const key = String(row?.renderedS3?.key || "");

    if (!bucket || !key) {
      return res.status(404).json({
        message: "Rendered PDF not available yet. Call POST /api/vouchers/:id/render",
      });
    }

    const filename =
      row?.docType === "flight"
        ? `flight_voucher_${String(row._id)}.pdf`
        : `hotel_voucher_${String(row._id)}.pdf`;

    const signedUrl = await presignGetObject({
      bucket,
      key,
      filename,
      expiresInSeconds: env.PRESIGN_TTL,
    });

    return res.json({ url: signedUrl, expiresIn: env.PRESIGN_TTL });
  } catch (e: any) {
    return res.status(400).json({ message: e?.message || "Bad request" });
  }
});

/**
 * PATCH /api/vouchers/:id (admin correction optional)
 * body: { extractedJson?, docType?, status?, error? }
 */
router.patch("/:id", requireAuth, requireAdmin, async (req: any, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid id" });

  const row: any = await scopedFindById(VoucherExtraction, id, req.workspaceId);
  if (!row) return res.status(404).json({ message: "Not found" });

  const { extractedJson, docType, status, error } = req.body || {};

  if (docType) row.docType = assertVoucherType(docType);

  if (isAllowedStatus(status)) row.status = status;
  if (typeof error === "string") row.error = error;
  if (error === null) row.error = undefined;

  if (extractedJson) {
    row.extractedJson = extractedJson;
    row.correctedBy = new mongoose.Types.ObjectId(req.user?._id || req.user?.id);
    row.correctedAt = new Date();

    // ✅ Invalidate rendered PDF when corrected (forces re-render)
    row.renderedS3 = undefined;
    row.renderedAt = undefined;
    row.renderedBy = undefined;
  }

  await row.save();
  return res.json(row);
});

export default router;