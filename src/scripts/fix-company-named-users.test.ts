// scripts/fix-company-named-users.ts — PROPOSE is read-only and picks the
// person in order (own firstName → Customer key contact → claimed traveller
// profile → onboarding signatory / key contacts / invitee → blank); APPLY is a
// dry run unless --apply, skips blank / company / changed-since-propose rows,
// backs up first, syncs the roster, audits; UNDO restores exactly.
// Fixtures are raw inserts so absent fields stay absent, as in prod.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const { proposeCompanyNamedUsers, applyNameFixes, undoNameFixes, toCsv, parseCsv, HOUSE_WORKSPACE_ID } = await import(
  "./fix-company-named-users.js"
);

let mongod: MongoMemoryServer;
const DB = "fix-company-named-test";
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const quiet = () => {};

const C_A = oid();
const C_B = oid();
const C_C = oid();
const WS_A = oid();
const WS_B = oid();
const WS_C = oid();
const HOUSE = new mongoose.Types.ObjectId(HOUSE_WORKSPACE_ID);
const U = { asha: oid(), anirudh: oid(), ravi: oid(), sig: oid(), blank: oid(), meera: oid(), staff: oid(), demo: oid(), qa: oid() };
const tmp = (name: string) => path.join(os.tmpdir(), `fcnu-${process.pid}-${Date.now()}-${name}`);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(DB));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await col("customers").insertMany([
    { _id: C_A, name: "Peachmint", legalName: "Peachmint Foods Private Limited", keyContacts: [{ name: "Asha Rao", email: "ASHA@peachmint.test" }] },
    { _id: C_B, name: "Pixxel Space", legalName: "Pixxel Space India Private Limited" },
    { _id: C_C, name: "Failte Events LLP" },
  ]);
  await col("customerworkspaces").insertMany([
    { _id: WS_A, customerId: String(C_A), companyName: "Peachmint Foods Private Limited" },
    { _id: WS_B, customerId: String(C_B), companyName: "Pixxel Space India Pvt Ltd" },
    { _id: WS_C, customerId: String(C_C), companyName: "Failte Events LLP" },
    { _id: HOUSE, customerId: "house", companyName: "Plumtrips" },
  ]);
  const cust = (id: any, ws: any, c: any, email: string, names: Record<string, string>) => ({
    _id: id, email, workspaceId: ws, customerId: String(c), passwordHash: "x", roles: ["CUSTOMER"], ...names,
  });
  await col("users").insertMany([
    cust(U.asha, WS_A, C_A, "asha@peachmint.test", { name: "Peachmint Foods Private Limited" }),
    cust(U.anirudh, WS_B, C_B, "anirudh@pixxel.test", { name: "Pixxel Space", firstName: "Anirudh Binani" }),
    cust(U.ravi, WS_A, C_A, "ravi@peachmint.test", { name: "PEACHMINT FOODS PVT LTD", firstName: "Peachmint" }),
    cust(U.sig, WS_A, C_A, "sig@peachmint.test", { name: "Peachmint Foods" }),
    cust(U.blank, WS_C, C_C, "blank@failte.test", { name: "Failte Events" }),
    cust(U.meera, WS_A, C_A, "meera@peachmint.test", { name: "Meera Iyer", firstName: "Meera", lastName: "Iyer" }),
    { _id: U.staff, email: "ops@plumtrips.com", workspaceId: HOUSE, name: "Plumtrips", passwordHash: "x" },
    cust(U.demo, WS_A, C_A, "demo1@plumtrips.com", { name: "Peachmint Foods" }),
    cust(U.qa, WS_A, C_A, "x@cstep-qa.test", { name: "Peachmint Foods" }),
  ]);
  await col("travellerprofiles").insertOne({ workspaceId: WS_A, firstName: "Ravi", lastName: "Menon", claimedBy: U.ravi, claimedAt: new Date() });
  await col("onboardings").insertMany([
    {
      type: "business", email: "nobody@peachmint.test", linkedCustomerId: C_A, inviteeName: "Peachmint Foods",
      formPayload: { signatory: { name: "Peachmint Foods Pvt Ltd" }, keyContacts: [{ name: "Sig Person", email: "sig@peachmint.test" }] },
    },
    { type: "business", email: "blank@failte.test", linkedCustomerId: C_C, inviteeName: "Failte Events", formPayload: {} },
  ]);
  await col("customermembers").insertMany([
    { customerId: String(C_A), email: "asha@peachmint.test", role: "WORKSPACE_LEADER", name: "Peachmint" },
    { customerId: String(C_A), email: "sig@peachmint.test", role: "REQUESTER" }, // no name field
  ]);
});

