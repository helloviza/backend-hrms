// apps/backend/src/scripts/fix-yash-accounts.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { fixYashAccounts, undoFixYashAccounts, scanReferences, KEEP_ID, RETIRE_ID } from "./fix-yash-accounts.js";

let rs: MongoMemoryReplSet;
const DB = "fix-yash-accounts-test";
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = (id?: string) => new mongoose.Types.ObjectId(id);
const WS = oid();
const NOW = new Date("2026-10-30T10:00:00Z");
const quiet = () => {};
let outDir = "";

const balance = (userId: string, extra: Record<string, unknown> = {}) => ({
  workspaceId: WS, userId: oid(userId), year: 2026,
  balances: { CL: { entitled: 6, accrued: 1.5, used: 0 }, EL: { entitled: 12, accrued: 7.5, used: 0 } },
  joinDate: new Date("2026-05-13"), probationEndDate: new Date("2026-08-11"), adjustmentLog: [],
  createdAt: new Date(), updatedAt: new Date(), __v: 0, ...extra,
});

beforeAll(async () => {
  // The fix writes in one transaction, so it needs a replica set.
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(rs.getUri(DB), { autoIndex: false, autoCreate: false });
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await rs?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "fya2-"));
  // Prod's unique indexes — the moves must respect them.
  await col("attendances").createIndex({ userId: 1, date: 1 }, { unique: true });
  await col("userpermissions").createIndex({ userId: 1 }, { unique: true });
  await col("users").insertMany([
    { _id: oid(KEEP_ID), email: "yash@plumtrips.com", status: "ACTIVE", workspaceId: WS, managerId: oid() },
    {
      _id: oid(RETIRE_ID), email: "yashk242002@gmail.com", status: "ACTIVE", workspaceId: WS, passwordHash: "h",
      resetTokenHash: "tok", resetTokenExpiry: new Date("2026-11-01"), updatedAt: new Date("2026-01-01"),
    },
  ] as any[]);
  await col("attendances").insertMany([
    { workspaceId: WS, userId: oid(RETIRE_ID), date: "2026-10-28" },
    { workspaceId: WS, userId: oid(RETIRE_ID), date: "2026-10-29" },
    { workspaceId: WS, userId: RETIRE_ID, date: "2026-10-30" }, // string-typed id stays a string
  ] as any[]);
  await col("userpermissions").insertOne({ userId: RETIRE_ID, email: "yash@plumtrips.com", status: "active" } as any);
  // As on prod: same balances, different joinDate / probationEndDate.
  await col("leavebalances").insertMany([
    balance(RETIRE_ID, { joinDate: new Date("2026-05-15"), probationEndDate: new Date("2026-08-13") }),
    balance(KEEP_ID),
  ] as any[]);
  await col("workspacememberships").insertMany([
    { userId: oid(RETIRE_ID), workspaceId: WS, status: "ACTIVE" },
    { userId: oid(KEEP_ID), workspaceId: WS, status: "ACTIVE" },
  ] as any[]);
  await col("employees").insertOne({ workspaceId: WS, ownerId: oid(KEEP_ID), status: "ACTIVE", joiningDate: new Date("2026-05-13") } as any);
});

/** Whole-database fingerprint for "nothing was written". */
async function dump() {
  const out: Record<string, unknown[]> = {};
  for (const c of (await mongoose.connection.db!.listCollections().toArray()).map((x) => x.name).sort()) {
    out[c] = await col(c).find({}).sort({ _id: 1 }).toArray();
  }
  return out;
}
const run = (extra: Record<string, unknown> = {}, lines?: string[]) =>
  fixYashAccounts({ expectDb: DB, outDir, now: NOW, log: lines ? (l) => lines.push(l) : quiet, ...extra });

