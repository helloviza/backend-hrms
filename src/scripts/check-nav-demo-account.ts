// apps/backend/src/scripts/check-nav-demo-account.ts
//
// READ-ONLY. Pre-flight and post-check for creating a limited-menu SUPERADMIN
// account (plumbox@plumtrips.com — docs/deploy/plumbox-account-plan.md).
// It never writes: there is no --apply. Prints the MongoDB host first
// (never credentials), then what the database says and whether each step of
// the plan is done.
//
//   MONGO_URI=... node --import tsx src/scripts/check-nav-demo-account.ts \
//     --email=plumbox@plumtrips.com [--expect=absent|created|granted|done]
//
// --expect picks which phase's checks decide the exit code (0 = all pass).
import mongoose from "mongoose";
import { mongoHosts } from "./set-visible-nav-groups.js";

const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";
const PLUMBOX = ["travelAnalytics", "travelbox", "spendbox", "helloviza"];

type Phase = "absent" | "created" | "granted" | "done";

export type Snapshot = {
  users: any[];
  perm: any | null;
  employee: any | null;
  houseTravelMode: string | null;
  audits: number;
};

/** Pure: the checks for a phase, from a snapshot. */
export function checksFor(phase: Phase, s: Snapshot): { name: string; ok: boolean; detail: string }[] {
  const u = s.users[0];
  const roles: string[] = (u?.roles || []).map((r: string) => String(r).toUpperCase());
  const out: { name: string; ok: boolean; detail: string }[] = [];
  const add = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });
  if (phase === "absent") {
    add("no user with this email yet", s.users.length === 0, `${s.users.length} found`);
    add("no UserPermission yet", !s.perm, s.perm ? `level ${s.perm?.level?.code}` : "none");
    add("HOUSE travelMode is not APPROVAL_FLOW (else the L8 grant 409s on sbt)", s.houseTravelMode !== "APPROVAL_FLOW", String(s.houseTravelMode));
    return out;
  }
  add("exactly one user", s.users.length === 1, `${s.users.length} found`);
  add("in HOUSE", String(u?.workspaceId) === HOUSE_WORKSPACE_ID, String(u?.workspaceId));
  add("status ACTIVE", u?.status === "ACTIVE", String(u?.status));
  add("Employee row exists", !!s.employee, s.employee ? String(s.employee._id) : "none");
  if (phase === "created") {
    add("UserPermission L1 (from POST /employees)", s.perm?.level?.code === "L1", String(s.perm?.level?.code));
    add("set-password link issued", !!u?.resetTokenExpiry, u?.resetTokenExpiry ? `expires ${new Date(u.resetTokenExpiry).toISOString()}` : "none");
    return out;
  }
  add("roles = [SUPERADMIN]", roles.length === 1 && roles[0] === "SUPERADMIN", roles.join(","));
  add("hrmsAccessRole SUPERADMIN", u?.hrmsAccessRole === "SUPERADMIN", String(u?.hrmsAccessRole));
  add("UserPermission L8, tier 3, active (never /pending)", s.perm?.level?.code === "L8" && s.perm?.tier === 3 && (s.perm?.status ?? "active") === "active", `${s.perm?.level?.code} tier ${s.perm?.tier} ${s.perm?.status}`);
  if (phase === "granted") {
    add("visibleNavGroups not set yet", !u?.visibleNavGroups?.length, JSON.stringify(u?.visibleNavGroups ?? null));
    return out;
  }
  add("visibleNavGroups = Travel Analytics, Travelbox, Spendbox, Helloviza", JSON.stringify(u?.visibleNavGroups) === JSON.stringify(PLUMBOX), JSON.stringify(u?.visibleNavGroups ?? null));
  add("change is audit-logged", s.audits >= 1, `${s.audits} NavPreferenceAudit row(s)`);
  return out;
}

async function main() {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
  const email = String(arg("email") || "").trim().toLowerCase();
  const expect = (arg("expect") || "done") as Phase;
  if (!email || !["absent", "created", "granted", "done"].includes(expect)) {
    console.error("usage: --email=<email> [--expect=absent|created|granted|done]");
    process.exit(2);
  }
  const uri = process.env.MONGO_URI || "";
  console.log(`target MongoDB host(s): ${mongoHosts(uri).join(", ") || "(none — MONGO_URI unset)"}`);
  console.log("mode: READ-ONLY (this script never writes)");
  if (!uri) process.exit(2);

  await mongoose.connect(uri);
  try {
    const db = mongoose.connection.db!;
    const users = await db
      .collection("users")
      .find({ $or: [{ email }, { officialEmail: email }] })
      .project({ _id: 1, email: 1, workspaceId: 1, roles: 1, status: 1, hrmsAccessRole: 1, sbtEnabled: 1, visibleNavGroups: 1, resetTokenExpiry: 1 })
      .toArray();
    const uid = users[0]?._id;
    const perm = uid ? await db.collection("userpermissions").findOne({ userId: String(uid) }, { projection: { level: 1, tier: 1, status: 1, workspaceId: 1 } }) : null;
    const employee = uid ? await db.collection("employees").findOne({ ownerId: uid }, { projection: { _id: 1 } }) : null;
    const house = await db.collection("customerworkspaces").findOne({ _id: new mongoose.Types.ObjectId(HOUSE_WORKSPACE_ID) }, { projection: { travelMode: 1 } });
    const audits = uid ? await db.collection("navpreferenceaudits").countDocuments({ userId: uid }) : 0;
    const snap: Snapshot = { users, perm, employee, houseTravelMode: (house as any)?.travelMode ?? null, audits };

    console.log(`user(s): ${JSON.stringify(users.map((u) => ({ ...u, resetTokenExpiry: u.resetTokenExpiry ? "set" : undefined })))}`);
    console.log(`permission: ${JSON.stringify(perm)}`);
    const checks = checksFor(expect, snap);
    for (const c of checks) console.log(`${c.ok ? "✔" : "✖"} ${c.name} — ${c.detail}`);
    const pass = checks.every((c) => c.ok);
    console.log(pass ? `PASS (${expect})` : `NOT YET (${expect})`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    await mongoose.disconnect();
  }
}

const invokedDirectly = process.argv[1] && /check-nav-demo-account\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error("✖", err?.message || err);
    process.exit(1);
  });
}
