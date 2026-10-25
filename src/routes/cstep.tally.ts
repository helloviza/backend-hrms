// apps/backend/src/routes/cstep.tally.ts
//
// CSTEP Finance — "Export to Tally". Mounted at /api/cstep/tally behind the
// same chain as routes/cstep.ts (requireAuth → requireWorkspace →
// requireFeature("cstepEnabled"); see server.ts).
//
//   GET /settings  — CSTEP Admin: company name, voucher type, the vendor-type
//                    → expense-ledger map, default ledger, the Locations
//                    label / source / location → cost-centre map, the
//                    reimbursement ledgers (below), plus the vendor types,
//                    the expense categories, the locations seen so far and
//                    the next Tally voucher number.
//   PUT /settings  — CSTEP Admin: saves them.
//   GET /export    — Finance (their own travellers) / Admin (everyone), the
//                    same scope as the vendor payables: ?kind=vendor (the
//                    default), reimbursements or both, paid in
//                    ?from=YYYY-MM-DD&to=YYYY-MM-DD (IST dates), as an
//                    .xlsx, sheet "Upload", in the 25-column Tally
//                    journal-upload layout. "both" writes the two kinds into
//                    one sheet.
//
// Vendor payments: each paid line is one journal voucher, two rows sharing
// its number:
//   Dr — the expense ledger mapped from the vendor's type (else the default
//        ledger), the line's INR amount, an auto narration, and the cost
//        centres: Project, the traveller's Department and name, and the
//        Location (label + the mapped code, else the location's own text);
//   Cr — the vendor's own ledger (its Vendor Master name), the same amount
//        and bill-wise New ref with the vendor invoice no. (blank if none).
//        No instrument columns: the payment itself is not in this journal.
//
// Reimbursements (Finance-a Stage 2): each case Finance paid in the range
// (its settlement's paidOn) is one journal voucher. Only what the traveller
// was reimbursed goes in: the settlement's traveller-paid (PERSONAL) lines
// and a Tour's per diem. Company-paid lines, disallowed lines and ₹0 lines
// are left out.
//   Dr — one row per expense ledger (each line's category → its ledger, the
//        tax ledger for TAX, else the reimbursement default ledger), the
//        lines summed, with the same cost centres as a vendor Dr row;
//   Cr — the employee: the control ledger with the employee as cost centre,
//        or the employee's own ledger, bill-wise New ref = the case's
//        reference.
// An Expense Claim with an advance: Dr the expenses (gross), Cr the advance
// ledger (the advance), Cr the employee (the net paid). When the advance was
// more than the expenses (the claimant paid it back), Dr the expenses, Dr the
// employee (the amount owed back), Cr the advance ledger (the advance).
// The cash side (bank) is not in these journals, as with vendor payments.
//
// Nothing is numbered or written while the export can't be complete. A 409
// names what to fix: no company name, a vendor type or an expense category
// with no ledger, a paid vendor line with no amount, an advance with no
// advance ledger, a traveller a per-employee ledger can't be named for, or a
// case whose lines don't add up to the amount it was paid on.
// The voucher number comes from the TALLY series (utils/cstepSequence.ts —
// continuous, settable start via PUT /cstep/sequences/TALLY), shared by both
// kinds. A vendor line or a reimbursement takes its number the first time it
// is exported and keeps it (tallyVoucherNo on the line / the settlement),
// so re-exporting a period gives the same vouchers, not new ones.

import { Router } from "express";
import mongoose from "mongoose";
import CstepArrangement, { arrangementAmountGap } from "../models/cstep/CstepArrangement.js";
import CstepSettlement from "../models/cstep/CstepSettlement.js";
import CstepSettlementLine from "../models/cstep/CstepSettlementLine.js";
import CstepTallySettings, {
  CSTEP_TALLY_DEFAULT_CONTROL_LEDGER,
  CSTEP_TALLY_EMPLOYEE_LEDGER_MODES,
  CSTEP_TALLY_EMPLOYEE_LEDGER_NAMES,
  CSTEP_TALLY_LOCATION_SOURCES,
  type CstepTallyEmployeeLedgerMode,
  type CstepTallyEmployeeLedgerName,
} from "../models/cstep/CstepTallySettings.js";
import CstepTravelRequest, { isClaimFormType } from "../models/cstep/CstepTravelRequest.js";
import CstepVendor from "../models/cstep/CstepVendor.js";
import CstepVendorType from "../models/cstep/CstepVendorType.js";
import {
  CSTEP_EXPENSE_CATEGORIES,
  CSTEP_EXPENSE_CATEGORY_LABEL,
  type CstepExpenseCategory,
} from "../models/cstep/expenseCategories.js";
import Department from "../models/Department.js";
import TravellerProfile from "../models/TravellerProfile.js";
import { ownerId, isCstepAdmin } from "../utils/cstepAccess.js";
import { formatCstepTallyVoucher, nextCstepSerial, peekCstepSerial } from "../utils/cstepSequence.js";
import { istDate } from "../utils/cstepTravelRegister.js";
import { sendSheet } from "../utils/sheetImport.js";
import { requireScope, inScope, SERVICE_LABEL, type Scope } from "./cstep.vendorPayables.js";

const router = Router();

