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

export default router;
