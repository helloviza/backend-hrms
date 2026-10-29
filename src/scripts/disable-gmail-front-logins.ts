// apps/backend/src/scripts/disable-gmail-front-logins.ts
//
// Closes the sign-in of the 38 personal-address "front" accounts that the
// onboarding flow created (onboarding invite went to a personal gmail →
// syncEmployeeFromOnboarding made a User with email = that address), by
// setting User.loginDisabled (utils/loginDisabled.ts) and clearing any
// outstanding set-password token. The ids are the A+B list of
// cleanup-email-field-conflicts (prod report 2026-10-29).
//
// Touches ONLY loginDisabled / loginDisabledAt / loginDisabledBy /
// loginDisabledReason / resetTokenHash / resetTokenExpiry, with raw
// $set/$unset (no Mongoose timestamps). status, Employee, membership and
// every HR record are left exactly as they are.
//
// Guards — anything that no longer looks like the report is SKIPPED: user
// missing, email changed, already disabled. A successful login in the last
// 90 days is NOT a skip (the point is to close the address) but is printed
// as WARN so the dry-run shows it.
//
// DRY-RUN by default. --apply first writes a JSON backup of those six fields
// per user (a key missing from `before` = the field was absent) to
// src/scripts/out/, prints its path, then writes. --undo=<backup.json>
// restores it exactly — including the cleared token — dry-run too unless
// --apply, skipping a user changed since.
//
//   npx tsx src/scripts/disable-gmail-front-logins.ts --expect-db=<db> [--apply]
//   npx tsx src/scripts/disable-gmail-front-logins.ts --expect-db=<db> --undo=<backup.json> [--apply]
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

type AnyObj = Record<string, any>;
const FIELDS = ["loginDisabled", "loginDisabledAt", "loginDisabledBy", "loginDisabledReason", "resetTokenHash", "resetTokenExpiry"] as const;
type Field = (typeof FIELDS)[number];
type Snapshot = Partial<Record<Field, string | boolean | null>>;
const DATE_FIELDS: Field[] = ["loginDisabledAt", "resetTokenExpiry"];

const ACTOR = "script:disable-gmail-front-logins";
const REASON = "Onboarding front account (personal email); the person signs in with their company account.";
const s = (v: unknown) => (v == null ? "" : String(v));
const norm = (v: unknown) => s(v).trim().toLowerCase();

/** Front account id → the email the 2026-10-29 report showed on it. */
export const FRONT_ACCOUNTS: Array<{ id: string; email: string }> = [
  { id: "6aba70a6ec67f0c143906389", email: "adutu20@gmail.com" },
  { id: "6a38daf4acc540cfe96493df", email: "ajaykumarpoddar2529@gmail.com" },
  { id: "69f2efead9f992b63739652c", email: "akankshasharma1000@gmail.com" },
  { id: "69f2e87ed9f992b637394be8", email: "anmolgarg9540@gmail.com" },
  { id: "69c1288faa88ed27a8ccefeb", email: "antaryami.mallick98@gmail.com" },
  { id: "6abbd04cec67f0c143971ccd", email: "anushkagehlot05@gmail.com" },
  { id: "69f23c9308f02c8abaabbbcb", email: "arwakhan8898@gmail.com" },
  { id: "6a5f014028c895e63e2583a0", email: "ashuugle94@gmail.com" },
  { id: "6a5b9679e64c94dd2ac0528d", email: "chayak025@gmail.com" },
  { id: "69c12a2caa88ed27a8ccf03e", email: "chiragkapoor63@gmail.com" },
  { id: "6acca2f42ba899f4c34335a5", email: "comrade31333@yahoo.com" },
  { id: "6a0f293d97dad0228433607a", email: "corbettfunsafari@gmail.com" },
  { id: "69b393586bfa759f0571ae59", email: "dsach1978@gmail.com" },
  { id: "6aa15d7b82561bf787a7a996", email: "harshalchaprot1@gmail.com" },
  { id: "6aa15d8182561bf787a7a9a3", email: "henryj102000@gmail.com" },
  { id: "6a75cd3f5c0308b03aa643b4", email: "jainavni666@gmail.com" },
  { id: "6a43651b7e25fcdc848be554", email: "jalwalbhumika1@gmail.com" },
  { id: "6a20288247e877485fd5ada5", email: "jasreetkaur.1205@gmail.com" },
  { id: "6ad975dc0cf8890a75b97bd3", email: "jo.ritesh@gmail.com" },
  { id: "6ac28bbc37667994d16d90e4", email: "kafia.saleem11@gmail.con" },
  { id: "6ab93dbcec67f0c1438a9d5e", email: "keshavvyas0514@gmail.com" },
  { id: "6a7970405c0308b03ab4a018", email: "mahimaa.bali16@gmail.com" },
  { id: "6ac363c1963e4d76be162144", email: "md_arif_286@hotmail.com" },
  { id: "6a882d1e80e11e0ffbb11675", email: "muskan10051999@gmail.com" },
  { id: "69f38ea33dbdc9d63fcf4e2e", email: "neelanchalbhargava9@gmail.com" },
  { id: "6a0b35c9dfe9c56d4d4b3ee9", email: "nikita1999dumka@gmail.com" },
  { id: "6a252d0704a47b3f91b4fa9b", email: "nitikagoel2603@gmail.con" },
  { id: "69c12884aa88ed27a8ccefd6", email: "nowshibamalik96@gmail.com" },
  { id: "6a0ffc7c97dad02284365cca", email: "rajdhruv9685@gmail.com" },
  { id: "6a3bcd4044ac14ef3830d017", email: "saisubhrasouresh2002@gmail.com" },
  { id: "69ef374f41cfea24d8eb245f", email: "sakibsaleem99@gmail.com" },
  { id: "6a293d5d04a47b3f91c44977", email: "savarnutkarsh@gmail.com" },
  { id: "6aaeaaab9bd2027eb1e2031a", email: "shivanshnigam19@gmail.com" },
  { id: "69f4e1783b66a776422ea038", email: "shreyamishra0804@gmail.com" },
  { id: "6a4f9525a4459c8957424d9b", email: "syma.saleem11@gmail.com" },
  { id: "6a0c0c4fdfe9c56d4d4e414c", email: "triptik063@gmail.com" },
  { id: "6a1c22f905bde40eaaef7875", email: "varunrohilladelhi@gmail.com" },
  { id: "69c12a32aa88ed27a8ccf049", email: "wassiqamir7@gmail.com" },
];

