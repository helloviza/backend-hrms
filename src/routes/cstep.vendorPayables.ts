// apps/backend/src/routes/cstep.vendorPayables.ts
//
// CSTEP Finance — vendor payables and the bank-payment upload. Mounted at
// /api/cstep/vendor-payables behind the same chain as routes/cstep.ts
// (requireAuth → requireWorkspace → requireFeature("cstepEnabled"); see
// server.ts), in its own file so cstep.ts doesn't grow further.
//
//   GET  /                — one row per vendor-bearing arrangement line on a
//                           Tour Proposal / Event Request from ARRANGING onwards
//                           (CSTEP_VENDOR_PAYABLE_STATUSES); filters
//                           paymentStatus, vendorId, from/to (trip departure).
//   GET  /export          — the same rows as an .xlsx that is ALSO the import
//                           template (Vendor Code … Payment Ref).
//   POST /import/preview  — dry run, no writes, one outcome per row.
//   POST /import/commit   — the same file re-run against live data.
//
// Scope: a CSTEP Admin sees and pays everything in the workspace; a Finance
// user only the travellers they are mapped to (TravellerProfile.
// financeUserId) — the same split as the Travel Register. Anyone else 403.
//
// Import matching, per row: the vendor by Vendor Code; the request by
// Reference = its claimReference (a Tour's TIN or an Event Request's EVR
// reference) read as TEXT — "0001/1026" is never a number or a date, and an
// old-format TIN ("CSTEP-004/1026-2") matches exactly as stored; then every
// arrangement line on that request booked with that vendor that isn't PAID
// yet. All of them flip to PAID with Paid On + Payment Ref from the row,
// paymentSource IMPORT and one paymentBatchId shared by the whole upload,
// and each is logged as a VENDOR_PAYMENT audit entry, as a manual payment is.
// A row whose lines are all paid already reports "already paid", so
// re-importing the same sheet changes nothing.

import { Router } from "express";
import mongoose from "mongoose";
import CstepArrangement, { CSTEP_VENDOR_PAYABLE_STATUSES } from "../models/cstep/CstepArrangement.js";
import CstepApproval from "../models/cstep/CstepApproval.js";
import CstepTravelRequest from "../models/cstep/CstepTravelRequest.js";
import CstepVendor from "../models/cstep/CstepVendor.js";
import TravellerProfile from "../models/TravellerProfile.js";
import { ownerId, isCstepAdmin } from "../utils/cstepAccess.js";
import { istDate } from "../utils/cstepTravelRegister.js";
import {
  sheetUpload,
  MAX_SHEET_ROWS,
  cellToString,
  readUploadedSheet,
  forEachSheetRow,
  sendSheet,
} from "../utils/sheetImport.js";

const router = Router();

const ARRANGED_FORM_TYPES = ["TOUR_PROPOSAL", "EVENT_REQUEST"];
const PAYABLE = new Set<string>(CSTEP_VENDOR_PAYABLE_STATUSES);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const SERVICE_LABEL: Record<string, string> = {
  FLIGHT: "Flight",
  HOTEL: "Hotel",
  CAB: "Cab",
  TRAIN: "Train",
  BUS: "Bus",
  VISA: "Visa",
  FOREX: "Forex",
  STATIONERY: "Stationery",
  OTHER: "Other",
};

/* ── scope ────────────────────────────────────────────────────────────── */

/** all = Admin (every traveller); otherwise only `travellerIds`. */
export type Scope = { all: boolean; travellerIds: mongoose.Types.ObjectId[] };

/** Admin → everything; a Finance user → their mapped travellers; anyone
 * else → null (the caller answers 403). */
async function resolveScope(req: any): Promise<Scope | null> {
  if (isCstepAdmin(req)) return { all: true, travellerIds: [] };
  const uid = ownerId(req);
  if (!mongoose.isValidObjectId(uid)) return null;
  const mine = await TravellerProfile.find({
    workspaceId: req.workspaceObjectId,
    financeUserId: new mongoose.Types.ObjectId(uid),
  })
    .select("_id")
    .lean();
  if (!mine.length) return null;
  return { all: false, travellerIds: mine.map((t: any) => t._id) };
}

