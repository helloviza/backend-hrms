// apps/backend/src/routes/cstep.reimbursements.ts
//
// CSTEP Finance — bulk reimbursement of the finance queue. Mounted at
// /api/cstep/reimbursements behind the same chain as routes/cstep.ts
// (requireAuth → requireWorkspace → requireFeature("cstepEnabled"); see
// server.ts).
//
//   GET  /export          — the caller's reimbursement queue (every case at
//                           TRANSFERRED_TO_FINANCE: Local Travel + Expense
//                           claims and Tour settlements) as an .xlsx that is
//                           ALSO the import template.
//   GET  /template        — the same columns, no rows.
//   POST /import/preview  — dry run, no writes, one outcome per row.
//   POST /import/commit   — the same file re-run against live data.
//
// Who: the traveller's Finance user ONLY — the single-claim reimbursement
// rule (POST /requests/:id/finance/settle). A CSTEP Admin as such is
// refused; an Admin who is also mapped as a traveller's Finance user works
// as that Finance user. Everything is scoped to the travellers the caller
// is the Finance user of (TravellerProfile.financeUserId).
//
// Import, per row: the case by Reference (its claimReference — TIN, LTC…,
// EXP…) read as TEXT; a row with a Paid On date closes the case through the
// same settleFinanceCase the single-claim button uses, at the
// system-computed net — any amount in the sheet is ignored. Paid On and
// Payment Ref are recorded on the settlement; one batch id per upload.
// A case already closed reports "already reimbursed", so re-importing the
// same sheet changes nothing.

import { Router } from "express";
import mongoose from "mongoose";
import CstepSettlement from "../models/cstep/CstepSettlement.js";
import CstepTravelRequest from "../models/cstep/CstepTravelRequest.js";
import TravellerProfile from "../models/TravellerProfile.js";
import { ownerId } from "../utils/cstepAccess.js";
import { istDate } from "../utils/cstepTravelRegister.js";
import { sheetUpload, MAX_SHEET_ROWS, cellToString, readUploadedSheet, forEachSheetRow, sendSheet } from "../utils/sheetImport.js";
import { financeCaseAmount, settleFinanceCase } from "./cstep.js";
import { parsePaidOn, readReference } from "./cstep.vendorPayables.js";

const router = Router();

const QUEUE_FORM_TYPES = ["LOCAL_TRAVEL_CLAIM", "EXPENSE_CLAIM", "TOUR_PROPOSAL"];
const TYPE_LABEL: Record<string, string> = {
  LOCAL_TRAVEL_CLAIM: "Local Travel",
  EXPENSE_CLAIM: "Expense",
  TOUR_PROPOSAL: "Tour",
};

/* ── scope ────────────────────────────────────────────────────────────── */

/** The travellers the caller is the Finance user of — or null (403). */
async function requireFinanceScope(req: any, res: any): Promise<mongoose.Types.ObjectId[] | null> {
  const uid = ownerId(req);
  const mine = mongoose.isValidObjectId(uid)
    ? await TravellerProfile.find({ workspaceId: req.workspaceObjectId, financeUserId: new mongoose.Types.ObjectId(uid) })
        .select("_id")
        .lean()
    : [];
  if (!mine.length) {
    res.status(403).json({ error: "Bulk reimbursement is open to the travellers' Finance users" });
    return null;
  }
  return mine.map((t: any) => t._id);
}

/* ── export = import template ─────────────────────────────────────────── */

const SHEET_COLUMNS = ["Reference", "Traveller", "Type", "Net Amount INR", "Advance INR", "Status", "Paid On", "Payment Ref"];
// Reference, Paid On and Payment Ref are typed as Text: "0001/1026" or a
// long UTR must survive an edit in Excel.
const TEXT_COLUMNS = [0, 6, 7];

const HEADER_FIELD_MAP: Record<string, string> = {
  reference: "reference",
  tin: "reference",
  traveller: "traveller",
  type: "type",
  netamountinr: "netAmount",
  netamount: "netAmount",
  advanceinr: "advance",
  status: "status",
  paidon: "paidOn",
  paymentref: "paymentRef",
  utr: "paymentRef",
};

