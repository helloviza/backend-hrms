// apps/backend/src/routes/admin.extractedDocuments.ts
import express from "express";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import ExtractedDocument from "../models/ExtractedDocument.js";
import ManualBooking from "../models/ManualBooking.js";
import Customer from "../models/Customer.js";
import CarbonRecord from "../models/CarbonRecord.js";
import { CARBON_CALCULATION_VERSION } from "../services/carbonEngine.service.js";

/**
 * Cross-tenant oversight over the ExtractedDocument master table.
 * ---------------------------------------------------------------
 * SuperAdmin-only. Every other surface over this collection is pinned to one
 * booking and one workspace (routes/manualBookings.ts); this is the single
 * place designed to read ACROSS tenants, which makes it the single place the
 * F-01 trap can resurface.
 *
 * ── The access rule, stated once ──
 *
 * The cross-workspace read is an EXPLICIT branch on a real-JWT SuperAdmin that
 * returns an explicit `{}` — a declared "no workspace restriction". It is never
 * an absent or undefined workspace filter that happens to read everything.
 * That distinction is the whole of F-01 (docs/audits/
 * vouchers-extract-render-audit.md §7): Mongoose 8 STRIPS undefined keys from a
 * filter, so `find({ workspaceId: undefined })` silently becomes `find({})` and
 * you get a cross-tenant query by accident rather than by decision. This file
 * mirrors routes/vouchers.ts:89-121 (tenantScope / voucherScope /
 * findVoucherInScope) deliberately, rather than reinventing the rule.
 *
 * Two independent layers, so neither is load-bearing alone:
 *   1. superAdminOnly  — nobody below a real SuperAdmin reaches these routes.
 *   2. extractedDocScope() — even if layer 1 were ever bypassed or reordered,
 *      a non-SuperAdmin's query is pinned to their own workspace, and
 *      tenantScope() THROWS rather than widen when there is no workspace.
 *
 * The export runs off the same scope + the same filter builder as the list, so
 * it can never contain a row the list would not have shown.
 */

const router = express.Router();

router.use(requireAuth, requireWorkspace);

/** Layer 1: nobody below a real SuperAdmin gets in at all. */
function superAdminOnly(req: any, res: any, next: any) {
  if (isSuperAdmin(req)) return next();
  return res.status(403).json({ error: "SuperAdmin access required" });
}
router.use(superAdminOnly);

/** Read the tenancy boundary. Throws rather than ever returning undefined. */
function tenantScope(req: any): mongoose.Types.ObjectId {
  const ws = req.workspaceObjectId;
  if (!ws) {
    // Reachable only for a SuperAdmin (the sole caller allowed past
    // requireWorkspace with no workspace context) — and every such path goes
    // through extractedDocScope() instead. Throwing keeps a future miswiring
    // loud rather than silently unscoped.
    throw Object.assign(new Error("Workspace context missing"), { status: 403 });
  }
  return ws;
}

/**
 * The tenancy clause for every query in this file.
 *
 * `{}` for a real SuperAdmin is a deliberate, readable "no workspace
 * restriction" — not the absence of a filter. Everyone else is pinned to their
 * own workspace by tenantScope(), which throws rather than return undefined.
 */
export function extractedDocScope(req: any): Record<string, unknown> {
  if (isSuperAdmin(req)) return {};
  return { workspaceId: tenantScope(req) };
}

/* ───────────────────────── filters ───────────────────────── */

/**
 * Oversight filters. Built once and shared by the list and the export, so the
 * two can never diverge into the export showing more than the page.
 */
