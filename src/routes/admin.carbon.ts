// apps/backend/src/routes/admin.carbon.ts
import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import CarbonRecord from "../models/CarbonRecord.js";
import ExtractedDocument from "../models/ExtractedDocument.js";
import Customer from "../models/Customer.js";
import { CARBON_CALCULATION_VERSION } from "../services/carbonEngine.service.js";

/**
 * Carbon Ledger — aggregations over CarbonRecord for the Sustainability
 * dashboard.
 * ---------------------------------------------------------------------------
 * ── The access rule, stated once (identical to routes/
 *    admin.extractedDocuments.ts, deliberately) ──
 *
 * The cross-workspace read is an EXPLICIT branch on a real-JWT SuperAdmin that
 * returns an explicit `{}` — a declared "no workspace restriction". It is never
 * an absent or undefined workspace filter that happens to read everything.
 * Mongoose 8 STRIPS undefined keys, so `{ workspaceId: undefined }` silently
 * becomes `{}` (docs/audits/vouchers-extract-render-audit.md §7, F-01).
 *
 * AGGREGATION IS WHERE THIS BITES HARDEST. On a `find`, an over-wide filter
 * returns rows a caller might notice. On a `$group`, it returns a single
 * plausible-looking NUMBER with another tenant's emissions folded into it, and
 * nothing about that number looks wrong. So the $match clause is built by the
 * same two-layer construction as every other query in this codebase, and the
 * tests assert on the pipeline handed to Mongo rather than on the totals it
 * returns — a totals-only test passes identically whether the scope was
 * deliberate or accidental.
 *
 * Two independent layers, so neither is load-bearing alone:
 *   1. adminOrSuperAdmin — the route is admin-facing to begin with.
 *   2. carbonScope()     — even if layer 1 were bypassed or reordered, a
 *      non-SuperAdmin is pinned to their own workspace, and tenantScope()
 *      THROWS rather than widen when there is no workspace context.
 *
 * ── Honest denominators ──
 *
 * An Insufficient Data row has co2eKg: null. It counts toward the DENOMINATOR
 * of coverage (it is a real segment we were asked to price) and contributes
 * exactly nothing to any emissions total. $sum ignores null, which is the
 * behaviour we want, but the counts are computed separately and explicitly so
 * that "how much we emitted" and "how much we could measure" are never the
 * same number by accident.
 */

const router = express.Router();

router.use(requireAuth, requireWorkspace);

/** Layer 1. Carbon reporting is an admin surface, not a per-employee one. */
function adminOrSuperAdmin(req: any, res: any, next: any) {
  if (isSuperAdmin(req)) return next();
  const roles: string[] = Array.isArray(req.user?.roles) ? req.user.roles : [];
  const ok = roles.some((r) => ["ADMIN", "SUPERADMIN", "HR", "OPS"].includes(String(r).toUpperCase()));
  if (ok) return next();
  return res.status(403).json({ error: "Admin access required" });
}
router.use(adminOrSuperAdmin);

/** Read the tenancy boundary. Throws rather than ever returning undefined. */
function tenantScope(req: any): mongoose.Types.ObjectId {
  const ws = req.workspaceObjectId;
  if (!ws) {
    throw Object.assign(new Error("Workspace context missing"), { status: 403 });
  }
  return ws;
}

/**
 * The tenancy clause for every aggregation in this file.
 *
 * `{}` for a real SuperAdmin is a deliberate, readable "no workspace
 * restriction" — not the absence of a filter.
 */
export function carbonScope(req: any): Record<string, unknown> {
  if (isSuperAdmin(req)) return {};
  return { workspaceId: tenantScope(req) };
}

/**
 * The $match stage shared by every endpoint here, so the KPI row, the trend and
 * the breakdowns can never disagree about which records they describe.
 *
 * Pinned to CARBON_CALCULATION_VERSION: a dashboard that silently switched to a
 * newer engine's numbers the moment one was seeded would restate history
 * without saying so.
 */
