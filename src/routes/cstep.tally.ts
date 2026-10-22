// apps/backend/src/routes/cstep.tally.ts
//
// CSTEP Finance — "Export to Tally". Mounted at /api/cstep/tally behind the
// same chain as routes/cstep.ts (requireAuth → requireWorkspace →
// requireFeature("cstepEnabled"); see server.ts).
//
//   GET /settings  — CSTEP Admin: company name, voucher type, the vendor-type
//                    → expense-ledger map, default ledger, the Locations
//                    label / source / location → cost-centre map, plus the
//                    vendor types, the locations seen so far and the next
//                    Tally voucher number.
//   PUT /settings  — CSTEP Admin: saves them.
//   GET /export    — Finance (their own travellers) / Admin (everyone), the
//                    same scope as the vendor payables: paid vendor lines
//                    whose paidAt falls in ?from=YYYY-MM-DD&to=YYYY-MM-DD
//                    (IST dates) as an .xlsx, sheet "Upload", in the
//                    25-column Tally journal-upload layout.
//
// Each paid line is one journal voucher, two rows sharing its number:
//   Dr — the expense ledger mapped from the vendor's type (else the default
//        ledger), the line's INR amount, an auto narration, and the cost
//        centres: Project, the traveller's Department and name, and the
//        Location (label + the mapped code, else the location's own text);
//   Cr — the vendor's own ledger (its Vendor Master name), the same amount
//        and bill-wise New ref with the vendor invoice no. (blank if none).
//        No instrument columns: the payment itself is not in this journal.
// Nothing is numbered or written while the export can't be complete: no
// company name, a vendor type with no ledger, or a line with no amount is a
// 409 naming what to fix.
// The voucher number comes from the TALLY series (utils/cstepSequence.ts —
// continuous, settable start via PUT /cstep/sequences/TALLY). A line takes
// its number the first time it is exported and keeps it (tallyVoucherNo),
// so re-exporting a period gives the same vouchers, not new ones.

import { Router } from "express";
import mongoose from "mongoose";
import CstepArrangement, { arrangementAmountGap } from "../models/cstep/CstepArrangement.js";
import CstepTallySettings, { CSTEP_TALLY_LOCATION_SOURCES } from "../models/cstep/CstepTallySettings.js";
import CstepTravelRequest from "../models/cstep/CstepTravelRequest.js";
import CstepVendor from "../models/cstep/CstepVendor.js";
import CstepVendorType from "../models/cstep/CstepVendorType.js";
import Department from "../models/Department.js";
import TravellerProfile from "../models/TravellerProfile.js";
import { ownerId, isCstepAdmin } from "../utils/cstepAccess.js";
import { formatCstepTallyVoucher, nextCstepSerial, peekCstepSerial } from "../utils/cstepSequence.js";
import { istDate } from "../utils/cstepTravelRegister.js";
import { sendSheet } from "../utils/sheetImport.js";
import { requireScope, inScope, SERVICE_LABEL } from "./cstep.vendorPayables.js";

const router = Router();

