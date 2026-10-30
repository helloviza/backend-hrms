// apps/backend/src/scripts/report-sbt-users-without-workspace.ts
//
// READ-ONLY. Who does company-switcher Phase 3b newly refuse?
//
// Before Phase 3b, /requests/mine, /requests/inbox and raising a request read
// the caller's flags with
//     User.findOne({ _id: <caller>, workspaceId: req.workspaceObjectId })
// and allowed everything when that found no row ("fail open"). Phase 3b reads
// the flags through getActiveMembership, i.e. User.findById — so a user whose
// row does NOT carry the workspace requireWorkspace resolves for them (no
// workspaceId, a different one, or a string instead of an ObjectId) now gets
// the flags applied:
//   - sbtEnabled === true        → 403 on /requests/mine, /requests/inbox and raising
//   - canRaiseRequest === false  → 403 on raising
// Workspace Leaders of the session's company are exempt from both.
//
// The workspace is resolved exactly as at login: the same claims
// (buildAuthSafeUserCore in routes/auth.ts), then requireWorkspace's rules —
// SUPERADMIN takes the token's id as-is, the TBO certification login is pinned
// to the House workspace, everyone else goes through resolveWorkspaceForUser.
// The old lookup is then re-run verbatim, so a "miss" here is a miss in prod.
//
// Users whose workspace does not resolve, or is not ACTIVE, are listed apart:
// requireWorkspace already refuses them, so Phase 3b changes nothing for them.
//
// Section 2 lists ACTIVE second-company memberships carrying the same flags —
// those sessions also missed the old lookup and now read the membership flags.
//
// Writes nothing (finds only, no saves, no index builds).
//
//   pnpm -C apps/backend tsx src/scripts/report-sbt-users-without-workspace.ts --expect-db=<db>
import "../config/env.js";
import mongoose from "mongoose";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import WorkspaceMembership from "../models/WorkspaceMembership.js";
import SessionLog from "../models/SessionLog.js";
import { resolveWorkspaceForUser } from "../middleware/requireWorkspace.js";
import { isOwnCompany } from "../services/activeMembership.js";
import { buildAuthSafeUserCore, normalizeRoles } from "../routes/auth.js";

const HOUSE_WS_ID = "69679a7628330a58d29f2254";
const TBO_CERT_EMAIL = "tbocertification@plumtrips.com";

export type ReportRow = {
  userId: string;
  email: string;
  roles: string;
  customerId: string;
  userWorkspaceId: string;
  workspaceId: string;
  workspace: string;
  status: string;
  lastLogin: string;
  sbtEnabled: boolean;
  canRaiseRequest: boolean | null;
  refusedOn: string;
};

export type SbtWorkspaceReport = {
  db: string;
  scanned: number;
  refused: ReportRow[];
  alreadyRefused: (ReportRow & { reason: string })[];
  secondCompany: ReportRow[];
};

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const day = (d: unknown) => (d ? new Date(d as any).toISOString().slice(0, 10) : "-");
const isWL = (roles: string[]) =>
  roles.map((r) => str(r).toUpperCase().replace(/[\s\-_]/g, "")).includes("WORKSPACELEADER");

/** What Phase 3b now refuses for these flags; "" when nothing changes. */
function refusedSurfaces(flags: { sbtEnabled?: unknown; canRaiseRequest?: unknown }, leader: boolean): string {
  const out: string[] = [];
  if (leader) return ""; // Workspace Leaders are exempt on /mine, /inbox and raising
  if (flags.sbtEnabled === true) out.push("/requests/mine", "/requests/inbox");
  if (flags.sbtEnabled === true || flags.canRaiseRequest === false) out.push("raise");
  return out.join(", ");
}

/** The claims login signs (routes/auth.ts, POST /login and /refresh). */
async function loginClaims(u: any) {
  const built: any = await buildAuthSafeUserCore(u);
  return {
    sub: String(u._id),
    email: str(u.email).toLowerCase(),
    roles: normalizeRoles(built.roles || []),
    workspaceId: built.staff ? str(u.workspaceId) || undefined : undefined,
    customerId: built.staff ? undefined : built.customerId || undefined,
    businessId: built.staff ? undefined : built.customerId || undefined,
  };
}

/** req.workspaceObjectId as requireWorkspace would set it, plus the row it came from. */
async function sessionWorkspace(claims: any): Promise<{ id: string; ws: any | null; superadmin: boolean }> {
  const SEL = "_id status customerId companyName";
  if (claims.roles.includes("SUPERADMIN")) {
    const id = str(claims.workspaceId || claims.customerId || claims.businessId);
    const ws = mongoose.isValidObjectId(id) ? await CustomerWorkspace.findById(id).select(SEL).lean() : null;
    return { id, ws, superadmin: true };
  }
  if (claims.email === TBO_CERT_EMAIL) {
    return { id: HOUSE_WS_ID, ws: await CustomerWorkspace.findById(HOUSE_WS_ID).select(SEL).lean(), superadmin: false };
  }
  const ws: any = await resolveWorkspaceForUser(claims, SEL);
  return { id: ws ? String(ws._id) : "", ws, superadmin: false };
}

async function lastLoginOf(u: any): Promise<string> {
  const s: any = await SessionLog.findOne({ userId: u._id, event: "LOGIN", success: true })
    .sort({ createdAt: -1 })
    .select("createdAt")
    .lean();
  return day(s?.createdAt ?? u.lastLoginAt ?? u.lastSeenAt);
}

