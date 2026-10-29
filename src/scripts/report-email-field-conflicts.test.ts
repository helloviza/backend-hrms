// apps/backend/src/scripts/report-email-field-conflicts.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { reportEmailFieldConflicts, loginPick } from "./report-email-field-conflicts.js";

let mongod: MongoMemoryServer;
const DB = "report-email-field-conflicts-test";
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const WS = oid();
const U = { owner: oid(), shadow: oid(), amb1: oid(), amb2: oid(), dupA: oid(), dupB: oid(), solo: oid() };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(DB), { autoIndex: false, autoCreate: false });
  await col("customerworkspaces").insertOne({ _id: WS, companyName: "Peachmint Advisors" } as any);
  await col("users").insertMany([
    { _id: U.owner, email: "shared@x.test", firstName: "Asha", lastName: "Rao", status: "ACTIVE", roles: ["CUSTOMER"], workspaceId: WS },
    { _id: U.shadow, email: "old@x.test", personalEmail: " Shared@X.test", firstName: "Asha", status: "INACTIVE", roles: ["EMPLOYEE"] },
    { _id: U.amb1, email: "a1@x.test", personalEmail: "amb@x.test" },
    { _id: U.amb2, email: "a2@x.test", personalEmail: "amb@x.test" },
    // duplicate-email pair: not a cross-field case
    { _id: U.dupA, email: "dup@x.test" },
    { _id: U.dupB, email: "dup@x.test" },
    { _id: U.solo, email: "solo@x.test", personalEmail: "solo@x.test" },
  ] as any[]);
  await col("sessionlogs").insertMany([
    { userId: U.owner, event: "LOGIN", success: true, createdAt: new Date("2026-10-20T10:00:00Z") },
    { userId: U.owner, event: "LOGIN", success: true, createdAt: new Date("2026-10-25T10:00:00Z") },
    { userId: U.shadow, event: "LOGIN_FAILED", success: false, createdAt: new Date("2026-10-26T10:00:00Z") },
  ] as any[]);
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe("report-email-field-conflicts", () => {
  it("refuses without the right --expect-db", async () => {
    await expect(reportEmailFieldConflicts({ log: () => {} })).rejects.toThrow(/REFUSING/);
    await expect(reportEmailFieldConflicts({ expectDb: "prod", log: () => {} })).rejects.toThrow(/REFUSING/);
  });

  it("lists cross-field addresses only, with who login picks and each user's details", async () => {
    const before = await mongoose.connection.db!.listCollections().toArray();
    const lines: string[] = [];
    const { conflicts } = await reportEmailFieldConflicts({ expectDb: DB, log: (l) => lines.push(l) });

    expect(conflicts.map((c) => c.address)).toEqual(["amb@x.test", "shared@x.test"]);
    const shared = conflicts.find((c) => c.address === "shared@x.test")!;
    expect(shared.loginPicks).toBe(String(U.owner));
    expect(shared.users.map((u) => u.userId)).toEqual([String(U.owner), String(U.shadow)]);
    expect(shared.users[0]).toMatchObject({ name: "Asha Rao", workspace: "Peachmint Advisors", loginsLast90d: 2, lastLogin: "2026-10-25 10:00" });
    expect(shared.users[1]).toMatchObject({ status: "INACTIVE", lastLogin: "—", fields: ["personalEmail"] });
    expect(shared.users[1].rawValues).toEqual(['personalEmail=" Shared@X.test"']);
    expect(conflicts.find((c) => c.address === "amb@x.test")!.loginPicks).toBe("REFUSED");
    expect(lines.join("\n")).toContain("NOBODY (ambiguous, refused)");

    // read only: nothing written, no collection created
    expect((await mongoose.connection.db!.listCollections().toArray()).length).toBe(before.length);
    expect(await col("users").countDocuments()).toBe(7);
  });

  it("loginPick follows email → officialEmail → personalEmail", () => {
    expect(loginPick([{ userId: "b", field: "personalEmail" }, { userId: "a", field: "email" }])).toBe("a");
    expect(loginPick([{ userId: "b", field: "personalEmail" }, { userId: "c", field: "officialEmail" }])).toBe("c");
    expect(loginPick([{ userId: "b", field: "officialEmail" }, { userId: "c", field: "officialEmail" }])).toBe("REFUSED");
  });
});