type BackupEntry = { userId: string; email: string; before: Snapshot; after: Snapshot };
export type Backup = { script: "disable-gmail-front-logins"; db: string; createdAt: string; entries: BackupEntry[] };

const users = () => mongoose.connection.db!.collection("users");
const oid = (id: string) => new mongoose.Types.ObjectId(id);

/** Dates as ISO strings so a snapshot round-trips through JSON. */
function snapshot(u: AnyObj): Snapshot {
  const snap: Snapshot = {};
  for (const f of FIELDS) {
    if (!(f in u)) continue;
    const v = u[f];
    snap[f] = v == null ? null : v instanceof Date ? v.toISOString() : typeof v === "boolean" ? v : String(v);
  }
  return snap;
}
const sameSnap = (a: Snapshot, b: Snapshot) => FIELDS.every((f) => (f in a) === (f in b) && a[f] === b[f]);

/** Write a snapshot back exactly: present keys $set (dates revived), absent keys $unset. */
async function writeSnapshot(userId: string, snap: Snapshot) {
  const set: AnyObj = {};
  const unset: AnyObj = {};
  for (const f of FIELDS) {
    if (!(f in snap)) { unset[f] = ""; continue; }
    const v = snap[f];
    set[f] = v != null && DATE_FIELDS.includes(f) ? new Date(String(v)) : v;
  }
  const update: AnyObj = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  const r = await users().updateOne({ _id: oid(userId) }, update);
  if (r.matchedCount !== 1) throw new Error(`user ${userId} not found while writing`);
}