const ARRANGED_FORM_TYPES = ["TOUR_PROPOSAL", "EVENT_REQUEST"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LEN = 200;
const MAX_SPAN_DAYS = 366;

const text = (v: any) => String(v ?? "").trim().replace(/\s+/g, " ");
/** A location as a map key — "Bengaluru", " bengaluru " and "BENGALURU" are one. */
const locationKey = (v: any) => text(v).toLowerCase();

/** A request's destination: an Event Request's location, an international
 * tour's first country, a domestic tour's first station travelled to. */
export function destinationOf(r: any): string {
  if (r?.formType === "EVENT_REQUEST") return text(r.eventLocation);
  if (r?.type === "INTERNATIONAL") return text((r.countries || []).map((c: any) => text(c?.country)).find(Boolean));
  return text((r?.stations || []).map((s: any) => text(s?.to)).find(Boolean));
}

/* ── settings ─────────────────────────────────────────────────────────── */

async function loadSettings(workspaceId: any) {
  const doc: any = await CstepTallySettings.findOne({ workspaceId }).lean();
  return {
    companyName: doc?.companyName || "",
    voucherType: doc?.voucherType || "Journal",
    defaultLedger: doc?.defaultLedger || "",
    ledgerMap: ((doc?.ledgerMap || []) as any[]).map((m) => ({ vendorTypeId: String(m.vendorTypeId), ledger: m.ledger })),
    locationLabel: doc?.locationLabel || "Locations",
    locationSource: (doc?.locationSource || "BASE") as "BASE" | "DESTINATION",
    locationMap: ((doc?.locationMap || []) as any[]).map((m) => ({ location: m.location, code: m.code })),
  };
}

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
      locations,
      nextVoucherNo: next.next,
    });
  } catch (err: any) {
    console.error("[CSTEP tally settings GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load the Tally settings" });
  }
});

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

    await CstepTallySettings.findOneAndUpdate(
      { workspaceId: req.workspaceObjectId },
      {
        $set: {
          companyName,
          voucherType,
          defaultLedger,
          ledgerMap,
          locationLabel,
          locationSource,
          locationMap,
          updatedBy: new mongoose.Types.ObjectId(ownerId(req)),
        },
        $setOnInsert: { workspaceId: req.workspaceObjectId },
      },
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

/** IST calendar date → a Date at UTC midnight, which Excel shows as that day. */
const excelDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

/** Gives every line without one a TALLY voucher number, in the order given.
 * Each number is taken inside a transaction with a conditional write, so a
 * number is never burnt and two concurrent exports can't number one line
 * twice (the loser re-reads the winner's number). */
async function assignVoucherNumbers(workspaceId: any, lines: any[]): Promise<void> {
  for (const line of lines) {
    if (line.tallyVoucherNo) continue;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const { seq } = await nextCstepSerial(workspaceId, "TALLY", { session });
        const r = await CstepArrangement.updateOne(
          { _id: line._id, workspaceId, tallyVoucherNo: { $exists: false } },
          { $set: { tallyVoucherNo: seq } },
          { session },
        );
        if (r.modifiedCount !== 1) throw new Error("ALREADY_NUMBERED");
        line.tallyVoucherNo = seq;
      });
    } catch (err: any) {
      if (err?.message !== "ALREADY_NUMBERED") throw err;
      const fresh: any = await CstepArrangement.findOne({ _id: line._id, workspaceId }).select("tallyVoucherNo").lean();
      line.tallyVoucherNo = fresh?.tallyVoucherNo;
    } finally {
      session.endSession();
    }
  }
}

