// apps/backend/src/scripts/report-membership-billing-admin-access.ts
//
// READ-ONLY. Whose access does company-switcher Phase 3c change?
//
// Phase 3c (billing, customer admin, workspace config, notifications) reads
// membership values ONLY for a company the User document does not describe
// (services/activeMembership.ts isOwnCompany), and filters notifications by
// the session only for users with two or more ACTIVE memberships. So a user's
// access on these routes can change only if they hold:
//
//   1. a WorkspaceMembership that is not their User document's company
//      ("second company"), any status:
//        ACTIVE     a session on it reads that company's billing, invoices,
//                   users, config with the membership's roles and flags; the
//                   company's leaders see and manage them; a visa raised
//                   there bills that company; the unlock email reaches them
//                   when they lead or have canViewBilling there (non-default).
//        SUSPENDED  a session on it is refused (401) instead of answered with
//        REMOVED    the User document's company; SUSPENDED members can still
//                   be managed by that company's leaders.
//      isDefault rows are listed too: a default membership whose customerId
//      no longer matches User.customerId (a stale write-through) counts as a
//      second company. freshLoginStamps says whether a new login would put
//      it in the token (its workspace is the one login resolves); an existing
//      session keeps it across /auth/refresh either way.
//   2. two or more ACTIVE memberships — notifications follow the session.
//
// Everyone else answers exactly as before. Writes nothing (finds only).
//
//   pnpm -C apps/backend tsx src/scripts/report-membership-billing-admin-access.ts --expect-db=<db>
import "../config/env.js";
import mongoose from "mongoose";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import WorkspaceMembership from "../models/WorkspaceMembership.js";
import { resolveWorkspaceForUser } from "../middleware/requireWorkspace.js";
import { isOwnCompany } from "../services/activeMembership.js";
import { buildAuthSafeUserCore, normalizeRoles } from "../routes/auth.js";

export type SecondCompanyRow = {
  userId: string;
  email: string;
  userCustomerId: string;
  membershipCustomerId: string;
  workspaceId: string;
  workspace: string;
  status: string;
  isDefault: boolean;
  roles: string;
  canViewBilling: boolean;
  sbtEnabled: boolean;
  freshLoginStamps: boolean;
  changes: string;
};

export type ManyCompaniesRow = { userId: string; email: string; activeMemberships: number; workspaces: string };

export type BillingAdminAccessReport = {
  db: string;
  memberships: number;
  secondCompany: SecondCompanyRow[];
  manyCompanies: ManyCompaniesRow[];
  usersChanged: number;
};

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

function changesFor(m: any): string {
  if (m.status === "ACTIVE") {
    return "session reads this company (billing, invoices, users, config); listed + managed by its leaders; visa billed here" +
      (m.isDefault !== true ? "; unlock email if leader/canViewBilling" : "");
  }
  if (m.status === "SUSPENDED") return "session on it refused (401); still managed by its leaders";
  return "session on it refused (401)";
}

/** Would a fresh login stamp this membership (its workspace = login's resolution)? */
async function freshLoginStamps(u: any, m: any): Promise<boolean> {
  const built: any = await buildAuthSafeUserCore(u);
  const roles = normalizeRoles(built.roles || []);
  const cid = built.staff ? undefined : built.customerId || undefined;
  const claims = {
    sub: String(u._id),
    roles,
    workspaceId: built.staff ? str(u.workspaceId) || undefined : undefined,
    customerId: cid || (built.staff ? str(u.workspaceId) || undefined : undefined),
    businessId: cid || (built.staff ? str(u.workspaceId) || undefined : undefined),
  };
  const ws: any = await resolveWorkspaceForUser(claims, "_id");
  return !!ws && String(ws._id) === String(m.workspaceId);
}

export async function reportMembershipBillingAdminAccess(opts: {
  expectDb?: string;
  log?: (line: string) => void;
  table?: (rows: unknown[]) => void;
}): Promise<BillingAdminAccessReport> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const show = opts.table ?? ((rows: unknown[]) => console.table(rows));
  const db = mongoose.connection.name;
  if (!opts.expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (opts.expectDb !== db) throw new Error(`REFUSING: --expect-db="${opts.expectDb}" but connected db is "${db}".`);
  log(`db ${db} · READ ONLY`);

  const report: BillingAdminAccessReport = { db, memberships: 0, secondCompany: [], manyCompanies: [], usersChanged: 0 };
  const memberships: any[] = await WorkspaceMembership.find({})
    .select("userId workspaceId customerId status isDefault roles flags")
    .sort({ userId: 1 })
    .lean();
  report.memberships = memberships.length;

  const wsName = new Map<string, string>();
  const nameOf = async (id: unknown) => {
    const k = str(id);
    if (!wsName.has(k)) {
      const ws: any = mongoose.isValidObjectId(k) ? await CustomerWorkspace.findById(k).select("companyName name").lean() : null;
      wsName.set(k, ws ? str(ws.companyName) || str(ws.name) || "(no name)" : "(missing workspace)");
    }
    return wsName.get(k)!;
  };

  const users = new Map<string, any>();
  const userOf = async (id: unknown) => {
    const k = str(id);
    if (!users.has(k)) {
      users.set(k, await User.findById(k)
        .select("_id email roles customerId businessId workspaceId vendorId status name firstName lastName")
        .lean());
    }
    return users.get(k);
  };

  const activeByUser = new Map<string, any[]>();
  for (const m of memberships) {
    if (m.status === "ACTIVE") activeByUser.set(str(m.userId), [...(activeByUser.get(str(m.userId)) || []), m]);
    const u = await userOf(m.userId);
    if (!u || isOwnCompany(m, u)) continue;
    report.secondCompany.push({
      userId: str(u._id),
      email: str(u.email),
      userCustomerId: str(u.customerId) || "-",
      membershipCustomerId: str(m.customerId) || "-",
      workspaceId: str(m.workspaceId),
      workspace: await nameOf(m.workspaceId),
      status: str(m.status),
      isDefault: m.isDefault === true,
      roles: (m.roles || []).join("|"),
      canViewBilling: m.flags?.canViewBilling === true,
      sbtEnabled: m.flags?.sbtEnabled === true,
      freshLoginStamps: await freshLoginStamps(u, m),
      changes: changesFor(m),
    });
  }

  for (const [userId, ms] of activeByUser) {
    if (ms.length < 2) continue;
    const u = await userOf(userId);
    report.manyCompanies.push({
      userId,
      email: str(u?.email) || "(no User row)",
      activeMemberships: ms.length,
      workspaces: (await Promise.all(ms.map((m) => nameOf(m.workspaceId)))).join(" | "),
    });
  }

  report.usersChanged = new Set([
    ...report.secondCompany.map((r) => r.userId),
    ...report.manyCompanies.map((r) => r.userId),
  ]).size;

  log(`\nmemberships scanned: ${report.memberships}`);
  log(`\n1) Memberships that are NOT the User document's company: ${report.secondCompany.length}`);
  if (report.secondCompany.length) show(report.secondCompany);
  log(`\n2) Users with 2+ ACTIVE memberships (notifications follow the session): ${report.manyCompanies.length}`);
  if (report.manyCompanies.length) show(report.manyCompanies);
  log(`\nCOUNT users whose access changes: ${report.usersChanged}`);
  return report;
}

async function main() {
  const expectDb = process.argv.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    await reportMembershipBillingAdminAccess({ expectDb });
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && /report-membership-billing-admin-access\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
