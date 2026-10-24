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
const { backfillPartnerLeadEmailHash } = await import("./backfill-partner-lead-email-hash.js");
const { emailHash } = await import("../services/partnerTrackHash.js");

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

describe("backfill-partner-lead-email-hash", () => {
  const seed = () =>
    col("approvalrequests").insertMany([
      { _id: new mongoose.Types.ObjectId(), meta: { source: "PARTNER_LINK", partnerLead: { caseNumber: "PL-AAAAA2", contact: { email: "Riya@Student.test" } } } },
      { _id: new mongoose.Types.ObjectId(), meta: { source: "PARTNER_LINK", partnerLead: { caseNumber: "PL-AAAAA3", contact: { email: "arjun@student.test" }, contactEmailHash: "already" } } },
      { _id: new mongoose.Types.ObjectId(), meta: { source: "PARTNER_LINK", partnerLead: { caseNumber: "PL-AAAAA4", contact: { name: "No Email" } } } },
      { _id: new mongoose.Types.ObjectId(), frontlinerEmail: "x@cust.test", meta: { ccLeaders: [] } },
    ] as any[]);
  const byCase = async (n: string) => ((await col("approvalrequests").findOne({ "meta.partnerLead.caseNumber": n })) as any).meta.partnerLead;

  it("refuses without --expect-db, with the wrong one, or without the salt", async () => {
    await expect(backfillPartnerLeadEmailHash({ apply: true, log: quiet })).rejects.toThrow(/REFUSING/);
    await expect(backfillPartnerLeadEmailHash({ expectDb: "prod", apply: true, log: quiet })).rejects.toThrow(/REFUSING/);
    const salt = process.env.PARTNER_LEAD_IP_SALT;
    delete process.env.PARTNER_LEAD_IP_SALT;
    await expect(backfillPartnerLeadEmailHash({ expectDb: DB, apply: true, log: quiet })).rejects.toThrow(/PARTNER_LEAD_IP_SALT/);
    if (salt) process.env.PARTNER_LEAD_IP_SALT = salt;
  });

  it("dry run counts and writes nothing; --apply stamps only partner cases missing it (and builds the index); a re-run does nothing", async () => {
    process.env.PARTNER_LEAD_IP_SALT ||= "salt-for-tests";
    await seed();
    const before = await col("approvalrequests").find({}).sort({ _id: 1 }).toArray();
    const dry = await backfillPartnerLeadEmailHash({ expectDb: DB, apply: false, log: quiet });
    expect(dry).toMatchObject({ index: "missing", missingHash: 1, noEmail: 1, updated: 0 });
    expect(await col("approvalrequests").find({}).sort({ _id: 1 }).toArray()).toEqual(before);

    const applied = await backfillPartnerLeadEmailHash({ expectDb: DB, apply: true, log: quiet });
    expect(applied).toMatchObject({ index: "created", missingHash: 1, updated: 1 });
    expect((await byCase("PL-AAAAA2")).contactEmailHash).toBe(emailHash("riya@student.test"));
    expect((await byCase("PL-AAAAA3")).contactEmailHash).toBe("already");
    expect((await byCase("PL-AAAAA4")).contactEmailHash).toBeUndefined();
    expect((await col("approvalrequests").findOne({ frontlinerEmail: "x@cust.test" }))!.meta).toEqual({ ccLeaders: [] });
    expect((await col("approvalrequests").indexes()).map((i: any) => i.name)).toContain("partner_lead_contact_email_hash");

    const again = await backfillPartnerLeadEmailHash({ expectDb: DB, apply: true, log: quiet });
    expect(again).toMatchObject({ index: "present", missingHash: 0, updated: 0 });
  });
});