router.get("/export", async (req: any, res: any) => {
  try {
    const travellerIds = await requireFinanceScope(req, res);
    if (!travellerIds) return;
    const workspaceId = req.workspaceObjectId;
    const docs: any[] = await CstepTravelRequest.find({
      workspaceId,
      status: "TRANSFERRED_TO_FINANCE",
      formType: { $in: QUEUE_FORM_TYPES },
      travelerProfileId: { $in: travellerIds },
    })
      .select("_id claimReference formType travelerProfileId")
      .sort({ updatedAt: 1, _id: 1 })
      .lean();
    const [settlements, travellers] = await Promise.all([
      CstepSettlement.find({ workspaceId, requestId: { $in: docs.map((d) => d._id) } }).lean(),
      TravellerProfile.find({ workspaceId, _id: { $in: travellerIds } }).select("_id firstName lastName").lean(),
    ]);
    const settlementOf = new Map((settlements as any[]).map((s) => [String(s.requestId), s]));
    const nameOf = new Map((travellers as any[]).map((t) => [String(t._id), [t.firstName, t.lastName].filter(Boolean).join(" ").trim()]));

    const rows = docs.map((d) => {
      const { direction, amount, advance } = financeCaseAmount(d.formType, settlementOf.get(String(d._id)));
      return [
        d.claimReference || "",
        nameOf.get(String(d.travelerProfileId)) || "",
        TYPE_LABEL[d.formType] || d.formType,
        amount,
        advance,
        direction === "COLLECT" ? "To collect from the claimant" : "To reimburse",
        "",
        "",
      ];
    });
    rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    await sendSheet(res, {
      format: String(req.query.format || "xlsx").toLowerCase() === "csv" ? "csv" : "xlsx",
      filename: `cstep-reimbursements-${istDate(new Date())}`,
      sheetName: "Reimbursements",
      columns: SHEET_COLUMNS,
      textColumns: TEXT_COLUMNS,
      rows,
    });
  } catch (err: any) {
    console.error("[CSTEP reimbursements EXPORT]", err?.message);
    if (!res.headersSent) res.status(500).json({ error: err?.message || "Failed to export the reimbursement queue" });
  }
});

router.get("/template", async (req: any, res: any) => {
  try {
    if (!(await requireFinanceScope(req, res))) return;
    await sendSheet(res, {
      format: String(req.query.format || "xlsx").toLowerCase() === "csv" ? "csv" : "xlsx",
      filename: "cstep-reimbursements-template",
      sheetName: "Reimbursements",
      columns: SHEET_COLUMNS,
      textColumns: TEXT_COLUMNS,
    });
  } catch (err: any) {
    console.error("[CSTEP reimbursements TEMPLATE]", err?.message);
    if (!res.headersSent) res.status(500).json({ error: err?.message || "Failed to build the template" });
  }
});

/* ── import ───────────────────────────────────────────────────────────── */

export type ReimburseRowOutcomeCode =
  | "REIMBURSED"
  | "UNKNOWN_REFERENCE"
  | "OUT_OF_SCOPE"
  | "ALREADY_REIMBURSED"
  | "NOT_WITH_FINANCE"
  | "NOT_MARKED"
  | "INVALID";
const OUTCOME_CODES: ReimburseRowOutcomeCode[] = [
  "REIMBURSED", "UNKNOWN_REFERENCE", "OUT_OF_SCOPE", "ALREADY_REIMBURSED", "NOT_WITH_FINANCE", "NOT_MARKED", "INVALID",
];

export interface ReimburseRowOutcome {
  rowNumber: number;
  outcome: ReimburseRowOutcomeCode;
  reference?: string;
  type?: string;
  amount?: number; // REIMBURSED: the system-computed figure paid (preview: would pay) / collected
  direction?: "PAY_OUT" | "COLLECT";
  reason?: string;
}

