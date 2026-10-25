// apps/backend/src/scripts/backfill-cstep-settlement-categories.ts
//
// Finance a+b — sets `category` (and `itemDate` where it has one) on CSTEP
// settlement lines created before lines carried them, by tracing each line
// to its SOURCE record — never by reading its description:
//
//   ARRANGEMENT  → the CstepArrangement's arrangedType
//   REPORT_LEG   → the CstepReportLeg's travelMode (+ fromDate)
//   CLAIM_LINE   → the claim request: the line whose _id is the sourceId in
//                  travelLines (its mode + date) / foodLines (FOOD + date) /
//                  expenseLines (its head, else EXPENSE_LINE + date); a
//                  sourceId that IS the request — a Local Travel Claim's
//                  "Other expenses" (OTHER) or an Expense Claim's tax (TAX),
//                  told apart by the request's formType
//
// The same rules as line creation (models/cstep/expenseCategories.ts). A line
// whose ARRANGEMENT / REPORT_LEG source no longer exists falls back to the
// mode the line itself was seeded with (a copy of the source's mode) and is
// listed as such. A CLAIM_LINE whose sourceId is in none of the claim's
// arrays is UNRESOLVED: listed, never written.
//
// Only lines with no category are touched; a line that already has one is
// left alone. Dry-run by default — prints the plan per workspace and a plan
// id. --apply needs --confirm=<planId>, so what is written is exactly what
// was reviewed (a changed database gives a different id and is refused).
// --apply first writes an undo file (the line ids it set); --undo=<file>
// removes exactly those fields again.
//
// Raw driver only — no models are loaded, so nothing builds an index or
// creates a collection on the target. Writes: one guarded updateOne per line
// (guard: category still absent), on cstepsettlementlines only.
//
// Usage (from apps/backend):
//   tsx src/scripts/backfill-cstep-settlement-categories.ts --expect-db=<db> [--workspaceId=<id>]
//   tsx src/scripts/backfill-cstep-settlement-categories.ts --expect-db=<db> [--workspaceId=<id>] --apply --confirm=<planId>
//   tsx src/scripts/backfill-cstep-settlement-categories.ts --expect-db=<db> --undo=<undo file>
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import {
  categoryOfClaimTravelMode,
  categoryOfExpenseLine,
  categoryOfServiceType,
  type CstepExpenseCategory,
} from "../models/cstep/expenseCategories.js";

export type CategoryChange = {
  lineId: string;
  workspaceId: string;
  requestId: string;
  source: string;
  category: CstepExpenseCategory;
  itemDate?: string;
  /** How it was found — "arrangement", "report leg", "claim travel line", … */
  via: string;
};

export async function planSettlementCategoryBackfill(db: any, workspaceId?: mongoose.Types.ObjectId) {
  const scope = workspaceId ? { workspaceId } : {};
  const lines: any[] = await db
    .collection("cstepsettlementlines")
    .find({ ...scope, category: { $exists: false } })
    .project({ _id: 1, workspaceId: 1, requestId: 1, source: 1, sourceId: 1, mode: 1, itemDate: 1 })
    .sort({ _id: 1 })
    .toArray();

  const ids = (src: string) => [...new Set(lines.filter((l) => l.source === src).map((l) => String(l.sourceId)))].map((s) => new mongoose.Types.ObjectId(s));
  const [arrangements, legs, requests] = await Promise.all([
    db.collection("csteparrangements").find({ _id: { $in: ids("ARRANGEMENT") } }).project({ arrangedType: 1 }).toArray(),
    db.collection("cstepreportlegs").find({ _id: { $in: ids("REPORT_LEG") } }).project({ travelMode: 1, fromDate: 1 }).toArray(),
    db
      .collection("csteptravelrequests")
      .find({ _id: { $in: [...new Set(lines.filter((l) => l.source === "CLAIM_LINE").map((l) => String(l.requestId)))].map((s) => new mongoose.Types.ObjectId(s)) } })
      .project({ formType: 1, travelLines: 1, foodLines: 1, expenseLines: 1 })
      .toArray(),
  ]);
  const arrangementById = new Map<string, any>(arrangements.map((a: any) => [String(a._id), a]));
  const legById = new Map<string, any>(legs.map((l: any) => [String(l._id), l]));
  const requestById = new Map<string, any>(requests.map((r: any) => [String(r._id), r]));

  const changes: CategoryChange[] = [];
  const unresolved: string[] = [];
  for (const l of lines) {
    const base = { lineId: String(l._id), workspaceId: String(l.workspaceId), requestId: String(l.requestId), source: l.source };
    const withDate = (date: any) => (!l.itemDate && date ? { itemDate: String(date) } : {});
    if (l.source === "ARRANGEMENT") {
      const a = arrangementById.get(String(l.sourceId));
      changes.push(
        a
          ? { ...base, category: categoryOfServiceType(a.arrangedType), via: "arrangement" }
          : { ...base, category: categoryOfServiceType(l.mode), via: "arrangement gone — the line's own mode" },
      );
    } else if (l.source === "REPORT_LEG") {
      const leg = legById.get(String(l.sourceId));
      changes.push(
        leg
          ? { ...base, category: categoryOfServiceType(leg.travelMode), ...withDate(leg.fromDate), via: "report leg" }
          : { ...base, category: categoryOfServiceType(l.mode), via: "report leg gone — the line's own mode" },
      );
    } else if (l.source === "CLAIM_LINE") {
      const r = requestById.get(String(l.requestId));
      const sid = String(l.sourceId);
      const find = (arr: any) => (arr || []).find((x: any) => String(x?._id) === sid);
      const travel = r && find(r.travelLines);
      const food = r && find(r.foodLines);
      const expense = r && find(r.expenseLines);
      if (!r) unresolved.push(`${base.lineId}: claim ${base.requestId} not found`);
      else if (travel) changes.push({ ...base, category: categoryOfClaimTravelMode(travel.mode), ...withDate(travel.date), via: "claim travel line" });
      else if (food) changes.push({ ...base, category: "FOOD", ...withDate(food.date), via: "claim food line" });
      else if (expense) changes.push({ ...base, category: categoryOfExpenseLine(expense), ...withDate(expense.date), via: "claim expense line" });
      else if (sid === String(r._id) && r.formType === "LOCAL_TRAVEL_CLAIM") changes.push({ ...base, category: "OTHER", via: "claim other expenses" });
      else if (sid === String(r._id) && r.formType === "EXPENSE_CLAIM") changes.push({ ...base, category: "TAX", via: "claim tax" });
      else unresolved.push(`${base.lineId}: source ${sid} is not a line of claim ${base.requestId}`);
    } else {
      unresolved.push(`${base.lineId}: unknown source ${l.source}`);
    }
  }

  const planId = crypto
    .createHash("sha256")
    .update(JSON.stringify({ ws: workspaceId ? String(workspaceId) : "all", changes, unresolved }))
    .digest("hex")
    .slice(0, 12);
  return { changes, unresolved, planId };
}