describe("fix-yash-accounts (keep 6a0307, retire 6a0190)", () => {
  it("refuses without the right --expect-db", async () => {
    await expect(fixYashAccounts({ log: quiet })).rejects.toThrow(/expect-db/);
    await expect(fixYashAccounts({ expectDb: "prod", log: quiet })).rejects.toThrow(/connected db/);
  });

  it("scanReferences finds ObjectId and string ids at any depth, not RETIRE's own doc", async () => {
    await col("notifications").insertOne({ to: [{ user: oid(RETIRE_ID) }], body: `ping user:${RETIRE_ID}` } as any);
    const refs = Object.fromEntries(await scanReferences(RETIRE_ID));
    expect(refs).toEqual({
      "attendances.userId": 3, "userpermissions.userId": 1, "leavebalances.userId": 1, "workspacememberships.userId": 1,
      "notifications.to[].user": 1, "notifications.body": 1,
    });
  });

  it("dry-run prints exactly what moves and writes nothing", async () => {
    const before = await dump();
    const lines: string[] = [];
    const r = await run({}, lines);
    expect(r).toMatchObject({ applied: false, backupPath: null });
    expect(await dump()).toEqual(before);
    expect(fs.readdirSync(outDir)).toHaveLength(0);
    const out = lines.join("\n");
    expect(out).toMatch(/2\. attendances: 3 row\(s\) RETIRE → KEEP \(2026-10-28 … 2026-10-30\)/);
    expect(out).toMatch(/3\. userpermissions: .* RETIRE → KEEP/);
    expect(out).toMatch(/KEEP Employee .* joiningDate=2026-05-13/);
    expect(out).toMatch(/RETIRE .*: joinDate=2026-05-15 probationEndDate=2026-08-13 balances=/);
    expect(out).toMatch(/KEEP {3}.*: joinDate=2026-05-13 probationEndDate=2026-08-11 balances=/);
    expect(out).toMatch(/balances equal — KEEP's row kept, RETIRE's left untouched/);
    expect(out).not.toMatch(/WARN/);
    expect(out).toMatch(/5\. RETIRE: loginDisabled \(absent\) → true; clears set-password token \(UNEXPIRED\)/);
  });

  it("--apply moves attendance + permission, disables RETIRE, touches nothing else", async () => {
    const before = await dump();
    const r = await run({ apply: true });
    expect(r.applied).toBe(true);
    expect(fs.existsSync(r.backupPath!)).toBe(true);

    const att = await col("attendances").find({}).sort({ date: 1 }).toArray();
    expect(att.map((a) => a.userId)).toEqual([oid(KEEP_ID), oid(KEEP_ID), KEEP_ID]);
    expect(await col("userpermissions").findOne({})).toMatchObject({ userId: KEEP_ID, email: "yash@plumtrips.com" });

    const ret: any = await col("users").findOne({ _id: oid(RETIRE_ID) });
    expect(ret).toMatchObject({
      email: "yashk242002@gmail.com", status: "ACTIVE", passwordHash: "h",
      loginDisabled: true, loginDisabledAt: NOW, loginDisabledBy: "script:fix-yash-accounts",
    });
    expect(ret).not.toHaveProperty("resetTokenHash");
    expect(ret).not.toHaveProperty("resetTokenExpiry");
    expect(ret.updatedAt).toEqual(new Date("2026-01-01"));

    const after = await dump();
    for (const c of ["leavebalances", "workspacememberships", "employees"]) expect(after[c]).toEqual(before[c]);
    expect(after.users.find((u: any) => String(u._id) === KEEP_ID)).toEqual(before.users.find((u: any) => String(u._id) === KEEP_ID));
  });

  it("is idempotent: a second run is a no-op", async () => {
    await run({ apply: true });
    const after = await dump();
    expect(await run({ apply: true })).toMatchObject({ applied: false });
    expect(await dump()).toEqual(after);
  });

  it("reports history references, leaves them on RETIRE and goes ahead", async () => {
    await col("sessionlogs").insertMany([{ userId: oid(RETIRE_ID), event: "LOGIN" }, { userId: oid(RETIRE_ID), event: "TOKEN_REFRESH" }] as any[]);
    await col("userpresences").insertOne({ userId: oid(RETIRE_ID), status: "IDLE" } as any);
    await col("workspaceauditlogs").insertOne({ details: { targetUserId: RETIRE_ID, targetEmail: "yashk242002@gmail.com" } } as any);
    const before = await dump();
    const lines: string[] = [];
    expect(await run({ apply: true }, lines)).toMatchObject({ applied: true });
    const out = lines.join("\n");
    expect(out).toMatch(/h  sessionlogs\.userId: 2 {2}\(history — stays on RETIRE\)/);
    expect(out).toMatch(/h  userpresences\.userId: 1/);
    expect(out).toMatch(/h  workspaceauditlogs\.details\.targetUserId: 1/);
    const after = await dump();
    for (const c of ["sessionlogs", "userpresences", "workspaceauditlogs"]) expect(after[c]).toEqual(before[c]);
  });

  it("STOPs on any reference beyond the allowed + history ones, moving nothing", async () => {
    await col("users").insertOne({ _id: oid(), email: "x@plumtrips.com", workspaceId: WS, managerId: oid(RETIRE_ID) } as any);
    await col("sessionlogs").insertOne({ userId: RETIRE_ID, event: "LOGIN" } as any);
    const before = await dump();
    const lines: string[] = [];
    await expect(run({ apply: true }, lines)).rejects.toThrow(/STOP: RETIRE is also referenced by users\.managerId — nothing moved/);
    expect(lines.join("\n")).toMatch(/!! users\.managerId: 1/);
    expect(await dump()).toEqual(before);
    expect(fs.readdirSync(outDir)).toHaveLength(0);
  });

  it("refuses an attendance date clash with KEEP", async () => {
    await col("attendances").insertOne({ workspaceId: WS, userId: oid(KEEP_ID), date: "2026-10-29" } as any);
    const before = await dump();
    await expect(run({ apply: true })).rejects.toThrow(/KEEP already has attendance on 2026-10-29/);
    expect(await dump()).toEqual(before);
  });

  it("refuses when KEEP already has a permission row", async () => {
    await col("userpermissions").insertOne({ userId: KEEP_ID, email: "other" } as any);
    const before = await dump();
    await expect(run({ apply: true })).rejects.toThrow(/KEEP already has permission row/);
    expect(await dump()).toEqual(before);
  });

  it("WARNs (does not block) when KEEP's leave joinDate differs from the Employee record", async () => {
    await col("employees").updateOne({ ownerId: oid(KEEP_ID) }, { $set: { joiningDate: new Date("2026-05-20") } });
    const lines: string[] = [];
    expect(await run({ apply: true }, lines)).toMatchObject({ applied: true });
    expect(lines.join("\n")).toMatch(/WARN: KEEP's leave joinDate 2026-05-13 ≠ Employee joiningDate 2026-05-20 \(not blocking\)/);
  });

  it("STOPs when the balance numbers differ, or KEEP has no row", async () => {
    await col("leavebalances").updateOne({ userId: oid(KEEP_ID) }, { $set: { "balances.CL.used": 1 } });
    const before = await dump();
    const lines: string[] = [];
    await expect(run({ apply: true }, lines)).rejects.toThrow(/STOP: leave balances need a decision \(year 2026: balances differ\)/);
    expect(lines.join("\n")).toMatch(/KEEP {3}.*"used":1/);
    expect(await dump()).toEqual(before);

    await col("leavebalances").deleteOne({ userId: oid(KEEP_ID) });
    await expect(run({ apply: true })).rejects.toThrow(/year 2026: KEEP has no row/);
  });

  it("rolls everything back when a write inside the transaction fails", async () => {
    // Reject only the last write: RETIRE getting loginDisabled.
    await mongoose.connection.db!.command({
      collMod: "users",
      validator: { $or: [{ _id: { $ne: oid(RETIRE_ID) } }, { loginDisabled: { $ne: true } }] },
      validationAction: "error",
    });
    const before = await dump();
    await expect(run({ apply: true })).rejects.toThrow();
    const after = await dump();
    for (const c of ["attendances", "userpermissions", "users"]) expect(after[c]).toEqual(before[c]);
  });

  it("--undo reverses it exactly, dry-run first, then is a no-op", async () => {
    const before = await dump();
    const { backupPath } = await run({ apply: true });
    const fixed = await dump();

    expect(await undoFixYashAccounts({ expectDb: DB, backupPath: backupPath!, log: quiet })).toMatchObject({ restored: false });
    expect(await dump()).toEqual(fixed);

    expect(await undoFixYashAccounts({ expectDb: DB, backupPath: backupPath!, apply: true, log: quiet })).toMatchObject({ restored: true });
    expect(await dump()).toEqual(before);

    expect(await undoFixYashAccounts({ expectDb: DB, backupPath: backupPath!, apply: true, log: quiet })).toMatchObject({ restored: false });
  });

  it("--undo refuses if anything changed since, or the backup is from another db", async () => {
    const { backupPath } = await run({ apply: true });
    await col("attendances").updateOne({ date: "2026-10-28" }, { $set: { userId: oid() } });
    await expect(undoFixYashAccounts({ expectDb: DB, backupPath: backupPath!, apply: true, log: quiet })).rejects.toThrow(/attendance .* changed since/);

    const b = JSON.parse(fs.readFileSync(backupPath!, "utf8"));
    const other = path.join(outDir, "other.json");
    fs.writeFileSync(other, JSON.stringify({ ...b, db: "Plumtrips_hrms" }));
    await expect(undoFixYashAccounts({ expectDb: DB, backupPath: other, log: quiet })).rejects.toThrow(/from db/);
  });
});
