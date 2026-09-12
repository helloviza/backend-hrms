// Phase 1 / Slice 1 — Company Account in place + nameNormalized (M8 code half)
// + manual-create dedupe, against a REAL crmcompanies collection
// (mongodb-memory-server). No mocks on the model: the thing under test is what
// lands in Mongo, and the prod unique+partial index is recreated here so the
// race path is exercised for real rather than faked.
//
// Auth/House/CRM-access middleware are passthroughs — they each hit
// UserPermission / workspace lookups that have nothing to do with this slice.
//
// Flag matrix: every behaviour is asserted in BOTH states, because the whole
// point of CRM_V2_FOUNDATION is that OFF is byte-for-byte legacy.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

const ADMIN_ID = new mongoose.Types.ObjectId().toHexString();

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: ADMIN_ID, sub: ADMIN_ID, roles: ["ADMIN"], email: "ops@plumtrips.com" };
    next();
  },
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireHouse.js", () => ({
  requireHouse: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../utils/crmAccess.js", () => ({
  requireCRMAccess: () => (req: any, _res: any, next: any) => {
    req.crmAccess = "FULL";
    req.crmScope = "ALL";
    next();
  },
}));

const { default: CRMCompany } = await import("../models/CRMCompany.js");
const { resolveOrCreateCompany } = await import("../utils/crmCompany.js");
const { default: router } = await import("./crm.companies.js");
const { CRM_V2_FOUNDATION_ENV } = await import("../config/crmV2.js");

let mongod: MongoMemoryServer;

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/crm/companies", router);
  return a;
}

function flag(on: boolean) {
  if (on) process.env[CRM_V2_FOUNDATION_ENV] = "true";
  else delete process.env[CRM_V2_FOUNDATION_ENV];
}

// Mirrors the prod index: unique over NON-EMPTY strings only, so the legacy
// "" default never collides.
async function createProdLikeIndex() {
  await CRMCompany.collection.createIndex(
    { nameNormalized: 1 },
    {
      unique: true,
      name: "nameNormalized_unique",
      partialFilterExpression: { nameNormalized: { $type: "string", $gt: "" } },
    }
  );
}

// A row exactly as the 41 existing prod docs look: no account fields, key "".
async function insertLegacyRaw(name: string, extra: Record<string, unknown> = {}) {
  const res = await CRMCompany.collection.insertOne({
    companyCode: `COMP-2025-${Math.floor(Math.random() * 9000 + 1000)}`,
    name,
    nameNormalized: "",
    industry: "",
    companySize: "",
    website: "",
    phone: "",
    email: "",
    city: "",
    state: "",
    country: "",
    address: "",
    notes: "",
    leadId: null,
    contactCount: 0,
    createdBy: new mongoose.Types.ObjectId(ADMIN_ID),
    isPrivate: false,
    createdAt: new Date("2025-06-01"),
    updatedAt: new Date("2025-06-01"),
    ...extra,
  });
  return res.insertedId;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await CRMCompany.collection.drop().catch(() => {});
  await CRMCompany.createCollection();
  await createProdLikeIndex();
});

afterEach(() => {
  flag(false);
  vi.restoreAllMocks();
});

/* ───────────────────────── 1. Existing docs stay valid ───────────────────────── */

