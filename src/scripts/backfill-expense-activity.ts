// apps/backend/src/scripts/backfill-expense-activity.ts
//
// Seed synthetic ExpenseActivity history for claims (Reports) that pre-date the
// activity log (B3), reconstructed from the fields we already store:
//   createdAt            → created       (actor = submitter)
//   submittedAt          → submitted     (actor = submitter)
//   approvedAt / status  → approved      (actor = approver; note = decisionNote if any)
//   status declined      → declined      (actor = approver; note = decisionNote)
//   status clarification → clarification_requested (actor = approver; note = decisionNote)
//   reimbursedAt         → reimbursed    (actor = approver)
//
// SAFE BY DEFAULT: dry-run prints the plan and writes nothing. Pass --commit to
// persist. Idempotent: a report that already has ANY activity row is skipped, so
// re-running (or running after live logging started) never duplicates history.
//
//   pnpm -C apps/backend tsx src/scripts/backfill-expense-activity.ts            # dry-run
//   pnpm -C apps/backend tsx src/scripts/backfill-expense-activity.ts --commit   # write
//
// BUILD-only deliverable — do not run as part of this change.

import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import Report from "../models/Report.js";
import User from "../models/User.js";
import ExpenseActivity, { type ExpenseActivityEvent } from "../models/ExpenseActivity.js";

const COMMIT = process.argv.includes("--commit");

type PlannedRow = {
  workspaceId: mongoose.Types.ObjectId;
  reportId: mongoose.Types.ObjectId;
  event: ExpenseActivityEvent;
  actorId?: mongoose.Types.ObjectId; // omitted when unknown (schema-valid BSON)
  actorName: string;
  note?: string | null;
  createdAt: Date;
};

function employeeNameOf(u: any): string {
  if (!u || typeof u !== "object") return "";
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return full || u.name || u.email || "";
}

// Small per-run cache so we resolve each user's name at most once.
const nameCache = new Map<string, string>();
async function nameFor(userId: any): Promise<string> {
  if (!userId) return "System";
  const key = String(userId);
  if (nameCache.has(key)) return nameCache.get(key) as string;
  let name = "System";
  try {
    const u: any = await User.findById(key).select("firstName lastName name email").lean();
    name = employeeNameOf(u) || "System";
  } catch {
    /* keep System */
  }
  nameCache.set(key, name);
  return name;
}

function asObjectId(v: any): mongoose.Types.ObjectId | undefined {
  return v && mongoose.Types.ObjectId.isValid(String(v))
    ? new mongoose.Types.ObjectId(String(v))
    : undefined;
}

async function buildRowsForReport(r: any): Promise<PlannedRow[]> {
  const ws = r.workspaceId as mongoose.Types.ObjectId;
  const rid = r._id as mongoose.Types.ObjectId;
  const submitterId = asObjectId(r.employeeId);
  const approverId = asObjectId(r.approverId);
  const submitterName = await nameFor(r.employeeId);
  const approverName = r.approverId ? await nameFor(r.approverId) : "System";
  const note = r.decisionNote ? String(r.decisionNote) : null;

  const rows: PlannedRow[] = [];

  // created — always (every claim was created).
  rows.push({
    workspaceId: ws,
    reportId: rid,
    event: "created",
    actorId: submitterId,
    actorName: submitterName,
    createdAt: r.createdAt ? new Date(r.createdAt) : new Date(),
  });

  // submitted — anything past draft has been submitted at least once.
  const everSubmitted =
    !!r.submittedAt || ["submitted", "approved", "declined", "clarification_required", "reimbursed"].includes(r.status);
  if (everSubmitted) {
    rows.push({
      workspaceId: ws,
      reportId: rid,
      event: "submitted",
      actorId: submitterId,
      actorName: submitterName,
      createdAt: r.submittedAt ? new Date(r.submittedAt) : new Date(r.createdAt || Date.now()),
    });
  }

  // Decision rows from the terminal/intermediate status. reimbursed implies a
  // prior approval, so synthesize the approved row too.
  if (r.status === "approved" || r.status === "reimbursed") {
    rows.push({
      workspaceId: ws,
      reportId: rid,
      event: "approved",
      actorId: approverId,
      actorName: approverName,
      note: r.selfApproved ? note || "Self-approved by admin" : note,
      createdAt: r.approvedAt ? new Date(r.approvedAt) : new Date(r.submittedAt || r.updatedAt || Date.now()),
    });
  } else if (r.status === "declined") {
    rows.push({
      workspaceId: ws,
      reportId: rid,
      event: "declined",
      actorId: approverId,
      actorName: approverName,
      note,
      createdAt: new Date(r.updatedAt || r.submittedAt || Date.now()),
    });
  } else if (r.status === "clarification_required") {
    rows.push({
      workspaceId: ws,
      reportId: rid,
      event: "clarification_requested",
      actorId: approverId,
      actorName: approverName,
      note,
      createdAt: new Date(r.updatedAt || r.submittedAt || Date.now()),
    });
  }

  // reimbursed — final settlement.
  if (r.status === "reimbursed" || r.reimbursedAt) {
    rows.push({
      workspaceId: ws,
      reportId: rid,
      event: "reimbursed",
      actorId: approverId,
      actorName: approverName,
      createdAt: r.reimbursedAt ? new Date(r.reimbursedAt) : new Date(r.updatedAt || Date.now()),
    });
  }

  // Chronological — the activity timeline reads oldest → newest by createdAt.
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return rows;
}

async function main() {
  await connectDb();
  console.log(`✅ Connected. Mode: ${COMMIT ? "COMMIT (writing)" : "DRY-RUN (no writes)"}`);

  const reports = await Report.find({}).lean();
  console.log(`Found ${reports.length} claim(s).`);

  let skipped = 0;
  let planned = 0;
  let written = 0;
  const eventTally: Record<string, number> = {};

  for (const r of reports as any[]) {
    // Idempotency: never double-seed a claim that already has activity.
    const existing = await ExpenseActivity.countDocuments({ reportId: r._id });
    if (existing > 0) {
      skipped++;
      continue;
    }

    const rows = await buildRowsForReport(r);
    planned += rows.length;
    for (const row of rows) eventTally[row.event] = (eventTally[row.event] || 0) + 1;

    if (!COMMIT) {
      console.log(
        `• ${r.ref || r._id} (${r.status}): ` + rows.map((x) => x.event).join(" → "),
      );
      continue;
    }

    // Persist with timestamps disabled so the synthetic historical createdAt is
    // preserved (the schema would otherwise overwrite it with "now").
    for (const row of rows) {
      const doc = new ExpenseActivity({
        workspaceId: row.workspaceId,
        reportId: row.reportId,
        event: row.event,
        actorId: row.actorId, // ObjectId or undefined (omitted)
        actorName: row.actorName,
        note: row.note ?? null,
        createdAt: row.createdAt,
      });
      await doc.save({ timestamps: false });
      written++;
    }
  }

  console.log("──────────────────────────────────────────");
  console.log(`Claims skipped (already had activity): ${skipped}`);
  console.log(`Rows ${COMMIT ? "written" : "planned"}: ${COMMIT ? written : planned}`);
  console.log("By event:", eventTally);
  if (!COMMIT) console.log("\nDry-run only — re-run with --commit to write.");

  await mongoose.connection.close();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("❌ Backfill failed:", err);
  try {
    await mongoose.connection.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