/** Writes the plan: one guarded update per line (category still absent). */
export async function applySettlementCategoryBackfill(db: any, changes: CategoryChange[]): Promise<number> {
  let n = 0;
  for (const c of changes) {
    const set: any = { category: c.category, ...(c.itemDate ? { itemDate: c.itemDate } : {}) };
    const r = await db
      .collection("cstepsettlementlines")
      .updateOne(
        { _id: new mongoose.Types.ObjectId(c.lineId), category: { $exists: false }, ...(c.itemDate ? { itemDate: { $exists: false } } : {}) },
        { $set: set },
      );
    if (r.modifiedCount === 1) n++;
    else console.log(`  ! line ${c.lineId}: changed since the plan was read — skipped`);
  }
  return n;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=") || "";
  const expectDb = arg("expect-db");
  const uri = process.env.MONGO_URI || "";
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    const db = mongoose.connection.db!;
    if (!expectDb || db.databaseName !== expectDb) {
      throw new Error(`connected database is "${db.databaseName}", --expect-db is "${expectDb}"`);
    }

    const undoFile = arg("undo");
    if (undoFile) {
      const undo: Array<{ lineId: string; fields: string[] }> = JSON.parse(fs.readFileSync(undoFile, "utf8"));
      let n = 0;
      for (const u of undo) {
        const unset = Object.fromEntries(u.fields.map((f) => [f, 1]));
        const r = await db.collection("cstepsettlementlines").updateOne({ _id: new mongoose.Types.ObjectId(u.lineId) }, { $unset: unset });
        if (r.modifiedCount === 1) n++;
      }
      return console.log(`UNDONE: ${n}/${undo.length} line(s).`);
    }

    const wsArg = arg("workspaceId");
    if (wsArg && !mongoose.isValidObjectId(wsArg)) throw new Error("--workspaceId is not an ObjectId");
    const workspaceId = wsArg ? new mongoose.Types.ObjectId(wsArg) : undefined;

    const plan = await planSettlementCategoryBackfill(db, workspaceId);
    const byWs = new Map<string, Map<string, number>>();
    for (const c of plan.changes) {
      const m = byWs.get(c.workspaceId) || new Map<string, number>();
      m.set(`${c.category} (${c.via})`, (m.get(`${c.category} (${c.via})`) || 0) + 1);
      byWs.set(c.workspaceId, m);
    }
    for (const [ws, m] of byWs) {
      console.log(`workspace ${ws}:`);
      for (const [k, v] of [...m].sort()) console.log(`  ${String(v).padStart(5)}  ${k}`);
    }
    for (const u of plan.unresolved) console.log(`  UNRESOLVED ${u}`);
    const dated = plan.changes.filter((c) => c.itemDate).length;
    console.log(`lines to set=${plan.changes.length} (with a date ${dated}) unresolved=${plan.unresolved.length}  plan id ${plan.planId}`);
    if (!argv.includes("--apply")) return console.log(`DRY RUN — nothing written. Apply exactly this plan with --apply --confirm=${plan.planId}`);
    if (arg("confirm") !== plan.planId) throw new Error(`--confirm does not match plan id ${plan.planId} (data changed since the dry run)`);
    if (!plan.changes.length) return console.log("Nothing to change.");

    const undoPath = path.resolve(`cstep-settlement-categories.undo-${plan.planId}.json`);
    fs.writeFileSync(undoPath, JSON.stringify(plan.changes.map((c) => ({ lineId: c.lineId, fields: c.itemDate ? ["category", "itemDate"] : ["category"] })), null, 1));
    console.log(`undo file written: ${undoPath}`);
    const n = await applySettlementCategoryBackfill(db, plan.changes);
    console.log(`APPLIED: ${n}/${plan.changes.length} line(s).`);
  } finally {
    await mongoose.connection.close();
  }
}

const isDirectRun = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(async (err) => {
    console.error("Settlement category backfill failed:", err?.message || err);
    try { await mongoose.connection.close(); } catch { /* ignore */ }
    process.exit(1);
  });
}
