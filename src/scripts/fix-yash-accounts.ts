// apps/backend/src/scripts/fix-yash-accounts.ts
//
// Yash Kumar has two User docs in the same workspace:
//   KEEP   6a0307c572df973ce0bbd8dc  email=yash@plumtrips.com — holds the Employee
//          record, manager/reporting lines and his documents
//   RETIRE 6a0190c4fb60d6d4d2b99d81  email=yashk242002@gmail.com — the one he has
//          been signing in to; holds attendance + the permission row
//
// 1. Pre-check (read-only): scans the raw BSON of EVERY document in EVERY
//    collection for RETIRE's id — as an ObjectId and as a 24-char string — and
//    prints each collection.field that holds it. sessionlogs.userId,
//    userpresences.userId and workspaceauditlogs.details.targetUserId are
//    history: reported, never moved, not blocking. Anything beyond those and
//    attendances.userId, userpermissions.userId, leavebalances.userId and
//    workspacememberships.userId (and RETIRE's own users doc) STOPS the run;
//    nothing is moved.
// 2. Attendance rows RETIRE → KEEP; refused if KEEP already has a row on any
//    of those dates (unique userId+date).
// 3. The UserPermission row RETIRE → KEEP; refused if KEEP already has one
//    (unique userId).
// 4. LeaveBalance: per year, only the `balances` numbers are compared
//    (entitled/accrued/used/pending/adjusted/carriedForward per leave type).
//    Equal → KEEP's row kept, RETIRE's left untouched; different (or KEEP has
//    no row) → STOP. joinDate / probationEndDate of both rows and KEEP's
//    Employee.joiningDate are printed; KEEP's leave joinDate not matching the
//    Employee record is a WARN only.
// 5. RETIRE gets loginDisabled (utils/loginDisabled.ts) and its set-password
//    token cleared. No email or status change; Employee and memberships are
//    not touched.
//
// Steps 2, 3 and 5 are written in ONE transaction (needs a replica set —
// Atlas is one), so either all of it lands or none of it. Raw updates, no
// timestamps bumped; ids keep their stored type (ObjectId stays ObjectId,
// string stays string).
//
// DRY-RUN by default and prints exactly what moves. --apply first writes a
// JSON backup to src/scripts/out/, prints its path, then writes.
// --undo=<backup.json> reverses it exactly (also one transaction, dry-run
// unless --apply), refused if anything changed since.
//
//   npx tsx src/scripts/fix-yash-accounts.ts --expect-db=<db> [--apply]
//   npx tsx src/scripts/fix-yash-accounts.ts --expect-db=<db> --undo=<backup.json> [--apply]
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

type AnyObj = Record<string, any>;
type Log = (line: string) => void;

export const KEEP_ID = "6a0307c572df973ce0bbd8dc";
export const RETIRE_ID = "6a0190c4fb60d6d4d2b99d81";

/** Places RETIRE may be referenced for the run to go ahead. */
export const ALLOWED_REFS = ["attendances.userId", "userpermissions.userId", "leavebalances.userId", "workspacememberships.userId"];
/** History of what RETIRE did / had done to it — reported, left on RETIRE, not blocking. */
export const HISTORY_REFS = ["sessionlogs.userId", "userpresences.userId", "workspaceauditlogs.details.targetUserId"];

const USER_FIELDS = ["loginDisabled", "loginDisabledAt", "loginDisabledBy", "loginDisabledReason", "resetTokenHash", "resetTokenExpiry"] as const;
type UserField = (typeof USER_FIELDS)[number];
type Snapshot = Partial<Record<UserField, string | boolean | null>>;
const DATE_FIELDS: UserField[] = ["loginDisabledAt", "resetTokenExpiry"];

const ACTOR = "script:fix-yash-accounts";
const REASON = "Duplicate account; Yash's records and permission now live on 6a0307c572df973ce0bbd8dc (yash@plumtrips.com).";

/** A stored id: its hex plus whether it was an ObjectId or a plain string. */
type StoredId = { hex: string; oid: boolean };
type Move = { _id: StoredId; userId: StoredId };
export type Backup = {
  script: "fix-yash-accounts-v2";
  db: string;
  createdAt: string;
  attendances: Array<Move & { date: string }>;
  permission: Move | null;
  user: { before: Snapshot; after: Snapshot };
};

