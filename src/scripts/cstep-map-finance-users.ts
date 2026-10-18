// apps/backend/src/scripts/cstep-map-finance-users.ts
//
// Bulk-sets each CSTEP traveller's Finance
// user (TravellerProfile.financeUserId) — the same field, and the same
// validation, as the one-at-a-time PATCH /api/workspace/travellers/:id/
// tour-approver the CSTEP Admin uses (resolveCstepMappingSlot: the user must
// exist in this workspace). Since d61c8c10 claim reimbursement is
// Finance-only, so a CSTEP workspace with no Finance mapping cannot close any
// claim; this loads the mapping in one reviewed pass.
//
// Input CSV (header row, any column order, case-insensitive):
//   Employee ID     — the traveller's travelerId          } at least one;
//   Email           — the traveller's email               } both → must agree
//   Finance email   — the Finance user's login email, or CLEAR to remove
//
// The whole file is validated before anything is written; one error and
// nothing is applied:
//   - traveller not found / matched by both columns to different people /
//     listed twice
//   - Finance email blank (use CLEAR to clear on purpose), not a user of this
//     workspace, or that user is inactive
// Dry-run by default: prints every change and a plan id. --apply needs
// --confirm=<planId>, so what is written is exactly what was reviewed — a
// changed file or database gives a different id and is refused.
//
// REVERSIBLE: --apply first writes <file>.undo-<planId>.csv holding every
// changed traveller's PREVIOUS Finance email (or CLEAR). Feeding that file
// back through this script restores the prior mapping exactly.
//
// Writes only financeUserId on TravellerProfile, one guarded update per row
// (the guard is the value the plan read, so a concurrent change is reported,
// not overwritten). No other field, no other collection.
//
// Usage:
//   pnpm -C apps/backend tsx src/scripts/cstep-map-finance-users.ts --workspaceId=<id> --file=finance.csv --expect-db=<db>
//   pnpm -C apps/backend tsx src/scripts/cstep-map-finance-users.ts --workspaceId=<id> --file=finance.csv --expect-db=<db> --apply --confirm=<planId>
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import TravellerProfile from "../models/TravellerProfile.js";
import User from "../models/User.js";
import { activeUserFilter } from "../utils/userActiveStatus.js";
import { isCstepWorkspace, normalizeEmployeeId } from "../services/cstepTravellerIds.js";

const norm = (h: string) => h.trim().toLowerCase().replace(/\s+/g, " ");
const email = (v: any) => String(v ?? "").trim().toLowerCase();