export async function requireScope(req: any, res: any): Promise<Scope | null> {
  const scope = await resolveScope(req);
  if (!scope) res.status(403).json({ error: "Vendor payments are open to CSTEP Admin and Finance users" });
  return scope;
}

export const inScope = (scope: Scope, travelerProfileId: any) =>
  scope.all || scope.travellerIds.some((id) => String(id) === String(travelerProfileId));

/* ── payables ─────────────────────────────────────────────────────────── */

export interface PayableRow {
  lineId: string;
  requestId: string;
  reference: string;
  formType: string;
  requestStatus: string;
  traveller: string;
  departureDate: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  service: string;
  details: string;
  amountInr: number | null;
  paymentStatus: "UNPAID" | "PAID";
  paidOn: string; // "YYYY-MM-DD" (IST) or ""
  paymentRef: string;
  paymentSource: string;
  paymentBatchId: string;
}

async function loadPayables(
  req: any,
  scope: Scope,
  q: { paymentStatus?: string; vendorId?: string; from?: string; to?: string },
): Promise<PayableRow[]> {
  const workspaceId = req.workspaceObjectId;
  const requestFilter: any = {
    workspaceId,
    formType: { $in: ARRANGED_FORM_TYPES },
    status: { $in: [...PAYABLE] },
  };
  if (!scope.all) requestFilter.travelerProfileId = { $in: scope.travellerIds };
  if (q.from || q.to) {
    requestFilter.departureDate = {};
    if (q.from) requestFilter.departureDate.$gte = q.from;
    if (q.to) requestFilter.departureDate.$lte = q.to;
  }
  const requests: any[] = await CstepTravelRequest.find(requestFilter)
    .select("_id claimReference formType status travelerProfileId departureDate")
    .lean();
  if (!requests.length) return [];

  const lineFilter: any = {
    workspaceId,
    requestId: { $in: requests.map((r) => r._id) },
    vendorId: { $exists: true, $ne: null },
  };
  // A row written before paymentStatus existed has no field at all — it is
  // unpaid, so "UNPAID" is "not PAID" rather than an equality match.
  if (q.paymentStatus === "PAID") lineFilter.paymentStatus = "PAID";
  if (q.paymentStatus === "UNPAID") lineFilter.paymentStatus = { $ne: "PAID" };
  if (q.vendorId) lineFilter.vendorId = new mongoose.Types.ObjectId(q.vendorId);
  const lines: any[] = await CstepArrangement.find(lineFilter).sort({ createdAt: 1, _id: 1 }).lean();

  const travellers: any[] = await TravellerProfile.find({
    workspaceId,
    _id: { $in: [...new Set(requests.map((r) => String(r.travelerProfileId)))] },
  })
    .select("_id firstName lastName")
    .lean();
  const nameOf = new Map(travellers.map((t) => [String(t._id), [t.firstName, t.lastName].filter(Boolean).join(" ").trim()]));
  const requestById = new Map(requests.map((r) => [String(r._id), r]));

  const rows: PayableRow[] = lines.map((l) => {
    const r = requestById.get(String(l.requestId));
    const paid = l.paymentStatus === "PAID";
    return {
      lineId: String(l._id),
      requestId: String(l.requestId),
      reference: r?.claimReference || "",
      formType: r?.formType || "",
      requestStatus: r?.status || "",
      traveller: nameOf.get(String(r?.travelerProfileId)) || "",
      departureDate: r?.departureDate || "",
      vendorId: String(l.vendorId),
      vendorCode: l.vendorCode || "",
      vendorName: l.vendorName || "",
      service: SERVICE_LABEL[l.arrangedType] || l.arrangedType,
      details: l.details || "",
      amountInr: typeof l.amountInr === "number" ? l.amountInr : null,
      paymentStatus: paid ? "PAID" : "UNPAID",
      paidOn: paid && l.paidAt ? istDate(new Date(l.paidAt)) : "",
      paymentRef: paid ? l.paymentRef || "" : "",
      paymentSource: paid ? l.paymentSource || "" : "",
      paymentBatchId: paid && l.paymentBatchId ? String(l.paymentBatchId) : "",
    };
  });
  rows.sort(
    (a, b) =>
      a.vendorName.localeCompare(b.vendorName) ||
      a.reference.localeCompare(b.reference) ||
      a.departureDate.localeCompare(b.departureDate),
  );
  return rows;
}