export async function disableGmailFrontLogins(opts: {
  expectDb?: string; apply?: boolean; outDir?: string; now?: Date; log?: (line: string) => void;
}) {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = guardDb(opts.expectDb);
  const now = opts.now ?? new Date();
  log(`db ${db} · ${opts.apply ? "APPLY — writes" : "DRY-RUN — nothing written"}`);

  const rows = new Map<string, AnyObj>();
  for (const u of await users().find({ _id: { $in: FRONT_ACCOUNTS.map((a) => oid(a.id)) } }).toArray()) rows.set(String(u._id), u);
  const loggedIn = new Set(
    (await mongoose.connection.db!.collection("sessionlogs").distinct("userId", {
      userId: { $in: FRONT_ACCOUNTS.map((a) => oid(a.id)) }, event: "LOGIN", success: { $ne: false },
    })).map(String),
  );

  const plan: BackupEntry[] = [];
  let skipped = 0;
  for (const a of FRONT_ACCOUNTS) {
    const u = rows.get(a.id);
    const why = !u ? "user not found"
      : norm(u.email) !== a.email ? `email is now "${s(u.email)}"`
      : u.loginDisabled === true ? "login already disabled"
      : "";
    if (why) { skipped++; log(`  ${a.id}  ${a.email}  SKIP — ${why}`); continue; }
    const before = snapshot(u!);
    const after: Snapshot = {
      ...before, loginDisabled: true, loginDisabledAt: now.toISOString(), loginDisabledBy: ACTOR, loginDisabledReason: REASON,
    };
    delete after.resetTokenHash;
    delete after.resetTokenExpiry;
    const token = u!.resetTokenHash
      ? `clears set-password token (${u!.resetTokenExpiry && new Date(u!.resetTokenExpiry) > now ? "UNEXPIRED" : "expired"})`
      : "no token";
    log(`  ${a.id}  ${a.email}  → disable login; ${token}${loggedIn.has(a.id) ? "  WARN: has a successful LOGIN in sessionlogs (90d)" : ""}`);
    plan.push({ userId: a.id, email: a.email, before, after });
  }
  log(`\n${plan.length} to disable, ${skipped} skipped`);
  if (!opts.apply || !plan.length) {
    if (!opts.apply) log("DRY-RUN complete. Re-run with --apply to write.");
    return { db, backupPath: null as string | null, planned: plan.length, applied: 0, skipped, failed: 0 };
  }

  const backup: Backup = { script: "disable-gmail-front-logins", db, createdAt: now.toISOString(), entries: plan };
  const outDir = opts.outDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
  fs.mkdirSync(outDir, { recursive: true });
  const backupPath = path.join(outDir, `disable-gmail-front-logins-${backup.createdAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  log(`backup written: ${backupPath}`);

  let applied = 0;
  let failed = 0;
  for (const e of plan) {
    try { await writeSnapshot(e.userId, e.after); applied++; log(`  OK   ${e.userId}  ${e.email}`); }
    catch (err: any) { failed++; log(`  FAIL ${e.userId}  ${e.email}: ${err?.message || err}`); }
  }
  log(`\ndone — ${applied} applied, ${failed} failed. Undo: --undo=${backupPath}`);
  return { db, backupPath, planned: plan.length, applied, skipped, failed };
}

export async function undoDisableGmailFrontLogins(opts: { expectDb?: string; backupPath: string; apply?: boolean; log?: (line: string) => void }) {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = guardDb(opts.expectDb);
  const backup = JSON.parse(fs.readFileSync(opts.backupPath, "utf8")) as Backup;
  if (backup.script !== "disable-gmail-front-logins") throw new Error(`REFUSING: ${opts.backupPath} is not a backup of this script.`);
  if (backup.db !== db) throw new Error(`REFUSING: backup is from db "${backup.db}", connected db is "${db}".`);
  log(`db ${db} · UNDO ${opts.backupPath} · ${opts.apply ? "APPLY — writes" : "DRY-RUN — nothing written"}`);

  let restored = 0;
  let skipped = 0;
  let failed = 0;
  for (const e of backup.entries) {
    const cur = (await users().findOne({ _id: oid(e.userId) })) as AnyObj | null;
    const now = cur ? snapshot(cur) : null;
    if (!now) { skipped++; log(`  SKIP ${e.userId}  ${e.email}  — user not found`); continue; }
    if (sameSnap(now, e.before)) { skipped++; log(`  SKIP ${e.userId}  ${e.email}  — already as before`); continue; }
    if (!sameSnap(now, e.after)) { skipped++; log(`  SKIP ${e.userId}  ${e.email}  — changed since: ${JSON.stringify(now)}`); continue; }
    if (!opts.apply) { log(`  would restore ${e.userId}  ${e.email}  → ${JSON.stringify(e.before)}`); continue; }
    try { await writeSnapshot(e.userId, e.before); restored++; log(`  RESTORED ${e.userId}  ${e.email}`); }
    catch (err: any) { failed++; log(`  FAIL ${e.userId}  ${e.email}: ${err?.message || err}`); }
  }
  log(`\nundo ${opts.apply ? "done" : "dry-run"} — ${restored} restored, ${skipped} skipped, ${failed} failed.`);
  return { db, restored, skipped, failed };
}

function guardDb(expectDb?: string) {
  const db = mongoose.connection.name;
  if (!expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (expectDb !== db) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${db}".`);
  return db;
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
    const r = undo
      ? await undoDisableGmailFrontLogins({ expectDb, backupPath: path.resolve(undo), apply })
      : await disableGmailFrontLogins({ expectDb, apply });
    if (r.failed) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

// Run only when executed directly — importing it (the tests) must not connect.
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/disable-gmail-front-logins.ts");
if (invokedDirectly) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
