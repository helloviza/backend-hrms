// apps/backend/src/scripts/partnerLeadScripts.test.ts
//
// seed-partner-intake-identity and migrate-partner-lead-indexes: both refuse
// without (or with the wrong) --expect-db, write nothing on a dry run, and are
// no-ops on a re-run. The intake-ref index is partial: requests without
// meta.partnerLead (all existing ones) are not in it, so they can repeat freely.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
const { seedPartnerIntakeIdentity } = await import("./seed-partner-intake-identity.js");
const { migratePartnerLeadIndexes, PARTNER_LEAD_INDEXES } = await import("./migrate-partner-lead-indexes.js");
const { PARTNER_INTAKE_EMAIL } = await import("../services/partnerLeadCase.js");

let mongod: MongoMemoryServer;
const DB = "partner-lead-scripts-test";
const col = (n: string) => mongoose.connection.db!.collection(n);
const quiet = () => {};

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
});

describe("seed-partner-intake-identity", () => {
  it("refuses without --expect-db or with the wrong one", async () => {
    await expect(seedPartnerIntakeIdentity({ apply: true, log: quiet })).rejects.toThrow(/REFUSING/);
    await expect(seedPartnerIntakeIdentity({ expectDb: "prod", apply: true, log: quiet })).rejects.toThrow(/REFUSING/);
  });

  it("dry run writes nothing; --apply creates one no-login system user; a re-run changes nothing", async () => {
    const dry = await seedPartnerIntakeIdentity({ expectDb: DB, apply: false, log: quiet });
    expect(dry).toMatchObject({ existed: false, created: false });
    expect(await col("users").countDocuments({})).toBe(0);

    const made = await seedPartnerIntakeIdentity({ expectDb: DB, apply: true, log: quiet });
    expect(made.created).toBe(true);
    const u: any = await col("users").findOne({ email: PARTNER_INTAKE_EMAIL });
    expect(u.roles).toEqual(["SYSTEM_PARTNER_INTAKE"]);
    expect(String(u.workspaceId)).toBe("69679a7628330a58d29f2254");
    expect(u.passwordHash).toMatch(/^\$2/); // a bcrypt hash of a random secret nobody holds

    const again = await seedPartnerIntakeIdentity({ expectDb: DB, apply: true, log: quiet });
    expect(again).toMatchObject({ existed: true, created: false, userId: String(u._id) });
    expect(await col("users").countDocuments({})).toBe(1);
  });
});

describe("migrate-partner-lead-indexes", () => {
  it("refuses without --expect-db or with the wrong one", async () => {
    await expect(migratePartnerLeadIndexes({ apply: true, log: quiet })).rejects.toThrow(/REFUSING/);
    await expect(migratePartnerLeadIndexes({ expectDb: "prod", apply: true, log: quiet })).rejects.toThrow(/REFUSING/);
  });

  it("dry run lists every index and builds none; --apply builds them; a re-run builds nothing", async () => {
    await col("approvalrequests").insertOne({ x: 1 });
    const dry = await migratePartnerLeadIndexes({ expectDb: DB, apply: false, log: quiet });
    expect(dry.missing).toHaveLength(PARTNER_LEAD_INDEXES.length);
    expect((await col("approvalrequests").indexes()).map((i: any) => i.name)).toEqual(["_id_"]);

    const applied = await migratePartnerLeadIndexes({ expectDb: DB, apply: true, log: quiet });
    expect(applied.created).toHaveLength(PARTNER_LEAD_INDEXES.length);
    const again = await migratePartnerLeadIndexes({ expectDb: DB, apply: true, log: quiet });
    expect(again.created).toEqual([]);
    expect(again.present).toHaveLength(PARTNER_LEAD_INDEXES.length);
  });

  it("the intake-ref index is unique for partner leads only", async () => {
    await migratePartnerLeadIndexes({ expectDb: DB, apply: true, log: quiet });
    const ar = col("approvalrequests");
    // Existing requests (no partnerLead) are outside the partial index.
    await ar.insertMany([{ meta: { ccLeaders: [] } }, { meta: { ccLeaders: [] } }, { meta: {} }]);
    await ar.insertOne({ meta: { partnerLead: { intakeRef: "partner:1", caseNumber: "PL-AAAAAA" } } });
    await expect(ar.insertOne({ meta: { partnerLead: { intakeRef: "partner:1", caseNumber: "PL-BBBBBB" } } })).rejects.toMatchObject({ code: 11000 });
    await expect(ar.insertOne({ meta: { partnerLead: { intakeRef: "partner:2", caseNumber: "PL-AAAAAA" } } })).rejects.toMatchObject({ code: 11000 });
  });
});