export async function reportSbtUsersWithoutWorkspace(opts: {
  expectDb?: string;
  log?: (line: string) => void;
  table?: (rows: unknown[]) => void;
}): Promise<SbtWorkspaceReport> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const show = opts.table ?? ((rows: unknown[]) => console.table(rows));
  const db = mongoose.connection.name;
  if (!opts.expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (opts.expectDb !== db) throw new Error(`REFUSING: --expect-db="${opts.expectDb}" but connected db is "${db}".`);
  log(`db ${db} · READ ONLY`);

  const report: SbtWorkspaceReport = { db, scanned: 0, refused: [], alreadyRefused: [], secondCompany: [] };

  // Raw flags, no schema defaults — the routes read them with .lean() too.
  const users: any[] = await User.find({ $or: [{ sbtEnabled: true }, { canRaiseRequest: false }] })
    .select("_id email roles customerId workspaceId businessId vendorId status sbtEnabled canRaiseRequest lastLoginAt lastSeenAt name firstName lastName")
    .sort({ email: 1 })
    .lean();
  report.scanned = users.length;

  for (const u of users) {
    const claims = await loginClaims(u);
    const { id, ws, superadmin } = await sessionWorkspace(claims);
    const refusedOn = refusedSurfaces(u, isWL(claims.roles));
    if (!refusedOn) continue; // a Workspace Leader: nothing changes

    const row: ReportRow = {
      userId: String(u._id),
      email: str(u.email),
      roles: claims.roles.join("|"),
      customerId: str(u.customerId) || (claims.customerId ? `${claims.customerId} (derived)` : "-"),
      userWorkspaceId: str(u.workspaceId) || "-",
      workspaceId: id || "-",
      workspace: ws ? str(ws.companyName) || "(no name)" : "-",
      status: str(u.status) || "-",
      lastLogin: await lastLoginOf(u),
      sbtEnabled: u.sbtEnabled === true,
      canRaiseRequest: typeof u.canRaiseRequest === "boolean" ? u.canRaiseRequest : null,
      refusedOn,
    };

    if (!superadmin) {
      if (!ws) {
        report.alreadyRefused.push({ ...row, reason: "no workspace resolves (requireWorkspace 403)" });
        continue;
      }
      if (ws.status !== "ACTIVE") {
        report.alreadyRefused.push({ ...row, reason: `workspace ${str(ws.status) || "?"} (requireWorkspace 403)` });
        continue;
      }
    }

    // The pre-3b lookup, verbatim. A hit means the flags already applied.
    const hit = id ? await User.findOne({ _id: u._id, workspaceId: id }).select("_id").lean() : null;
    if (!hit) report.refused.push(row);
  }

  // Second-company memberships carrying the flags (own company is the User row above).
  const memberships: any[] = await WorkspaceMembership.find({
    status: "ACTIVE",
    $or: [{ "flags.sbtEnabled": true }, { "flags.canRaiseRequest": false }],
  })
    .select("userId workspaceId customerId roles flags isDefault")
    .lean();
  for (const m of memberships) {
    const u: any = await User.findById(m.userId)
      .select("_id email roles customerId workspaceId status lastLoginAt lastSeenAt")
      .lean();
    if (!u || isOwnCompany(m, u)) continue;
    const refusedOn = refusedSurfaces(m.flags || {}, isWL(m.roles || []));
    if (!refusedOn) continue;
    const ws: any = await CustomerWorkspace.findById(m.workspaceId).select("companyName status").lean();
    const hit = await User.findOne({ _id: u._id, workspaceId: m.workspaceId }).select("_id").lean();
    if (hit) continue;
    report.secondCompany.push({
      userId: String(u._id),
      email: str(u.email),
      roles: (m.roles || []).join("|"),
      customerId: str(m.customerId) || "-",
      userWorkspaceId: str(u.workspaceId) || "-",
      workspaceId: str(m.workspaceId),
      workspace: ws ? str(ws.companyName) || "(no name)" : "(missing workspace)",
      status: `${str(u.status) || "-"} / membership ACTIVE`,
      lastLogin: await lastLoginOf(u),
      sbtEnabled: m.flags?.sbtEnabled === true,
      canRaiseRequest: typeof m.flags?.canRaiseRequest === "boolean" ? m.flags.canRaiseRequest : null,
      refusedOn,
    });
  }

  const table = (rows: any[]) =>
    rows.map(({ userId, email, roles, customerId, workspace, workspaceId, userWorkspaceId, status, lastLogin, refusedOn, reason }) => ({
      email,
      roles,
      customerId,
      workspace,
      sessionWs: workspaceId,
      userWs: userWorkspaceId,
      status,
      lastLogin,
      refusedOn,
      ...(reason ? { reason } : {}),
      userId,
    }));

  log(`\nusers with sbtEnabled=true or canRaiseRequest=false: ${report.scanned}`);
  log(`\n1) NEWLY REFUSED by Phase 3b (User row does not carry the session workspace): ${report.refused.length}`);
  if (report.refused.length) show(table(report.refused));
  log(`\n2) Second-company memberships newly refused: ${report.secondCompany.length}`);
  if (report.secondCompany.length) show(table(report.secondCompany));
  log(`\n(for reference) already refused by requireWorkspace, unchanged by 3b: ${report.alreadyRefused.length}`);
  if (report.alreadyRefused.length) show(table(report.alreadyRefused));
  log(`\nCOUNT newly refused: ${report.refused.length + report.secondCompany.length}`);
  return report;
}

async function main() {
  const expectDb = process.argv.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri);
  try {
    await reportSbtUsersWithoutWorkspace({ expectDb });
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && /report-sbt-users-without-workspace\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