describe("Company Account fields — existing docs load without error", () => {
  it.each([false, true])("legacy row hydrates with defaults and validates (flag=%s)", async (on) => {
    flag(on);
    const id = await insertLegacyRaw("Ather Energy");

    const doc = await CRMCompany.findById(id);
    expect(doc).not.toBeNull();
    // Defaults materialise on hydration; nothing was written to Mongo yet.
    expect(doc!.accountType).toBe("corporate");
    expect(doc!.lifecycleStatus).toBe("prospect");
    expect(doc!.accountTier).toBeNull();
    expect(doc!.accountManagerId).toBeNull();
    expect(doc!.customerId).toBeNull();
    expect(doc!.customerWorkspaceId).toBeNull();
    await expect(doc!.validate()).resolves.toBeUndefined();

    // The stored row is untouched by a read — no backfill beyond defaults.
    const raw = await CRMCompany.collection.findOne({ _id: id });
    expect(raw).not.toHaveProperty("accountType");
    expect(raw!.nameNormalized).toBe("");
  });

  it("flag OFF: saving a legacy row leaves nameNormalized '' (byte-for-byte legacy)", async () => {
    flag(false);
    const id = await insertLegacyRaw("Ather Energy");
    const doc = await CRMCompany.findById(id);
    doc!.notes = "touched";
    await doc!.save();
    const raw = await CRMCompany.collection.findOne({ _id: id });
    expect(raw!.nameNormalized).toBe("");
  });

  it("flag ON: saving a legacy row re-keys nameNormalized from name", async () => {
    flag(true);
    const id = await insertLegacyRaw("Ather Energy");
    const doc = await CRMCompany.findById(id);
    doc!.notes = "touched";
    await doc!.save();
    const raw = await CRMCompany.collection.findOne({ _id: id });
    expect(raw!.nameNormalized).toBe("ather energy");
  });

  it("rejects an out-of-enum account value at the model layer", async () => {
    const doc = new CRMCompany({ name: "X", accountType: "galaxy" } as any);
    await expect(doc.validate()).rejects.toThrow(/accountType/);
  });
});

/* ───────────────────────── 2. POST / — legacy path ───────────────────────── */