const ARRANGED_FORM_TYPES = ["TOUR_PROPOSAL", "EVENT_REQUEST"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LEN = 200;
const MAX_SPAN_DAYS = 366;

const text = (v: any) => String(v ?? "").trim().replace(/\s+/g, " ");
/** A location as a map key — "Bengaluru", " bengaluru " and "BENGALURU" are one. */
const locationKey = (v: any) => text(v).toLowerCase();
const money = (v: any) => Math.round(Number(v || 0) * 100) / 100;

/** A request's destination: an Event Request's location, an international
 * tour's first country, a domestic tour's first station travelled to. */
export function destinationOf(r: any): string {
  if (r?.formType === "EVENT_REQUEST") return text(r.eventLocation);
  if (r?.type === "INTERNATIONAL") return text((r.countries || []).map((c: any) => text(c?.country)).find(Boolean));
  return text((r?.stations || []).map((s: any) => text(s?.to)).find(Boolean));
}

/* ── settings ─────────────────────────────────────────────────────────── */

export type ReimbursementSettings = {
  defaultLedger: string;
  categoryLedgerMap: Array<{ category: CstepExpenseCategory; ledger: string }>;
  taxLedger: string;
  advanceLedger: string;
  employeeLedgerMode: CstepTallyEmployeeLedgerMode;
  controlLedger: string;
  employeeLedgerName: CstepTallyEmployeeLedgerName;
};

async function loadSettings(workspaceId: any) {
  const doc: any = await CstepTallySettings.findOne({ workspaceId }).lean();
  const r = doc?.reimbursement || {};
  const reimbursement: ReimbursementSettings = {
    defaultLedger: r.defaultLedger || "",
    categoryLedgerMap: ((r.categoryLedgerMap || []) as any[]).map((m) => ({ category: m.category, ledger: m.ledger })),
    taxLedger: r.taxLedger || "",
    advanceLedger: r.advanceLedger || "",
    employeeLedgerMode: r.employeeLedgerMode || "CONTROL",
    controlLedger: r.controlLedger || CSTEP_TALLY_DEFAULT_CONTROL_LEDGER,
    employeeLedgerName: r.employeeLedgerName || "NAME_AND_ID",
  };
  return {
    companyName: doc?.companyName || "",
    voucherType: doc?.voucherType || "Journal",
    defaultLedger: doc?.defaultLedger || "",
    ledgerMap: ((doc?.ledgerMap || []) as any[]).map((m) => ({ vendorTypeId: String(m.vendorTypeId), ledger: m.ledger })),
    locationLabel: doc?.locationLabel || "Locations",
    locationSource: (doc?.locationSource || "BASE") as "BASE" | "DESTINATION",
    locationMap: ((doc?.locationMap || []) as any[]).map((m) => ({ location: m.location, code: m.code })),
    reimbursement,
  };
}
type TallySettings = Awaited<ReturnType<typeof loadSettings>>;

/** The locations a line can carry, so the Admin can map each to a code:
 * travellers' base locations and requests' destinations, distinct by key. */
async function knownLocations(workspaceId: any) {
  const [bases, requests] = await Promise.all([
    TravellerProfile.distinct("workLocation", { workspaceId }),
    CstepTravelRequest.find({ workspaceId, formType: { $in: ARRANGED_FORM_TYPES } })
      .select("formType type stations countries eventLocation")
      .lean(),
  ]);
  const distinct = (values: any[]) => {
    const byKey = new Map<string, string>();
    for (const v of values) if (text(v) && !byKey.has(locationKey(v))) byKey.set(locationKey(v), text(v));
    return [...byKey.values()].sort((a, b) => a.localeCompare(b));
  };
  return { base: distinct(bases as any[]), destination: distinct((requests as any[]).map(destinationOf)) };
}

router.get("/settings", async (req: any, res: any) => {
  try {
    if (!isCstepAdmin(req)) return res.status(403).json({ error: "Only a CSTEP Admin can view the Tally settings" });
    const [settings, types, next, locations] = await Promise.all([
      loadSettings(req.workspaceObjectId),
      CstepVendorType.find({ workspaceId: req.workspaceObjectId }).sort({ name: 1 }).lean(),
      peekCstepSerial(req.workspaceObjectId, "TALLY"),
      knownLocations(req.workspaceObjectId),
    ]);
    res.json({
      ok: true,
      settings,
      vendorTypes: (types as any[]).map((t) => ({ _id: String(t._id), name: t.name, isActive: t.isActive !== false })),
      expenseCategories: CSTEP_EXPENSE_CATEGORIES.map((c) => ({ category: c, label: CSTEP_EXPENSE_CATEGORY_LABEL[c] })),
      locations,
      nextVoucherNo: next.next,
    });
  } catch (err: any) {
    console.error("[CSTEP tally settings GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load the Tally settings" });
  }
});