export function buildCarbonMatch(req: any): Record<string, any> {
  const q = req.query || {};
  const match: Record<string, any> = { calculationVersion: CARBON_CALCULATION_VERSION };

  // Caller-supplied workspace narrowing. Applied FIRST, deliberately, so the
  // tenancy clause below can overwrite it — a caller can never widen their own
  // scope by passing someone else's workspaceId.
  if (q.workspaceId) {
    try {
      match.workspaceId = new mongoose.Types.ObjectId(String(q.workspaceId));
    } catch {
      match._id = { $in: [] }; // invalid id → force an empty result
    }
  }

  // Period, on TRAVEL month. Rows with no parseable travel date are excluded
  // from a bounded period rather than dumped into an arbitrary bucket; the Data
  // Quality panel reports how many those are.
  const from = q.from ? String(q.from).slice(0, 7) : null;
  const to = q.to ? String(q.to).slice(0, 7) : null;
  if (from || to) {
    match.travelMonth = {};
    if (from) match.travelMonth.$gte = from;
    if (to) match.travelMonth.$lte = to;
  }

  // The tenancy clause, applied LAST so it always wins. For a non-SuperAdmin
  // this overwrites any caller-supplied workspaceId with their own. For a real
  // SuperAdmin it is `{}`, so the narrowing above stands. This ordering is the
  // load-bearing line in the file.
  Object.assign(match, carbonScope(req));

  return match;
}

const round = (n: number, dp = 2) => Number((n || 0).toFixed(dp));
const pct = (n: number, d: number) => (d > 0 ? round((n / d) * 100, 1) : 0);

/* ───────────────────────── overview ───────────────────────── */

/**
 * Totals, coverage and the confidence split in one pass.
 *
 * `totalCo2eKg` sums only rows that produced a figure. `records` counts every
 * row in scope including the ones we refused to price — so coverage is
 * calculated, not asserted, and the two can be reconciled by hand.
 */