export function buildFilter(req: any): Record<string, any> {
  const q = req.query || {};
  const filter: Record<string, any> = {};

  if (q.status) filter.status = String(q.status);
  if (q.docType) filter.docType = String(q.docType);

  // Caller-supplied workspace narrowing. Applied FIRST, deliberately, so that
  // the tenancy clause below can overwrite it — a caller can never widen their
  // own scope by passing someone else's workspaceId.
  if (q.workspaceId) {
    try {
      filter.workspaceId = new mongoose.Types.ObjectId(String(q.workspaceId));
    } catch {
      filter._id = { $in: [] }; // invalid id → force an empty result
    }
  }

  const from = q.from ? new Date(String(q.from)) : null;
  const to = q.to ? new Date(String(q.to)) : null;
  if ((from && !isNaN(from.getTime())) || (to && !isNaN(to.getTime()))) {
    filter.createdAt = {};
    if (from && !isNaN(from.getTime())) filter.createdAt.$gte = from;
    if (to && !isNaN(to.getTime())) {
      // Inclusive end-of-day for a plain YYYY-MM-DD.
      to.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = to;
    }
  }

  // The tenancy clause, applied LAST so it always wins. For a non-SuperAdmin
  // this overwrites any caller-supplied workspaceId with their own. For a real
  // SuperAdmin it is `{}` — a declared "no workspace restriction" — so the
  // narrowing above stands. This ordering is the load-bearing line in the file.
  Object.assign(filter, extractedDocScope(req));

  return filter;
}

/**
 * Document-level fields only — extractedJson (the full voucher) is deliberately
 * never selected here. This is a reporting view; the blob is large, and the
 * per-booking panel is where the full record is read.
 */
const LIST_PROJECTION =
  "workspaceId bookingId originalFilename mimeType size status docType " +
  "attempts modelUsed validationErrorCount error skipReason verified " +
  "flightRows createdAt updatedAt";

/**
 * Resolve the two id→label columns the master table shows: workspace name and
 * booking ref. Both are labels for ids ALREADY stored on the row — no data is
 * introduced that the collection doesn't already point at. Batched into two
 * queries for the whole page rather than one per row.
 *
 * The workspace label comes from `Customer`, NOT `CustomerWorkspace`. Despite
 * the field name, ExtractedDocument.workspaceId is copied verbatim from
 * ManualBooking.workspaceId, which is ref:"Customer" — the ids live in the
 * `customers` collection. Looking them up in `customerworkspaces` matched
 * nothing and rendered raw ObjectIds (verified against prod: 0/3 sampled ids
 * in customerworkspaces, 3/3 in customers). Name precedence is the model's own
 * canonical order from Customer.ts's pre-save hook — legalName, then
 * companyName, then name — the same order routes/manualBookings.ts uses for
 * the booking export, so one customer reads identically on both surfaces.
 *
 * manualBookings is the only writer today and it is Customer-space throughout.
 * If a future source module stores a workspace id from a different id-space
 * (a real CustomerWorkspace._id, say), this resolver must become source-aware
 * — keyed on sourceModule — rather than having a second lookup bolted on.
 */
async function resolveLabels(docs: any[]) {
  const wsIds = [...new Set(docs.map((d) => String(d.workspaceId)).filter(Boolean))];
  const bkIds = [...new Set(docs.map((d) => String(d.bookingId)).filter(Boolean))];

  const [customers, bookings] = await Promise.all([
    wsIds.length
      ? Customer.find({ _id: { $in: wsIds } }).select("legalName companyName name").lean()
      : [],
    bkIds.length
      ? ManualBooking.find({ _id: { $in: bkIds } }).select("bookingRef").lean()
      : [],
  ]);

  const wsName: Record<string, string> = {};
  for (const c of customers as any[]) {
    wsName[String(c._id)] = c.legalName || c.companyName || c.name || "";
  }
  const bookingRef: Record<string, string> = {};
  for (const b of bookings as any[]) bookingRef[String(b._id)] = b.bookingRef || "";

  return { wsName, bookingRef };
}