/** PUT body.reimbursement → what is stored, or the 400 message. */
function parseReimbursementSettings(body: any): ReimbursementSettings | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "reimbursement must be an object";
  const defaultLedger = text(body.defaultLedger);
  const taxLedger = text(body.taxLedger);
  const advanceLedger = text(body.advanceLedger);
  const controlLedger = text(body.controlLedger) || CSTEP_TALLY_DEFAULT_CONTROL_LEDGER;
  for (const [label, v] of [
    ["Default reimbursement ledger", defaultLedger],
    ["Tax (IGST) ledger", taxLedger],
    ["Advance ledger", advanceLedger],
    ["Control ledger", controlLedger],
  ]) {
    if (v.length > MAX_LEN) return `${label} is too long (${MAX_LEN} characters max)`;
  }
  const employeeLedgerMode = body.employeeLedgerMode === undefined || body.employeeLedgerMode === "" ? "CONTROL" : body.employeeLedgerMode;
  if (!(CSTEP_TALLY_EMPLOYEE_LEDGER_MODES as readonly string[]).includes(employeeLedgerMode)) {
    return "Employee ledger must be CONTROL or PER_EMPLOYEE";
  }
  const employeeLedgerName = body.employeeLedgerName === undefined || body.employeeLedgerName === "" ? "NAME_AND_ID" : body.employeeLedgerName;
  if (!(CSTEP_TALLY_EMPLOYEE_LEDGER_NAMES as readonly string[]).includes(employeeLedgerName)) {
    return "Employee ledger name must be NAME, EMPLOYEE_ID or NAME_AND_ID";
  }
  if (body.categoryLedgerMap !== undefined && !Array.isArray(body.categoryLedgerMap)) return "categoryLedgerMap must be a list";
  const categoryLedgerMap: ReimbursementSettings["categoryLedgerMap"] = [];
  const seen = new Set<string>();
  for (const m of body.categoryLedgerMap || []) {
    const category = String(m?.category || "");
    const ledger = text(m?.ledger);
    if (!(CSTEP_EXPENSE_CATEGORIES as readonly string[]).includes(category)) return "Unknown expense category in the ledger map";
    if (category === "TAX") return "Tax goes to the tax (IGST) ledger, not the category map";
    if (!ledger) continue; // blank = unmapped → the default reimbursement ledger
    if (ledger.length > MAX_LEN) return `Ledger names are ${MAX_LEN} characters max`;
    if (seen.has(category)) continue;
    seen.add(category);
    categoryLedgerMap.push({ category: category as CstepExpenseCategory, ledger });
  }
  return {
    defaultLedger,
    categoryLedgerMap,
    taxLedger,
    advanceLedger,
    employeeLedgerMode: employeeLedgerMode as CstepTallyEmployeeLedgerMode,
    controlLedger,
    employeeLedgerName: employeeLedgerName as CstepTallyEmployeeLedgerName,
  };
}

router.put("/settings", async (req: any, res: any) => {
  try {
    if (!isCstepAdmin(req)) return res.status(403).json({ error: "Only a CSTEP Admin can change the Tally settings" });
    const body = req.body || {};
    const companyName = text(body.companyName);
    const voucherType = text(body.voucherType) || "Journal";
    const defaultLedger = text(body.defaultLedger);
    const locationLabel = text(body.locationLabel) || "Locations";
    for (const [label, v] of [["Company name", companyName], ["Voucher type", voucherType], ["Default ledger", defaultLedger], ["Locations label", locationLabel]]) {
      if (v.length > MAX_LEN) return res.status(400).json({ error: `${label} is too long (${MAX_LEN} characters max)` });
    }
    const locationSource = body.locationSource === undefined || body.locationSource === "" ? "BASE" : body.locationSource;
    if (!(CSTEP_TALLY_LOCATION_SOURCES as readonly string[]).includes(locationSource)) {
      return res.status(400).json({ error: "Location source must be BASE or DESTINATION" });
    }

    if (body.ledgerMap !== undefined && !Array.isArray(body.ledgerMap)) {
      return res.status(400).json({ error: "ledgerMap must be a list" });
    }
    const typeIds = new Set(
      ((await CstepVendorType.find({ workspaceId: req.workspaceObjectId }).select("_id").lean()) as any[]).map((t) => String(t._id)),
    );
    const ledgerMap: Array<{ vendorTypeId: mongoose.Types.ObjectId; ledger: string }> = [];
    const seen = new Set<string>();
    for (const m of body.ledgerMap || []) {
      const id = String(m?.vendorTypeId || "");
      const ledger = text(m?.ledger);
      if (!ledger) continue; // blank = unmapped → default ledger
      if (!typeIds.has(id)) return res.status(400).json({ error: "Unknown vendor type in the ledger map" });
      if (ledger.length > MAX_LEN) return res.status(400).json({ error: `Ledger names are ${MAX_LEN} characters max` });
      if (seen.has(id)) continue;
      seen.add(id);
      ledgerMap.push({ vendorTypeId: new mongoose.Types.ObjectId(id), ledger });
    }

    if (body.locationMap !== undefined && !Array.isArray(body.locationMap)) {
      return res.status(400).json({ error: "locationMap must be a list" });
    }
    const locationMap: Array<{ location: string; code: string }> = [];
    const seenLocations = new Set<string>();
    for (const m of body.locationMap || []) {
      const location = text(m?.location);
      const code = text(m?.code);
      if (!location || !code) continue; // blank code = unmapped → the location's own text
      if (location.length > MAX_LEN || code.length > MAX_LEN) {
        return res.status(400).json({ error: `Locations and their codes are ${MAX_LEN} characters max` });
      }
      if (seenLocations.has(locationKey(location))) continue;
      seenLocations.add(locationKey(location));
      locationMap.push({ location, code });
    }

    // The reimbursement block is saved only when it is sent, so a caller
    // that predates it (or sends only the vendor settings) leaves it as is.
    const $set: any = {
      companyName,
      voucherType,
      defaultLedger,
      ledgerMap,
      locationLabel,
      locationSource,
      locationMap,
      updatedBy: new mongoose.Types.ObjectId(ownerId(req)),
    };
    if (body.reimbursement !== undefined) {
      const reimbursement = parseReimbursementSettings(body.reimbursement);
      if (typeof reimbursement === "string") return res.status(400).json({ error: reimbursement });
      $set.reimbursement = reimbursement;
    }

    await CstepTallySettings.findOneAndUpdate(
      { workspaceId: req.workspaceObjectId },
      { $set, $setOnInsert: { workspaceId: req.workspaceObjectId } },
      { upsert: true },
    );
    res.json({ ok: true, settings: await loadSettings(req.workspaceObjectId) });
  } catch (err: any) {
    console.error("[CSTEP tally settings PUT]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to save the Tally settings" });
  }
});

