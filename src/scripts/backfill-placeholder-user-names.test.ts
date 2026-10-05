// apps/backend/src/scripts/backfill-placeholder-user-names.test.ts
//
// Dry run by default (writes nothing, prints masked emails old → new and a
// count); --apply writes only placeholder fields; a real name is never
// overwritten; users with no better name are skipped and listed; refuses
// without --expect-db or with the wrong one.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const { backfillPlaceholderUserNames, maskEmail } = await import("./backfill-placeholder-user-names.js");
const { isPlaceholderName } = await import("../services/actorNames.js");

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const WS = oid();
const U = { asha: oid(), ravi: oid(), noname: oid(), meera: oid(), real: oid(), lowercase: oid() };
const DB = "backfill-names-test";

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
  await col("users").insertMany([
    { _id: U.asha, workspaceId: WS, email: "asha.rao@peachmint.test", firstName: "Workspace User", lastName: "" },
    { _id: U.ravi, workspaceId: WS, email: "ravi@peachmint.test", firstName: "Workspace User", name: "Ravi Kumar" },
    { _id: U.noname, workspaceId: WS, email: "s.iyer@peachmint.test", firstName: "Workspace User" },
    { _id: U.meera, workspaceId: WS, email: "meera@peachmint.test", firstName: "Meera", lastName: "Iyer", name: "Workspace User" },
    { _id: U.real, workspaceId: WS, email: "kiran@peachmint.test", firstName: "Kiran", lastName: "Mehta", name: "Kiran Mehta" },
    { _id: U.lowercase, workspaceId: WS, email: "dev@peachmint.test", firstName: "workspace user" },
  ] as any[]);
  await col("travellerprofiles").insertMany([
    { workspaceId: WS, travelerId: "PEA-001", firstName: "Asha", lastName: "Rao", claimedBy: U.asha },
    // A claimed profile never replaces a real account name.
    { workspaceId: WS, travelerId: "PEA-002", firstName: "Someone", lastName: "Else", claimedBy: U.real },
    { workspaceId: WS, travelerId: "PEA-003", firstName: "Dev", lastName: "Shah", claimedBy: U.lowercase },
  ] as any[]);
});

const user = (id: mongoose.Types.ObjectId) => col("users").findOne({ _id: id }) as Promise<any>;
const quiet = () => {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
};

describe("backfill-placeholder-user-names", () => {
  it("dry run: reports old → new with masked emails and a count, writes nothing", async () => {
    const before = await col("users").find().sort({ _id: 1 }).toArray();
    const q = quiet();
    const r = await backfillPlaceholderUserNames({ expectDb: DB, log: q.log });
    expect(r.applied).toBe(false);
    expect(r.candidates).toBe(5);
    expect(r.changes.map((c) => [c.email, c.from, c.to, c.source]).sort()).toEqual(
      [
        ["***@peachmint.test", "Workspace User", "Asha Rao", "traveller"],
        ["***@peachmint.test", "Workspace User", "Ravi Kumar", "profile"],
        ["***@peachmint.test", "Meera Iyer", "Meera Iyer", "profile"],
        ["***@peachmint.test", "workspace user", "Dev Shah", "traveller"],
      ].sort(),
    );
    expect(r.skipped.map((s) => s.email)).toEqual(["***@peachmint.test"]);
    expect(await col("users").find().sort({ _id: 1 }).toArray()).toEqual(before);
    const out = q.lines.join("\n");
    expect(out).toContain("DRY RUN");
    expect(out).not.toMatch(/asha\.rao@|ravi@|s\.iyer@/);
  });

  it("--apply writes only placeholder fields and never a real name; the unnamed user is left as is", async () => {
    const r = await backfillPlaceholderUserNames({ expectDb: DB, apply: true, log: () => {} });
    expect(r.written).toBe(4);
    expect(await user(U.asha)).toMatchObject({ firstName: "Asha", lastName: "Rao" });
    expect(await user(U.ravi)).toMatchObject({ firstName: "Ravi", name: "Ravi Kumar" });
    // Only the placeholder `name` changes; Meera's real first/last stay.
    expect(await user(U.meera)).toMatchObject({ firstName: "Meera", lastName: "Iyer", name: "Meera Iyer" });
    expect(await user(U.real)).toMatchObject({ firstName: "Kiran", lastName: "Mehta", name: "Kiran Mehta" });
    expect((await user(U.noname)).firstName).toBe("Workspace User");
    expect((await user(U.lowercase)).firstName).toBe("Dev");

    // A second run finds nothing left to change.
    const again = await backfillPlaceholderUserNames({ expectDb: DB, apply: true, log: () => {} });
    expect([again.changes.length, again.written, again.skipped.length]).toEqual([0, 0, 1]);
  });

  it("does not overwrite a name changed between the read and the write", async () => {
    // Simulated race: the guard is the value read, so a changed field is left alone.
    const q = quiet();
    const dry = await backfillPlaceholderUserNames({ expectDb: DB, log: q.log });
    expect(dry.changes.length).toBe(4);
    await col("users").updateOne({ _id: U.asha }, { $set: { firstName: "Asha (edited)" } });
    await backfillPlaceholderUserNames({ expectDb: DB, apply: true, log: () => {} });
    expect((await user(U.asha)).firstName).toBe("Asha (edited)");
  });

  it("refuses without --expect-db, or with the wrong one, before reading", async () => {
    await expect(backfillPlaceholderUserNames({ expectDb: undefined, log: () => {} })).rejects.toThrow(/expect-db/);
    await expect(backfillPlaceholderUserNames({ expectDb: "Plumtrips_hrms", apply: true, log: () => {} })).rejects.toThrow(/REFUSING/);
    expect((await user(U.asha)).firstName).toBe("Workspace User");
  });

  it("masks emails; the query's placeholder list matches the app's", () => {
    expect(maskEmail("Asha.Rao@Peachmint.test")).toBe("***@peachmint.test");
    for (const p of ["Workspace User", "user", "Customer", "traveller", "Traveler"]) expect(isPlaceholderName(p), p).toBe(true);
    expect(isPlaceholderName("Asha Rao")).toBe(false);
  });
});
