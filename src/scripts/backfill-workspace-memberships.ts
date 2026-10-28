// apps/backend/src/scripts/backfill-workspace-memberships.ts
//
// ══════════════════════════════════════════════════════════════════════
// Company switcher PHASE 1: one shadow WorkspaceMembership row per existing
// user (docs/audits/multi-workspace-login-audit.md §8.3). Nothing reads the
// collection yet.
//
// DRY RUN BY DEFAULT — reads and reports, writes nothing (not even the
// collection or its indexes). --apply writes.
//
// RULES (services/workspaceMembership.service.ts resolveMembershipTarget,
// the same order login uses today):
//   staff    → User.workspaceId
//   customer → the CustomerWorkspace of the resolved customerId
//              (User.customerId → latest active CustomerMember → Customer →
//               MasterData → workspace allowlist)
//   vendor, or no customer link with a non-customer role set (SaaS
//   WORKSPACE_ADMIN signups) → User.workspaceId, as requireWorkspace does
//   roles and the SBT/billing flags are copied from User; isDefault = true.
// Idempotent: upsert on {userId, workspaceId}. Never edits User or
// CustomerMember (or creates a workspace, as login would).
//
// REPORT SECTIONS
//   A  counts by kind; how many rows would be created / updated / moved
//   B  customers whose User.workspaceId disagrees with the resolved customer
//      workspace (promote-customer staleness)
//   C  emails with ACTIVE CustomerMember rows in more than one customer
//   D  users with no resolvable workspace (and why)
//   E  duplicate addresses: the same address on two users, as `email` on both
//      (duplicate-email pair) or across email / officialEmail / personalEmail
//   F  live users-collection indexes (read only): is email_1 unique?
//
// REQUIRED
//   --expect-db=<name>   must equal the connected database, or nothing is read
// OPTIONAL
//   --apply              write (default: dry run)
//
// USAGE
//   npx tsx src/scripts/backfill-workspace-memberships.ts --expect-db=Plumtrips_hrms
//   npx tsx src/scripts/backfill-workspace-memberships.ts --expect-db=Plumtrips_hrms --apply
//   (MONGO_URI from the environment.)
//
// Sections B–E print full email addresses (they are the worklist). No
// passwords or personal details are printed.
// ══════════════════════════════════════════════════════════════════════

import "dotenv/config";
import mongoose from "mongoose";
import WorkspaceMembership from "../models/WorkspaceMembership.js";
import { resolveMembershipTarget, writeMembership } from "../services/workspaceMembership.service.js";

export type Options = {
  expectDb: string | undefined;
  apply?: boolean;
  log?: (line: string) => void;
};

export type Report = {
  db: string;
  applied: boolean;
  users: number;
  byKind: Record<string, number>;
  toCreate: number;
  toUpdate: number;
  toMove: number;
  written: { created: number; updated: number; moved: number; failed: number };
  workspaceMismatch: Array<{ userId: string; email: string; userWorkspaceId: string | null; resolvedWorkspaceId: string; customerSource: string | null }>;
  multiCompany: Array<{ email: string; companies: Array<{ customerId: string; company: string; role: string }> }>;
  unresolved: Array<{ userId: string; email: string; kind: string; reason: string }>;
  duplicates: Array<{ address: string; type: "duplicate-email" | "cross-field"; users: Array<{ userId: string; field: string }> }>;
  indexes: Array<{ name: string; key: Record<string, unknown>; unique: boolean }>;
  emailUnique: boolean;
};

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