router.get("/export", async (req: any, res: any) => {
  try {
    const scope = await requireScope(req, res);
    if (!scope) return;
    const workspaceId = req.workspaceObjectId;

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
    if (!lines.length) {
      return res.status(404).json({ error: `No vendor payments were marked paid between ${from} and ${to}` });
    }

    const [settings, vendors, types, travellers] = await Promise.all([
      loadSettings(workspaceId),
      CstepVendor.find({ workspaceId, _id: { $in: [...new Set(lines.map((l) => String(l.vendorId)))] } })
        .select("_id name vendorTypeId")
        .lean(),
      CstepVendorType.find({ workspaceId }).select("_id name").lean(),
      TravellerProfile.find({ workspaceId, _id: { $in: [...new Set(requests.map((r) => String(r.travelerProfileId)))] } })
        .select("_id firstName lastName departmentId workLocation")
        .lean(),
    ]);
    const departments: any[] = await Department.find({
      workspaceId,
      _id: { $in: [...new Set((travellers as any[]).map((t) => t.departmentId).filter(Boolean).map(String))] },
    })
      .select("_id name")
      .lean();
    const vendorById = new Map((vendors as any[]).map((v) => [String(v._id), v]));
    const typeName = new Map((types as any[]).map((t) => [String(t._id), t.name]));
    const ledgerByType = new Map(settings.ledgerMap.map((m) => [m.vendorTypeId, m.ledger]));
    const travellerById = new Map((travellers as any[]).map((t) => [String(t._id), t]));
    const nameOf = new Map(
      (travellers as any[]).map((t) => [String(t._id), [t.firstName, t.lastName].filter(Boolean).join(" ").trim()]),
    );
    const departmentName = new Map(departments.map((d) => [String(d._id), text(d.name)]));
    const codeByLocation = new Map(settings.locationMap.map((m) => [locationKey(m.location), m.code]));
    const typeIdOf = (l: any) => String(vendorById.get(String(l.vendorId))?.vendorTypeId || "");

    // Nothing is numbered unless the whole sheet can be written: a company
    // name, an expense ledger for every line, and an amount on every line.
    if (!settings.companyName) {
      return res.status(409).json({
        error: "No company name — set it, as it appears in Tally, in the Tally settings",
        missingSettings: ["companyName"],
      });
    }
    if (!settings.defaultLedger) {
      const unmapped = [...new Set(lines.filter((l) => !ledgerByType.get(typeIdOf(l))).map((l) => typeName.get(typeIdOf(l)) || "(no type)"))];
      if (unmapped.length) {
        return res.status(409).json({
          error: `No expense ledger for vendor type ${unmapped.join(", ")} — map it, or set a default ledger, in the Tally settings`,
          unmappedTypes: unmapped,
        });
      }
    }
    const noAmount = lines.filter((l) => arrangementAmountGap(l));
    if (noAmount.length) {
      const references = [...new Set(noAmount.map((l) => requestById.get(String(l.requestId))?.claimReference || "(no reference)"))];
      return res.status(409).json({
        error: `${noAmount.length} paid vendor line${noAmount.length === 1 ? " has" : "s have"} no amount, on ${references.join(", ")} — Finance or a CSTEP Admin sets it on the request, then export again`,
        missingAmountReferences: references,
      });
    }

    await assignVoucherNumbers(workspaceId, lines);
    lines.sort((a, b) => (a.tallyVoucherNo || 0) - (b.tallyVoucherNo || 0));

    const rows: any[][] = [];
    for (const l of lines) {
      const r = requestById.get(String(l.requestId));
      const traveller = travellerById.get(String(r?.travelerProfileId));
      const vendor = vendorById.get(String(l.vendorId));
      const typeId = typeIdOf(l);
      const amount = Math.round(Number(l.amountInr) * 100) / 100;
      const voucherNo = formatCstepTallyVoucher(l.tallyVoucherNo);
      const paidOn = excelDate(istDate(new Date(l.paidAt)));
      // Project CC: the picked project's Tally cost-centre code, else its
      // project code; a request from before the Project Master keeps its
      // free-text project.
      const projectCc = r?.projectTallyCC || r?.projectCode || r?.project || "";
      const projects = projectCc ? "Projects" : "";
      const department = departmentName.get(String(traveller?.departmentId || "")) || "";
      const employee = nameOf.get(String(r?.travelerProfileId)) || "";
      // Location CC: the mapped code for the traveller's base (or the trip's
      // destination, per the settings); an unmapped location goes out as its
      // own text, so the sheet still says where.
      const location = settings.locationSource === "DESTINATION" ? destinationOf(r) : text(traveller?.workLocation);
      const locationCc = location ? codeByLocation.get(locationKey(location)) || location : "";
      const locations = locationCc ? settings.locationLabel : "";
      const service = l.arrangedType === "OTHER" ? typeName.get(typeId) || "Other" : SERVICE_LABEL[l.arrangedType] || l.arrangedType;
      const narration = ["Being", service, "for", employee, r?.claimReference || ""].filter(Boolean).join(" ");
      const head = [settings.companyName, settings.voucherType, voucherNo, paidOn];

      rows.push([
        ...head, ledgerByType.get(typeId) || settings.defaultLedger, "Dr", projects, projectCc,
        department, employee, "", "", locations, locationCc,
        amount, narration, "", "", null, null, "", "", null, "", "",
      ]);
      rows.push([
        ...head, vendor?.name || l.vendorName || "", "Cr", projects, projectCc,
        "", "", "", "", "", "",
        amount, "", "New ref", l.vendorInvoiceNo || "", null, amount, "Cr", "", null, "", "",
      ]);
    }

    await sendSheet(res, {
      format: "xlsx",
      filename: `cstep-tally-${from}-to-${to}`,
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
