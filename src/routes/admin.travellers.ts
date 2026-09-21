// apps/backend/src/routes/admin.travellers.ts
//
// HOUSE-staff READ access to a CLIENT's saved travellers — the shared
// foundation for the Ops traveller viewer and the manual-booking passenger
// typeahead. See the 2026-09-21 audit ("HOUSE/Ops access to a client's
// travellers") for every decision below.
//
// WHY A NEW ROUTER AND NOT /api/workspace/travellers: that router scopes to
// the CALLER's own workspace (requireWorkspace → req.workspaceObjectId, then
// requireActiveMember demands a CustomerMember row), so a HOUSE staffer who is
// not a member of client X gets 403 — correctly. Only a SUPERADMIN could point
// it elsewhere, and only by supplying a raw CustomerWorkspace._id verbatim.
// This router instead takes the CUSTOMER (what the booking form's Client
// picker actually holds) and resolves the workspace itself.
//
// THE ID-SPACE HOP (the audit's point 4): the Client picker yields a
// Customer._id; TravellerProfile.workspaceId is a CustomerWorkspace._id.
// customerworkspaces.customerId is stored as a STRING, so the hop is
// CustomerWorkspace.findOne({ customerId: String(customerId) }) — an ObjectId
// match would miss every row. A client-supplied workspaceId is NEVER read.
//
// THE SECURITY LINE: workspaceScopePlugin injects workspaceId only when a
// query passes `_workspaceId` in its options — a bare
// TravellerProfile.find({ isActive: true }) is CROSS-TENANT. Every query here
// therefore carries an explicit `workspaceId: ws._id`, and the detail read
// re-checks it rather than trusting the traveller id alone.
//
// READ-ONLY by design. Creation/edit/auto-capture stay the customer's own
// POST /api/workspace/travellers, which 403s staff — correctly.
//
// Two-step disclosure, mirroring pages/sbt/SBTPassengers.tsx: the LIST is
// masked (passportMasked = last-4, no PAN/Aadhaar) and capped; the full
// record only crosses the wire on the DETAIL read for a traveller the
// operator actually picked.
import { Router } from "express";
import mongoose from "mongoose";
import { requirePermission } from "../middleware/requirePermission.js";
import { audit } from "../middleware/audit.js";
import TravellerProfile from "../models/TravellerProfile.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { maskTailId } from "../utils/piiMask.js";
import logger from "../utils/logger.js";

const router = Router();

/** Mirrors SBTPassengers' per-row typeahead (8 rows). The customer list caps at 100. */
export const TRAVELLER_LIST_DEFAULT_LIMIT = 8;
export const TRAVELLER_LIST_MAX_LIMIT = 100;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function actorId(req: any): string {
  return String(req.user?._id || req.user?.id || req.user?.sub || "");
}

/**
 * Customer._id → CustomerWorkspace, or null when the customer has no
 * workspace (68 of 114 active customers in prod don't — a read must NEVER
 * mint one; ensureWorkspace() belongs to the write paths that need it).
 */
async function resolveWorkspaceForCustomer(customerId: string): Promise<{ _id: mongoose.Types.ObjectId } | null> {
  if (!mongoose.isValidObjectId(customerId)) return null;
  const ws = await CustomerWorkspace.findOne({ customerId: String(customerId) }).select("_id").lean();
  return (ws as any) ?? null;
}

/**
 * The deliberate cross-tenant read, recorded. middleware/audit.ts is a
 * pass-through today, so the durable record is this structured log line —
 * who read which customer's travellers, and how much.
 */
function recordCrossTenantRead(req: any, what: string, extra: Record<string, unknown>): void {
  logger.info("[HouseTravellerAccess] " + what, {
    actorId: actorId(req),
    actorEmail: req.user?.email,
    actorWorkspaceId: req.workspaceId ?? null,
    customerId: req.params.customerId,
    ...extra,
  });
}