const snapshot = async () =>
  JSON.stringify(await Promise.all(["users", "customermembers", "usernameaudits"].map((n) => col(n).find({}).sort({ _id: 1 }).toArray())));
const byEmail = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.email, r]));
const user = async (id: any) => (await col("users").findOne({ _id: id })) as any;

describe("PROPOSE (read-only)", () => {
  it("lists only company-named, non-HOUSE, non-excluded users, each with a person in order", async () => {
    const before = await snapshot();
    const { rows } = await proposeCompanyNamedUsers({ expectDb: DB, log: quiet });
    const r = byEmail(rows);

    expect(Object.keys(r).sort()).toEqual([
      "anirudh@pixxel.test",
      "asha@peachmint.test",
      "blank@failte.test",
      "ravi@peachmint.test",
      "sig@peachmint.test",
    ]);
    expect(r["anirudh@pixxel.test"]).toMatchObject({ proposedFirstName: "Anirudh", proposedLastName: "Binani", source: "existingFirstName" });
    expect(r["asha@peachmint.test"]).toMatchObject({ proposedFirstName: "Asha", proposedLastName: "Rao", source: "customerKeyContact" });
    // firstName "Peachmint" is the company's first word — never a person.
    expect(r["ravi@peachmint.test"]).toMatchObject({ proposedFirstName: "Ravi", proposedLastName: "Menon", source: "travellerProfile" });
    // signatory is the company → skipped; the matching key contact wins.
    expect(r["sig@peachmint.test"]).toMatchObject({ proposedFirstName: "Sig", proposedLastName: "Person", source: "onboardingKeyContact" });
    // invitee is the company → blank.
    expect(r["blank@failte.test"]).toMatchObject({ proposedFirstName: "", proposedLastName: "", source: "none" });
    expect(r["asha@peachmint.test"]).toMatchObject({ currentName: "Peachmint Foods Private Limited", currentFirstName: "", currentLastName: "" });

    expect(await snapshot()).toBe(before);
  });

  it("CSV round-trips, including Excel's BOM, CRLF and quoted commas", async () => {
    const { rows } = await proposeCompanyNamedUsers({ expectDb: DB, log: quiet });
    rows[0].note = 'a, "quoted" note';
    const excel = "﻿" + toCsv(rows).replace(/\n/g, "\r\n");
    expect(parseCsv(excel)).toEqual(rows);
  });

  it("refuses without --expect-db or with the wrong one", async () => {
    await expect(proposeCompanyNamedUsers({ expectDb: undefined, log: quiet })).rejects.toThrow(/REFUSING/);
    await expect(proposeCompanyNamedUsers({ expectDb: "prod", log: quiet })).rejects.toThrow(/REFUSING/);
  });
});