router.get("/overview", async (req: any, res: any) => {
  try {
    const match = buildCarbonMatch(req);

    const [agg] = await CarbonRecord.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          records: { $sum: 1 },
          // $sum ignores nulls; the calculated count is tracked separately so
          // the denominator is never inferred from the numerator.
          totalCo2eKg: { $sum: "$co2eKg" },
          totalDistanceKm: { $sum: "$distanceKm" },
          calculated: { $sum: { $cond: [{ $eq: ["$status", "calculated"] }, 1, 0] } },
          high: { $sum: { $cond: [{ $eq: ["$confidence", "high"] }, 1, 0] } },
          medium: { $sum: { $cond: [{ $eq: ["$confidence", "medium"] }, 1, 0] } },
          insufficient: { $sum: { $cond: [{ $eq: ["$confidence", "insufficient"] }, 1, 0] } },
          undatedRows: { $sum: { $cond: [{ $eq: ["$travelMonth", null] }, 1, 0] } },
        },
      },
    ]);

    const r = agg || {
      records: 0, totalCo2eKg: 0, totalDistanceKm: 0, calculated: 0,
      high: 0, medium: 0, insufficient: 0, undatedRows: 0,
    };

    res.json({
      ok: true,
      calculationVersion: CARBON_CALCULATION_VERSION,
      records: r.records,
      calculated: r.calculated,
      totalCo2eKg: round(r.totalCo2eKg),
      totalDistanceKm: round(r.totalDistanceKm, 1),
      // Share of in-scope segments that produced a real figure.
      coveragePct: pct(r.calculated, r.records),
      confidence: {
        high: r.high,
        medium: r.medium,
        insufficient: r.insufficient,
        highPct: pct(r.high, r.records),
        mediumPct: pct(r.medium, r.records),
        insufficientPct: pct(r.insufficient, r.records),
      },
      undatedRows: r.undatedRows,
    });
  } catch (err: any) {
    console.error("[Carbon OVERVIEW]", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ───────────────────────── trend ───────────────────────── */

// Emissions by TRAVEL month, not by when we happened to compute them.
router.get("/trend", async (req: any, res: any) => {
  try {
    const match = buildCarbonMatch(req);
    const rows = await CarbonRecord.aggregate([
      // Undated rows cannot sit on a time axis. They are excluded here and
      // counted by /overview's undatedRows so the omission is visible.
      { $match: { ...match, travelMonth: { ...(match.travelMonth || {}), $ne: null } } },
      {
        $group: {
          _id: "$travelMonth",
          co2eKg: { $sum: "$co2eKg" },
          records: { $sum: 1 },
          calculated: { $sum: { $cond: [{ $eq: ["$status", "calculated"] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({
      ok: true,
      months: rows.map((m: any) => ({
        month: m._id,
        co2eKg: round(m.co2eKg),
        records: m.records,
        calculated: m.calculated,
      })),
    });
  } catch (err: any) {
    console.error("[Carbon TREND]", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ───────────────────────── by airline ───────────────────────── */

/**
 * Emissions by carrier, with everything that has no carrier collected into a
 * single "Unattributed" row rather than dropped.
 *
 * The §17/§36 rule: a breakdown must sum to its own total. Silently omitting
 * unmatched rows produces a table that looks complete and reconciles to a
 * different number than the KPI above it, which is how a reader ends up
 * trusting a figure that is quietly missing a slice.
 */
router.get("/by-airline", async (req: any, res: any) => {
  try {
    const match = buildCarbonMatch(req);
    const rows = await CarbonRecord.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            $let: {
              vars: { a: { $trim: { input: { $ifNull: ["$airline", ""] } } } },
              in: { $cond: [{ $eq: ["$$a", ""] }, "__UNATTRIBUTED__", "$$a"] },
            },
          },
          co2eKg: { $sum: "$co2eKg" },
          records: { $sum: 1 },
          calculated: { $sum: { $cond: [{ $eq: ["$status", "calculated"] }, 1, 0] } },
          distanceKm: { $sum: "$distanceKm" },
        },
      },
      { $sort: { co2eKg: -1, records: -1 } },
    ]);

    const totalCo2e = rows.reduce((s: number, r: any) => s + (r.co2eKg || 0), 0);
    res.json({
      ok: true,
      totalCo2eKg: round(totalCo2e),
      airlines: rows.map((r: any) => ({
        airline: r._id === "__UNATTRIBUTED__" ? "Unattributed" : r._id,
        unattributed: r._id === "__UNATTRIBUTED__",
        co2eKg: round(r.co2eKg),
        sharePct: pct(r.co2eKg || 0, totalCo2e),
        records: r.records,
        calculated: r.calculated,
        distanceKm: round(r.distanceKm, 1),
      })),
    });
  } catch (err: any) {
    console.error("[Carbon BY-AIRLINE]", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ───────────────────────── by haul band ───────────────────────── */

router.get("/by-haul-band", async (req: any, res: any) => {
  try {
    const match = buildCarbonMatch(req);
    const rows = await CarbonRecord.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $ifNull: ["$haulBand", "__UNRESOLVED__"] },
          co2eKg: { $sum: "$co2eKg" },
          records: { $sum: 1 },
          distanceKm: { $sum: "$distanceKm" },
        },
      },
      { $sort: { co2eKg: -1 } },
    ]);

    const total = rows.reduce((s: number, r: any) => s + (r.co2eKg || 0), 0);
    res.json({
      ok: true,
      totalCo2eKg: round(total),
      bands: rows.map((r: any) => ({
        // A null band is a row we could not place — named, not hidden.
        band: r._id === "__UNRESOLVED__" ? "Not determined" : r._id,
        resolved: r._id !== "__UNRESOLVED__",
        co2eKg: round(r.co2eKg),
        sharePct: pct(r.co2eKg || 0, total),
        records: r.records,
        distanceKm: round(r.distanceKm, 1),
      })),
    });
  } catch (err: any) {
    console.error("[Carbon BY-HAUL-BAND]", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ───────────────────────── top routes ───────────────────────── */

router.get("/top-routes", async (req: any, res: any) => {
  try {
    const match = buildCarbonMatch(req);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const rows = await CarbonRecord.aggregate([
      // Only rows we could actually place produce a meaningful route pair; the
      // unplaceable ones are reported by /data-quality instead of appearing
      // here as a "? -> ?" row competing for a top-10 slot.
      { $match: { ...match, status: "calculated" } },
      {
        $group: {
          _id: { from: "$origin.code", to: "$destination.code" },
          co2eKg: { $sum: "$co2eKg" },
          records: { $sum: 1 },
          distanceKm: { $avg: "$distanceKm" },
        },
      },
      { $sort: { co2eKg: -1 } },
      { $limit: limit },
    ]);

    res.json({
      ok: true,
      routes: rows.map((r: any) => ({
        from: r._id.from || "—",
        to: r._id.to || "—",
        route: `${r._id.from || "—"} → ${r._id.to || "—"}`,
        co2eKg: round(r.co2eKg),
        records: r.records,
        distanceKm: round(r.distanceKm, 1),
      })),
    });
  } catch (err: any) {
    console.error("[Carbon TOP-ROUTES]", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ───────────────────────── data quality ───────────────────────── */

/**
 * Why the number is a floor.
 *
 * Two grains are reported here and they are labelled as two, not summed:
 *   - Insufficient CAUSES are per passenger-segment, over CarbonRecord.
 *   - modeNotSupported is per DOCUMENT, over ExtractedDocument, because the
 *     engine deliberately writes no CarbonRecord for a hotel or other document
 *     (see services/carbonEngine.service.ts). There is no segment grain to
 *     count for them, so folding them into the 361-row denominator would
 *     invent rows that do not exist.
 */
router.get("/data-quality", async (req: any, res: any) => {
  try {
    const match = buildCarbonMatch(req);

    const [causes] = await CarbonRecord.aggregate([
      { $match: { ...match, status: "insufficient_data" } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          // The document carried no airport tokens at all (screenshots the
          // extractor could read no route from).
          blankEndpoints: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $in: [{ $ifNull: ["$origin.code", ""] }, ["", null]] },
                    { $in: [{ $ifNull: ["$destination.code", ""] }, ["", null]] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);

    const insufficientTotal = causes?.total || 0;
    const blank = causes?.blankEndpoints || 0;

    // Cabin softness — the reason most rows are Medium rather than High.
    const cabinAgg = await CarbonRecord.aggregate([
      { $match: match },
      { $group: { _id: "$cabinResolution", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]);

    // Document-grain, deliberately separate. Scoped the same way; for a
    // SuperAdmin the workspace key is absent by the same explicit branch.
    const docScope: Record<string, any> = { ...carbonScope(req) };
    if (req.query.workspaceId && !docScope.workspaceId) {
      try {
        docScope.workspaceId = new mongoose.Types.ObjectId(String(req.query.workspaceId));
      } catch {
        docScope._id = { $in: [] };
      }
    }
    const modeNotSupported = await ExtractedDocument.countDocuments({
      ...docScope,
      status: "extracted",
      docType: { $ne: "flight" },
    });

    res.json({
      ok: true,
      insufficient: {
        total: insufficientTotal,
        causes: [
          {
            cause: "blank_origin_destination",
            label: "No route on the document",
            detail: "The extractor found no departure or arrival airport at all — typically a screenshot rather than a ticket PDF.",
            records: blank,
          },
          {
            cause: "unresolvable_code",
            label: "Airport code not in the master",
            detail: "A code was present but matched no airport, so no distance could be derived. No figure is reported rather than a guess.",
            records: insufficientTotal - blank,
          },
        ],
      },
      cabinResolution: cabinAgg.map((c: any) => ({
        resolution: c._id || "not_applicable",
        records: c.n,
      })),
      modeNotSupported: {
        grain: "documents",
        documents: modeNotSupported,
        note: "Hotel and other documents produce no carbon segments at all — the factor library covers air travel only in Phase 1. Counted as documents, not segments, and deliberately not folded into the segment totals above.",
      },
    });
  } catch (err: any) {
    console.error("[Carbon DATA-QUALITY]", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ───────────────────────── workspaces ───────────────────────── */

// The workspace filter's options — only tenants that actually have carbon
// records. Same Customer-space lookup as the master page: workspaceId is copied
// from ManualBooking.workspaceId, which is ref:"Customer".
router.get("/workspaces", async (req: any, res: any) => {
  try {
    const ids = await CarbonRecord.distinct("workspaceId", carbonScope(req));
    const customers = ids.length
      ? await Customer.find({ _id: { $in: ids } }).select("legalName companyName name").lean()
      : [];
    res.json({
      ok: true,
      workspaces: (customers as any[])
        .map((c) => ({ _id: String(c._id), name: c.legalName || c.companyName || c.name || String(c._id) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (err: any) {
    console.error("[Carbon WORKSPACES]", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
