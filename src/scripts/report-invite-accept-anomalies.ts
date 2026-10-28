// apps/backend/src/scripts/report-invite-accept-anomalies.ts
//
// READ ONLY. Looks for signs that the workspace-invite account-takeover
// chain (docs/audits/multi-workspace-login-audit.md §0) was used before the
// fix. Writes nothing: find() on raw collections only, no autoIndex /
// autoCreate, no model hooks.
//
// What it reports:
//   A. ACCEPTED invites whose email belongs to a login OUTSIDE the invite's
//      workspace. POST /api/signup/invite/accept set the password of that
//      login, so this is the takeover signature.
//   B. ACCEPTED invites where the login already existed before the invite was
//      created. /join refuses existing users, so these went through
//      /signup/invite/accept, which SET THE PASSWORD at acceptedAt. Same-
//      workspace rows are mostly HR's legit "set your password" flow;
//      cross-workspace rows are in A as well.
//   C. Invites (any status) carrying a role an invite may not confer
//      (anything outside INVITABLE_ROLES — e.g. SUPERADMIN), and the logins
//      created from accepted ones.
//   D. PENDING, unexpired invites whose email is a login in another workspace:
//      still redeemable on the old code until the fix is deployed.
// For every flagged login: successful LOGINs since acceptedAt (SessionLog,
// 90-day TTL) with distinct IPs. Every invite shows who sent it and their
// roles — a non-admin inviter means the missing role gate was used.
//
// Password changes are not versioned, so "password changed via invite" is
// inferred (B), not proven: acceptedAt is when it would have happened.
//
//   npx tsx src/scripts/report-invite-accept-anomalies.ts --expect-db=<db>
import "dotenv/config";
import mongoose from "mongoose";

type AnyObj = Record<string, any>;

// Kept in step with routes/workspace.invites.ts INVITABLE_ROLES. Duplicated so
// this script never imports a router (and its mailer) to run.
const INVITABLE_ROLES = new Set(["EMPLOYEE", "MANAGER", "HR", "ADMIN", "APPROVER", "REQUESTER"]);
const ADMIN_ROLES = new Set(["TENANT_ADMIN", "WORKSPACE_LEADER", "WORKSPACE_ADMIN", "SUPERADMIN", "ADMIN", "HR", "HR_ADMIN"]);

const s = (v: unknown) => (v == null ? "" : String(v));
const iso = (d: unknown) => (d ? new Date(d as any).toISOString() : "—");
const upper = (arr: unknown) => (Array.isArray(arr) ? arr.map((r) => s(r).toUpperCase()) : []);

/** The login owns this email under any of the three fields login matches. */
function emailClause(email: string) {
  return { $or: [{ email }, { officialEmail: email }, { personalEmail: email }] };
}

/** Does this login belong to the invite's workspace (by workspaceId, or a customer user by customerId)? */
export function inInviteWorkspace(user: AnyObj, inviteWorkspaceId: string, wsCustomerId: string): boolean {
  if (s(user.workspaceId) === inviteWorkspaceId) return true;
  return !!wsCustomerId && s(user.customerId) === wsCustomerId;
}

