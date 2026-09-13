// Code generator collision fix (audit #6): LEAD/COMP/CONT codes come from the
// atomic Counter, seeded once from existing codes — never countDocuments()+1.
// Real collections + unique indexes on mongodb-memory-server so an E11000
// would surface as a real failure.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/code-seq-test";
process.env.JWT_SECRET ||= "test-secret";

const { default: Lead } = await import("../models/Lead.js");
const { default: CRMCompany } = await import("../models/CRMCompany.js");
const { default: CRMContact } = await import("../models/CRMContact.js");
const { default: Counter } = await import("../models/Counter.js");
const { nextCode, getNextSequence, currentMaxSequence, counterId, formatCode } = await import("./codeSequence.js");

const YEAR = new Date().getFullYear();
const lead = (over: Record<string, any> = {}) => Lead.create({ contactName: "P", contactPhone: "1", companyName: "Zepto", ...over });
const company = (over: Record<string, any> = {}) => CRMCompany.create({ name: `Co ${Math.random()}`, ...over });
const contact = (over: Record<string, any> = {}) => CRMContact.create({ firstName: "C", phone: "1", ...over });

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Lead.syncIndexes(), CRMCompany.syncIndexes(), CRMContact.syncIndexes()]);
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all([Lead.deleteMany({}), CRMCompany.deleteMany({}), CRMContact.deleteMany({}), Counter.deleteMany({})]);
});

describe("codeSequence — atomic PREFIX-YYYY-NNNN", () => {
  it("(a) delete-then-create no longer reissues a code (the countDocuments+1 bug)", async () => {
    const a = await lead();
    const b = await lead();
    expect(a.leadCode).toBe(`LEAD-${YEAR}-0001`);
    expect(b.leadCode).toBe(`LEAD-${YEAR}-0002`);
    await a.deleteOne(); // count is now 1 → the old hook would issue 0002 again → E11000
    const c = await lead();
    expect(c.leadCode).toBe(`LEAD-${YEAR}-0003`);
    expect(await Lead.countDocuments({})).toBe(2);
    expect((await Counter.findById(counterId("LEAD", YEAR)))!.seq).toBe(3);

    // same for the other two
    const c1 = await company(); const c2 = await company(); await c1.deleteOne();
    expect((await company()).companyCode).toBe(`COMP-${YEAR}-0003`);
    expect(c2.companyCode).toBe(`COMP-${YEAR}-0002`);
    const k1 = await contact(); const k2 = await contact(); await k1.deleteOne();
    expect((await contact()).contactCode).toBe(`CONT-${YEAR}-0003`);
    expect(k2.contactCode).toBe(`CONT-${YEAR}-0002`);
  });

  it("(b) rapid concurrent creates get distinct codes, no E11000", async () => {
    const N = 25;
    const [leads, companies, contacts] = await Promise.all([
      Promise.all(Array.from({ length: N }, () => lead())),
      Promise.all(Array.from({ length: N }, () => company())),
      Promise.all(Array.from({ length: N }, () => contact())),
    ]);
    for (const [rows, field, prefix] of [
      [leads, "leadCode", "LEAD"], [companies, "companyCode", "COMP"], [contacts, "contactCode", "CONT"],
    ] as const) {
      const codes = rows.map((r: any) => r[field] as string);
      expect(new Set(codes).size).toBe(N);
      expect(codes.every((c) => new RegExp(`^${prefix}-${YEAR}-\\d{4}$`).test(c))).toBe(true);
      const seqs = codes.map((c) => parseInt(c.split("-")[2], 10)).sort((x, y) => x - y);
      expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1)); // 1..N, nothing skipped, nothing doubled
    }
    // the counter itself, hammered directly, is strictly monotonic
    const draws = await Promise.all(Array.from({ length: 50 }, () => getNextSequence("X", YEAR)));
    expect(new Set(draws).size).toBe(50);
  });

  it("(c) first run seeds from the existing MAX suffix (numeric, mixed widths), never from a count", async () => {
    // Legacy rows written by the old scheme / by hand — no counter doc exists.
    // Only 4 docs but codes reach 302 and 9002: a count-based seed would say 4.
    await Lead.collection.insertMany([
      { contactName: "L", contactPhone: "1", leadCode: `LEAD-${YEAR}-0007` },
      { contactName: "L", contactPhone: "1", leadCode: `LEAD-${YEAR}-302` }, // unpadded legacy width
      { contactName: "L", contactPhone: "1", leadCode: `LEAD-${YEAR}-9002` },
      { contactName: "L", contactPhone: "1", leadCode: `LEAD-${YEAR - 1}-9999` }, // other year: ignored
      { contactName: "L", contactPhone: "1" }, // no code at all: ignored
    ] as any[]);
    expect(await Counter.exists({ _id: counterId("LEAD", YEAR) })).toBeNull();
    expect(await currentMaxSequence(Lead, "leadCode", "LEAD", YEAR)).toBe(9002);

    const next = await lead();
    expect(next.leadCode).toBe(`LEAD-${YEAR}-9003`);
    expect((await Counter.findById(counterId("LEAD", YEAR)))!.seq).toBe(9003);
    // and the seed happened exactly once — the second create just increments
    expect((await lead()).leadCode).toBe(`LEAD-${YEAR}-9004`);

    // existing rows keep their codes (no migration)
    expect(await Lead.countDocuments({ leadCode: `LEAD-${YEAR}-302` })).toBe(1);

    // empty collection → seeds to 0 → first code is 0001
    await CRMCompany.collection.insertOne({ name: "Old", companyCode: `COMP-${YEAR}-0041` } as any);
    expect((await company()).companyCode).toBe(`COMP-${YEAR}-0042`);
    expect((await contact()).contactCode).toBe(`CONT-${YEAR}-0001`);
  });

  it("(d) a code taken out-of-band ahead of the counter is skipped, not collided with", async () => {
    await lead(); // seq 1
    // someone hand-assigns the next two codes the counter would issue
    await Lead.collection.insertMany([
      { contactName: "M", contactPhone: "1", leadCode: formatCode("LEAD", YEAR, 2) },
      { contactName: "M", contactPhone: "1", leadCode: formatCode("LEAD", YEAR, 3) },
    ] as any[]);
    const c = await lead(); // draws 2 (taken), 3 (taken), 4 (free)
    expect(c.leadCode).toBe(`LEAD-${YEAR}-0004`);
    expect(await Lead.countDocuments({})).toBe(4);
  });

  it("an explicitly supplied code is respected and does not advance the counter", async () => {
    const manual = await lead({ leadCode: `LEAD-${YEAR}-7777` });
    expect(manual.leadCode).toBe(`LEAD-${YEAR}-7777`);
    expect(await Counter.exists({ _id: counterId("LEAD", YEAR) })).toBeNull();
    // the next generated code seeds from it
    expect((await lead()).leadCode).toBe(`LEAD-${YEAR}-7778`);
  });

  it("unique+sparse indexes are still in place", async () => {
    for (const [m, f] of [[Lead, "leadCode"], [CRMCompany, "companyCode"], [CRMContact, "contactCode"]] as const) {
      const idx = (await m.collection.indexes()).find((i: any) => i.key[f] === 1 && Object.keys(i.key).length === 1);
      expect(idx, `${f} index`).toBeTruthy();
      expect(idx!.unique).toBe(true);
      expect(idx!.sparse).toBe(true);
    }
  });
});