/* ── GET /:customerId/travellers?search=&limit= ───────────────────────
 * Masked list. `search` matches first/middle/last name, email, travelerId.
 * With no search the newest-by-name `limit` rows come back (default 8, max
 * 100) — never the whole directory unbounded.
 */
router.get(
  "/:customerId/travellers",
  requirePermission("manualBookings", "READ"),
  audit("house-traveller-list"),
  async (req: any, res: any) => {
    try {
      const ws = await resolveWorkspaceForCustomer(String(req.params.customerId));
      if (!ws) {
        recordCrossTenantRead(req, "list — no directory", { hasDirectory: false });
        return res.json({
          ok: true,
          hasDirectory: false,
          workspaceId: null,
          travellers: [],
          message: "This client has no traveller directory yet.",
        });
      }

      const search = String(req.query.search ?? "").trim();
      const limitRaw = parseInt(String(req.query.limit ?? ""), 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(limitRaw, TRAVELLER_LIST_MAX_LIMIT)
        : TRAVELLER_LIST_DEFAULT_LIMIT;

      // EXPLICIT workspaceId — see the header. Never a bare find.
      const filter: Record<string, any> = { workspaceId: ws._id, isActive: true };
      if (search) {
        const re = new RegExp(escapeRegex(search), "i");
        filter.$or = [
          { firstName: re }, { middleName: re }, { lastName: re },
          { email: re }, { travelerId: re },
        ];
      }

      // Allowlisted leaf fields; passportNo is selected only to derive the
      // masked tail and is stripped before the row is built.
      const docs = await TravellerProfile.find(filter)
        .select("travelerId title firstName middleName lastName email mobile mobileCountryCode dob nationality passportNo")
        .sort({ firstName: 1, lastName: 1 })
        .limit(limit)
        .lean();

      const travellers = (docs as any[]).map((d) => ({
        _id: String(d._id),
        travelerId: d.travelerId,
        title: d.title ?? null,
        firstName: d.firstName,
        middleName: d.middleName ?? null,
        lastName: d.lastName,
        email: d.email ?? null,
        mobile: d.mobile ?? null,
        mobileCountryCode: d.mobileCountryCode ?? null,
        dob: d.dob ?? null,
        nationality: d.nationality ?? null,
        passportMasked: maskTailId(d.passportNo) ?? null,
      }));

      recordCrossTenantRead(req, "list", { hasDirectory: true, workspaceId: String(ws._id), search: search || null, returned: travellers.length });
      res.json({ ok: true, hasDirectory: true, workspaceId: String(ws._id), travellers });
    } catch (err: any) {
      console.error("[admin.travellers GET list]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

/* ── GET /:customerId/travellers/:id ──────────────────────────────────
 * Unmasked detail for the fill-on-select. The traveller must belong to the
 * workspace resolved from :customerId — a valid id from another tenant is a
 * 404, indistinguishable from a nonexistent one.
 */
router.get(
  "/:customerId/travellers/:id",
  requirePermission("manualBookings", "READ"),
  audit("house-traveller-detail"),
  async (req: any, res: any) => {
    try {
      const ws = await resolveWorkspaceForCustomer(String(req.params.customerId));
      if (!ws) return res.status(404).json({ error: "Traveller not found" });
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Traveller not found" });

      // id AND workspaceId together — never findById.
      const traveller: any = await TravellerProfile.findOne({
        _id: req.params.id,
        workspaceId: ws._id,
        isActive: true,
      })
        // Regulated IDs are write-gated and empty today; never ship them
        // from here regardless. __v is noise.
        .select("-pan -aadhaar -__v")
        .lean();
      if (!traveller) return res.status(404).json({ error: "Traveller not found" });

      recordCrossTenantRead(req, "detail", { workspaceId: String(ws._id), travellerId: String(traveller._id), travelerId: traveller.travelerId });
      res.json({ ok: true, workspaceId: String(ws._id), traveller });
    } catch (err: any) {
      console.error("[admin.travellers GET one]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

export default router;