/* ── export ───────────────────────────────────────────────────────────── */

// The Tally journal-upload layout — exact headers, exact order. "Dr/Cr"
// appears twice (the ledger side, then the bill-wise side) and "Locations "
// carries a trailing space, both as the upload template has them.
export const TALLY_COLUMNS = [
  "Company Name", "Voucher Type", "Voucher Number", "Voucher Date", "Ledger Name", "Dr/Cr",
  "Projects", "Project CC", "Department", "Employee Name", "Test Department", "Test Department CC",
  "Locations ", "Location CC", "Amount", "Narration", "Bill Type", "Bill No", "Bill Due Date",
  "Bill Amount", "Dr/Cr", "Inst No", "Inst Date", "Type of Transfer (e-Fund Transfer, Cheque)",
  "Transfer Mode (NEFT/RTGS)",
];
// Text: names, voucher no., Dr/Cr, cost centres and their codes, narration, bill/instrument nos.
const TALLY_TEXT_COLUMNS = [0, 1, 2, 4, 5, 6, 7, 8, 9, 12, 13, 15, 16, 17, 20, 21];
const TALLY_DATE_COLUMNS = [3, 18, 22];

export const TALLY_EXPORT_KINDS = ["vendor", "reimbursements", "both"] as const;
type TallyExportKind = (typeof TALLY_EXPORT_KINDS)[number];

/** IST calendar date → a Date at UTC midnight, which Excel shows as that day. */
const excelDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

/** One voucher to write: the record that holds its number (a vendor line or
 * a settlement), when it was paid (the numbering order), and its rows once
 * it has a number. */
type PendingVoucher = {
  model: mongoose.Model<any>;
  doc: any;
  paidAt: Date;
  rows: (voucherNo: string) => any[][];
};
/** found = how many vouchers the range holds, refused or not (so an empty
 * range is a 404 before any 409); refusal = the 409 body when it can't be
 * written. */
type Built = { found: number; vouchers: PendingVoucher[]; refusal?: any };
const refuse = (found: number, body: any): Built => ({ found, vouchers: [], refusal: body });

/** Gives every voucher without one a TALLY voucher number, in the order
 * given. Each number is taken inside a transaction with a conditional
 * write, so a number is never burnt and two concurrent exports can't number
 * one record twice (the loser re-reads the winner's number). */
async function assignVoucherNumbers(workspaceId: any, vouchers: PendingVoucher[]): Promise<void> {
  for (const { model, doc } of vouchers) {
    if (doc.tallyVoucherNo) continue;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const { seq } = await nextCstepSerial(workspaceId, "TALLY", { session });
        const r = await model.updateOne(
          { _id: doc._id, workspaceId, tallyVoucherNo: { $exists: false } },
          { $set: { tallyVoucherNo: seq } },
          { session },
        );
        if (r.modifiedCount !== 1) throw new Error("ALREADY_NUMBERED");
        doc.tallyVoucherNo = seq;
      });
    } catch (err: any) {
      if (err?.message !== "ALREADY_NUMBERED") throw err;
      const fresh: any = await model.findOne({ _id: doc._id, workspaceId }).select("tallyVoucherNo").lean();
      doc.tallyVoucherNo = fresh?.tallyVoucherNo;
    } finally {
      session.endSession();
    }
  }
}

/** The travellers' names, departments and locations, and the cost-centre
 * columns (Projects … Location CC) a Dr row carries — shared by both kinds. */