describe("APPLY", () => {
  it("dry run (default) writes nothing and no backup", async () => {
    const { rows } = await proposeCompanyNamedUsers({ expectDb: DB, log: quiet });
    const before = await snapshot();
    const backupPath = tmp("dry.json");
    const out = await applyNameFixes({ expectDb: DB, rows, backupPath, log: quiet });
    expect(out).toMatchObject({ applied: false, planned: 4, written: 0 });
    expect(out.skipped.map((s: any) => [s.email, s.reason])).toEqual([["blank@failte.test", "blank proposal"]]);
    expect(await snapshot()).toBe(before);
    expect(fs.existsSync(backupPath)).toBe(false);
  });

  it("--apply: backup first, first / last / name, roster synced, one audit row each; blank skipped", async () => {
    const { rows } = await proposeCompanyNamedUsers({ expectDb: DB, log: quiet });
    const backupPath = tmp("apply.json");
    const out = await applyNameFixes({ expectDb: DB, rows, apply: true, backupPath, log: quiet });
    expect(out).toMatchObject({ applied: true, planned: 4, written: 4 });

    const a = await user(U.asha);
    expect([a.firstName, a.lastName, a.name]).toEqual(["Asha", "Rao", "Asha Rao"]);
    expect((await user(U.anirudh)).name).toBe("Anirudh Binani");
    expect((await user(U.ravi)).name).toBe("Ravi Menon");
    expect((await user(U.blank)).name).toBe("Failte Events"); // never touched
    expect((await col("customermembers").findOne({ email: "asha@peachmint.test" }))?.name).toBe("Asha Rao");
    expect((await col("customermembers").findOne({ email: "sig@peachmint.test" }))?.name).toBe("Sig Person");

    const audits = await col("usernameaudits").find({}).toArray();
    expect(audits).toHaveLength(4);
    expect(audits.every((x: any) => x.via === "script")).toBe(true);

    const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
    expect(backup.db).toBe(DB);
    const ashaB = backup.entries.find((e: any) => e.email === "asha@peachmint.test");
    expect(ashaB.before).toEqual({ name: { present: true, value: "Peachmint Foods Private Limited" }, firstName: { present: false }, lastName: { present: false } });
  });

  it("skips a user changed since PROPOSE, and an edited proposal that is the company; writes the rest", async () => {
    const { rows } = await proposeCompanyNamedUsers({ expectDb: DB, log: quiet });
    await col("users").updateOne({ _id: U.asha }, { $set: { name: "Asha R" } }); // renamed meanwhile (e.g. via My Profile)
    const r = byEmail(rows);
    r["ravi@peachmint.test"].proposedFirstName = "Peachmint Foods"; // someone typed the company into the CSV
    r["ravi@peachmint.test"].proposedLastName = "";

    const out = await applyNameFixes({ expectDb: DB, rows, apply: true, backupPath: tmp("skip.json"), log: quiet });
    const reasons = Object.fromEntries(out.skipped.map((s: any) => [s.email, s.reason]));
    expect(reasons["asha@peachmint.test"]).toMatch(/changed since PROPOSE/);
    expect(reasons["ravi@peachmint.test"]).toMatch(/company/);
    expect(out.written).toBe(2);
    expect((await user(U.asha)).name).toBe("Asha R");
    expect((await user(U.ravi)).name).toBe("PEACHMINT FOODS PVT LTD");
  });
});

describe("UNDO", () => {
  it("dry run writes nothing; --apply restores exactly (absent fields absent again), roster too; a later edit is kept", async () => {
    const before = await col("users").find({}).sort({ _id: 1 }).toArray();
    const membersBefore = await col("customermembers").find({}).sort({ _id: 1 }).toArray();
    const { rows } = await proposeCompanyNamedUsers({ expectDb: DB, log: quiet });
    const backupPath = tmp("undo.json");
    await applyNameFixes({ expectDb: DB, rows, apply: true, backupPath, log: quiet });
    const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));

    // The person fixed their own name after the cleanup — undo must not clobber it.
    await col("users").updateOne({ _id: U.anirudh }, { $set: { name: "Anirudh B", lastName: "B" } });

    const dry = await undoNameFixes({ expectDb: DB, backup, log: quiet });
    expect(dry).toMatchObject({ applied: false, planned: 3, restored: 0 });
    expect((await user(U.asha)).name).toBe("Asha Rao");

    const out = await undoNameFixes({ expectDb: DB, backup, apply: true, log: quiet });
    expect(out.restored).toBe(3);
    expect(out.skipped.map((s: any) => s.email)).toEqual(["anirudh@pixxel.test"]);

    const strip = (d: any) => {
      const { updatedAt, ...rest } = d;
      return rest;
    };
    const after = await col("users").find({}).sort({ _id: 1 }).toArray();
    for (const id of [U.asha, U.ravi, U.sig]) {
      const b = before.find((x: any) => String(x._id) === String(id));
      const a = after.find((x: any) => String(x._id) === String(id));
      expect(strip(a)).toEqual(strip(b));
    }
    expect((await user(U.anirudh)).name).toBe("Anirudh B");
    const membersAfter = await col("customermembers").find({}).sort({ _id: 1 }).toArray();
    expect(membersAfter.map(strip)).toEqual(membersBefore.map(strip));
    expect(await col("usernameaudits").countDocuments({ actorEmail: /:undo$/ })).toBe(3);
  });

  it("refuses a backup taken from another database", async () => {
    await expect(undoNameFixes({ expectDb: DB, backup: { db: "other", createdAt: "", script: "", entries: [] }, log: quiet })).rejects.toThrow(
      /REFUSING/,
    );
  });
});