export async function reportInviteAcceptAnomalies(opts: { expectDb?: string; log?: (line: string) => void }) {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = mongoose.connection.name;
  if (!opts.expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (opts.expectDb !== db) throw new Error(`REFUSING: --expect-db="${opts.expectDb}" but connected db is "${db}".`);
  log(`db ${db} · READ ONLY`);

  const col = (n: string) => mongoose.connection.db!.collection(n);
  const invites: AnyObj[] = await col("workspaceinvites").find({}).sort({ createdAt: 1 }).toArray();
  log(`workspace invites: ${invites.length}`);

  const wsCache = new Map<string, AnyObj | null>();
  const workspace = async (id: unknown) => {
    const k = s(id);
    if (!wsCache.has(k)) {
      const ws = mongoose.isValidObjectId(k)
        ? await col("customerworkspaces").findOne(
            { _id: new mongoose.Types.ObjectId(k) },
            { projection: { customerId: 1, companyName: 1 } },
          )
        : null;
      wsCache.set(k, ws);
    }
    return wsCache.get(k)!;
  };
  const userCache = new Map<string, AnyObj | null>();
  const userById = async (id: unknown) => {
    const k = s(id);
    if (!userCache.has(k)) {
      userCache.set(
        k,
        mongoose.isValidObjectId(k)
          ? await col("users").findOne({ _id: new mongoose.Types.ObjectId(k) }, { projection: { email: 1, roles: 1, workspaceId: 1 } })
          : null,
      );
    }
    return userCache.get(k)!;
  };
  const inviterLabel = async (inv: AnyObj) => {
    const u = await userById(inv.invitedBy);
    if (!u) return `inviter ${s(inv.invitedBy) || "—"} (not found)`;
    const roles = upper(u.roles);
    const admin = roles.some((r) => ADMIN_ROLES.has(r));
    return `inviter ${s(u.email)} [${roles.join(",")}]${admin ? "" : " ← NOT AN ADMIN"}`;
  };
  const loginsSince = async (userId: unknown, since: unknown) => {
    const rows: AnyObj[] = await col("sessionlogs")
      .find(
        { userId: new mongoose.Types.ObjectId(s(userId)), event: "LOGIN", success: true, ...(since ? { createdAt: { $gte: new Date(since as any) } } : {}) },
        { projection: { ipAddress: 1, createdAt: 1 } },
      )
      .toArray();
    const ips = Array.from(new Set(rows.map((r) => s(r.ipAddress)).filter(Boolean)));
    return `${rows.length} login(s) since${ips.length ? ` from ${ips.join(", ")}` : ""}`;
  };

  const A: string[] = [];
  const B: string[] = [];
  const C: string[] = [];
  const D: string[] = [];
  const now = Date.now();

  for (const inv of invites) {
    const email = s(inv.email).trim().toLowerCase();
    const status = s(inv.status);
    const role = s(inv.role).toUpperCase();
    const ws = await workspace(inv.workspaceId);
    const wsLabel = `${s(ws?.companyName) || "?"} (${s(inv.workspaceId)})`;
    const owners: AnyObj[] = email
      ? await col("users")
          .find(emailClause(email), { projection: { email: 1, roles: 1, workspaceId: 1, customerId: 1, createdAt: 1, status: 1 } })
          .toArray()
      : [];
    const head = `invite ${s(inv._id)} · ${email} · role ${role || "—"} · ${status} · ws ${wsLabel} · sent ${iso(inv.createdAt)}`;

    if (!INVITABLE_ROLES.has(role)) {
      const created = owners.filter((u) => upper(u.roles).includes(role));
      C.push(
        `${head} · accepted ${iso(inv.acceptedAt)} · ${await inviterLabel(inv)}` +
          (created.length ? ` · login(s) holding ${role}: ${created.map((u) => `${s(u._id)} ${s(u.email)}`).join("; ")}` : ""),
      );
    }

    for (const u of owners) {
      const inside = inInviteWorkspace(u, s(inv.workspaceId), s(ws?.customerId));
      const userLine = `user ${s(u._id)} ${s(u.email)} ws ${s(u.workspaceId) || "—"} cust ${s(u.customerId) || "—"} [${upper(u.roles).join(",")}] ${s(u.status) || "ACTIVE"}`;

      if (status === "accepted") {
        const existedBefore = u.createdAt && inv.createdAt && new Date(u.createdAt) < new Date(inv.createdAt);
        if (!inside) {
          A.push(`${head} · accepted ${iso(inv.acceptedAt)} · ${await inviterLabel(inv)}\n      → ${userLine} · ${await loginsSince(u._id, inv.acceptedAt)}`);
        }
        if (existedBefore) {
          B.push(`${head} · accepted ${iso(inv.acceptedAt)} · ${inside ? "same workspace" : "OTHER WORKSPACE"}\n      → ${userLine} · ${await loginsSince(u._id, inv.acceptedAt)}`);
        }
      } else if (status === "pending" && inv.expiresAt && new Date(inv.expiresAt).getTime() > now && !inside) {
        D.push(`${head} · expires ${iso(inv.expiresAt)} · ${await inviterLabel(inv)}\n      → ${userLine}`);
      }
    }
  }

  const section = (title: string, rows: string[]) => {
    log("");
    log(`${title}: ${rows.length}`);
    for (const r of rows) log(`  ${r}`);
  };
  section("A. accepted invites whose login is OUTSIDE the invite's workspace (takeover signature)", A);
  section("B. accepted invites on a login that existed before the invite (password set via /signup/invite/accept)", B);
  section("C. invites with a role invites may not confer", C);
  section("D. pending invites still pointing at a login in another workspace", D);

  return { db, invites: invites.length, A, B, C, D };
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    const expectDb = process.argv.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
    await reportInviteAcceptAnomalies({ expectDb });
  } finally {
    await mongoose.disconnect();
  }
}

// Run only when executed directly — importing it (the tests) must not connect.
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/report-invite-accept-anomalies.ts");
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