async function costCentres(workspaceId: any, settings: TallySettings, requests: any[]) {
  const travellers: any[] = await TravellerProfile.find({
    workspaceId,
    _id: { $in: [...new Set(requests.map((r) => String(r.travelerProfileId)))] },
  })
    .select("_id firstName lastName departmentId workLocation employeeId travelerId")
    .lean();
  const departments: any[] = await Department.find({
    workspaceId,
    _id: { $in: [...new Set(travellers.map((t) => t.departmentId).filter(Boolean).map(String))] },
  })
    .select("_id name")
    .lean();
  const travellerById = new Map(travellers.map((t) => [String(t._id), t]));
  const departmentName = new Map(departments.map((d) => [String(d._id), text(d.name)]));
  const codeByLocation = new Map(settings.locationMap.map((m) => [locationKey(m.location), m.code]));
  const nameOf = (r: any) => {
    const t = travellerById.get(String(r?.travelerProfileId));
    return t ? text([t.firstName, t.lastName].filter(Boolean).join(" ")) : "";
  };
  const employeeIdOf = (r: any) => {
    const t = travellerById.get(String(r?.travelerProfileId));
    return text(t?.employeeId || t?.travelerId);
  };
  /** Projects, Project CC, Department, Employee Name, Test Department, Test
   * Department CC, Locations, Location CC — for a request's Dr row. */
  const drColumns = (r: any) => {
    const traveller = travellerById.get(String(r?.travelerProfileId));
    // Project CC: the picked project's Tally cost-centre code, else its
    // project code; a request from before the Project Master keeps its
    // free-text project.
    const projectCc = r?.projectTallyCC || r?.projectCode || r?.project || "";
    const department = departmentName.get(String(traveller?.departmentId || "")) || "";
    // Location CC: the mapped code for the traveller's base (or the trip's
    // destination, per the settings); an unmapped location goes out as its
    // own text, so the sheet still says where.
    const location = settings.locationSource === "DESTINATION" ? destinationOf(r) : text(traveller?.workLocation);
    const locationCc = location ? codeByLocation.get(locationKey(location)) || location : "";
    return [
      projectCc ? "Projects" : "", projectCc, department, nameOf(r), "", "",
      locationCc ? settings.locationLabel : "", locationCc,
    ];
  };
  return { nameOf, employeeIdOf, drColumns };
}

/* ── vendor payments ──────────────────────────────────────────────────── */

async function vendorVouchers(workspaceId: any, scope: Scope, start: Date, end: Date, settings: TallySettings): Promise<Built> {
  const allLines: any[] = await CstepArrangement.find({
    workspaceId,
    paymentStatus: "PAID",
    vendorId: { $exists: true, $ne: null },
    paidAt: { $gte: start, $lt: end },
  })
    .sort({ paidAt: 1, _id: 1 })
    .lean();

  const requests: any[] = await CstepTravelRequest.find({
    workspaceId,
    _id: { $in: [...new Set(allLines.map((l) => String(l.requestId)))] },
    formType: { $in: ARRANGED_FORM_TYPES },
  })
    .select("_id claimReference travelerProfileId project projectCode projectTallyCC formType type stations countries eventLocation")
    .lean();
  const requestById = new Map(requests.filter((r) => inScope(scope, r.travelerProfileId)).map((r) => [String(r._id), r]));
  const lines = allLines.filter((l) => requestById.has(String(l.requestId)));
  if (!lines.length) return { found: 0, vouchers: [] };

  const [vendors, types, cc] = await Promise.all([
    CstepVendor.find({ workspaceId, _id: { $in: [...new Set(lines.map((l) => String(l.vendorId)))] } })
      .select("_id name vendorTypeId")
      .lean(),
    CstepVendorType.find({ workspaceId }).select("_id name").lean(),
    costCentres(workspaceId, settings, [...requestById.values()]),
  ]);
  const vendorById = new Map((vendors as any[]).map((v) => [String(v._id), v]));
  const typeName = new Map((types as any[]).map((t) => [String(t._id), t.name]));
  const ledgerByType = new Map(settings.ledgerMap.map((m) => [m.vendorTypeId, m.ledger]));
  const typeIdOf = (l: any) => String(vendorById.get(String(l.vendorId))?.vendorTypeId || "");

  // An expense ledger for every line, and an amount on every line.
  if (!settings.defaultLedger) {
    const unmapped = [...new Set(lines.filter((l) => !ledgerByType.get(typeIdOf(l))).map((l) => typeName.get(typeIdOf(l)) || "(no type)"))];
    if (unmapped.length) {
      return refuse(lines.length, {
        error: `No expense ledger for vendor type ${unmapped.join(", ")} — map it, or set a default ledger, in the Tally settings`,
        unmappedTypes: unmapped,
      });
    }
  }
  const noAmount = lines.filter((l) => arrangementAmountGap(l));
  if (noAmount.length) {
    const references = [...new Set(noAmount.map((l) => requestById.get(String(l.requestId))?.claimReference || "(no reference)"))];
    return refuse(lines.length, {
      error: `${noAmount.length} paid vendor line${noAmount.length === 1 ? " has" : "s have"} no amount, on ${references.join(", ")} — Finance or a CSTEP Admin sets it on the request, then export again`,
      missingAmountReferences: references,
    });
  }

  return {
    found: lines.length,
    vouchers: lines.map((l) => ({
      model: CstepArrangement,
      doc: l,
      paidAt: new Date(l.paidAt),
      rows: (voucherNo: string) => {
        const r = requestById.get(String(l.requestId));
        const vendor = vendorById.get(String(l.vendorId));
        const typeId = typeIdOf(l);
        const amount = money(l.amountInr);
        const columns = cc.drColumns(r);
        const [projects, projectCc] = columns;
        const service = l.arrangedType === "OTHER" ? typeName.get(typeId) || "Other" : SERVICE_LABEL[l.arrangedType] || l.arrangedType;
        const narration = ["Being", service, "for", cc.nameOf(r), r?.claimReference || ""].filter(Boolean).join(" ");
        const head = [settings.companyName, settings.voucherType, voucherNo, excelDate(istDate(new Date(l.paidAt)))];
        return [
          [
            ...head, ledgerByType.get(typeId) || settings.defaultLedger, "Dr", ...columns,
            amount, narration, "", "", null, null, "", "", null, "", "",
          ],
          [
            ...head, vendor?.name || l.vendorName || "", "Cr", projects, projectCc,
            "", "", "", "", "", "",
            amount, "", "New ref", l.vendorInvoiceNo || "", null, amount, "Cr", "", null, "", "",
          ],
        ];
      },
    })),
  };
}