/** The query's filters, validated — or the 400 message. */
function readFilters(query: any): { filters: { paymentStatus?: string; vendorId?: string; from?: string; to?: string } } | { error: string } {
  const paymentStatus = String(query.paymentStatus || "").toUpperCase();
  if (paymentStatus && paymentStatus !== "PAID" && paymentStatus !== "UNPAID") {
    return { error: "paymentStatus must be PAID or UNPAID" };
  }
  const vendorId = String(query.vendorId || "").trim();
  if (vendorId && !mongoose.isValidObjectId(vendorId)) return { error: "Invalid vendorId" };
  const from = String(query.from || "").trim();
  const to = String(query.to || "").trim();
  if ((from && !ISO_DATE.test(from)) || (to && !ISO_DATE.test(to))) return { error: "from / to must be YYYY-MM-DD" };
  return { filters: { paymentStatus: paymentStatus || undefined, vendorId: vendorId || undefined, from: from || undefined, to: to || undefined } };
}

router.get("/", async (req: any, res: any) => {
  try {
    const scope = await requireScope(req, res);
    if (!scope) return;
    const parsed = readFilters(req.query);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    const rows = await loadPayables(req, scope, parsed.filters);
    const unpaid = rows.filter((r) => r.paymentStatus === "UNPAID");
    res.json({
      ok: true,
      scope: scope.all ? "ALL" : "MINE",
      rows,
      totals: {
        lines: rows.length,
        unpaidLines: unpaid.length,
        unpaidInr: Math.round(unpaid.reduce((s, r) => s + (r.amountInr || 0), 0) * 100) / 100,
      },
    });
  } catch (err: any) {
    console.error("[CSTEP vendor-payables GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load vendor payables" });
  }
});

/* ── export = import template ─────────────────────────────────────────── */

const SHEET_COLUMNS = [
  "Vendor Code", "Vendor Name", "Reference", "Traveller", "Service", "Amount INR", "Payment Status", "Paid On", "Payment Ref",
];
// Vendor Code, Reference, Paid On and Payment Ref are typed as Text: a
// reference like 0001/1026 or a long UTR must survive an edit in Excel.
const TEXT_COLUMNS = [0, 2, 7, 8];

const HEADER_FIELD_MAP: Record<string, string> = {
  vendorcode: "vendorCode",
  vendorname: "vendorName",
  reference: "reference",
  tin: "reference",
  traveller: "traveller",
  service: "service",
  amountinr: "amountInr",
  paymentstatus: "paymentStatus",
  paidon: "paidOn",
  paymentref: "paymentRef",
  utr: "paymentRef",
};

router.get("/export", async (req: any, res: any) => {
  try {
    const scope = await requireScope(req, res);
    if (!scope) return;
    const parsed = readFilters(req.query);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    const rows = await loadPayables(req, scope, parsed.filters);
    const format = String(req.query.format || "xlsx").toLowerCase() === "csv" ? "csv" : "xlsx";
    await sendSheet(res, {
      format,
      filename: `cstep-vendor-payables-${istDate(new Date())}`,
      sheetName: "Vendor payables",
      columns: SHEET_COLUMNS,
      textColumns: TEXT_COLUMNS,
      rows: rows.map((r) => [
        r.vendorCode,
        r.vendorName,
        r.reference,
        r.traveller,
        r.details ? `${r.service} — ${r.details}` : r.service,
        r.amountInr,
        r.paymentStatus === "PAID" ? "Paid" : "Unpaid",
        r.paidOn,
        r.paymentRef,
      ]),
    });
  } catch (err: any) {
    console.error("[CSTEP vendor-payables EXPORT]", err?.message);
    if (!res.headersSent) res.status(500).json({ error: err?.message || "Failed to export vendor payables" });
  }
});