async function processReimburseRows(
  req: any,
  travellerIds: mongoose.Types.ObjectId[],
  rawRows: Record<string, any>[],
  dryRun: boolean,
): Promise<{ results: ReimburseRowOutcome[]; batchId: mongoose.Types.ObjectId | null }> {
  const workspaceId = req.workspaceObjectId;
  const batchId = dryRun ? null : new mongoose.Types.ObjectId();
  const mine = new Set(travellerIds.map(String));
  const results: ReimburseRowOutcome[] = [];
  const seen = new Map<string, number>(); // reference → first row number

  await forEachSheetRow(rawRows, HEADER_FIELD_MAP, async (mapped, rowNumber) => {
    const refRead = readReference(mapped.reference);
    const reference = refRead.value;
    const out = (outcome: ReimburseRowOutcomeCode, extra: Partial<ReimburseRowOutcome> = {}) =>
      void results.push({ rowNumber, outcome, reference: reference || undefined, ...extra });

    const paidRaw = mapped.paidOn;
    if (paidRaw === undefined || paidRaw === null || cellToString(paidRaw) === "") {
      return out("NOT_MARKED", { reason: "No Paid On date — fill it in to reimburse this row" });
    }
    if (refRead.error) return out("INVALID", { reason: refRead.error });
    if (!reference) return out("UNKNOWN_REFERENCE", { reason: "No reference on this row" });

    const doc: any = await CstepTravelRequest.findOne({ workspaceId, claimReference: reference, formType: { $in: QUEUE_FORM_TYPES } });
    if (!doc) return out("UNKNOWN_REFERENCE", { reason: `No Tour or claim with reference ${reference}` });
    const type = TYPE_LABEL[doc.formType];
    if (!mine.has(String(doc.travelerProfileId))) {
      return out("OUT_OF_SCOPE", { type, reason: "You are not this traveller's Finance user" });
    }

    const paid = parsePaidOn(paidRaw);
    if (paid.error) return out("INVALID", { type, reason: paid.error });
    const paymentRef = cellToString(mapped.paymentRef);
    if (paymentRef.length > 100) return out("INVALID", { type, reason: "Payment Ref is too long (100 characters max)" });

    const first = seen.get(reference);
    if (first !== undefined) {
      return out("ALREADY_REIMBURSED", { type, reason: `Same reference as row ${first} of this file — handled there` });
    }
    seen.set(reference, rowNumber);

    if (doc.status === "REIMBURSED" || doc.status === "SETTLED") {
      return out("ALREADY_REIMBURSED", { type, reason: `${reference} is already ${doc.status === "SETTLED" ? "settled" : "reimbursed"}` });
    }
    if (doc.status !== "TRANSFERRED_TO_FINANCE") {
      return out("NOT_WITH_FINANCE", { type, reason: `${reference} is ${doc.status} — not with Finance yet` });
    }

    const settlement: any = await CstepSettlement.findOne({ workspaceId, requestId: doc._id }).lean();
    const { direction, amount } = financeCaseAmount(doc.formType, settlement);
    const sheetAmount = Number(cellToString(mapped.netAmount).replace(/[,₹\s]/g, ""));
    const amountNote =
      cellToString(mapped.netAmount) && Number.isFinite(sheetAmount) && sheetAmount !== amount
        ? ` (the sheet said ${sheetAmount}; the system figure is used)`
        : "";
    const what = direction === "COLLECT" ? `₹${amount} received back — settled` : `₹${amount} reimbursed`;

    if (dryRun) {
      const ready = settlement && (doc.formType === "TOUR_PROPOSAL" ? settlement.status === "FINALIZED" : settlement.status === "VERIFYING");
      if (!ready) return out("NOT_WITH_FINANCE", { type, reason: "Its settlement is not ready for Finance" });
      const will = direction === "COLLECT" ? `Will record ₹${amount} received back — settled` : `Will reimburse ₹${amount}`;
      return out("REIMBURSED", { type, amount, direction, reason: `${will}${amountNote}` });
    }

    const result = await settleFinanceCase(req, doc, {
      reference: paymentRef,
      paidOn: new Date(`${paid.value}T12:00:00+05:30`), // midday IST — the date never slips a day
      source: "IMPORT",
      batchId: batchId!,
    });
    if ("error" in result) {
      return out(result.code === "ALREADY_SETTLED" ? "ALREADY_REIMBURSED" : "NOT_WITH_FINANCE", { type, reason: result.error });
    }
    return out("REIMBURSED", { type, amount: result.amount, direction: result.direction, reason: `${what}${amountNote}` });
  });

  return { results, batchId };
}

async function importStep(req: any, res: any, dryRun: boolean) {
  const travellerIds = await requireFinanceScope(req, res);
  if (!travellerIds) return;
  const sheet = await readUploadedSheet(req.file);
  if (sheet.error !== undefined) return res.status(400).json({ error: sheet.error });
  const { results, batchId } = await processReimburseRows(req, travellerIds, sheet.rows, dryRun);
  const done = results.filter((r) => r.outcome === "REIMBURSED");
  res.json({
    ok: true,
    dryRun,
    batchId: batchId && done.length > 0 ? String(batchId) : null,
    totalRows: results.length,
    maxRows: MAX_SHEET_ROWS,
    reimbursedRows: done.length,
    reimbursedInr: Math.round(done.filter((r) => r.direction !== "COLLECT").reduce((s, r) => s + (r.amount || 0), 0) * 100) / 100,
    counts: Object.fromEntries(OUTCOME_CODES.map((c) => [c, results.filter((r) => r.outcome === c).length])),
    results,
  });
}

router.post("/import/preview", sheetUpload.single("file"), async (req: any, res: any) => {
  try {
    await importStep(req, res, true);
  } catch (err: any) {
    console.error("[CSTEP reimbursements IMPORT PREVIEW]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to read the file" });
  }
});

router.post("/import/commit", sheetUpload.single("file"), async (req: any, res: any) => {
  try {
    await importStep(req, res, false);
  } catch (err: any) {
    console.error("[CSTEP reimbursements IMPORT COMMIT]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to import reimbursements" });
  }
});

export default router;
