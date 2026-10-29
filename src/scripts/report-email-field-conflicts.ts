// apps/backend/src/scripts/report-email-field-conflicts.ts
//
// READ ONLY. Lists every "cross-field" address: one address held by two or
// more users across email / officialEmail / personalEmail, where it is NOT
// the `email` of two users (those are the duplicate-email pairs, a separate
// list in backfill-workspace-memberships section E). Same definition, so the
// counts match that dry run.
//
// For each address it shows which account login now signs in to
// (utils/loginEmailLookup order: email → officialEmail → personalEmail, an
// ambiguous fallback is REFUSED), then every user holding it: name, status,
// roles, workspace, created, last successful login (SessionLog keeps 90
// days) and lastSeenAt — enough to decide which duplicate account to clean.
//
// Writes nothing: find()/aggregate() on raw collections only, connected with
// autoIndex/autoCreate off. Prints full addresses (they are the worklist).
//
//   npx tsx src/scripts/report-email-field-conflicts.ts --expect-db=<db>
import "dotenv/config";
import mongoose from "mongoose";

type AnyObj = Record<string, any>;
type Field = "email" | "officialEmail" | "personalEmail";
const FIELDS: Field[] = ["email", "officialEmail", "personalEmail"];

const s = (v: unknown) => (v == null ? "" : String(v));
const norm = (v: unknown) => s(v).trim().toLowerCase();
const iso = (d: unknown) => (d ? new Date(d as any).toISOString().slice(0, 16).replace("T", " ") : "—");

/** Who login picks for this address, given which users hold it in which field. */
export function loginPick(holders: Array<{ userId: string; field: Field }>): string {
  const on = (f: Field) => [...new Set(holders.filter((h) => h.field === f).map((h) => h.userId))];
  const email = on("email");
  if (email.length) return email[0];
  for (const f of ["officialEmail", "personalEmail"] as Field[]) {
    const ids = on(f);
    if (ids.length === 1) return ids[0];
    if (ids.length > 1) return "REFUSED";
  }
  return "—";
}

export type ConflictUser = {
  userId: string;
  fields: Field[];
  /** Stored value when it differs from the normalised address (login matches exactly). */
  rawValues: string[];
  name: string;
  email: string;
  status: string;
  roles: string[];
  workspaceId: string;
  workspace: string;
  customerId: string;
  createdAt: string;
  lastLogin: string;
  lastSeenAt: string;
  loginsLast90d: number;
};
export type Conflict = { address: string; loginPicks: string; users: ConflictUser[] };