describe("POST /crm/companies — flag OFF (legacy)", () => {
  it("creates with nameNormalized '' and does NOT dedupe", async () => {
    flag(false);
    const a = await request(app()).post("/api/crm/companies").send({ name: "Ather Energy" });
    const b = await request(app()).post("/api/crm/companies").send({ name: "ather  energy" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.company._id).not.toBe(b.body.company._id);
    expect(a.body.company.nameNormalized).toBe("");
    expect(await CRMCompany.countDocuments({})).toBe(2);
  });

  it("still spreads the body (legacy behaviour preserved, warts included)", async () => {
    flag(false);
    const r = await request(app())
      .post("/api/crm/companies")
      .send({ name: "Legacy Co", contactCount: 7, accountType: "agency" });
    expect(r.status).toBe(201);
    expect(r.body.company.contactCount).toBe(7);
    // The schema now has the field, so a legacy spread would persist it — the
    // flag does not (and cannot) hide schema paths; it only governs the route.
    expect(r.body.company.accountType).toBe("agency");
  });
});

/* ───────────────────────── 3. POST / — CRM_V2_FOUNDATION path ───────────────────────── */

describe("POST /crm/companies — flag ON (dedupe on nameNormalized)", () => {
  beforeEach(() => flag(true));

  it("sets nameNormalized via the shared key on create", async () => {
    const r = await request(app()).post("/api/crm/companies").send({ name: "  Ather   Energy " });
    expect(r.status).toBe(201);
    expect(r.body.company.name).toBe("Ather   Energy"); // schema trims ends only
    expect(r.body.company.nameNormalized).toBe("ather energy");
    expect(r.body.company.accountType).toBe("corporate");
    expect(r.body.company.lifecycleStatus).toBe("prospect");
  });

  it("collapses a manual duplicate onto the existing doc (200 + deduped) without overwriting it", async () => {
    const first = await request(app())
      .post("/api/crm/companies")
      .send({ name: "Ather Energy", industry: "Automotive", city: "Bengaluru" });
    expect(first.status).toBe(201);

    const dup = await request(app())
      .post("/api/crm/companies")
      .send({ name: "ATHER  ENERGY", industry: "Should not win", city: "Mumbai" });
    expect(dup.status).toBe(200);
    expect(dup.body.deduped).toBe(true);
    expect(dup.body.company._id).toBe(first.body.company._id);
    expect(dup.body.company.industry).toBe("Automotive"); // $setOnInsert semantics
    expect(dup.body.company.city).toBe("Bengaluru");
    expect(await CRMCompany.countDocuments({})).toBe(1);
  });

  it("dedupes against a company the LEAD side created (resolveOrCreateCompany)", async () => {
    const fromLead = await resolveOrCreateCompany({ name: "Zetwerk", industry: "Manufacturing" });
    const r = await request(app()).post("/api/crm/companies").send({ name: "zetwerk" });
    expect(r.status).toBe(200);
    expect(r.body.deduped).toBe(true);
    expect(r.body.company._id).toBe(String(fromLead._id));
    expect(await CRMCompany.countDocuments({})).toBe(1);
  });

  it("a later lead-side resolve lands on the MANUALLY created company", async () => {
    const r = await request(app()).post("/api/crm/companies").send({ name: "Sarvam AI" });
    expect(r.status).toBe(201);
    const fromLead = await resolveOrCreateCompany({ name: "  sarvam ai " });
    expect(String(fromLead._id)).toBe(r.body.company._id);
    expect(await CRMCompany.countDocuments({})).toBe(1);
  });

  it("does NOT dedupe against a legacy row whose key is still '' (needs the data half of M8)", async () => {
    // Documents the boundary honestly: the code half keys new writes; rows
    // written before it keep "" until they are saved or backfilled.
    await insertLegacyRaw("Exponent Energy");
    const r = await request(app()).post("/api/crm/companies").send({ name: "Exponent Energy" });
    expect(r.status).toBe(201);
    expect(await CRMCompany.countDocuments({})).toBe(2);
  });

  it("accepts and stores the Company Account fields", async () => {
    const mgr = new mongoose.Types.ObjectId().toHexString();
    const cust = new mongoose.Types.ObjectId().toHexString();
    const r = await request(app()).post("/api/crm/companies").send({
      name: "Acme Travel Desk",
      accountType: "agency",
      lifecycleStatus: "active",
      accountTier: "growth",
      accountManagerId: mgr,
      customerId: cust,
      customerWorkspaceId: " 69679a7628330a58d29f2254 ",
    });
    expect(r.status).toBe(201);
    expect(r.body.company.accountType).toBe("agency");
    expect(r.body.company.lifecycleStatus).toBe("active");
    expect(r.body.company.accountTier).toBe("growth");
    expect(r.body.company.accountManagerId).toBe(mgr);
    expect(r.body.company.customerId).toBe(cust);
    expect(r.body.company.customerWorkspaceId).toBe("69679a7628330a58d29f2254");
  });

  it.each([
    [{ accountType: "galaxy" }, /accountType/],
    [{ lifecycleStatus: "won" }, /lifecycleStatus/],
    [{ accountTier: "platinum" }, /accountTier/],
    [{ accountManagerId: "not-an-id" }, /accountManagerId/],
    [{ customerId: "nope" }, /customerId/],
  ])("400s on invalid account value %j", async (bad, re) => {
    const r = await request(app()).post("/api/crm/companies").send({ name: "Bad Co", ...bad });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(re);
    expect(await CRMCompany.countDocuments({})).toBe(0);
  });

  it("ignores non-writable fields instead of spreading them", async () => {
    const r = await request(app()).post("/api/crm/companies").send({
      name: "Tight Co",
      contactCount: 99,
      leadId: new mongoose.Types.ObjectId().toHexString(),
      companyCode: "COMP-HACK-0001",
      nameNormalized: "something else",
      createdBy: new mongoose.Types.ObjectId().toHexString(),
    });
    expect(r.status).toBe(201);
    expect(r.body.company.contactCount).toBe(0);
    expect(r.body.company.leadId).toBeNull();
    expect(r.body.company.companyCode).toMatch(/^COMP-\d{4}-\d{4}$/);
    expect(r.body.company.nameNormalized).toBe("tight co");
    expect(r.body.company.createdBy).toBe(ADMIN_ID);
  });

  it("400s on a whitespace-only name", async () => {
    const r = await request(app()).post("/api/crm/companies").send({ name: "   " });
    expect(r.status).toBe(400);
  });

  it("survives losing the create race: unique index rejects, the winner is returned", async () => {
    // Simulate: our pre-check sees nothing, then someone else inserts the key
    // before our create runs. The partial unique index throws 11000; the route
    // must return the winner rather than a 500.
    const realFindOne = CRMCompany.findOne.bind(CRMCompany);
    let calls = 0;
    vi.spyOn(CRMCompany, "findOne").mockImplementation(((...args: any[]) => {
      calls++;
      if (calls === 1) {
        // First lookup: pretend the row does not exist yet, then create it
        // out-of-band so the subsequent create() collides.
        return {
          lean: async () => {
            await CRMCompany.collection.insertOne({
              name: "Racer Ltd",
              nameNormalized: "racer ltd",
              createdAt: new Date(),
              updatedAt: new Date(),
            });
            return null;
          },
        } as any;
      }
      return (realFindOne as any)(...args);
    }) as any);

    const r = await request(app()).post("/api/crm/companies").send({ name: "Racer Ltd" });
    expect(r.status).toBe(200);
    expect(r.body.deduped).toBe(true);
    expect(r.body.company.nameNormalized).toBe("racer ltd");
    expect(await CRMCompany.countDocuments({ nameNormalized: "racer ltd" })).toBe(1);
  });
});

/* ───────────────────────── 4. PUT /:id ───────────────────────── */

describe("PUT /crm/companies/:id", () => {
  it("flag OFF: rename leaves nameNormalized stale (legacy)", async () => {
    flag(true);
    const c = await request(app()).post("/api/crm/companies").send({ name: "Old Name" });
    flag(false);
    const r = await request(app()).put(`/api/crm/companies/${c.body.company._id}`).send({ name: "New Name" });
    expect(r.status).toBe(200);
    expect(r.body.company.name).toBe("New Name");
    expect(r.body.company.nameNormalized).toBe("old name");
  });

  it("flag ON: rename re-keys nameNormalized via the shared function", async () => {
    flag(true);
    const c = await request(app()).post("/api/crm/companies").send({ name: "Old Name" });
    const r = await request(app())
      .put(`/api/crm/companies/${c.body.company._id}`)
      .send({ name: "  New   NAME " });
    expect(r.status).toBe(200);
    expect(r.body.company.nameNormalized).toBe("new name");
  });

  it("flag ON: rename onto another company's key is refused with 409 (merge, not edit)", async () => {
    flag(true);
    const a = await request(app()).post("/api/crm/companies").send({ name: "Ather Energy" });
    const b = await request(app()).post("/api/crm/companies").send({ name: "Ola Electric" });
    const r = await request(app())
      .put(`/api/crm/companies/${b.body.company._id}`)
      .send({ name: "ather energy" });
    expect(r.status).toBe(409);
    expect(r.body.existingId).toBe(a.body.company._id);
    const untouched = await CRMCompany.findById(b.body.company._id).lean();
    expect(untouched!.name).toBe("Ola Electric");
    expect(untouched!.nameNormalized).toBe("ola electric");
  });

  it("flag ON: a legacy row with key '' is re-keyed on its first edit", async () => {
    flag(true);
    const id = await insertLegacyRaw("LKQ India Pvt Ltd");
    const r = await request(app()).put(`/api/crm/companies/${id}`).send({ notes: "edited" });
    expect(r.status).toBe(200);
    expect(r.body.company.nameNormalized).toBe("lkq india pvt ltd");
  });

  it("flag ON: a legacy '' row whose name already belongs to a keyed row 409s instead of 500ing on the index", async () => {
    flag(true);
    const keyed = await request(app()).post("/api/crm/companies").send({ name: "Suprajit Engineering Ltd" });
    const legacyId = await insertLegacyRaw("Suprajit Engineering Ltd");
    const r = await request(app()).put(`/api/crm/companies/${legacyId}`).send({ notes: "edited" });
    expect(r.status).toBe(409);
    expect(r.body.existingId).toBe(keyed.body.company._id);
  });

  it("flag ON: account fields are updatable and validated; non-writable fields ignored", async () => {
    flag(true);
    const c = await request(app()).post("/api/crm/companies").send({ name: "Tier Co" });
    const ok = await request(app())
      .put(`/api/crm/companies/${c.body.company._id}`)
      .send({ lifecycleStatus: "onboarding", accountTier: "strategic", contactCount: 55 });
    expect(ok.status).toBe(200);
    expect(ok.body.company.lifecycleStatus).toBe("onboarding");
    expect(ok.body.company.accountTier).toBe("strategic");
    expect(ok.body.company.contactCount).toBe(0);

    const bad = await request(app())
      .put(`/api/crm/companies/${c.body.company._id}`)
      .send({ lifecycleStatus: "won" });
    expect(bad.status).toBe(400);

    const cleared = await request(app())
      .put(`/api/crm/companies/${c.body.company._id}`)
      .send({ accountTier: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.company.accountTier).toBeNull();
  });
});