/* GET /template — the import columns with no rows, for format reference.
 * The export above remains the working sheet (it carries the real unpaid
 * rows); same scope gate. */
router.get("/template", async (req: any, res: any) => {
  try {
    const scope = await requireScope(req, res);
    if (!scope) return;
    await sendSheet(res, {
      format: String(req.query.format || "xlsx").toLowerCase() === "csv" ? "csv" : "xlsx",
      filename: "cstep-vendor-payments-template",
      sheetName: "Vendor payables",
      columns: SHEET_COLUMNS,
      textColumns: TEXT_COLUMNS,
    });
  } catch (err: any) {
    console.error("[CSTEP vendor-payables TEMPLATE]", err?.message);
    if (!res.headersSent) res.status(500).json({ error: err?.message || "Failed to build the template" });
  }
});

/* ── import ───────────────────────────────────────────────────────────── */

export type PaymentRowOutcomeCode =
  | "PAID"
  | "UNKNOWN_VENDOR"
  | "UNKNOWN_REFERENCE"
  | "OUT_OF_SCOPE"
  | "NO_UNPAID_LINES"
  | "ALREADY_PAID"
  | "NOT_MARKED_PAID"
  | "INVALID";

export interface PaymentRowOutcome {
  rowNumber: number;
  outcome: PaymentRowOutcomeCode;
  vendorCode?: string;
  reference?: string;
  paidLines?: number; // PAID: how many lines flipped (preview: would flip)
  reason?: string;
}

/** Paid On as "YYYY-MM-DD": an Excel date, an Excel date serial (a date
 * typed into a cell that isn't formatted as a date reads back as the bare
 * day number), or text YYYY-MM-DD / DD-MM-YYYY / DD/MM/YYYY / DD.MM.YYYY. */
export function parsePaidOn(raw: any): { value?: string; error?: string } {
  if (raw === undefined || raw === null || raw === "") return {};
  let y: number, m: number, d: number;
  if (typeof raw === "number" && raw > 20000 && raw < 80000) {
    // Excel day serial: day 0 = 1899-12-30 (keeps Excel's 1900 leap-year quirk out of range).
    raw = new Date(Date.UTC(1899, 11, 30) + Math.floor(raw) * 86400000);
  }
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { error: "Paid On is not a valid date" };
    y = raw.getUTCFullYear();
    m = raw.getUTCMonth() + 1;
    d = raw.getUTCDate();
  } else {
    const s = cellToString(raw);
    if (!s) return {};
    let mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (mt) [y, m, d] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
    else if ((mt = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) [d, m, y] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
    else return { error: `Paid On "${s}" isn't a date — use YYYY-MM-DD or DD/MM/YYYY` };
  }
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso) return { error: `Paid On ${iso} isn't a real date` };
  if (iso > istDate(new Date())) return { error: `Paid On ${iso} is in the future` };
  return { value: iso };
}

/** The Reference cell as text, exactly as written. A cell Excel has turned
 * into a date or a number (every reference has a "/", so a bare number never
 * is one) is refused with a hint rather than guessed back. */
export function readReference(raw: any): { value: string; error?: string } {
  if (raw instanceof Date) {
    return { value: "", error: "Reference was read as a date — format the Reference column as Text and type it again" };
  }
  if (typeof raw === "number") {
    return { value: "", error: "Reference was read as a number — format the Reference column as Text and type it again" };
  }
  return { value: cellToString(raw) };
}