/* ── reimbursements ───────────────────────────────────────────────────── */

/** One reimbursed amount: a settlement line, or a Tour's per diem. A line
 * from before the categories (never backfilled) has category null. */
export type ReimbursedItem = { category: CstepExpenseCategory | null; amountInr: number };
export type JournalEntry = {
  role: "EXPENSE" | "EMPLOYEE" | "ADVANCE";
  ledger: string;
  side: "Dr" | "Cr";
  amount: number;
  /** EXPENSE only: the categories summed into this ledger, in list order. */
  categories?: Array<CstepExpenseCategory | null>;
};

/** The expense ledger a category goes to, or "" when it has none. TAX is
 * the tax (IGST) ledger; any category falls back to the default ledger. */
export function reimbursementLedgerOf(category: CstepExpenseCategory | null, s: ReimbursementSettings): string {
  if (category === "TAX") return s.taxLedger || s.defaultLedger;
  return s.categoryLedgerMap.find((m) => m.category === category)?.ledger || s.defaultLedger;
}

/**
 * The reimbursement journal for one case, as ledger entries, Dr first.
 * The traveller's items are summed per expense ledger (Dr). The employee is
 * credited with the gross. With an advance (Expense Claims), the advance
 * ledger is credited with the advance and the employee with only the net.
 * When the advance was more than the expenses, the employee is debited with
 * what they owed back instead. Every amount is in paise-rounded INR, and
 * the entries always balance. unmapped lists the categories with no ledger
 * (only when there is no default ledger).
 */
export function reimbursementJournal(
  items: ReimbursedItem[],
  advanceInr: number,
  employeeLedger: string,
  s: ReimbursementSettings,
): { entries: JournalEntry[]; gross: number; unmapped: Array<CstepExpenseCategory | null> } {
  const order = (c: CstepExpenseCategory | null) => (c ? CSTEP_EXPENSE_CATEGORIES.indexOf(c) : CSTEP_EXPENSE_CATEGORIES.length);
  const sorted = items.filter((i) => money(i.amountInr) > 0).sort((a, b) => order(a.category) - order(b.category));
  const unmapped: Array<CstepExpenseCategory | null> = [];
  const byLedger = new Map<string, JournalEntry>();
  for (const i of sorted) {
    const ledger = reimbursementLedgerOf(i.category, s);
    if (!ledger) {
      if (!unmapped.includes(i.category)) unmapped.push(i.category);
      continue;
    }
    const e = byLedger.get(ledger) || { role: "EXPENSE" as const, ledger, side: "Dr" as const, amount: 0, categories: [] };
    e.amount = money(e.amount + money(i.amountInr));
    if (!e.categories!.includes(i.category)) e.categories!.push(i.category);
    byLedger.set(ledger, e);
  }
  const gross = money(sorted.reduce((sum, i) => sum + money(i.amountInr), 0));
  const advance = money(advanceInr);
  const entries: JournalEntry[] = [...byLedger.values()];
  if (advance > gross) {
    entries.push({ role: "EMPLOYEE", ledger: employeeLedger, side: "Dr", amount: money(advance - gross) });
  }
  if (advance > 0) entries.push({ role: "ADVANCE", ledger: s.advanceLedger, side: "Cr", amount: advance });
  if (gross > advance) entries.push({ role: "EMPLOYEE", ledger: employeeLedger, side: "Cr", amount: money(gross - advance) });
  return { entries, gross, unmapped };
}

/** The employee's ledger: the control ledger, or their own ledger named from
 * the traveller ("" when the name it needs is missing). */
export function employeeLedgerOf(s: ReimbursementSettings, name: string, employeeId: string): string {
  if (s.employeeLedgerMode === "CONTROL") return s.controlLedger;
  if (s.employeeLedgerName === "NAME") return name;
  if (s.employeeLedgerName === "EMPLOYEE_ID") return employeeId;
  return name && employeeId ? `${name} (${employeeId})` : "";
}

const categoryText = (c: CstepExpenseCategory | null) => (c ? CSTEP_EXPENSE_CATEGORY_LABEL[c] : "(no category)");

