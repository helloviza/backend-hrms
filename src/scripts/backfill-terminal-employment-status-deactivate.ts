// apps/backend/src/scripts/backfill-terminal-employment-status-deactivate.ts
//
// Q2 backfill (2026-09-16): users whose `employmentStatus` is already
// terminal (Resigned / Terminated) but whose canonical `User.status` is still
// ACTIVE — the people the value-based coupling would have deactivated had it
// existed when HR recorded their exit. On the 2026-09-16 prod read there were
// 8 of them; one (a MANAGER, exit 2026-07-31) logged in on 2026-09-01.
//
// DEFAULT RUN = LIST ONLY. Nothing is written without --commit, and --commit
// acts on exactly the _ids listed in the same run (re-selected under the same
// filter, so a row that changed in between is skipped, not surprised).
//
//   pnpm -C apps/backend tsx src/scripts/backfill-terminal-employment-status-deactivate.ts
//   pnpm -C apps/backend tsx src/scripts/backfill-terminal-employment-status-deactivate.ts --commit
//
// Reads MONGO_URI from the environment (apps/backend/.env via config/env).
// Writes go through setUserActiveStatus (utils/userActiveStatus) — User.status
// + Employee mirrors + a UserStatusAudit row per person with trigger "script"
// — never a raw update. Nothing else on the person is touched.
import "../config/env.js";
import mongoose from "mongoose";
import User from "../models/User.js";
import Employee from "../models/Employee.js";
import SessionLog from "../models/SessionLog.js";
import {
  TERMINAL_EMPLOYMENT_STATUSES,
  USER_STATUS_INACTIVE,
  isTerminalEmploymentStatus,
  isUserActive,
  setUserActiveStatus,
} from "../utils/userActiveStatus.js";

const COMMIT = process.argv.includes("--commit");
const ACTOR_EMAIL = process.env.BACKFILL_ACTOR_EMAIL || "script:backfill-terminal-employment-status";

const fmt = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : "-");

async function selectCandidates() {
  // Case-insensitive on the stored text — the schema never normalised it.
  const rx = new RegExp(`^\\s*(${TERMINAL_EMPLOYMENT_STATUSES.join("|")})\\s*$`, "i");
  const users = (await User.find({ employmentStatus: rx })
    .select("_id name firstName lastName email employmentStatus status exitDate workspaceId roles lastLoginAt")
    .sort({ email: 1 })
    .lean()) as any[];
  // Belt and braces: the helper's own predicate decides, not the regex.
  return users.filter((u) => isTerminalEmploymentStatus(u.employmentStatus) && isUserActive(u));
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri);
  const host = uri.replace(/\/\/[^@]*@/, "//***@").split("?")[0];
  console.log(`[backfill] connected to ${host}`);
  console.log(`[backfill] mode: ${COMMIT ? "COMMIT — will deactivate the rows below" : "DRY RUN — list only, nothing written"}`);

  const candidates = await selectCandidates();
  console.log(`[backfill] terminal employmentStatus + ACTIVE User.status: ${candidates.length} user(s)\n`);

  const rows: any[] = [];
  for (const u of candidates) {
    const [lastLogin, emp] = await Promise.all([
      SessionLog.findOne({ userId: u._id, event: "LOGIN", success: true }).sort({ createdAt: -1 }).select("createdAt").lean() as any,
      Employee.findOne({ ownerId: u._id }).select("status isActive").lean() as any,
    ]);
    rows.push({
      _id: String(u._id),
      name: u.name || [u.firstName, u.lastName].filter(Boolean).join(" ") || "",
      email: u.email,
      employmentStatus: u.employmentStatus,
      exitDate: u.exitDate || "-",
      lastLogin: fmt(lastLogin?.createdAt ?? u.lastLoginAt),
      roles: (u.roles || []).join("|"),
      employeeMirror: emp ? `${emp.status ?? "?"}/${emp.isActive ?? "?"}` : "no Employee row",
    });
  }
  console.table(rows);

  if (!COMMIT) {
    console.log("\n[backfill] DRY RUN complete. Re-run with --commit to deactivate exactly these _ids.");
    await mongoose.disconnect();
    return;
  }

  console.log("\n[backfill] COMMIT: deactivating through setUserActiveStatus…");
  let changed = 0;
  for (const r of rows) {
    const res = await setUserActiveStatus({
      userId: r._id,
      workspaceId: null, // platform script — the row was selected by _id above
      status: USER_STATUS_INACTIVE,
      audit: { trigger: "script", actorEmail: ACTOR_EMAIL, employmentStatus: r.employmentStatus },
    });
    console.log(`  ${res.changed ? "DEACTIVATED" : "unchanged  "}  ${r.email}  mirrors=${res.employeeMirrorsUpdated}`);
    if (res.changed) changed += 1;
  }
  console.log(`\n[backfill] done — ${changed}/${rows.length} deactivated, ${rows.length - changed} already inactive.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("[backfill] FAILED", err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