const db = () => mongoose.connection.db!;
const oid = (id: string) => new mongoose.Types.ObjectId(id);
const isOid = (v: unknown): v is mongoose.Types.ObjectId => v instanceof mongoose.mongo.ObjectId;
const stored = (v: unknown): StoredId => ({ hex: String(v), oid: isOid(v) });
const revive = (s: StoredId) => (s.oid ? oid(s.hex) : s.hex);
/** Same id, same stored type as `like`. */
const asTypeOf = (hex: string, like: StoredId) => (like.oid ? oid(hex) : hex);
const idIn = (hex: string) => ({ $in: [oid(hex), hex] });
const s = (v: unknown) => (v == null ? "" : String(v));

/* ── 1. reference scan ─────────────────────────────────────────────────── */

/**
 * Every collection.field holding `hex` (as ObjectId or inside a string), with
 * the number of documents per field. Array indices are folded to `[]`. The
 * users doc whose _id IS `hex` is not counted. Raw BSON is byte-searched
 * first, so only candidate docs are decoded.
 */
export async function scanReferences(hex: string, opts: { log?: Log } = {}) {
  const needles = [Buffer.from(hex, "hex"), Buffer.from(hex, "utf8")];
  const counts = new Map<string, number>();
  const colls = (await db().listCollections({ type: "collection" }, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith("system."))
    .sort();
  for (const name of colls) {
    let scanned = 0;
    const cursor = db().collection(name).find({}, { raw: true, batchSize: 1000 });
    for await (const raw of cursor as AsyncIterable<unknown>) {
      scanned++;
      const buf = raw as Buffer;
      if (!needles.some((n) => buf.indexOf(n) !== -1)) continue;
      const doc = mongoose.mongo.BSON.deserialize(buf);
      if (name === "users" && String(doc._id) === hex) continue;
      const paths = new Set<string>();
      collectPaths(doc, "", hex, paths);
      for (const p of paths) counts.set(`${name}.${p}`, (counts.get(`${name}.${p}`) ?? 0) + 1);
    }
    opts.log?.(`    scanned ${name} (${scanned})`);
  }
  return counts;
}

function collectPaths(v: unknown, at: string, hex: string, out: Set<string>) {
  if (isOid(v)) { if (v.toHexString() === hex) out.add(at || "(root)"); return; }
  if (typeof v === "string") { if (v.toLowerCase().includes(hex)) out.add(at || "(root)"); return; }
  if (Array.isArray(v)) { for (const x of v) collectPaths(x, `${at}[]`, hex, out); return; }
  if (v && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    for (const [k, x] of Object.entries(v)) collectPaths(x, at ? `${at}.${k}` : k, hex, out);
  }
}

/* ── helpers ───────────────────────────────────────────────────────────── */

function snapshot(u: AnyObj): Snapshot {
  const snap: Snapshot = {};
  for (const f of USER_FIELDS) {
    if (!(f in u)) continue;
    const v = u[f];
    snap[f] = v == null ? null : v instanceof Date ? v.toISOString() : typeof v === "boolean" ? v : String(v);
  }
  return snap;
}
const sameSnap = (a: Snapshot, b: Snapshot) => USER_FIELDS.every((f) => (f in a) === (f in b) && a[f] === b[f]);

function snapshotUpdate(snap: Snapshot) {
  const set: AnyObj = {};
  const unset: AnyObj = {};
  for (const f of USER_FIELDS) {
    if (!(f in snap)) { unset[f] = ""; continue; }
    const v = snap[f];
    set[f] = v != null && DATE_FIELDS.includes(f) ? new Date(String(v)) : v;
  }
  const update: AnyObj = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  return update;
}

/** Stable JSON (sorted keys, ObjectIds/Dates as strings) for comparing balances. */
function canon(v: unknown): string {
  if (isOid(v)) return JSON.stringify(v.toHexString());
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as AnyObj)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
/** A date as YYYY-MM-DD, or "(none)". */
const day = (v: unknown) => (v == null || v === "" ? "(none)" : new Date(v as any).toISOString().slice(0, 10));

async function requireTransactions() {
  const hello: AnyObj = await db().admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid") {
    throw new Error("REFUSING: this server is standalone — the all-or-nothing write needs a transaction (replica set).");
  }
}

/** Run `fn` in one transaction; every write must hit exactly one doc or it all rolls back. */
async function inTransaction(fn: (session: mongoose.mongo.ClientSession) => Promise<void>) {
  const session = mongoose.connection.getClient().startSession();
  try {
    await session.withTransaction(() => fn(session));
  } finally {
    await session.endSession();
  }
}
async function updateExactlyOne(coll: string, filter: AnyObj, update: AnyObj, session: mongoose.mongo.ClientSession, what: string) {
  const r = await db().collection(coll).updateOne(filter, update, { session });
  if (r.matchedCount !== 1) throw new Error(`${what}: expected to match 1 document, matched ${r.matchedCount}`);
}