/**
 * Load the carbon results for a page of documents, keyed for an exact join on
 * the flattening's own grain.
 *
 * Pinned to CARBON_CALCULATION_VERSION rather than "the newest record": an
 * implicit latest() would silently restate historical numbers the moment a new
 * engine version is seeded alongside the old one, which is precisely what
 * CarbonRecord's versioning exists to prevent.
 *
 * Scoped with the same extractedDocScope() clause as everything else in this
 * file. The extractedDocumentId restriction is already strictly tighter (those
 * ids came out of a scoped query), so this is the second of two independent
 * layers rather than the load-bearing one — same posture as the rest of the
 * file, where neither layer is trusted alone.
 */
async function loadCarbon(req: any, docs: any[]) {
  const ids = docs.map((d) => d._id);
  const byKey = new Map<string, any>();
  if (!ids.length) return byKey;

  const records = await CarbonRecord.find({
    ...extractedDocScope(req),
    extractedDocumentId: { $in: ids },
    calculationVersion: CARBON_CALCULATION_VERSION,
  })
    .select(
      "extractedDocumentId passengerIndex segmentIndex distanceKm distanceMethod " +
        "factorValue factorUnit factorVersion factorSource rfVariant haulBand " +
        "resolvedCabin cabinResolution co2eKg methodology status confidence notes pax",
    )
    .lean();

  for (const r of records as any[]) {
    byKey.set(`${String(r.extractedDocumentId)}|${r.passengerIndex}|${r.segmentIndex}`, r);
  }
  return byKey;
}

/**
 * The carbon half of a flattened row.
 *
 * Every branch here says something true. A flight row that has no record yet
 * is "not_calculated" (the compute pass has not reached it), NOT zero and not
 * blank. A hotel or other document is "mode_not_supported" — derived from the
 * document's own docType rather than from a synthetic placeholder record, which
 * is why the engine writes no rows for non-flight documents at all.
 *
 * `aircraftType` is present, empty, and honest: the extractor's contract has no
 * aircraft field, so there is nothing to put here. The column exists so the
 * shape is stable when that changes; it renders as an em dash, never as a
 * guessed airframe.
 */
function carbonFields(docType: string, rec: any | undefined) {
  if (!rec) {
    return {
      carbonStatus: docType === "flight" ? "not_calculated" : "mode_not_supported",
      carbonConfidence: "",
      distanceKm: null as number | null,
      aircraftType: "",
      emissionFactor: null as number | null,
      emissionFactorUnit: "",
      factorVersion: "",
      factorSource: "",
      haulBand: "",
      resolvedCabin: "",
      co2eKg: null as number | null,
      methodology:
        docType === "flight"
          ? "Not calculated yet — this document has not been through the carbon compute pass."
          : `Mode "${docType}" is not yet supported by the emission factor library; no CO2e is calculated for it.`,
      carbonNotes: "",
    };
  }
  return {
    carbonStatus: rec.status || "",
    carbonConfidence: rec.confidence || "",
    distanceKm: rec.distanceKm ?? null,
    aircraftType: "",
    emissionFactor: rec.factorValue ?? null,
    emissionFactorUnit: rec.factorUnit || "",
    factorVersion: rec.factorVersion || "",
    factorSource: rec.factorSource || "",
    haulBand: rec.haulBand || "",
    resolvedCabin: rec.resolvedCabin || "",
    co2eKg: rec.co2eKg ?? null,
    methodology: rec.methodology || "",
    carbonNotes: rec.notes || "",
  };
}

/** Column order for the master table AND the export — one definition, no drift. */
export const MASTER_COLUMNS = [
  "Workspace",
  "Booking Ref",
  "File",
  "Doc Type",
  "Status",
  "Attempts",
  "Model",
  "Validation Errors",
  "Verified",
  "Created At",
  "Extracted At",
  "Passenger",
  "Pax Type",
  "Airline",
  "Flight No",
  "Class",
  "From",
  "Dep City",
  "Dep Date",
  "Dep Time",
  "To",
  "Arr City",
  "Arr Date",
  "Arr Time",
  "PNR",
  "Ticket No",
  // Carbon Engine Phase 1. Distance and CO2e are blank — never 0 — on a row
  // the engine refused to price, so a spreadsheet SUM over this export cannot
  // quietly absorb an unknown as a zero.
  "Distance (km)",
  "Aircraft Type",
  "Emission Factor",
  "Factor Version",
  "CO2e (kg)",
  "Carbon Confidence",
  "Carbon Status",
  "Calculation Methodology",
];

