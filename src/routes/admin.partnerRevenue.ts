/* ───────────────────────── partner revenue share (SUPERADMIN only) ─────────────────────────
 * One config row per partner workspace (visible margin % and partner share %),
 * plus an append-only change log. Same shape and guards as the SBT margins in
 * routes/admin.sbt.ts. Saving a config also sets the workspace's
 * config.features.revenueShareEnabled to the config's `enabled`, which gates
 * the partner's own /api/my-bookings/revenue endpoints.
 *
 * Changing a config never rewrites past bookings: the amounts are frozen onto
 * each booking when it is invoiced (services/partnerRevenue.ts).
 */
import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin.js";
import { userNames, nameOrUnknown } from "../services/actorNames.js";
import PartnerRevenueConfig from "../models/PartnerRevenueConfig.js";
import PartnerRevenueChange from "../models/PartnerRevenueChange.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { HOUSE_WORKSPACE_ID } from "../utils/bookingAccess.js";
import ManualBooking from "../models/ManualBooking.js";
import Invoice from "../models/Invoice.js";
import { isValidPartnerPct, computePartnerShare, PARTNER_PCT_MIN, PARTNER_PCT_MAX } from "../services/partnerRevenue.js";

const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);
router.use(requireSuperAdmin);

const actorOf = (req: any) => String(req.user?._id ?? req.user?.id ?? req.user?.sub ?? "");
const MAX_REASON = 500;

async function actorName(req: any): Promise<string> {
  const id = actorOf(req);
  const names = await userNames([id, req.user?.email].filter(Boolean));
  return nameOrUnknown(names.get(id), names.get(String(req.user?.email || "").toLowerCase()));
}

async function logChange(req: any, entry: {
  action: "UPDATE" | "CREATE" | "REMOVE" | "BACKFILL";
  workspaceId: unknown; workspaceName?: string; before: unknown; after: unknown; reason: string;
}) {
  await PartnerRevenueChange.create({
    ...entry,
    workspaceId: new mongoose.Types.ObjectId(String(entry.workspaceId)),
    workspaceName: entry.workspaceName || "",
    actorId: actorOf(req),
    actorName: await actorName(req),
    at: new Date(),
  });
}

const wsName = (w: any) => String(w?.companyName || "").trim() || String(w?.customerId || "") || "Unnamed company";
const termsOf = (r: any) => (r ? { enabled: r.enabled !== false, visiblePct: r.visiblePct, sharePct: r.sharePct, version: r.version ?? 1 } : null);

async function setFeatureFlag(workspaceId: string, enabled: boolean) {
  await CustomerWorkspace.updateOne(
    { _id: new mongoose.Types.ObjectId(workspaceId) },
    { $set: { "config.features.revenueShareEnabled": enabled } },
  );
}