export async function reportEmailFieldConflicts(opts: { expectDb?: string; log?: (line: string) => void }) {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = mongoose.connection.name;
  if (!opts.expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (opts.expectDb !== db) throw new Error(`REFUSING: --expect-db="${opts.expectDb}" but connected db is "${db}".`);
  log(`db ${db} · READ ONLY`);

  const raw = mongoose.connection.db!;
  const users = raw.collection("users");

  // ── collect every address → holders ──
  const addresses = new Map<string, Array<{ userId: string; field: Field; raw: string }>>();
  const docs = new Map<string, AnyObj>();
  const cursor = users.find({}).project({
    email: 1, officialEmail: 1, personalEmail: 1, firstName: 1, lastName: 1, name: 1,
    status: 1, roles: 1, workspaceId: 1, customerId: 1, createdAt: 1, lastSeenAt: 1,
  });
  for await (const u of cursor as AsyncIterable<AnyObj>) {
    const userId = String(u._id);
    for (const field of FIELDS) {
      const a = norm(u[field]);
      if (!a) continue;
      const list = addresses.get(a) ?? [];
      list.push({ userId, field, raw: s(u[field]) });
      addresses.set(a, list);
    }
    docs.set(userId, u);
  }

  const picked: Array<{ address: string; holders: Array<{ userId: string; field: Field; raw: string }> }> = [];
  for (const [address, holders] of addresses) {
    const distinct = new Set(holders.map((h) => h.userId));
    if (distinct.size < 2) continue;
    const onEmail = new Set(holders.filter((h) => h.field === "email").map((h) => h.userId));
    if (onEmail.size >= 2) continue; // duplicate-email pair, not cross-field
    picked.push({ address, holders });
  }
  picked.sort((a, b) => a.address.localeCompare(b.address));

  // ── enrich: workspaces + last logins for the users involved ──
  const involved = [...new Set(picked.flatMap((p) => p.holders.map((h) => h.userId)))];
  const wsIds = [...new Set(involved.map((id) => s(docs.get(id)?.workspaceId)).filter((w) => /^[a-f0-9]{24}$/i.test(w)))];
  const wsNames = new Map<string, string>();
  for (const w of await raw
    .collection("customerworkspaces")
    .find({ _id: { $in: wsIds.map((w) => new mongoose.Types.ObjectId(w)) } })
    .project({ companyName: 1, name: 1 })
    .toArray()) {
    wsNames.set(String(w._id), s(w.companyName) || s(w.name));
  }
  const logins = new Map<string, { last: Date; n: number }>();
  for (const row of await raw
    .collection("sessionlogs")
    .aggregate([
      { $match: { userId: { $in: involved.map((id) => new mongoose.Types.ObjectId(id)) }, event: "LOGIN", success: { $ne: false } } },
      { $group: { _id: "$userId", last: { $max: "$createdAt" }, n: { $sum: 1 } } },
    ])
    .toArray()) {
    logins.set(String(row._id), { last: row.last, n: row.n });
  }

  const conflicts: Conflict[] = picked.map(({ address, holders }) => {
    const byUser = new Map<string, ConflictUser>();
    for (const h of holders) {
      const u = docs.get(h.userId) ?? {};
      const cu = byUser.get(h.userId) ?? {
        userId: h.userId,
        fields: [],
        rawValues: [],
        name: [s(u.firstName), s(u.lastName)].filter(Boolean).join(" ") || s(u.name) || "—",
        email: s(u.email) || "—",
        status: s(u.status) || "ACTIVE (unset)",
        roles: Array.isArray(u.roles) ? u.roles.map(s) : [],
        workspaceId: s(u.workspaceId) || "—",
        workspace: wsNames.get(s(u.workspaceId)) || "—",
        customerId: s(u.customerId) || "—",
        createdAt: iso(u.createdAt),
        lastLogin: iso(logins.get(h.userId)?.last),
        lastSeenAt: iso(u.lastSeenAt),
        loginsLast90d: logins.get(h.userId)?.n ?? 0,
      };
      cu.fields.push(h.field);
      if (h.raw !== address) cu.rawValues.push(`${h.field}="${h.raw}"`);
      byUser.set(h.userId, cu);
    }
    // email holder first, then officialEmail, then personalEmail
    const rank = (c: ConflictUser) => Math.min(...c.fields.map((f) => FIELDS.indexOf(f)));
    const list = [...byUser.values()].sort((a, b) => rank(a) - rank(b));
    return { address, loginPicks: loginPick(holders), users: list };
  });

  // ── print ──
  const refused = conflicts.filter((c) => c.loginPicks === "REFUSED").length;
  log(`cross-field addresses: ${conflicts.length} (login refuses ${refused} of them as ambiguous)`);
  log(`last login = latest successful LOGIN in sessionlogs (90-day TTL); "—" = none in that window`);
  for (const c of conflicts) {
    log("");
    log(`${c.address}  →  login signs in to: ${c.loginPicks === "REFUSED" ? "NOBODY (ambiguous, refused)" : c.loginPicks}`);
    for (const u of c.users) {
      const mark = u.userId === c.loginPicks ? "*" : " ";
      log(
        ` ${mark} ${u.userId}  as ${u.fields.join("+")}  ${u.name} <${u.email}>  status=${u.status}  roles=${u.roles.join(",") || "—"}`,
      );
      log(
        `      workspace=${u.workspace} (${u.workspaceId})  customerId=${u.customerId}  created=${u.createdAt}  lastLogin=${u.lastLogin} (${u.loginsLast90d} in 90d)  lastSeen=${u.lastSeenAt}` +
          (u.rawValues.length ? `  stored: ${u.rawValues.join(" ")} — login matches stored value exactly` : ""),
      );
    }
  }
  return { db, conflicts };
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    const expectDb = process.argv.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
    await reportEmailFieldConflicts({ expectDb });
  } finally {
    await mongoose.disconnect();
  }
}

// Run only when executed directly — importing it (the tests) must not connect.
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/report-email-field-conflicts.ts");
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