async function processPaymentRows(
  req: any,
  scope: Scope,
  rawRows: Record<string, any>[],
  dryRun: boolean,
): Promise<{ results: PaymentRowOutcome[]; batchId: mongoose.Types.ObjectId | null }> {
  const workspaceId = req.workspaceObjectId;
  const uid = new mongoose.Types.ObjectId(ownerId(req));
  const batchId = dryRun ? null : new mongoose.Types.ObjectId();
  const results: PaymentRowOutcome[] = [];
  const vendorByCode = new Map<string, any>();
  const requestsByRef = new Map<string, any[]>();
  const pairRows = new Map<string, number>(); // `${vendorId}|${reference}` → first row number

  await forEachSheetRow(rawRows, HEADER_FIELD_MAP, async (mapped, rowNumber) => {
    const vendorCode = cellToString(mapped.vendorCode).toUpperCase();
    const refRead = readReference(mapped.reference);
    const reference = refRead.value;
    const out = (outcome: PaymentRowOutcomeCode, reason?: string, paidLines?: number) =>
      void results.push({
        rowNumber,
        outcome,
        vendorCode: vendorCode || undefined,
        reference: reference || undefined,
        ...(paidLines !== undefined ? { paidLines } : {}),
        ...(reason ? { reason } : {}),
      });

    // A row pays only when the sheet says so: Paid On filled, or Payment
    // Status "Paid". The export's untouched Unpaid rows are left alone.
    const statusCell = cellToString(mapped.paymentStatus).toLowerCase();
    const paidOnRead = parsePaidOn(mapped.paidOn);
    const marked = !!paidOnRead.value || !!paidOnRead.error || statusCell === "paid";
    if (!marked) return out("NOT_MARKED_PAID", "Not marked paid — fill in Paid On to pay this row");

    if (!vendorCode) return out("UNKNOWN_VENDOR", "Vendor Code is required");
    if (!vendorByCode.has(vendorCode)) {
      vendorByCode.set(vendorCode, await CstepVendor.findOne({ workspaceId, vendorCode }).select("_id vendorCode name").lean());
    }
    const vendor = vendorByCode.get(vendorCode);
    if (!vendor) return out("UNKNOWN_VENDOR", `No vendor with code ${vendorCode}`);

    if (refRead.error) return out("UNKNOWN_REFERENCE", refRead.error);
    if (!reference) return out("UNKNOWN_REFERENCE", "Reference is required");
    if (!requestsByRef.has(reference)) {
      requestsByRef.set(
        reference,
        await CstepTravelRequest.find({ workspaceId, claimReference: reference, formType: { $in: ARRANGED_FORM_TYPES } })
          .select("_id claimReference status travelerProfileId")
          .lean(),
      );
    }
    const requests = requestsByRef.get(reference)!;
    if (!requests.length) return out("UNKNOWN_REFERENCE", `No Tour or Event Request with reference ${reference}`);
    const scoped = requests.filter((r) => inScope(scope, r.travelerProfileId));
    if (!scoped.length) return out("OUT_OF_SCOPE", `${reference} is not one of your travellers' requests`);

    if (paidOnRead.error) return out("INVALID", paidOnRead.error);
    if (!paidOnRead.value) return out("INVALID", "Paid On is required to mark a row paid");
    const paymentRef = cellToString(mapped.paymentRef);
    if (paymentRef.length > 100) return out("INVALID", "Payment Ref is too long (100 characters max)");

    const payable = scoped.filter((r) => PAYABLE.has(r.status));
    if (!payable.length) {
      return out("NO_UNPAID_LINES", `${reference} is ${scoped[0].status} — vendor payments are recorded once it is being arranged`);
    }

    const pairKey = `${vendor._id}|${reference}`;
    if (pairRows.has(pairKey)) {
      return out("ALREADY_PAID", `Same vendor and reference as row ${pairRows.get(pairKey)} of this file — paid there`);
    }
    pairRows.set(pairKey, rowNumber);

    const lines: any[] = await CstepArrangement.find({
      workspaceId,
      requestId: { $in: payable.map((r) => r._id) },
      vendorId: vendor._id,
    })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    if (!lines.length) return out("NO_UNPAID_LINES", `No arrangement line on ${reference} is booked with ${vendorCode}`);
    const unpaid = lines.filter((l) => l.paymentStatus !== "PAID");
    if (!unpaid.length) return out("ALREADY_PAID", `All ${lines.length} line(s) for ${vendorCode} on ${reference} are already paid`);

    if (dryRun) return out("PAID", undefined, unpaid.length);

    const paidAt = new Date(`${paidOnRead.value}T12:00:00+05:30`); // midday IST, as a manual payment
    let flipped = 0;
    for (const l of unpaid) {
      // Conditional on still being unpaid, so a concurrent manual payment
      // (or a second upload racing this one) is never overwritten.
      const updated: any = await CstepArrangement.findOneAndUpdate(
        { _id: l._id, workspaceId, paymentStatus: { $ne: "PAID" } },
        {
          $set: {
            paymentStatus: "PAID",
            paidAt,
            paidBy: uid,
            paymentRef: paymentRef || undefined,
            paymentSource: "IMPORT",
            paymentBatchId: batchId,
          },
        },
        { new: true },
      ).lean();
      if (!updated) continue;
      flipped++;
      await CstepApproval.create({
        workspaceId,
        entityType: "REQUEST",
        entityId: updated.requestId,
        stage: "FINANCE",
        actor: uid,
        action: "VENDOR_PAYMENT",
        comment:
          `${updated.arrangedType} — ${updated.vendorCode} ${updated.vendorName}: UNPAID => PAID` +
          (paymentRef ? ` | Ref: ${paymentRef}` : "") +
          ` | Paid on ${paidOnRead.value} | Import batch ${batchId}`,
        at: new Date().toISOString(),
      });
    }
    if (!flipped) return out("ALREADY_PAID", `All line(s) for ${vendorCode} on ${reference} were paid meanwhile`);
    out("PAID", undefined, flipped);
  });

  return { results, batchId };
}

