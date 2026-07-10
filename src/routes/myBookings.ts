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

function resolveScopeFilter(req: Request): { filter: Record<string, any>; scope: "ORG" | "OWN" } {
  const user: any = (req as any).user;
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

  // tenantId on TravelBooking is the customer id string; the workspace was
  // resolved via the same customerId, so prefer it as a stable fallback.
  const tenantId: string | null =
    user?.customerId || user?.businessId || (req as any).workspace?.customerId || null;

  if ((isLeader || isApprover || isStaffAdmin) && tenantId) {
    return { filter: { tenantId: String(tenantId) }, scope: "ORG" };
  }

  // OWN — userId on TravelBooking is an ObjectId; cast the JWT string id.
  const uid = user?._id || user?.id || user?.sub;
  const userId =
    uid && mongoose.isValidObjectId(uid) ? new mongoose.Types.ObjectId(String(uid)) : uid;
  return { filter: { userId }, scope: "OWN" };
}

/* ── ORG-scope detection, reused by the attachment routes below ───────
 * Same leader/approver/staff-admin signals as resolveScopeFilter above,
 * factored out because the attachment access check (bookingCustomerAccess.ts)
 * needs a plain boolean rather than a query filter. */
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

    const url = await presignGetObject({
      bucket: env.S3_BUCKET,
      key: attachment.s3Key,
      filename: attachment.originalFilename,
      expiresInSeconds: env.PRESIGN_TTL,
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

export default router;