/**
 * Flatten documents to table rows: one row per flightRow, so a multi-passenger
 * ticket reads as several lines. A document with NO flight rows (queued,
 * failed, skipped, or a hotel voucher) still emits exactly one row with its
 * document-level fields and blank flight fields — an oversight view that hid
 * its failures would be worse than useless.
 */
function flattenRows(
  docs: any[],
  labels: { wsName: Record<string, string>; bookingRef: Record<string, string> },
  carbon: Map<string, any>,
) {
  const out: Record<string, any>[] = [];

  for (const d of docs) {
    const head = {
      documentId: String(d._id),
      workspaceId: String(d.workspaceId || ""),
      workspace: labels.wsName[String(d.workspaceId)] || "",
      bookingId: String(d.bookingId || ""),
      bookingRef: labels.bookingRef[String(d.bookingId)] || "",
      originalFilename: d.originalFilename || "",
      docType: d.docType || "",
      status: d.status || "",
      attempts: d.attempts ?? 0,
      modelUsed: d.modelUsed || "",
      validationErrorCount: d.validationErrorCount ?? 0,
      verified: !!d.verified,
      createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : "",
      // The row is written on the extraction that succeeded, so updatedAt is
      // the extraction time for an `extracted` row and nothing meaningful
      // otherwise — left blank rather than mislabelled.
      extractedAt: d.status === "extracted" && d.updatedAt ? new Date(d.updatedAt).toISOString() : "",
      error: d.error || "",
      skipReason: d.skipReason || "",
    };

    const frs = Array.isArray(d.flightRows) ? d.flightRows : [];
    if (!frs.length) {
      out.push({ ...head, passengerIndex: null, segmentIndex: null,
        passengerName: "", passengerType: "", airline: "", flightNo: "",
        cabinClass: "", depAirport: "", depCity: "", depDate: "", depTime: "",
        arrAirport: "", arrCity: "", arrDate: "", arrTime: "", pnr: "", ticketNo: "",
        ...carbonFields(d.docType || "", undefined) });
      continue;
    }
    for (const f of frs) {
      out.push({
        ...head,
        // Emitted so the client has the record's own grain to key on, and so a
        // support question about one line can name the exact segment.
        passengerIndex: f.passengerIndex,
        segmentIndex: f.segmentIndex,
        ...carbonFields(
          d.docType || "",
          carbon.get(`${String(d._id)}|${f.passengerIndex}|${f.segmentIndex}`),
        ),
        passengerName: f.passengerName || "",
        passengerType: f.passengerType || "",
        airline: f.airline || "",
        flightNo: f.flightNo || "",
        cabinClass: f.cabinClass || "",
        depAirport: f.depAirport || "",
        depCity: f.depCity || "",
        depDate: f.depDate || "",
        depTime: f.depTime || "",
        arrAirport: f.arrAirport || "",
        arrCity: f.arrCity || "",
        arrDate: f.arrDate || "",
        arrTime: f.arrTime || "",
        pnr: f.pnr || "",
        ticketNo: f.ticketNo || "",
      });
    }
  }
  return out;
}

