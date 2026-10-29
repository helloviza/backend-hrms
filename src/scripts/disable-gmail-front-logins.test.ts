// apps/backend/src/scripts/disable-gmail-front-logins.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { disableGmailFrontLogins, undoDisableGmailFrontLogins, FRONT_ACCOUNTS } from "./disable-gmail-front-logins.js";

let mongod: MongoMemoryServer;
const DB = "disable-gmail-front-logins-test";
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = (id?: string) => new mongoose.Types.ObjectId(id);
const WS = oid();
const NOW = new Date("2026-10-29T14:00:00Z");
const [F1, F2, F3, F4, F5] = FRONT_ACCOUNTS;
let outDir = "";

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(DB), { autoIndex: false, autoCreate: false });
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "dgfl-"));
  await col("users").insertMany([
    // F1: unexpired welcome link
    { _id: oid(F1.id), email: F1.email, status: "ACTIVE", workspaceId: WS, passwordHash: "h1", resetTokenHash: "tok1", resetTokenExpiry: new Date("2026-10-30T00:00:00Z"), updatedAt: new Date("2026-01-01") },
    // F2: no token, has logged in
    { _id: oid(F2.id), email: ` ${F2.email.toUpperCase()}`, status: "ACTIVE", workspaceId: WS, passwordHash: "h2" },
    // F3: email changed since the report → skip
    { _id: oid(F3.id), email: "someone-else@gmail.com", status: "ACTIVE", workspaceId: WS, passwordHash: "h3" },
    // F4: already disabled → skip
    { _id: oid(F4.id), email: F4.email, workspaceId: WS, passwordHash: "h4", loginDisabled: true },
    // F5: INACTIVE stays INACTIVE
    { _id: oid(F5.id), email: F5.email, status: "INACTIVE", workspaceId: WS, passwordHash: "h5" },
  ] as any[]);
  await col("employees").insertOne({ workspaceId: WS, ownerId: oid(F1.id), status: "ACTIVE", isActive: true } as any);
  await col("sessionlogs").insertOne({ userId: oid(F2.id), event: "LOGIN", success: true, createdAt: NOW } as any);
});

const users = async () => col("users").find({}).sort({ _id: 1 }).toArray();
const u = async (id: string) => (await col("users").findOne({ _id: oid(id) })) as any;

describe("disable-gmail-front-logins", () => {
  it("lists exactly 38 front ids", () => {
    expect(FRONT_ACCOUNTS).toHaveLength(38);
    expect(new Set(FRONT_ACCOUNTS.map((a) => a.id)).size).toBe(38);
  });

  it("refuses without the right --expect-db", async () => {
    await expect(disableGmailFrontLogins({ log: () => {} })).rejects.toThrow(/expect-db/);
    await expect(disableGmailFrontLogins({ expectDb: "prod", log: () => {} })).rejects.toThrow(/connected db/);
  });

  it("dry-run writes nothing and shows the plan", async () => {
    const before = await users();
    const lines: string[] = [];
    const r = await disableGmailFrontLogins({ expectDb: DB, outDir, now: NOW, log: (l) => lines.push(l) });
    expect(r).toMatchObject({ planned: 3, applied: 0, backupPath: null });
    expect(await users()).toEqual(before);
    expect(fs.readdirSync(outDir)).toHaveLength(0);
    const out = lines.join("\n");
    expect(out).toMatch(new RegExp(`${F1.id}.*UNEXPIRED`));
    expect(out).toMatch(new RegExp(`${F2.id}.*WARN`));
    expect(out).toMatch(new RegExp(`${F3.id}.*SKIP — email is now`));
    expect(out).toMatch(new RegExp(`${F4.id}.*SKIP — login already disabled`));
    expect(out).toMatch(/user not found/);
  });

  it("apply sets only the flag fields + clears the token; undo restores exactly", async () => {
    const before = await users();
    const emp = await col("employees").find({}).toArray();
    const r = await disableGmailFrontLogins({ expectDb: DB, apply: true, outDir, now: NOW, log: () => {} });
    expect(r).toMatchObject({ planned: 3, applied: 3, failed: 0 });
    expect(fs.existsSync(r.backupPath!)).toBe(true);

    const f1 = await u(F1.id);
    expect(f1).toMatchObject({ loginDisabled: true, loginDisabledBy: "script:disable-gmail-front-logins", status: "ACTIVE", passwordHash: "h1" });
    expect(f1.loginDisabledAt).toEqual(NOW);
    expect(f1.loginDisabledReason).toMatch(/front account/i);
    expect(f1.resetTokenHash).toBeUndefined();
    expect(f1.resetTokenExpiry).toBeUndefined();
    expect(f1.updatedAt).toEqual(new Date("2026-01-01"));
    expect((await u(F5.id)).status).toBe("INACTIVE");
    expect((await u(F3.id)).loginDisabled).toBeUndefined();

    // nothing but the six fields changed
    const strip = (d: any) => {
      const { loginDisabled, loginDisabledAt, loginDisabledBy, loginDisabledReason, resetTokenHash, resetTokenExpiry, ...rest } = d;
      return rest;
    };
    expect((await users()).map(strip)).toEqual(before.map(strip));
    expect(await col("employees").find({}).toArray()).toEqual(emp);

    // undo dry-run writes nothing
    const applied = await users();
    await undoDisableGmailFrontLogins({ expectDb: DB, backupPath: r.backupPath!, log: () => {} });
    expect(await users()).toEqual(applied);

    // a user changed since is skipped
    await col("users").updateOne({ _id: oid(F2.id) }, { $set: { loginDisabledReason: "edited by hand" } });
    const undo = await undoDisableGmailFrontLogins({ expectDb: DB, backupPath: r.backupPath!, apply: true, log: () => {} });
    expect(undo).toMatchObject({ restored: 2, skipped: 1, failed: 0 });
    const after = await users();
    const byId = (list: any[], id: string) => list.find((d) => String(d._id) === id);
    for (const id of [F1.id, F5.id]) expect(byId(after, id)).toEqual(byId(before, id));
    expect(byId(after, F1.id).resetTokenExpiry).toEqual(new Date("2026-10-30T00:00:00Z"));
    expect(byId(after, F2.id).loginDisabled).toBe(true);
  });

  it("undo refuses a backup from another db or script", async () => {
    const p = path.join(outDir, "x.json");
    fs.writeFileSync(p, JSON.stringify({ script: "disable-gmail-front-logins", db: "prod", entries: [] }));
    await expect(undoDisableGmailFrontLogins({ expectDb: DB, backupPath: p, log: () => {} })).rejects.toThrow(/backup is from db/);
    fs.writeFileSync(p, JSON.stringify({ script: "other", db: DB, entries: [] }));
    await expect(undoDisableGmailFrontLogins({ expectDb: DB, backupPath: p, log: () => {} })).rejects.toThrow(/not a backup/);
  });
});