/* ── fix ───────────────────────────────────────────────────────────────── */

export class StopError extends Error {
  constructor(message: string) { super(`STOP: ${message}`); this.name = "StopError"; }
}

export async function fixYashAccounts(opts: { expectDb?: string; apply?: boolean; outDir?: string; now?: Date; log?: Log }) {
  const log = opts.log ?? ((l: string) => console.log(l));
  const dbName = guardDb(opts.expectDb);
  const now = opts.now ?? new Date();
  log(`db ${dbName} · ${opts.apply ? "APPLY — writes" : "DRY-RUN — nothing written"}`);
  log(`KEEP ${KEEP_ID} · RETIRE ${RETIRE_ID}`);

  const users = db().collection("users");
  const keep = (await users.findOne({ _id: oid(KEEP_ID) })) as AnyObj | null;
  const retire = (await users.findOne({ _id: oid(RETIRE_ID) })) as AnyObj | null;
  if (!keep) throw new Error(`REFUSING: KEEP ${KEEP_ID} not found.`);
  if (!retire) throw new Error(`REFUSING: RETIRE ${RETIRE_ID} not found.`);
  log(`  KEEP   email=${s(keep.email)} status=${s(keep.status)} loginDisabled=${s(keep.loginDisabled)}`);
  log(`  RETIRE email=${s(retire.email)} status=${s(retire.status)} loginDisabled=${s(retire.loginDisabled)}`);
  if (keep.loginDisabled === true) throw new Error("REFUSING: KEEP's login is disabled — that is the account he must sign in to.");

  // 1. Every reference to RETIRE.
  log("\n1. references to RETIRE (every collection, ObjectId + string):");
  const refs = await scanReferences(RETIRE_ID);
  if (!refs.size) log("    (none)");
  const tag = (k: string) => (ALLOWED_REFS.includes(k) ? "  " : HISTORY_REFS.includes(k) ? "h " : "!!");
  for (const [k, n] of [...refs].sort()) log(`    ${tag(k)} ${k}: ${n}${HISTORY_REFS.includes(k) ? "  (history — stays on RETIRE)" : ""}`);
  const blockers = [...refs.keys()].filter((k) => tag(k) === "!!");
  if (blockers.length) throw new StopError(`RETIRE is also referenced by ${blockers.join(", ")} — nothing moved.`);

  // 2. Attendance.
  const att = db().collection("attendances");
  const attRows = (await att.find({ userId: idIn(RETIRE_ID) }).sort({ date: 1 }).toArray()) as AnyObj[];
  const dates = attRows.map((r) => r.date);
  const clashes = (await att.find({ userId: idIn(KEEP_ID), date: { $in: dates } }).toArray()) as AnyObj[];
  log(`\n2. attendances: ${attRows.length} row(s) RETIRE → KEEP` + (attRows.length ? ` (${s(dates[0])} … ${s(dates[dates.length - 1])})` : ""));
  for (const r of attRows) log(`    ${String(r._id)}  ${s(r.date)}`);
  if (clashes.length) {
    throw new Error(`REFUSING: KEEP already has attendance on ${clashes.map((c) => s(c.date)).sort().join(", ")} — would clash.`);
  }

  // 3. Permission.
  const perms = db().collection("userpermissions");
  const retirePerms = (await perms.find({ userId: idIn(RETIRE_ID) }).toArray()) as AnyObj[];
  const keepPerms = (await perms.find({ userId: idIn(KEEP_ID) }).toArray()) as AnyObj[];
  if (retirePerms.length > 1) throw new Error(`REFUSING: RETIRE has ${retirePerms.length} permission rows.`);
  const perm = retirePerms[0] ?? null;
  log(`\n3. userpermissions: ${perm ? `${String(perm._id)} (email=${s(perm.email)} status=${s(perm.status)}) RETIRE → KEEP` : "RETIRE has none — nothing to move"}`);
  if (perm && keepPerms.length) {
    throw new Error(`REFUSING: KEEP already has permission row ${String(keepPerms[0]._id)} (userId is unique).`);
  }

  // 4. Leave balances — compared, never written.
  const lb = db().collection("leavebalances");
  const retireLb = (await lb.find({ userId: idIn(RETIRE_ID) }).sort({ year: 1 }).toArray()) as AnyObj[];
  const keepLb = (await lb.find({ userId: idIn(KEEP_ID) }).sort({ year: 1 }).toArray()) as AnyObj[];
  const keepEmp = (await db().collection("employees").findOne({ ownerId: idIn(KEEP_ID) })) as AnyObj | null;
  const empJoin = day(keepEmp?.joiningDate);
  log(`\n4. leavebalances: RETIRE ${retireLb.length} row(s), KEEP ${keepLb.length} row(s); `
    + `KEEP Employee ${keepEmp ? String(keepEmp._id) : "(none)"} joiningDate=${empJoin}`);
  const lbProblems: string[] = [];
  for (const r of retireLb) {
    const k = keepLb.find((x) => s(x.year) === s(r.year) && s(x.workspaceId) === s(r.workspaceId));
    const dates = (row: AnyObj) => `joinDate=${day(row.joinDate)} probationEndDate=${day(row.probationEndDate)}`;
    log(`    year ${s(r.year)}`);
    log(`      RETIRE ${String(r._id)}: ${dates(r)} balances=${canon(r.balances)}`);
    log(`      KEEP   ${k ? `${String(k._id)}: ${dates(k)} balances=${canon(k.balances)}` : "(no row)"}`);
    if (!k) { lbProblems.push(`year ${s(r.year)}: KEEP has no row`); continue; }
    if (canon(k.balances) !== canon(r.balances)) { lbProblems.push(`year ${s(r.year)}: balances differ`); continue; }
    log("      balances equal — KEEP's row kept, RETIRE's left untouched");
    if (day(k.joinDate) !== empJoin) {
      log(`      WARN: KEEP's leave joinDate ${day(k.joinDate)} ≠ Employee joiningDate ${empJoin} (not blocking)`);
    }
  }
  if (lbProblems.length) throw new StopError(`leave balances need a decision (${lbProblems.join("; ")}) — nothing moved.`);

  // 5. Close RETIRE's login.
  const userBefore = snapshot(retire);
  const already = retire.loginDisabled === true && !attRows.length && !perm;
  if (already) {
    log("\nAlready applied. Nothing to do.");
    return { db: dbName, backupPath: null as string | null, applied: false };
  }
  const userAfter: Snapshot = {
    ...userBefore, loginDisabled: true, loginDisabledAt: now.toISOString(), loginDisabledBy: ACTOR, loginDisabledReason: REASON,
  };
  delete userAfter.resetTokenHash;
  delete userAfter.resetTokenExpiry;
  const token = retire.resetTokenHash
    ? `clears set-password token (${retire.resetTokenExpiry && new Date(retire.resetTokenExpiry) > now ? "UNEXPIRED" : "expired"})`
    : "no set-password token";
  log(`\n5. RETIRE: loginDisabled ${s(retire.loginDisabled) || "(absent)"} → true; ${token}. Email, status, Employee, memberships unchanged.`);

  const backup: Backup = {
    script: "fix-yash-accounts-v2",
    db: dbName,
    createdAt: now.toISOString(),
    attendances: attRows.map((r) => ({ _id: stored(r._id), userId: stored(r.userId), date: s(r.date) })),
    permission: perm ? { _id: stored(perm._id), userId: stored(perm.userId) } : null,
    user: { before: userBefore, after: userAfter },
  };
  if (!opts.apply) {
    log("\nDRY-RUN complete. Re-run with --apply to write.");
    return { db: dbName, backupPath: null as string | null, applied: false };
  }

  await requireTransactions();
  const outDir = opts.outDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
  fs.mkdirSync(outDir, { recursive: true });
  const backupPath = path.join(outDir, `fix-yash-accounts-v2-${backup.createdAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  log(`backup written: ${backupPath}`);

  await inTransaction(async (session) => {
    for (const a of backup.attendances) {
      await updateExactlyOne("attendances", { _id: revive(a._id), userId: revive(a.userId) },
        { $set: { userId: asTypeOf(KEEP_ID, a.userId) } }, session, `attendance ${a._id.hex}`);
    }
    if (backup.permission) {
      const p = backup.permission;
      await updateExactlyOne("userpermissions", { _id: revive(p._id), userId: revive(p.userId) },
        { $set: { userId: asTypeOf(KEEP_ID, p.userId) } }, session, `permission ${p._id.hex}`);
    }
    await updateExactlyOne("users", { _id: oid(RETIRE_ID), loginDisabled: retire.loginDisabled ?? null },
      snapshotUpdate(userAfter), session, `user ${RETIRE_ID}`);
  });
  log(`\ndone — ${backup.attendances.length} attendance row(s) and ${backup.permission ? 1 : 0} permission row moved, RETIRE login disabled.`);
  log(`Undo: --undo=${backupPath}`);
  return { db: dbName, backupPath, applied: true };
}

/* ── undo ──────────────────────────────────────────────────────────────── */

export async function undoFixYashAccounts(opts: { expectDb?: string; backupPath: string; apply?: boolean; log?: Log }) {
  const log = opts.log ?? ((l: string) => console.log(l));
  const dbName = guardDb(opts.expectDb);
  const backup = JSON.parse(fs.readFileSync(opts.backupPath, "utf8")) as Backup;
  if (backup.script !== "fix-yash-accounts-v2") throw new Error(`REFUSING: ${opts.backupPath} is not a backup of this script.`);
  if (backup.db !== dbName) throw new Error(`REFUSING: backup is from db "${backup.db}", connected db is "${dbName}".`);
  log(`db ${dbName} · UNDO ${opts.backupPath} · ${opts.apply ? "APPLY — writes" : "DRY-RUN — nothing written"}`);

  // Every recorded item must be wholly in the fixed state (or wholly before).
  const states = new Set<"before" | "after">();
  const where = (v: unknown, from: StoredId) =>
    s(v) === from.hex && isOid(v) === from.oid ? "before" : s(v) === KEEP_ID && isOid(v) === from.oid ? "after" : null;
  for (const a of backup.attendances) {
    const row = (await db().collection("attendances").findOne({ _id: revive(a._id) } as AnyObj)) as AnyObj | null;
    const st = row ? where(row.userId, a.userId) : null;
    if (!st) throw new Error(`REFUSING: attendance ${a._id.hex} changed since the fix (userId ${s(row?.userId) || "missing"}).`);
    states.add(st);
  }
  if (backup.permission) {
    const p = backup.permission;
    const row = (await db().collection("userpermissions").findOne({ _id: revive(p._id) } as AnyObj)) as AnyObj | null;
    const st = row ? where(row.userId, p.userId) : null;
    if (!st) throw new Error(`REFUSING: permission ${p._id.hex} changed since the fix (userId ${s(row?.userId) || "missing"}).`);
    states.add(st);
  }
  const u = (await db().collection("users").findOne({ _id: oid(RETIRE_ID) })) as AnyObj | null;
  const cur = u ? snapshot(u) : null;
  if (!cur) throw new Error(`REFUSING: user ${RETIRE_ID} not found.`);
  if (sameSnap(cur, backup.user.before)) states.add("before");
  else if (sameSnap(cur, backup.user.after)) states.add("after");
  else throw new Error(`REFUSING: user ${RETIRE_ID} login fields changed since the fix: ${JSON.stringify(cur)}`);

  if (states.size > 1) throw new Error("REFUSING: partly undone already — some items are back, some are not.");
  if (states.has("before")) {
    log("Already as before. Nothing to do.");
    return { db: dbName, restored: false };
  }
  log(`  ${opts.apply ? "restoring" : "would restore"}: ${backup.attendances.length} attendance row(s) → RETIRE, `
    + `${backup.permission ? "permission row → RETIRE, " : ""}RETIRE login fields → ${JSON.stringify(backup.user.before)}`);
  if (!opts.apply) {
    log("\nundo dry-run — nothing written.");
    return { db: dbName, restored: false };
  }

  await requireTransactions();
  await inTransaction(async (session) => {
    for (const a of backup.attendances) {
      await updateExactlyOne("attendances", { _id: revive(a._id), userId: asTypeOf(KEEP_ID, a.userId) },
        { $set: { userId: revive(a.userId) } }, session, `attendance ${a._id.hex}`);
    }
    if (backup.permission) {
      const p = backup.permission;
      await updateExactlyOne("userpermissions", { _id: revive(p._id), userId: asTypeOf(KEEP_ID, p.userId) },
        { $set: { userId: revive(p.userId) } }, session, `permission ${p._id.hex}`);
    }
    await updateExactlyOne("users", { _id: oid(RETIRE_ID), loginDisabled: true },
      snapshotUpdate(backup.user.before), session, `user ${RETIRE_ID}`);
  });
  log("\nundo done.");
  return { db: dbName, restored: true };
}

function guardDb(expectDb?: string) {
  const name = mongoose.connection.name;
  if (!expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${name}").`);
  if (expectDb !== name) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${name}".`);
  return name;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
    const expectDb = arg("expect-db");
    const apply = process.argv.includes("--apply");
    const undo = arg("undo");
    if (undo) await undoFixYashAccounts({ expectDb, backupPath: path.resolve(undo), apply });
    else await fixYashAccounts({ expectDb, apply });
  } finally {
    await mongoose.disconnect();
  }
}

// Run only when executed directly — importing it (the tests) must not connect.
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/fix-yash-accounts.ts");
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