export async function backfillWorkspaceMemberships(opts: Options): Promise<Report> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = mongoose.connection.name;
  if (!opts.expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (opts.expectDb !== db) throw new Error(`REFUSING: --expect-db="${opts.expectDb}" but connected db is "${db}".`);

  const raw = mongoose.connection.db!;
  const users = raw.collection("users");
  // Raw read: a dry run must not create the collection (the model would).
  const memberships = raw.collection("workspacememberships");

  const report: Report = {
    db, applied: !!opts.apply, users: 0, byKind: {}, toCreate: 0, toUpdate: 0, toMove: 0,
    written: { created: 0, updated: 0, moved: 0, failed: 0 },
    workspaceMismatch: [], multiCompany: [], unresolved: [], duplicates: [], indexes: [], emailUnique: false,
  };
  log(`[backfill-memberships] db=${db} mode=${opts.apply ? "APPLY" : "DRY RUN"}`);

  if (opts.apply) await WorkspaceMembership.createIndexes();

  const addresses = new Map<string, Array<{ userId: string; field: string }>>();
  const cursor = users.find({}).project({ passwordHash: 0, resetTokenHash: 0, onboardingSnapshot: 0, documents: 0 });

  for await (const u of cursor as AsyncIterable<any>) {
    report.users++;
    const userId = String(u._id);
    const email = str(u.email).toLowerCase();

    for (const field of ["email", "officialEmail", "personalEmail"]) {
      const a = str(u[field]).toLowerCase();
      if (!a) continue;
      const list = addresses.get(a) ?? [];
      list.push({ userId, field });
      addresses.set(a, list);
    }

    const target = await resolveMembershipTarget(u);
    if (!target.workspaceId) {
      report.unresolved.push({ userId, email, kind: target.kind, reason: target.reason || "unknown" });
      continue;
    }
    report.byKind[target.kind] = (report.byKind[target.kind] ?? 0) + 1;

    if (target.kind === "CUSTOMER" && str(u.workspaceId) !== String(target.workspaceId)) {
      report.workspaceMismatch.push({
        userId, email, userWorkspaceId: str(u.workspaceId) || null,
        resolvedWorkspaceId: String(target.workspaceId), customerSource: target.customerSource,
      });
    }

    const existing = await memberships.find({ userId: u._id }).project({ workspaceId: 1 }).toArray();
    if (existing.some((m: any) => String(m.workspaceId) === String(target.workspaceId))) report.toUpdate++;
    else if (existing.length) report.toMove++;
    else report.toCreate++;

    if (opts.apply) {
      try {
        const r = await writeMembership(u, target);
        report.written[r]++;
      } catch (err: any) {
        report.written.failed++;
        log(`  ! write failed userId=${userId}: ${err?.message || err}`);
      }
    }
  }

  // ── C: already multi-company (active CustomerMember rows in >1 customer) ──
  const multi = await raw
    .collection("customermembers")
    .aggregate([
      { $match: { isActive: { $ne: false } } },
      { $group: { _id: { $toLower: "$email" }, rows: { $push: { customerId: "$customerId", role: "$role" } }, customers: { $addToSet: "$customerId" } } },
      { $match: { "customers.1": { $exists: true } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  if (multi.length) {
    const cids = [...new Set(multi.flatMap((m: any) => m.customers.map(String)))];
    const oids = cids.filter((c) => /^[a-f0-9]{24}$/i.test(c)).map((c) => new mongoose.Types.ObjectId(c));
    const names = new Map<string, string>();
    for (const c of await raw.collection("customers").find({ _id: { $in: oids } }).project({ legalName: 1, name: 1, companyName: 1 }).toArray()) {
      names.set(String(c._id), str(c.legalName) || str(c.name) || str(c.companyName));
    }
    for (const w of await raw.collection("customerworkspaces").find({ customerId: { $in: cids } }).project({ customerId: 1, companyName: 1 }).toArray()) {
      if (!names.get(String(w.customerId))) names.set(String(w.customerId), str(w.companyName));
    }
    report.multiCompany = multi.map((m: any) => ({
      email: m._id,
      companies: m.rows.map((r: any) => ({ customerId: String(r.customerId), company: names.get(String(r.customerId)) || "(unknown)", role: str(r.role) })),
    }));
  }

  // ── E: the same address on two different users ──
  for (const [address, list] of addresses) {
    const distinct = new Set(list.map((x) => x.userId));
    if (distinct.size < 2) continue;
    const onEmail = new Set(list.filter((x) => x.field === "email").map((x) => x.userId));
    report.duplicates.push({ address, type: onEmail.size >= 2 ? "duplicate-email" : "cross-field", users: list });
  }
  report.duplicates.sort((a, b) => a.type.localeCompare(b.type) || a.address.localeCompare(b.address));

  // ── F: live indexes (read only) ──
  report.indexes = (await users.indexes()).map((i: any) => ({ name: i.name, key: i.key, unique: !!i.unique }));
  report.emailUnique = report.indexes.some((i) => i.unique && Object.keys(i.key).length === 1 && i.key.email === 1);

  printReport(report, log);
  return report;
}

function printReport(r: Report, log: (l: string) => void) {
  const resolved = Object.values(r.byKind).reduce((a, b) => a + b, 0);
  log("");
  log(`A. COUNTS — users=${r.users} resolved=${resolved} unresolved=${r.unresolved.length}`);
  for (const [k, n] of Object.entries(r.byKind).sort()) log(`   ${k.padEnd(8)} ${n}`);
  log(`   to create=${r.toCreate}  already present (update)=${r.toUpdate}  present for another workspace (move)=${r.toMove}`);
  if (r.applied) log(`   WRITTEN created=${r.written.created} updated=${r.written.updated} moved=${r.written.moved} failed=${r.written.failed}`);

  log("");
  log(`B. CUSTOMER User.workspaceId ≠ resolved customer workspace — ${r.workspaceMismatch.length}`);
  for (const m of r.workspaceMismatch) log(`   ${m.email}  user.workspaceId=${m.userWorkspaceId ?? "—"} → resolved=${m.resolvedWorkspaceId} (customer via ${m.customerSource})  userId=${m.userId}`);

  log("");
  log(`C. EMAILS WITH ACTIVE CustomerMember ROWS IN >1 CUSTOMER — ${r.multiCompany.length}`);
  for (const m of r.multiCompany) {
    log(`   ${m.email}`);
    for (const c of m.companies) log(`      ${c.company}  [${c.customerId}]  ${c.role}`);
  }

  log("");
  log(`D. NO RESOLVABLE WORKSPACE — ${r.unresolved.length}`);
  for (const u of r.unresolved) log(`   ${u.email || "(no email)"}  ${u.kind}  ${u.reason}  userId=${u.userId}`);

  log("");
  const dupEmail = r.duplicates.filter((d) => d.type === "duplicate-email").length;
  log(`E. DUPLICATE ADDRESSES — duplicate-email pairs=${dupEmail} cross-field=${r.duplicates.length - dupEmail}`);
  for (const d of r.duplicates) log(`   [${d.type}] ${d.address}  ${d.users.map((u) => `${u.userId}:${u.field}`).join("  ")}`);

  log("");
  log(`F. users INDEXES — email_1 unique: ${r.emailUnique ? "YES" : "NO"}`);
  for (const i of r.indexes) log(`   ${i.name.padEnd(28)} ${JSON.stringify(i.key)}${i.unique ? "  UNIQUE" : ""}`);

  log("");
  log(r.applied ? "[backfill-memberships] done (APPLY)." : "[backfill-memberships] dry run — nothing written (add --apply).");
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  // A dry run must not create the collection or its indexes on connect;
  // --apply builds the indexes explicitly before writing.
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    await backfillWorkspaceMemberships({ expectDb: arg("expect-db"), apply: process.argv.includes("--apply") });
  } finally {
    await mongoose.connection.close();
  }
}

// Run only when executed directly — importing it (the test) must not connect.
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/backfill-workspace-memberships.ts");

if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