async function importStep(req: any, res: any, dryRun: boolean) {
  const scope = await requireScope(req, res);
  if (!scope) return;
  const sheet = await readUploadedSheet(req.file);
  if (sheet.error !== undefined) return res.status(400).json({ error: sheet.error });
  const { results, batchId } = await processPaymentRows(req, scope, sheet.rows, dryRun);
  const count = (o: PaymentRowOutcomeCode) => results.filter((r) => r.outcome === o).length;
  const paidLines = results.reduce((s, r) => s + (r.outcome === "PAID" ? r.paidLines || 0 : 0), 0);
  res.json({
    ok: true,
    dryRun,
    batchId: batchId && paidLines > 0 ? String(batchId) : null,
    totalRows: results.length,
    maxRows: MAX_SHEET_ROWS,
    paidRows: count("PAID"),
    paidLines,
    counts: {
      PAID: count("PAID"),
      UNKNOWN_VENDOR: count("UNKNOWN_VENDOR"),
      UNKNOWN_REFERENCE: count("UNKNOWN_REFERENCE"),
      OUT_OF_SCOPE: count("OUT_OF_SCOPE"),
      NO_UNPAID_LINES: count("NO_UNPAID_LINES"),
      ALREADY_PAID: count("ALREADY_PAID"),
      NOT_MARKED_PAID: count("NOT_MARKED_PAID"),
      INVALID: count("INVALID"),
    },
    results,
  });
}

router.post("/import/preview", sheetUpload.single("file"), async (req: any, res: any) => {
  try {
    await importStep(req, res, true);
  } catch (err: any) {
    console.error("[CSTEP vendor-payables IMPORT PREVIEW]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to read the file" });
  }
});

router.post("/import/commit", sheetUpload.single("file"), async (req: any, res: any) => {
  try {
    await importStep(req, res, false);
  } catch (err: any) {
    console.error("[CSTEP vendor-payables IMPORT COMMIT]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to import vendor payments" });
  }
});

export default router;