function rowToArray(r: Record<string, any>) {
  return [
    r.workspace, r.bookingRef, r.originalFilename, r.docType, r.status, r.attempts,
    r.modelUsed, r.validationErrorCount, r.verified ? "Yes" : "No", r.createdAt, r.extractedAt,
    r.passengerName, r.passengerType, r.airline, r.flightNo, r.cabinClass,
    r.depAirport, r.depCity, r.depDate, r.depTime,
    r.arrAirport, r.arrCity, r.arrDate, r.arrTime,
    r.pnr, r.ticketNo,
    // null (not 0) where the engine emitted no number — csvRow and ExcelJS both
    // render that as an empty cell, which is what an unknown must look like in
    // a spreadsheet.
    r.distanceKm, r.aircraftType, r.emissionFactor, r.factorVersion, r.co2eKg,
    r.carbonConfidence, r.carbonStatus, r.methodology,
  ];
}

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

/* ───────────────────────── routes ───────────────────────── */

// GET /api/admin/extracted-documents
// Paginates DOCUMENTS; the returned `rows` are flattened per passenger, so
// rows.length >= documents on the page. `total` counts documents.
router.get("/", async (req: any, res: any) => {
  try {
    const filter = buildFilter(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const [docs, total] = await Promise.all([
      ExtractedDocument.find(filter)
        .select(LIST_PROJECTION)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ExtractedDocument.countDocuments(filter),
    ]);

    const [labels, carbon] = await Promise.all([resolveLabels(docs), loadCarbon(req, docs)]);
    const rows = flattenRows(docs, labels, carbon);

    res.json({
      ok: true,
      rows,
      documents: docs.length,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      columns: MASTER_COLUMNS,
    });
  } catch (err: any) {
    console.error("[ExtractedDocs LIST]", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/admin/extracted-documents/export?format=csv|xlsx
// Same scope + same filter builder as the list. Uncapped where the list
// paginates, but never wider: it cannot contain a row the list would not show.
router.get("/export", async (req: any, res: any) => {
  try {
    const filter = buildFilter(req);
    const format = req.query.format === "xlsx" ? "xlsx" : "csv";

    const docs = await ExtractedDocument.find(filter)
      .select(LIST_PROJECTION)
      .sort({ createdAt: -1 })
      .lean();

    const [labels, carbon] = await Promise.all([resolveLabels(docs), loadCarbon(req, docs)]);
    const rows = flattenRows(docs, labels, carbon);

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="extracted-documents.csv"');
      res.write(csvRow(MASTER_COLUMNS));
      for (const r of rows) res.write(csvRow(rowToArray(r)));
      res.end();
      return;
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Extracted Documents");
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    const headerRow = sheet.addRow(MASTER_COLUMNS);
    headerRow.font = { bold: true };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF0" } };

    const widths = [
      24, 16, 30, 10, 12, 9, 18, 10, 9, 22, 22, 24, 10, 16, 12, 12, 8, 16, 14, 10, 8, 16, 14, 10, 12, 18,
      // Carbon columns. Methodology is a full sentence and is given room rather
      // than being truncated — an unexplained CO2e is the thing this column set
      // exists to prevent.
      13, 13, 15, 16, 12, 16, 18, 120,
    ];
    widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });

    for (const r of rows) sheet.addRow(rowToArray(r));

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", 'attachment; filename="extracted-documents.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err: any) {
    console.error("[ExtractedDocs EXPORT]", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/admin/extracted-documents/workspaces
// The workspace filter's options — only tenants that actually have extracted
// documents, so the dropdown can't offer an empty selection. Same Customer-space
// lookup and same name precedence as resolveLabels above; this had the identical
// CustomerWorkspace mismatch and would have listed raw ObjectIds in the dropdown.
router.get("/workspaces", async (req: any, res: any) => {
  try {
    const ids = await ExtractedDocument.distinct("workspaceId", extractedDocScope(req));
    const customers = ids.length
      ? await Customer.find({ _id: { $in: ids } })
          .select("legalName companyName name")
          .lean()
      : [];
    res.json({
      ok: true,
      workspaces: (customers as any[])
        .map((c) => ({ _id: String(c._id), name: c.legalName || c.companyName || c.name || String(c._id) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (err: any) {
    console.error("[ExtractedDocs WORKSPACES]", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