async function reimbursementVouchers(workspaceId: any, scope: Scope, start: Date, end: Date, settings: TallySettings): Promise<Built> {
  const s = settings.reimbursement;
  const allSettlements: any[] = await CstepSettlement.find({ workspaceId, paidOn: { $gte: start, $lt: end } })
    .sort({ paidOn: 1, _id: 1 })
    .lean();
  // Paid by Finance: REIMBURSED, or a claim SETTLED by the claimant paying
  // back an unspent advance (it has a paid-on date; a case closed with
  // nothing paid has none).
  const requests: any[] = await CstepTravelRequest.find({
    workspaceId,
    _id: { $in: allSettlements.map((x) => x.requestId) },
    status: { $in: ["REIMBURSED", "SETTLED"] },
  })
    .select("_id claimReference travelerProfileId project projectCode projectTallyCC formType type stations countries eventLocation")
    .lean();
  const requestById = new Map(requests.filter((r) => inScope(scope, r.travelerProfileId)).map((r) => [String(r._id), r]));
  const settlements = allSettlements.filter((x) => requestById.has(String(x.requestId)));
  if (!settlements.length) return { found: 0, vouchers: [] };

  const [lines, cc] = await Promise.all([
    CstepSettlementLine.find({ workspaceId, settlementId: { $in: settlements.map((x) => x._id) }, classification: "PERSONAL" })
      .select("settlementId category amountInr financeRejected")
      .sort({ createdAt: 1, _id: 1 })
      .lean(),
    costCentres(workspaceId, settings, [...requestById.values()]),
  ]);
  const linesBySettlement = new Map<string, any[]>();
  for (const l of lines as any[]) {
    const k = String(l.settlementId);
    linesBySettlement.set(k, [...(linesBySettlement.get(k) || []), l]);
  }

  type Case = { settlement: any; request: any; name: string; employeeLedger: string; advance: number; journal: ReturnType<typeof reimbursementJournal> };
  const cases: Case[] = [];
  const unmapped = new Map<string, Set<string>>(); // category label → references
  const noAdvanceLedger: string[] = [];
  const noEmployeeLedger: string[] = [];
  const mismatched: string[] = [];
  for (const settlement of settlements) {
    const request = requestById.get(String(settlement.requestId));
    const reference = request.claimReference || "(no reference)";
    const isClaim = isClaimFormType(request.formType);
    // What the traveller was actually reimbursed: their own lines (not
    // company-paid), not disallowed, above ₹0 — and a Tour's per diem.
    const items: ReimbursedItem[] = (linesBySettlement.get(String(settlement._id)) || [])
      .filter((l) => !l.financeRejected && money(l.amountInr) > 0)
      .map((l) => ({ category: l.category || null, amountInr: money(l.amountInr) }));
    if (!isClaim && !settlement.perDiem?.financeRejected && money(settlement.perDiem?.amountInr) > 0) {
      items.push({ category: "PER_DIEM", amountInr: money(settlement.perDiem.amountInr) });
    }
    const advance = isClaim ? money(settlement.advanceTaken) : 0;
    const name = cc.nameOf(request);
    const employeeLedger = employeeLedgerOf(s, name, cc.employeeIdOf(request));
    const journal = reimbursementJournal(items, advance, employeeLedger, s);
    if (!(journal.gross > 0) && !(advance > 0)) continue; // nothing moved

    for (const c of journal.unmapped) {
      const k = categoryText(c);
      unmapped.set(k, (unmapped.get(k) || new Set()).add(reference));
    }
    if (advance > 0 && !s.advanceLedger) noAdvanceLedger.push(reference);
    if (!employeeLedger) noEmployeeLedger.push(`${name || "(no name)"} on ${reference}`);
    // The journal is built from the lines; the case was paid on the
    // settlement's amountClaimed. They must agree, or the voucher would not
    // match what was paid.
    if (Math.abs(journal.gross - money(settlement.amountClaimed)) > 0.005) mismatched.push(reference);
    cases.push({ settlement, request, name, employeeLedger, advance, journal });
  }

  if (unmapped.size) {
    const categories = [...unmapped.keys()];
    const references = [...new Set([...unmapped.values()].flatMap((x) => [...x]))];
    return refuse(cases.length, {
      error: `No ledger for expense categor${categories.length === 1 ? "y" : "ies"} ${categories.join(", ")} (on ${references.join(", ")}) — map it, or set a default reimbursement ledger, in the Tally settings`,
      unmappedCategories: categories,
      references,
    });
  }
  if (noAdvanceLedger.length) {
    return refuse(cases.length, {
      error: `No advance ledger — ${noAdvanceLedger.join(", ")} cleared an advance; set the advance ledger in the Tally settings`,
      missingSettings: ["advanceLedger"],
      references: noAdvanceLedger,
    });
  }
  if (noEmployeeLedger.length) {
    const needs = s.employeeLedgerName === "NAME" ? "a name" : s.employeeLedgerName === "EMPLOYEE_ID" ? "an employee ID" : "a name and an employee ID";
    return refuse(cases.length, {
      error: `The per-employee ledger needs ${needs} — missing for ${noEmployeeLedger.join("; ")}. Fill it on the traveller, or use the control ledger, in the Tally settings`,
      employeesWithoutLedger: noEmployeeLedger,
    });
  }
  if (mismatched.length) {
    return refuse(cases.length, {
      error: `The reimbursed lines don't add up to the amount paid on ${mismatched.join(", ")} — check the settlement before exporting`,
      mismatchedReferences: mismatched,
    });
  }

  return {
    found: cases.length,
    vouchers: cases.map(({ settlement, request, name, employeeLedger, advance, journal }) => ({
      model: CstepSettlement,
      doc: settlement,
      paidAt: new Date(settlement.paidOn),
      rows: (voucherNo: string) => {
        const reference = request.claimReference || "";
        const columns = cc.drColumns(request);
        const [projects, projectCc] = columns;
        const head = [settings.companyName, settings.voucherType, voucherNo, excelDate(istDate(new Date(settlement.paidOn)))];
        const what = journal.entries
          .flatMap((e) => e.categories || [])
          .map(categoryText)
          .join(", ");
        const narration =
          advance > journal.gross
            ? ["Being advance", String(advance), "settled by", name, reference, what ? `against ${what},` : "", `${money(advance - journal.gross)} recovered`]
            : ["Being", what, "reimbursed to", name, reference, advance > 0 ? `less advance ${advance}` : ""];
        // The employee as cost centre: on the control ledger and the advance
        // ledger, which hold every employee; an employee's own ledger needs none.
        const employeeCc = s.employeeLedgerMode === "CONTROL" ? name : "";
        return journal.entries.map((e, i) => {
          const note = i === 0 ? narration.filter(Boolean).join(" ") : "";
          if (e.role === "EXPENSE") {
            return [...head, e.ledger, "Dr", ...columns, e.amount, note, "", "", null, null, "", "", null, "", ""];
          }
          const ccName = e.role === "ADVANCE" ? name : employeeCc;
          // Bill-wise New ref on the employee, with the case's reference.
          const bill = e.role === "EMPLOYEE" ? ["New ref", reference, null, e.amount, e.side] : ["", "", null, null, ""];
          return [
            ...head, e.ledger, e.side, projects, projectCc, "", ccName, "", "", "", "",
            e.amount, note, ...bill, "", null, "", "",
          ];
        });
      },
    })),
  };
}

