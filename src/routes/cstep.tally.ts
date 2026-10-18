// apps/backend/src/routes/cstep.tally.ts
//
// CSTEP Finance — "Export to Tally". Mounted at /api/cstep/tally behind the
// same chain as routes/cstep.ts (requireAuth → requireWorkspace →
// requireFeature("cstepEnabled"); see server.ts).
//
//   GET /settings  — CSTEP Admin: company name, voucher type, the vendor-type
//                    → expense-ledger map, default ledger, plus the vendor
//                    types and the next Tally voucher number.
//   PUT /settings  — CSTEP Admin: saves them.
//   GET /export    — Finance (their own travellers) / Admin (everyone), the
//                    same scope as the vendor payables: paid vendor lines
//                    whose paidAt falls in ?from=YYYY-MM-DD&to=YYYY-MM-DD
//                    (IST dates) as an .xlsx, sheet "Upload", in the
//                    25-column Tally journal-upload layout.
//
// Each paid line is one journal voucher, two rows sharing its number:
//   Dr — the expense ledger mapped from the vendor's type (else the default
//        ledger), the line's INR amount, an auto narration;
//   Cr — the vendor's own ledger (its Vendor Master name), the same amount,
//        bill-wise New ref (vendor invoice no., else the payment reference)
//        and the payment reference / date as the instrument.
// The voucher number comes from the TALLY series (utils/cstepSequence.ts —
// continuous, settable start via PUT /cstep/sequences/TALLY). A line takes
// its number the first time it is exported and keeps it (tallyVoucherNo),
// so re-exporting a period gives the same vouchers, not new ones.

import { Router } from "express";
import mongoose from "mongoose";
import CstepArrangement from "../models/cstep/CstepArrangement.js";
import CstepTallySettings from "../models/cstep/CstepTallySettings.js";
import CstepTravelRequest from "../models/cstep/CstepTravelRequest.js";
import CstepVendor from "../models/cstep/CstepVendor.js";
import CstepVendorType from "../models/cstep/CstepVendorType.js";
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

/* ── settings ─────────────────────────────────────────────────────────── */

async function loadSettings(workspaceId: any) {
  const doc: any = await CstepTallySettings.findOne({ workspaceId }).lean();
  return {
    companyName: doc?.companyName || "",
    voucherType: doc?.voucherType || "Journal",
    defaultLedger: doc?.defaultLedger || "",
    ledgerMap: ((doc?.ledgerMap || []) as any[]).map((m) => ({ vendorTypeId: String(m.vendorTypeId), ledger: m.ledger })),
  };
}

router.get("/settings", async (req: any, res: any) => {
  try {
    if (!isCstepAdmin(req)) return res.status(403).json({ error: "Only a CSTEP Admin can view the Tally settings" });
    const [settings, types, next] = await Promise.all([
      loadSettings(req.workspaceObjectId),
      CstepVendorType.find({ workspaceId: req.workspaceObjectId }).sort({ name: 1 }).lean(),
      peekCstepSerial(req.workspaceObjectId, "TALLY"),
    ]);
    res.json({
      ok: true,
      settings,
      vendorTypes: (types as any[]).map((t) => ({ _id: String(t._id), name: t.name, isActive: t.isActive !== false })),
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
    const text = (v: any) => String(v ?? "").trim().replace(/\s+/g, " ");
    const companyName = text(body.companyName);
    const voucherType = text(body.voucherType) || "Journal";
    const defaultLedger = text(body.defaultLedger);
    for (const [label, v] of [["Company name", companyName], ["Voucher type", voucherType], ["Default ledger", defaultLedger]]) {
      if (v.length > MAX_LEN) return res.status(400).json({ error: `${label} is too long (${MAX_LEN} characters max)` });
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

    await CstepTallySettings.findOneAndUpdate(
      { workspaceId: req.workspaceObjectId },
      {
        $set: { companyName, voucherType, defaultLedger, ledgerMap, updatedBy: new mongoose.Types.ObjectId(ownerId(req)) },
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
// Text: names, voucher no., Dr/Cr, cost-centre code, narration, bill/instrument nos.
const TALLY_TEXT_COLUMNS = [0, 1, 2, 4, 5, 6, 7, 15, 16, 17, 20, 21];
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
      .select("_id claimReference travelerProfileId project projectCode projectTallyCC")
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
        .select("_id firstName lastName")
        .lean(),
    ]);
    const vendorById = new Map((vendors as any[]).map((v) => [String(v._id), v]));
    const typeName = new Map((types as any[]).map((t) => [String(t._id), t.name]));
    const ledgerByType = new Map(settings.ledgerMap.map((m) => [m.vendorTypeId, m.ledger]));
    const nameOf = new Map(
      (travellers as any[]).map((t) => [String(t._id), [t.firstName, t.lastName].filter(Boolean).join(" ").trim()]),
    );
    const typeIdOf = (l: any) => String(vendorById.get(String(l.vendorId))?.vendorTypeId || "");

    // Every line needs an expense ledger before anything is numbered.
    if (!settings.defaultLedger) {
      const unmapped = [...new Set(lines.filter((l) => !ledgerByType.get(typeIdOf(l))).map((l) => typeName.get(typeIdOf(l)) || "(no type)"))];
      if (unmapped.length) {
        return res.status(409).json({
          error: `No expense ledger for vendor type ${unmapped.join(", ")} — map it, or set a default ledger, in the Tally settings`,
          unmappedTypes: unmapped,
        });
      }
    }

    await assignVoucherNumbers(workspaceId, lines);
    lines.sort((a, b) => (a.tallyVoucherNo || 0) - (b.tallyVoucherNo || 0));

    const rows: any[][] = [];
    for (const l of lines) {
      const r = requestById.get(String(l.requestId));
      const vendor = vendorById.get(String(l.vendorId));
      const typeId = typeIdOf(l);
      const amount = Math.round((Number(l.amountInr) || 0) * 100) / 100;
      const voucherNo = formatCstepTallyVoucher(l.tallyVoucherNo);
      const paidOn = excelDate(istDate(new Date(l.paidAt)));
      // Project CC: the picked project's Tally cost-centre code, else its
      // project code; a request from before the Project Master keeps its
      // free-text project.
      const projectCc = r?.projectTallyCC || r?.projectCode || r?.project || "";
      const projects = projectCc ? "Projects" : "";
      const service = l.arrangedType === "OTHER" ? typeName.get(typeId) || "Other" : SERVICE_LABEL[l.arrangedType] || l.arrangedType;
      const narration = ["Being", service, "for", nameOf.get(String(r?.travelerProfileId)) || "", r?.claimReference || ""]
        .filter(Boolean)
        .join(" ");
      const head = [settings.companyName, settings.voucherType, voucherNo, paidOn];
      const blankMid = ["", "", "", "", "", ""]; // Department … Location CC

      rows.push([
        ...head, ledgerByType.get(typeId) || settings.defaultLedger, "Dr", projects, projectCc, ...blankMid,
        amount, narration, "", "", null, null, "", "", null, "", "",
      ]);
      rows.push([
        ...head, vendor?.name || l.vendorName || "", "Cr", projects, projectCc, ...blankMid,
        amount, "", "New ref", l.vendorInvoiceNo || l.paymentRef || "", null, amount, "Cr", l.paymentRef || "", paidOn, "", "",
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
