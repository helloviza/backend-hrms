// apps/backend/src/routes/vouchers.ts
import { Router } from "express";
import multer from "multer";
import mongoose from "mongoose";

import { requireAuth } from "../middleware/auth.js";
import {
  requireWorkspace,
  requireResolvedWorkspace,
} from "../middleware/requireWorkspace.js";
import { requireFeature } from "../middleware/requireFeature.js";
import {
  requirePermission,
  requireAnyPermission,
} from "../middleware/requirePermission.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";

import VoucherExtraction from "../models/VoucherExtraction.js";
import type { VoucherType } from "../types/index.js";

import { uploadBufferToS3, deleteObject } from "../utils/s3Upload.js";
import { presignGetObject } from "../utils/s3Presign.js";
import { env } from "../config/env.js";

import { extractVoucherViaGemini } from "../services/voucherExtractorGemini.js";
import { normalizePlumtripsVoucher } from "../services/voucherNormalize.js";
import { generateTravelPDF } from "../services/pdfService.js";
import { adaptFlight, adaptHotel } from "../services/voucherAdapter.js";
import {
  VOUCHER_RENDER_VIA_LAMBDA,
  invokeRendererLambda,
} from "../services/voucherLambdaRenderer.js";
import { generateTicketHTML } from "@plumtrips/shared/voucher-templates/ticketGenerator";
import { generateHotelVoucherHTML } from "@plumtrips/shared/voucher-templates/hotelVoucherGenerator";
import logger from "../utils/logger.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
});

/* ───────────────────────── access model ─────────────────────────
 *
 * ONE definition of access, applied to every route in this router. It replaces
 * three checks that used to disagree with each other: a route-level role
 * allowlist (requireAdmin), a record-level role sniff (isRequesterAdmin), and
 * an owner-vs-admin branch inside each handler.
 *
 * A caller may act on a voucher record when BOTH hold:
 *   1. they hold the voucher grant (adminVouchers; upload also accepts
 *      voucherExtract), and
 *   2. record.workspaceId === the caller's resolved workspace.
 *
 * There is deliberately NO owner-only path. These extractions are a shared ops
 * queue: whoever holds the grant in a workspace works the whole queue, and
 * "created it" confers nothing extra. Permission *scope* (OWN/TEAM/WORKSPACE)
 * is intentionally not consulted for record access — workspace equality is the
 * whole boundary.
 *
 * ── The one exception: a real SUPERADMIN ──
 *
 * A platform SUPERADMIN (the JWT role isSuperAdmin() already trusts everywhere
 * else) bypasses all three of the feature flag, the grant, and the workspace
 * scope, and works voucher records across every workspace — including records
 * stranded in deactivated tenants.
 *
 * That bypass is written as an explicit branch, never as an absent filter.
 * `voucherScope()` returns `{}` for a SUPERADMIN because the query is genuinely
 * meant to be unscoped, and `{ workspaceId }` for everyone else. It is NEVER
 * reached by letting an undefined workspaceId fall through to Mongoose, which
 * would strip the condition and produce the same unscoped query by accident.
 * That distinction is the whole of F-01: for a non-SUPERADMIN, tenantScope()
 * still throws rather than widen.
 */
router.use(
  requireAuth,
  requireWorkspace,
  // Fail closed for everyone except a real SUPERADMIN, who is allowed to
  // operate with no workspace context at all (see voucherScope below).
  // requireResolvedWorkspace itself stays strict for every other caller and
  // every other router — the exemption is declared here, not buried in it.
  (req, res, next) =>
    isSuperAdmin(req) ? next() : requireResolvedWorkspace(req, res, next),
  requireFeature("vouchersEnabled"), // already a no-op for SUPERADMIN
);

/** Read the tenancy boundary. Throws rather than ever returning undefined. */
function tenantScope(req: any): mongoose.Types.ObjectId {
  const ws = req.workspaceObjectId;
  if (!ws) {
    // Reachable only for a SUPERADMIN (the sole caller allowed past the guard
    // above without a workspace) — and every such path goes through
    // voucherScope() instead. Throwing keeps a future miswiring loud.
    throw Object.assign(new Error("Workspace context missing"), { status: 403 });
  }
  return ws;
}

/**
 * The tenancy clause for every voucher query.
 *
 * `{}` for a real SUPERADMIN is a deliberate, readable "no workspace
 * restriction" — not the absence of a filter. Everyone else is pinned to their
 * own workspace by tenantScope(), which throws rather than return undefined.
 */
function voucherScope(req: any): Record<string, unknown> {
  if (isSuperAdmin(req)) return {};
  return { workspaceId: tenantScope(req) };
}

/**
 * Fetch one record under the caller's scope: workspace-pinned normally,
 * unrestricted for a SUPERADMIN. Replaces scopedFindById, which cannot express
 * "deliberately unscoped" — passing it an undefined workspaceId would silently
 * degrade to a bare findById, the exact failure F-01 closed.
 */
function findVoucherInScope(req: any, id: string) {
  return VoucherExtraction.findOne({ _id: id, ...voucherScope(req) });
}