/* ── the export route ─────────────────────────────────────────────────── */

router.get("/export", async (req: any, res: any) => {
  try {
    const scope = await requireScope(req, res);
    if (!scope) return;
    const workspaceId = req.workspaceObjectId;

    const kind = (String(req.query.kind || "").trim() || "vendor") as TallyExportKind;
    if (!(TALLY_EXPORT_KINDS as readonly string[]).includes(kind)) {
      return res.status(400).json({ error: "kind must be vendor, reimbursements or both" });
    }
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
      return res.status(400).json({ error: "Choose a paid-on date range (from / to, YYYY-MM-DD)" });
    }
    if (from > to) return res.status(400).json({ error: "The start date is after the end date" });
    const start = new Date(`${from}T00:00:00+05:30`);
    const end = new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 24 * 3600 * 1000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ error: "from / to must be real dates" });
    }
    if ((end.getTime() - start.getTime()) / (24 * 3600 * 1000) > MAX_SPAN_DAYS) {
      return res.status(400).json({ error: `A Tally export covers at most ${MAX_SPAN_DAYS} days` });
    }

    const settings = await loadSettings(workspaceId);
    const built: Built[] = [];
    if (kind !== "reimbursements") built.push(await vendorVouchers(workspaceId, scope, start, end, settings));
    if (kind !== "vendor") built.push(await reimbursementVouchers(workspaceId, scope, start, end, settings));
    if (!built.some((b) => b.found > 0)) {
      const what = { vendor: "vendor payments were", reimbursements: "reimbursements were", both: "vendor payments or reimbursements were" }[kind];
      return res.status(404).json({ error: `No ${what} marked paid between ${from} and ${to}` });
    }
    // Nothing is numbered unless the whole sheet can be written: a company
    // name (every voucher needs it), then each kind's own checks.
    if (!settings.companyName) {
      return res.status(409).json({
        error: "No company name — set it, as it appears in Tally, in the Tally settings",
        missingSettings: ["companyName"],
      });
    }
    const refused = built.find((b) => b.refusal);
    if (refused) return res.status(409).json(refused.refusal);
    const vouchers = built.flatMap((b) => b.vouchers);

    vouchers.sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime() || String(a.doc._id).localeCompare(String(b.doc._id)));
    await assignVoucherNumbers(workspaceId, vouchers);
    vouchers.sort((a, b) => (a.doc.tallyVoucherNo || 0) - (b.doc.tallyVoucherNo || 0));
    const rows = vouchers.flatMap((v) => v.rows(formatCstepTallyVoucher(v.doc.tallyVoucherNo)));

    await sendSheet(res, {
      format: "xlsx",
      filename: { vendor: `cstep-tally-${from}-to-${to}`, reimbursements: `cstep-tally-reimbursements-${from}-to-${to}`, both: `cstep-tally-all-${from}-to-${to}` }[kind],
      sheetName: "Upload",
      columns: TALLY_COLUMNS,
      rows,
      width: 18,
      textColumns: TALLY_TEXT_COLUMNS,
      dateColumns: TALLY_DATE_COLUMNS,
    });
  } catch (err: any) {
    console.error("[CSTEP tally EXPORT]", err?.message);
    if (!res.headersSent) res.status(500).json({ error: err?.message || "Failed to build the Tally export" });
  }
});

export default router;
