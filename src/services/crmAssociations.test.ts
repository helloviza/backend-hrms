// Phase 1 / Slice 1 — crmassociations bridge: schema + thin service, against a
// REAL collection (mongodb-memory-server). No consumers exist yet; these pin
// the contract Slice 2 will build on: idempotent create, bidirectional
// listFor with `other`, remove by id or triple, and hard-off behind the flag.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const { default: CrmAssociation, CRM_ENTITY_TYPES } = await import("../models/CrmAssociation.js");
const { createAssociation, removeAssociation, listFor, normalizeLabel } = await import(
  "./crmAssociations.js"
);
const { CRM_V2_FOUNDATION_ENV, CrmV2DisabledError } = await import("../config/crmV2.js");

let mongod: MongoMemoryServer;
const oid = () => new mongoose.Types.ObjectId();

function flag(on: boolean) {
  if (on) process.env[CRM_V2_FOUNDATION_ENV] = "true";
  else delete process.env[CRM_V2_FOUNDATION_ENV];
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await CrmAssociation.syncIndexes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await CrmAssociation.deleteMany({});
  flag(true);
});

afterEach(() => flag(false));

describe("schema", () => {
  it("has the two lookup indexes and the (from,to,label) unique index", async () => {
    const idx = await CrmAssociation.collection.indexes();
    const keys = idx.map((i) => JSON.stringify(i.key));
    expect(keys).toContain(JSON.stringify({ fromType: 1, fromId: 1 }));
    expect(keys).toContain(JSON.stringify({ toType: 1, toId: 1 }));
    const uniq = idx.find((i) => i.name === "crm_association_unique");
    expect(uniq?.unique).toBe(true);
    expect(uniq?.key).toEqual({ fromType: 1, fromId: 1, toType: 1, toId: 1, label: 1 });
  });

  it("carries a nullable, unused workspaceId (decision A) and rejects unknown entity types", async () => {
    const row = await createAssociation({
      from: { type: "LEAD", id: oid() },
      to: { type: "CONTACT", id: oid() },
    });
    expect(row.workspaceId).toBeNull();
    await expect(
      createAssociation({ from: { type: "WIDGET" as any, id: oid() }, to: { type: "CONTACT", id: oid() } })
    ).rejects.toThrow(/from\.type/);
    expect(CRM_ENTITY_TYPES).toContain("OPPORTUNITY"); // reserved for Slice 2
  });
});

describe("feature flag", () => {
  it("every entry point throws CrmV2DisabledError when CRM_V2_FOUNDATION is off", async () => {
    flag(false);
    const from = { type: "LEAD" as const, id: oid() };
    const to = { type: "CONTACT" as const, id: oid() };
    await expect(createAssociation({ from, to })).rejects.toBeInstanceOf(CrmV2DisabledError);
    await expect(removeAssociation({ from, to })).rejects.toBeInstanceOf(CrmV2DisabledError);
    await expect(listFor(from)).rejects.toBeInstanceOf(CrmV2DisabledError);
    expect(await CrmAssociation.countDocuments({})).toBe(0);
  });
});

describe("createAssociation", () => {
  it("is idempotent on (from, to, label) and normalises the label", async () => {
    const lead = oid();
    const contact = oid();
    const a = await createAssociation({
      from: { type: "LEAD", id: lead },
      to: { type: "CONTACT", id: contact },
      label: " primary_contact ",
    });
    const b = await createAssociation({
      from: { type: "LEAD", id: lead.toHexString() },
      to: { type: "CONTACT", id: contact.toHexString() },
      label: "PRIMARY_CONTACT",
    });
    expect(String(a._id)).toBe(String(b._id));
    expect(a.label).toBe("PRIMARY_CONTACT");
    expect(await CrmAssociation.countDocuments({})).toBe(1);
  });

  it("treats a different label as a different link, and unlabelled as its own", async () => {
    const opp = oid();
    const contact = oid();
    await createAssociation({ from: { type: "OPPORTUNITY", id: opp }, to: { type: "CONTACT", id: contact }, label: "DECISION_MAKER" });
    await createAssociation({ from: { type: "OPPORTUNITY", id: opp }, to: { type: "CONTACT", id: contact }, label: "BILLING_CONTACT" });
    await createAssociation({ from: { type: "OPPORTUNITY", id: opp }, to: { type: "CONTACT", id: contact } });
    expect(await CrmAssociation.countDocuments({})).toBe(3);
  });

  it("rejects self-association and bad ids", async () => {
    const id = oid();
    await expect(
      createAssociation({ from: { type: "CONTACT", id }, to: { type: "CONTACT", id } })
    ).rejects.toThrow(/itself/);
    await expect(
      createAssociation({ from: { type: "CONTACT", id: "nope" }, to: { type: "CONTACT", id: oid() } })
    ).rejects.toThrow(/from\.id/);
  });

  it("records createdBy when given", async () => {
    const user = oid();
    const row = await createAssociation({
      from: { type: "COMPANY", id: oid() },
      to: { type: "CONTACT", id: oid() },
      createdBy: user.toHexString(),
    });
    expect(String(row.createdBy)).toBe(user.toHexString());
  });
});