/** Grant to view the queue and open documents. */
const canReadVouchers = requirePermission("adminVouchers", "READ");
/** Grant to correct JSON or re-render — ops actions, not upload. */
const canWriteVouchers = requirePermission("adminVouchers", "WRITE");
/**
 * Upload. `adminVouchers` is the single source of truth (see the Access Console),
 * but a legacy `voucherExtract` grant is still honoured for upload alone so
 * existing holders are not cut off. It confers no page, list or edit access.
 */
const canUploadVouchers = requireAnyPermission(
  ["adminVouchers", "voucherExtract"],
  "WRITE",
);

/* ───────────────────────── helpers ───────────────────────── */

/**
 * Legacy customerId mirror — used ONLY for the S3 storage path prefix and the
 * legacy `customerId` mirror field on the record. This is NOT a security
 * boundary anymore: tenancy is enforced via workspaceId (req.workspaceObjectId,
 * set by requireWorkspace). The previously-trusted client `x-customer-id`
 * header has been removed so a caller can no longer influence scoping.
 */
function getCustomerId(req: any): string {
  return String(
    req.workspace?.customerId ||
      req.user?.customerId ||
      req.user?.workspaceId ||
      req.user?.workspace?.id ||
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
 * Render the voucher via the SHARED SBT template (adapter → HTML) and the
 * deployed html→pdf Lambda. Used only when VOUCHER_RENDER_VIA_LAMBDA is on.
 * Throws on any adapter/template/Lambda failure so the caller can fall back.
 */
async function renderViaSbtLambda(record: any): Promise<Buffer> {
  // Demo Platform — merge VoucherExtraction.isDemo (DB column, set at extraction time
  // from req.user.isDemoUser) into the adapter input so the template renders the
  // SAMPLE watermark + disclaimer. NOT persisted back into extractedJson.
  const v = { ...(record?.extractedJson ?? {}), isDemo: !!record?.isDemo };
  if (record?.docType === "flight") {
    const { booking, returnBooking } = adaptFlight(v);
    // showPrintButton=false; logoUrl=undefined → template's parameterized default.
    const html = await generateTicketHTML(booking, [], returnBooking, undefined, false);
    return invokeRendererLambda(html);
  }
  const params = adaptHotel(v);
  const html = await generateHotelVoucherHTML(params);
  return invokeRendererLambda(html);
}

/**
 * Generate + upload rendered PDF, persist in schema-backed fields:
 * renderedS3/renderedAt/renderedBy/renderedTemplateVersion/renderedRevision
 *
 * Render path (both call sites go through here):
 *   - VOUCHER_RENDER_VIA_LAMBDA on  → SBT template + Lambda, tagged "v2-sbt";
 *     on ANY failure, fall back to pdfkit (tagged "v1-pdfkit") and log. Render
 *     must NEVER hard-fail the caller's flow beyond what pdfkit already did.
 *   - flag off → pdfkit exactly as before, tagged "v1-pdfkit".
 */
async function generateAndStoreRenderedPdf(args: {
  record: any;
  customerId: string;
  actorUserId: string;
  renderedTemplateVersion?: string; // legacy arg; the actual path now sets the tag
}) {
  const { record, customerId, actorUserId } = args;

  const normalized = record?.extractedJson;
  if (!normalized) throw new Error("Missing extractedJson for render");

  // Generate the PDF — choose path and tag it so we can tell SBT from fallback.
  let pdfBuffer: Buffer;
  let renderedTemplateVersion: string;

  // Demo Platform — demo bookings MUST go through the SBT shared template path
  // (the only one with watermark + disclaimer code). No fallback to pdfkit for
  // demo bookings — better to fail loudly than ship a watermark-less sample PDF
  // that could be mistaken for a real reservation.
  const isDemo = !!record?.isDemo;

  if (VOUCHER_RENDER_VIA_LAMBDA || isDemo) {
    try {
      pdfBuffer = await renderViaSbtLambda(record);
      renderedTemplateVersion = "v2-sbt";
    } catch (err: any) {
      if (isDemo) {
        logger.error("[voucher-render] SBT+Lambda failed for DEMO booking — refusing to fall back to pdfkit", {
          recordId: String(record?._id),
          docType: record?.docType,
          message: err?.message,
        });
        throw err;
      }
      logger.warn("[voucher-render] SBT+Lambda path failed; falling back to pdfkit", {
        recordId: String(record?._id),
        docType: record?.docType,
        message: err?.message,
      });
      pdfBuffer = await generateTravelPDF(normalized);
      renderedTemplateVersion = "v1-pdfkit";
    }
  } else {
    pdfBuffer = await generateTravelPDF(normalized);
    renderedTemplateVersion = "v1-pdfkit";
  }

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
  record.renderedTemplateVersion = renderedTemplateVersion;
  record.renderedRevision = (record.renderedRevision || 0) + 1;

  await record.save();
  return renderedS3;
}

/* ───────────────────────── Routes ───────────────────────── */

/**
 * POST /api/vouchers/extract
 */
// Creating a record REQUIRES a workspace even for a SUPERADMIN — workspaceId is
// required by the schema, and a voucher has to belong to some tenant. A
// SUPERADMIN uploading must therefore name the workspace (body/query/param or
// the x-workspace-id header, per requireWorkspace); the read paths below are
// the ones that go unscoped.
router.post("/extract", requireResolvedWorkspace, canUploadVouchers, upload.single("file"), async (req: any, res) => {
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

    // The record cannot be created before the upload — VoucherExtraction.s3 is
    // `required: true`, so there is nothing valid to persist until the object
    // exists. That leaves a window between upload and create, and anything that
    // fails inside it (schema validation, a lost Mongo connection) would strand
    // a customer document in the bucket that no record references and no
    // retention path can find. So the window is explicitly closed: on any
    // failure the just-uploaded object is deleted before the error propagates.

    // 1) Upload original to S3
    const s3 = await uploadBufferToS3({
      buffer: file.buffer,
      mime: file.mimetype,
      originalName: file.originalname,
      customerId,
      createdBy,
    });

    // 2) DB record (processing)
    let record: any;
    try {
      record = await VoucherExtraction.create({
        workspaceId: tenantScope(req), // ← tenancy boundary (schema requires it)
        customerId, // legacy mirror only (not the security boundary)
        createdBy: new mongoose.Types.ObjectId(createdBy),
        s3,
        file: {
          originalName: file.originalname,
          mime: file.mimetype,
          size: file.size,
        },
        docType: voucherType,
        status: "PROCESSING",
        // Demo Platform — snapshot caller's demo flag so future renders watermark correctly.
        isDemo: req.user?.isDemoUser === true,
      });
    } catch (createErr: any) {
      try {
        await deleteObject(s3.key);
        logger.warn("[vouchers] record create failed; uploaded object removed", {
          correlationId,
          key: s3.key,
          message: createErr?.message,
        });
      } catch (cleanupErr: any) {
        // Deletion is best-effort: report the orphan loudly rather than swallow
        // the original failure, so it can be reclaimed out of band.
        logger.error("[vouchers] ORPHANED S3 OBJECT — create failed and cleanup failed", {
          correlationId,
          bucket: s3.bucket,
          key: s3.key,
          createError: createErr?.message,
          cleanupError: cleanupErr?.message,
        });
      }
      throw createErr;
    }

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
          renderedTemplateVersion: "v1",
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
        renderedTemplateVersion: record.renderedTemplateVersion || "v1",
        renderedRevision: record.renderedRevision || 0,
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
 * Force regenerate PDF from extractedJson. Shared queue — the grant plus the
 * workspace match is the whole check; authorship confers nothing.
 */
router.post("/:id/render", canWriteVouchers, async (req: any, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid id" });

  const row: any = await findVoucherInScope(req, id);
  if (!row) return res.status(404).json({ message: "Not found" });

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
      renderedTemplateVersion: row?.renderedTemplateVersion || "v1",
    });

    return res.json({
      id: row._id,
      renderedS3,
      renderedAt: row.renderedAt || null,
      renderedTemplateVersion: row.renderedTemplateVersion || "v1",
      renderedRevision: row.renderedRevision || 0,
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
 * GET /api/vouchers — the workspace queue.
 *
 * This replaces the old pair of listings: GET /my (own records) and GET /
 * (admin, everything in the workspace). They returned different slices of the
 * same collection under different guards, which is what made "who can see
 * what" ambiguous. There is now one list, scoped to the caller's workspace,
 * behind one grant.
 *
 * Explicit workspaceId filter: this route doesn't set the _workspaceId query
 * option, so the workspaceScope plugin won't auto-inject — workspaceId is the
 * tenancy boundary and must be in the filter directly.
 */
router.get("/", canReadVouchers, async (req: any, res) => {
  const rows = await VoucherExtraction.find({ ...voucherScope(req) })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  return res.json(rows);
});

/**
 * GET /api/vouchers/:id
 */
router.get("/:id", canReadVouchers, async (req: any, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid id" });

  const row: any = await findVoucherInScope(req, id).lean();
  if (!row) return res.status(404).json({ message: "Not found" });

  return res.json(row);
});

/**
 * GET /api/vouchers/:id/open
 * Signed URL for UPLOADED ORIGINAL voucher file.
 */
router.get("/:id/open", canReadVouchers, async (req: any, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid id" });

    const row: any = await findVoucherInScope(req, id).lean();
    if (!row) return res.status(404).json({ message: "Not found" });

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
router.get("/:id/open-rendered", canReadVouchers, async (req: any, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid id" });

    const row: any = await findVoucherInScope(req, id).lean();
    if (!row) return res.status(404).json({ message: "Not found" });

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
 * PATCH /api/vouchers/:id — correct a record.
 * body: { extractedJson?, docType?, status?, error? }
 */
router.patch("/:id", canWriteVouchers, async (req: any, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid id" });

  const row: any = await findVoucherInScope(req, id);
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