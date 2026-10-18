// apps/backend/src/scripts/cstep-remap-traveller-ids.ts
//
// Re-maps existing CSTEP travellers onto their employee ids
// (Traveller ID = Employee ID). Deliberately NOT part of the normal bulk
// import, which can only fill a blank id — rewriting ids that are already
// in use is a one-off, reviewed operation.
//
// Input: a CSV with an "Employee ID" column and an "Email" and/or
// "Current ID" column identifying each traveller (both given → must agree).
//
// The whole file is validated before anything is written
// (services/cstepTravellerIds.ts planTravelerIdRemap): blank / overlong
// ids, unknown or ambiguous travellers, a traveller listed twice, an
// employee id used twice in the file, and an id already held by a traveller
// the file does not move. One error and nothing is applied. Swaps and
// chains (A→B while B→C) are fine — apply parks every mover on a temporary
// value first, inside one transaction.
//
// Dry-run by default: prints the full plan and a plan id. Applying needs
// that plan id back, so what gets written is exactly what was reviewed — a
// file or database that changed in between produces a different id and is
// refused.
//
// CustomerMember is never read or written (its travelerId index is global
// across every tenant). Ids are stored trimmed + uppercased, into both
// travelerId and employeeId.
//
// Usage:
//   pnpm -C apps/backend tsx src/scripts/cstep-remap-traveller-ids.ts --workspaceId=<id> --file=map.csv --expect-db=<db>
//   pnpm -C apps/backend tsx src/scripts/cstep-remap-traveller-ids.ts --workspaceId=<id> --file=map.csv --expect-db=<db> --apply --confirm=<planId>
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import {
  isCstepWorkspace,
  parseRemapCsv,
  planTravelerIdRemap,
  applyTravelerIdRemap,
  type RemapPlan,
} from "../services/cstepTravellerIds.js";

export interface RemapArgs {
  workspaceId: string;
  csv: string;
  apply: boolean;
  confirm?: string;
  expectDb: string;
}

/** Prints the plan and, when asked and confirmed, applies it. Assumes a live
 * connection. Returns the plan and whether anything was written. */
export async function runRemap(args: RemapArgs, log: (line: string) => void = console.log): Promise<{ plan: RemapPlan | null; applied: boolean; error?: string }> {
  const fail = (error: string) => {
    log(`REFUSED: ${error}`);
    return { plan: null, applied: false, error };
  };

  const dbName = mongoose.connection.db?.databaseName;
  if (!args.expectDb || dbName !== args.expectDb) {
    return fail(`connected database is "${dbName}", --expect-db is "${args.expectDb || ""}"`);
  }
  if (!mongoose.isValidObjectId(args.workspaceId)) return fail(`--workspaceId=${args.workspaceId} is not an ObjectId`);
  const workspaceId = new mongoose.Types.ObjectId(args.workspaceId);
  if (!(await isCstepWorkspace(workspaceId))) return fail("workspace is not cstepEnabled — this re-map is CSTEP only");

  const parsed = parseRemapCsv(args.csv);
  if (parsed.error) return fail(parsed.error);
  if (!parsed.rows.length) return fail("the file has no data rows");

  const plan = await planTravelerIdRemap(workspaceId, parsed.rows);
  log(`Workspace ${plan.workspaceId} — ${parsed.rows.length} row(s)`);
  log("-".repeat(90));
  for (const c of plan.changes) {
    const fromLabel = c.from || "(blank)";
    const empNote = c.employeeIdFrom && c.employeeIdFrom !== c.from ? ` [employeeId was ${c.employeeIdFrom}]` : "";
    log(`  row ${c.row}: ${c.name} <${c.email || "no email"}>  ${fromLabel} → ${c.to}${c.swap ? "  (swap: id freed by another row)" : ""}${empNote}`);
  }
  for (const u of plan.unchanged) log(`  row ${u.row}: ${u.name}  ${u.travelerId} — already correct, no change`);
  for (const e of plan.errors) log(`  ERROR row ${e.row}: ${e.message}`);
  log("-".repeat(90));
  log(`changes=${plan.changes.length} unchanged=${plan.unchanged.length} errors=${plan.errors.length}`);
  log(`Plan id: ${plan.planId}`);

  if (plan.errors.length) return { plan, applied: false, error: "plan has errors — fix the file; nothing applied" };
  if (!args.apply) {
    log("DRY RUN — nothing written. To apply exactly this plan, re-run with --apply --confirm=" + plan.planId);
    return { plan, applied: false };
  }
  if (args.confirm !== plan.planId) {
    return { ...fail(`--confirm=${args.confirm || ""} does not match plan id ${plan.planId} (the file or data changed since the dry run, or no confirm was given)`), plan };
  }
  if (!plan.changes.length) {
    log("Nothing to change.");
    return { plan, applied: false };
  }
  const { changed } = await applyTravelerIdRemap(plan);
  log(`APPLIED: ${changed} traveller(s) re-mapped.`);
  return { plan, applied: true };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  const file = arg("file");
  if (!file) throw new Error("--file=<csv> is required");
  const { env } = await import("../config/env.js");
  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  try {
    const r = await runRemap({
      workspaceId: arg("workspaceId") || "",
      csv: fs.readFileSync(file, "utf8"),
      apply: argv.includes("--apply"),
      confirm: arg("confirm"),
      expectDb: arg("expect-db") || "",
    });
    if (r.error) process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
}

const isDirectRun = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(async (err) => {
    console.error("Re-map failed:", err?.message || err);
    try {
      await mongoose.connection.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}