// GET /api/admin/partner-revenue — every partner config with its company name
router.get("/", async (_req: any, res: any) => {
  try {
    const rows = (await PartnerRevenueConfig.find({}).sort({ updatedAt: -1 }).lean()) as any[];
    const workspaces = rows.length
      ? ((await CustomerWorkspace.find({ _id: { $in: rows.map((r) => r.workspaceId) } })
          .select("companyName customerId").lean()) as any[])
      : [];
    const byWs = new Map(workspaces.map((w) => [String(w._id), w]));
    const names = await userNames(rows.flatMap((r) => [r.updatedBy, r.createdBy]).filter(Boolean));
    res.json({
      ok: true,
      configs: rows.map((r) => ({
        id: String(r._id),
        workspaceId: String(r.workspaceId),
        companyName: wsName(byWs.get(String(r.workspaceId))),
        isHouse: String(r.workspaceId) === HOUSE_WORKSPACE_ID,
        ...termsOf(r),
        reason: r.reason,
        updatedAt: r.updatedAt,
        updatedByName: nameOrUnknown(names.get(String(r.updatedBy || r.createdBy || ""))),
      })),
      limits: { min: PARTNER_PCT_MIN, max: PARTNER_PCT_MAX },
    });
  } catch (err: any) {
    console.error("[Admin Partner Revenue GET]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/partner-revenue/companies?q= — companies to set up as a partner
router.get("/companies", async (req: any, res: any) => {
  try {
    const q = String(req.query?.q || "").trim().slice(0, 80);
    const filter: any = { status: { $ne: "DELETED" } };
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ companyName: rx }, { customerId: rx }];
    }
    const rows = (await CustomerWorkspace.find(filter).select("companyName customerId").sort({ companyName: 1 }).limit(20).lean()) as any[];
    const taken = new Set(
      ((await PartnerRevenueConfig.find({ workspaceId: { $in: rows.map((r) => r._id) } }).select("workspaceId").lean()) as any[])
        .map((r) => String(r.workspaceId)),
    );
    res.json({
      ok: true,
      companies: rows.map((w) => ({
        workspaceId: String(w._id),
        companyName: wsName(w),
        isHouse: String(w._id) === HOUSE_WORKSPACE_ID,
        hasConfig: taken.has(String(w._id)),
      })),
    });
  } catch (err: any) {
    console.error("[Admin Partner Revenue companies]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/partner-revenue/history?workspaceId= — the change log, newest first
router.get("/history", async (req: any, res: any) => {
  try {
    const filter: any = {};
    const wsId = String(req.query?.workspaceId || "");
    if (wsId) {
      if (!mongoose.Types.ObjectId.isValid(wsId)) return res.json({ ok: true, changes: [] });
      filter.workspaceId = new mongoose.Types.ObjectId(wsId);
    }
    const rows = (await PartnerRevenueChange.find(filter).sort({ at: -1, _id: -1 }).limit(300).lean()) as any[];
    const names = await userNames(rows.map((r) => r.actorId).filter(Boolean));
    res.json({
      ok: true,
      changes: rows.map((r) => ({
        id: String(r._id), action: r.action,
        workspaceId: String(r.workspaceId), workspaceName: r.workspaceName,
        before: r.before, after: r.after, reason: r.reason,
        actorName: nameOrUnknown(names.get(String(r.actorId || "")), r.actorName),
        at: r.at,
      })),
    });
  } catch (err: any) {
    console.error("[Admin Partner Revenue history]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/partner-revenue/:workspaceId — add or change a partner's terms.
// visiblePct and sharePct are numbers in [0, 100]; enabled is a boolean
// (default true); reason required. Version +1 on every change; logged.
router.put("/:workspaceId", async (req: any, res: any) => {
  try {
    const wsId = String(req.params.workspaceId || "");
    if (!mongoose.Types.ObjectId.isValid(wsId)) return res.status(400).json({ ok: false, error: "Unknown company" });
    const ws = (await CustomerWorkspace.findById(wsId).select("companyName customerId").lean()) as any;
    if (!ws) return res.status(404).json({ ok: false, error: "Unknown company" });

    const b = req.body || {};
    for (const key of ["visiblePct", "sharePct"] as const) {
      if (!isValidPartnerPct(b[key])) {
        return res.status(400).json({
          ok: false,
          error: `${key} must be a number between ${PARTNER_PCT_MIN} and ${PARTNER_PCT_MAX}`,
        });
      }
    }
    if (b.enabled !== undefined && typeof b.enabled !== "boolean") {
      return res.status(400).json({ ok: false, error: "enabled must be true or false" });
    }
    const enabled = b.enabled !== false;
    const reason = typeof b.reason === "string" ? b.reason.trim() : "";
    if (!reason) return res.status(400).json({ ok: false, error: "A reason is required" });
    if (reason.length > MAX_REASON) return res.status(400).json({ ok: false, error: `Keep the reason under ${MAX_REASON} characters` });

    const userId = actorOf(req);
    const prev = (await PartnerRevenueConfig.findOne({ workspaceId: wsId }).lean()) as any;
    const version = prev ? (Number(prev.version) || 1) + 1 : 1;
    const row = await PartnerRevenueConfig.findOneAndUpdate(
      { workspaceId: wsId },
      {
        $set: { enabled, visiblePct: b.visiblePct, sharePct: b.sharePct, reason, version, updatedBy: userId },
        $setOnInsert: { createdBy: userId },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
    ).lean();
    await setFeatureFlag(wsId, enabled);
    await logChange(req, {
      action: prev ? "UPDATE" : "CREATE", workspaceId: wsId, workspaceName: wsName(ws),
      before: termsOf(prev),
      after: termsOf(row),
      reason,
    });
    res.json({ ok: true, config: { id: String((row as any)?._id), workspaceId: wsId, ...termsOf(row), reason } });
  } catch (err: any) {
    console.error("[Admin Partner Revenue PUT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/partner-revenue/:workspaceId — the company stops being a
// partner (feature flag off). Bookings already invoiced keep their snapshot.
// Reason required; logged.
router.delete("/:workspaceId", async (req: any, res: any) => {
  try {
    const wsId = String(req.params.workspaceId || "");
    if (!mongoose.Types.ObjectId.isValid(wsId)) return res.status(400).json({ ok: false, error: "Unknown company" });
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) return res.status(400).json({ ok: false, error: "A reason is required" });
    const prev = (await PartnerRevenueConfig.findOneAndDelete({ workspaceId: wsId }).lean()) as any;
    if (!prev) return res.status(404).json({ ok: false, error: "This company has no partner revenue config" });
    await setFeatureFlag(wsId, false);
    const ws = (await CustomerWorkspace.findById(wsId).select("companyName customerId").lean()) as any;
    await logChange(req, {
      action: "REMOVE", workspaceId: wsId, workspaceName: wsName(ws),
      before: { ...termsOf(prev), reason: prev.reason }, after: null,
      reason: reason.slice(0, MAX_REASON),
    });
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[Admin Partner Revenue DELETE]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/partner-revenue/:workspaceId/backfill
// body { fromDate: "YYYY-MM-DD", dryRun = true, reason }
//
// Snapshots the partner share onto bookings invoiced BEFORE the partner was
// enabled (the live path only snapshots at the moment of invoicing). Takes
// the workspace's INVOICED, active bookings with bookingDate ≥ fromDate (start
// of that day in India), on an invoice that is not CANCELLED, and with NO
// partnerShare yet — an existing snapshot is never overwritten, so a re-run is
// a no-op. Uses the CURRENT terms; same skips as the live path (cost 0 → no
// snapshot, loss → 0). Works on a PAUSED partner too — the post-deploy order
// is add (paused) → dry run → compare with the manual sheet → apply → switch
// on — so only a workspace with NO config is refused. (The live snapshot at
// invoicing still runs only while the partner is on.)
// dryRun (the default) writes nothing; apply needs a reason and logs one
// BACKFILL entry.
const round2 = (n: number) => Math.round(n * 100) / 100;

function parseFromDate(v: unknown): Date | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
}

router.post("/:workspaceId/backfill", async (req: any, res: any) => {
  try {
    const wsId = String(req.params.workspaceId || "");
    if (!mongoose.Types.ObjectId.isValid(wsId)) return res.status(400).json({ ok: false, error: "Unknown company" });
    const ws = (await CustomerWorkspace.findById(wsId).select("companyName customerId").lean()) as any;
    if (!ws) return res.status(404).json({ ok: false, error: "Unknown company" });

    const b = req.body || {};
    const from = parseFromDate(b.fromDate);
    if (!from) return res.status(400).json({ ok: false, error: "fromDate must be a date (YYYY-MM-DD)" });
    if (b.dryRun !== undefined && typeof b.dryRun !== "boolean") {
      return res.status(400).json({ ok: false, error: "dryRun must be true or false" });
    }
    const dryRun = b.dryRun !== false;
    const reason = typeof b.reason === "string" ? b.reason.trim() : "";
    if (!dryRun && !reason) return res.status(400).json({ ok: false, error: "A reason is required" });
    if (reason.length > MAX_REASON) return res.status(400).json({ ok: false, error: `Keep the reason under ${MAX_REASON} characters` });

    const config = (await PartnerRevenueConfig.findOne({ workspaceId: wsId }).lean()) as any;
    if (!config) {
      return res.status(400).json({ ok: false, error: "This company is not set up as a partner" });
    }
    // computePartnerShare() returns nothing for a paused config — right for the
    // live path, wrong here: the backfill applies the terms whether or not the
    // partner is switched on yet.
    const activeTerms = { ...config, enabled: true };
    const customerId = String(ws.customerId || "");
    if (!mongoose.Types.ObjectId.isValid(customerId)) return res.status(400).json({ ok: false, error: "This company has no customer record" });

    // ManualBooking.workspaceId is the Customer._id — never the workspace id.
    const candidates = (await ManualBooking.find({
      workspaceId: new mongoose.Types.ObjectId(customerId),
      status: "INVOICED",
      isActive: { $ne: false },
      isDemo: { $ne: true },
      bookingDate: { $gte: from },
      partnerShare: { $exists: false },
    })
      .select("_id bookingRef bookingDate invoiceId pricing.actualPrice pricing.basePrice")
      .sort({ bookingDate: 1 })
      .lean()) as any[];

    const invoiceIds = [...new Set(candidates.map((c) => String(c.invoiceId || "")).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
    const invoices = invoiceIds.length
      ? ((await Invoice.find({ _id: { $in: invoiceIds.map((id) => new mongoose.Types.ObjectId(id)) } }).select("invoiceNo status").lean()) as any[])
      : [];
    const invById = new Map(invoices.map((i) => [String(i._id), i]));

    const at = new Date();
    const planned: Array<{ booking: any; invoiceNo: string; snap: any }> = [];
    const skipped = { noCost: 0, cancelledOrMissingInvoice: 0 };
    for (const c of candidates) {
      const inv = c.invoiceId ? invById.get(String(c.invoiceId)) : null;
      if (!inv || inv.status === "CANCELLED") {
        skipped.cancelledOrMissingInvoice++;
        continue;
      }
      const snap = computePartnerShare(c, activeTerms, at);
      if (!snap) {
        skipped.noCost++;
        continue;
      }
      planned.push({ booking: c, invoiceNo: String(inv.invoiceNo || ""), snap });
    }

    const rowOf = (p: (typeof planned)[number]) => ({
      bookingId: String(p.booking._id),
      bookingRef: p.booking.bookingRef,
      bookingDate: p.booking.bookingDate,
      invoiceNo: p.invoiceNo,
      marginBase: p.snap.marginBase,
      bakedIn: p.snap.bakedIn,
      share: p.snap.share,
    });
    const sum = (rows: typeof planned) => ({
      count: rows.length,
      totalBakedIn: round2(rows.reduce((s, p) => s + p.snap.bakedIn, 0)),
      totalShare: round2(rows.reduce((s, p) => s + p.snap.share, 0)),
    });
    const terms = {
      visiblePct: config.visiblePct,
      sharePct: config.sharePct,
      configVersion: Number(config.version) || 1,
      partnerEnabled: config.enabled !== false,
    };

    if (dryRun) {
      return res.json({ ok: true, dryRun: true, fromDate: b.fromDate, ...terms, ...sum(planned), skipped, rows: planned.map(rowOf) });
    }

    // Each write is guarded on "still no snapshot", so a booking snapshotted
    // meanwhile (a concurrent backfill, or a re-invoice) is left alone.
    const written: typeof planned = [];
    for (const p of planned) {
      const r = await ManualBooking.updateOne(
        { _id: p.booking._id, status: "INVOICED", partnerShare: { $exists: false } },
        { $set: { partnerShare: p.snap } },
      );
      if (r.modifiedCount === 1) written.push(p);
    }
    const totals = sum(written);
    if (written.length) {
      await logChange(req, {
        action: "BACKFILL", workspaceId: wsId, workspaceName: wsName(ws),
        before: null,
        after: { fromDate: b.fromDate, ...terms, ...totals },
        reason: reason.slice(0, MAX_REASON),
      });
    }
    res.json({ ok: true, dryRun: false, fromDate: b.fromDate, ...terms, ...totals, skipped, rows: written.map(rowOf) });
  } catch (err: any) {
    console.error("[Admin Partner Revenue backfill]", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