/** Minimal RFC-4180 CSV reader (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

interface Change { row: number; profileId: string; traveller: string; employeeId: string; travellerEmail: string; fromUserId: string | null; fromEmail: string; toUserId: string | null; toEmail: string }

export async function planFinanceMapping(workspaceId: mongoose.Types.ObjectId, csv: string) {
  const errors: string[] = [];
  const changes: Change[] = [];
  const unchanged: string[] = [];
  const grid = parseCsv(csv.replace(/^﻿/, ""));
  const header = (grid.shift() || []).map(norm);
  const col = (n: string) => header.indexOf(n);
  const iEmp = col("employee id"), iEmail = col("email"), iFin = col("finance email");
  if (iFin < 0 || (iEmp < 0 && iEmail < 0)) {
    return { errors: ['header must have "Finance email" and "Employee ID" and/or "Email"'], changes, unchanged, planId: "" };
  }

  const travellers: any[] = await TravellerProfile.find({ workspaceId })
    .select("_id travelerId email firstName lastName financeUserId").lean();
  const byId = new Map(travellers.filter((t) => t.travelerId).map((t) => [String(t.travelerId).toUpperCase(), t]));
  const byEmail = new Map<string, any[]>();
  for (const t of travellers) if (t.email) byEmail.set(email(t.email), [...(byEmail.get(email(t.email)) || []), t]);
  const users: any[] = await User.find({ workspaceId }).select("_id email status").lean();
  const userByEmail = new Map(users.map((u) => [email(u.email), u]));
  const activeIds = new Set(((await User.find({ workspaceId, ...activeUserFilter() }).select("_id").lean()) as any[]).map((u) => String(u._id)));
  const emailOfUser = new Map(users.map((u) => [String(u._id), email(u.email)]));
  const seen = new Map<string, number>();

  grid.forEach((cells, k) => {
    const row = k + 2;
    const emp = iEmp >= 0 ? normalizeEmployeeId(cells[iEmp]) : "";
    const tEmail = iEmail >= 0 ? email(cells[iEmail]) : "";
    const fin = String(cells[iFin] ?? "").trim();
    let t: any = null;
    if (emp) {
      t = byId.get(emp);
      if (!t) return errors.push(`row ${row}: no traveller with Employee ID ${emp}`);
      if (tEmail && email(t.email) !== tEmail) return errors.push(`row ${row}: Employee ID ${emp} belongs to ${t.email || "(no email)"}, not ${tEmail}`);
    } else if (tEmail) {
      const hits = byEmail.get(tEmail) || [];
      if (hits.length !== 1) return errors.push(`row ${row}: ${hits.length ? `${hits.length} travellers share` : "no traveller has"} email ${tEmail}${hits.length ? " — use Employee ID" : ""}`);
      t = hits[0];
    } else return errors.push(`row ${row}: no Employee ID or Email`);
    const pid = String(t._id);
    if (seen.has(pid)) return errors.push(`row ${row}: traveller already listed on row ${seen.get(pid)}`);
    seen.set(pid, row);

    let toUserId: string | null = null;
    if (!fin) return errors.push(`row ${row}: Finance email is blank (write CLEAR to remove a mapping on purpose)`);
    if (fin.toUpperCase() !== "CLEAR") {
      const u = userByEmail.get(email(fin));
      if (!u) return errors.push(`row ${row}: ${fin} is not a user of this workspace`);
      if (!activeIds.has(String(u._id))) return errors.push(`row ${row}: ${fin} is an inactive user`);
      toUserId = String(u._id);
    }
    const fromUserId = t.financeUserId ? String(t.financeUserId) : null;
    const name = [t.firstName, t.lastName].filter(Boolean).join(" ") || t.email || pid;
    if (fromUserId === toUserId) return unchanged.push(`row ${row}: ${name} — already ${toUserId ? emailOfUser.get(toUserId) : "unmapped"}`);
    changes.push({ row, profileId: pid, traveller: `${name} [${t.travelerId || "no id"}]`, employeeId: t.travelerId || "", travellerEmail: email(t.email), fromUserId, fromEmail: fromUserId ? emailOfUser.get(fromUserId) || `(user ${fromUserId})` : "CLEAR", toUserId, toEmail: toUserId ? emailOfUser.get(toUserId)! : "CLEAR" });
  });

  const planId = crypto.createHash("sha256").update(JSON.stringify({ ws: String(workspaceId), changes, unchanged, errors })).digest("hex").slice(0, 12);
  return { errors, changes, unchanged, planId };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=") || "";
  const file = arg("file"), expectDb = arg("expect-db"), apply = argv.includes("--apply");
  if (!file) throw new Error("--file=<csv> is required");
  const { env } = await import("../config/env.js");
  // autoIndex + autoCreate off: importing models must never build indexes or
  // create collections on the target as a side effect. The only writes are
  // the guarded financeUserId updates below.
  await mongoose.connect(env.MONGO_URI, { autoIndex: false, autoCreate: false });
  try {
    const db = mongoose.connection.db?.databaseName;
    if (!expectDb || db !== expectDb) throw new Error(`connected database is "${db}", --expect-db is "${expectDb}"`);
    if (!mongoose.isValidObjectId(arg("workspaceId"))) throw new Error("--workspaceId is not an ObjectId");
    const workspaceId = new mongoose.Types.ObjectId(arg("workspaceId"));
    if (!(await isCstepWorkspace(workspaceId))) throw new Error("workspace is not cstepEnabled");

    const plan = await planFinanceMapping(workspaceId, fs.readFileSync(file, "utf8"));
    for (const c of plan.changes) console.log(`  row ${c.row}: ${c.traveller}  Finance ${c.fromEmail} → ${c.toEmail}`);
    for (const u of plan.unchanged) console.log(`  ${u}`);
    for (const e of plan.errors) console.log(`  ERROR ${e}`);
    console.log(`changes=${plan.changes.length} unchanged=${plan.unchanged.length} errors=${plan.errors.length}  plan id ${plan.planId}`);
    if (plan.errors.length) { process.exitCode = 1; return console.log("Nothing applied — fix the file."); }
    if (!apply) return console.log(`DRY RUN — nothing written. Apply exactly this plan with --apply --confirm=${plan.planId}`);
    if (arg("confirm") !== plan.planId) throw new Error(`--confirm does not match plan id ${plan.planId} (file or data changed since the dry run)`);
    if (!plan.changes.length) return console.log("Nothing to change.");

    const undo = `${file}.undo-${plan.planId}.csv`;
    fs.writeFileSync(undo, ["Employee ID,Email,Finance email", ...plan.changes.map((c) => `${c.employeeId},${c.employeeId ? "" : c.travellerEmail},${c.fromEmail}`)].join("\n") + "\n");
    console.log(`undo file written: ${undo}`);
    let n = 0;
    for (const c of plan.changes) {
      const r = await TravellerProfile.updateOne(
        { _id: c.profileId, workspaceId, financeUserId: c.fromUserId ? new mongoose.Types.ObjectId(c.fromUserId) : { $in: [null] } },
        c.toUserId ? { $set: { financeUserId: new mongoose.Types.ObjectId(c.toUserId) } } : { $unset: { financeUserId: 1 } },
      );
      if (r.modifiedCount === 1) n++;
      else console.log(`  ! row ${c.row}: changed since the plan was read — skipped`);
    }
    console.log(`APPLIED: ${n}/${plan.changes.length} traveller(s).`);
  } finally {
    await mongoose.connection.close();
  }
}

const isDirectRun = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(async (err) => {
    console.error("Finance mapping failed:", err?.message || err);
    try { await mongoose.connection.close(); } catch { /* ignore */ }
    process.exit(1);
  });
}