describe("listFor", () => {
  it("returns links in both directions with an `other` ref, and honours direction/label/otherType filters", async () => {
    const contact = oid();
    const lead = oid();
    const company = oid();
    const traveller = oid();
    await createAssociation({ from: { type: "LEAD", id: lead }, to: { type: "CONTACT", id: contact }, label: "PRIMARY_CONTACT" });
    await createAssociation({ from: { type: "COMPANY", id: company }, to: { type: "CONTACT", id: contact }, label: "TRAVEL_MANAGER" });
    await createAssociation({ from: { type: "CONTACT", id: contact }, to: { type: "TRAVELLER", id: traveller }, label: "TRAVELLER" });
    // Noise that must not appear:
    await createAssociation({ from: { type: "LEAD", id: oid() }, to: { type: "CONTACT", id: oid() } });

    const all = await listFor({ type: "CONTACT", id: contact });
    expect(all).toHaveLength(3);
    const others = all.map((r) => `${r.other.type}:${r.other.id}`).sort();
    expect(others).toEqual(
      [`LEAD:${lead}`, `COMPANY:${company}`, `TRAVELLER:${traveller}`].sort()
    );

    const outgoing = await listFor({ type: "CONTACT", id: contact }, { direction: "from" });
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].other.type).toBe("TRAVELLER");

    const incoming = await listFor({ type: "CONTACT", id: contact }, { direction: "to" });
    expect(incoming).toHaveLength(2);

    const byLabel = await listFor({ type: "CONTACT", id: contact }, { label: "travel_manager" });
    expect(byLabel).toHaveLength(1);
    expect(String(byLabel[0].other.id)).toBe(String(company));

    const byType = await listFor({ type: "CONTACT", id: contact }, { otherType: "LEAD" });
    expect(byType).toHaveLength(1);
    expect(String(byType[0].other.id)).toBe(String(lead));
  });

  it("returns [] for an entity with no links", async () => {
    expect(await listFor({ type: "BOOKING", id: oid() })).toEqual([]);
  });
});

describe("removeAssociation", () => {
  it("removes by triple and by id; returns 0 when nothing matched", async () => {
    const from = { type: "OPPORTUNITY" as const, id: oid() };
    const to = { type: "BOOKING" as const, id: oid() };
    const row = await createAssociation({ from, to, label: "fulfilled_by" });

    expect(await removeAssociation({ from, to, label: "FULFILLED_BY" })).toBe(1);
    expect(await CrmAssociation.countDocuments({})).toBe(0);
    expect(await removeAssociation({ from, to, label: "FULFILLED_BY" })).toBe(0);

    const again = await createAssociation({ from, to, label: "fulfilled_by" });
    expect(String(again._id)).not.toBe(String(row._id)); // it was really gone
    expect(await removeAssociation(again._id as any)).toBe(1);
    expect(await CrmAssociation.countDocuments({})).toBe(0);
  });
});

describe("normalizeLabel", () => {
  it("trims and upper-cases; blank → ''", () => {
    expect(normalizeLabel("  primary contact ")).toBe("PRIMARY CONTACT");
    expect(normalizeLabel(undefined)).toBe("");
    expect(normalizeLabel(null)).toBe("");
  });
});
