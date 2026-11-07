// apps/backend/src/services/gstRegistrations.test.ts
//
// R2 (P1): the GST registration service — the only writer of
// Customer.gstRegistrations and of the fields that mirror the default one.
// Real models + in-memory Mongo; nothing stubbed.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const svc = await import("./gstRegistrations.js");
const { default: Customer } = await import("../models/Customer.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: GstRegistrationAudit } = await import("../models/GstRegistrationAudit.js");

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export function gstin(state: string, pan: string, entity = "1"): string {
  const body = `${state}${pan}${entity}Z`;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARS.indexOf(body[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return body + CHARS[(36 - (sum % 36)) % 36];
}

const PAN = "AACCO4321P";
const HR = gstin("06", PAN); // Haryana
const KA = gstin("29", PAN); // Karnataka
const MH = gstin("27", PAN); // Maharashtra
const OUR_HR = "06AAACP1234A1Z5"; // Plumtrips issuer profiles (CompanySettings)
const OUR_KA = "29AAACP1234A1Z1";
const actor = { actorId: "staff-1", source: "test" };

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);

async function company(extra: Record<string, unknown> = {}) {
  const c: any = await Customer.create({ name: "Osprey Foods", legalName: "Osprey Foods Private Limited", status: "ACTIVE", ...extra } as any);
  await CustomerWorkspace.create({ customerId: String(c._id), slug: `ws-${c._id}`, companyName: "Osprey Foods", status: "ACTIVE" } as any);
  return String(c._id);
}
const fresh = async (id: string): Promise<any> => Customer.findById(id).lean();
const ws = async (id: string): Promise<any> => CustomerWorkspace.findOne({ customerId: id }).lean();
async function expectCode(p: Promise<unknown>, code: string, status?: number) {
  await expect(p).rejects.toMatchObject({ code, ...(status ? { status } : {}) });
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("gst-registrations-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await col("companysettings").insertOne({
    gstProfiles: [
      { state: "Haryana", stateCode: "06", gstin: OUR_HR, isDefault: true, active: true },
      { state: "Karnataka", stateCode: "29", gstin: OUR_KA, isDefault: false, active: true },
      { state: "Delhi", stateCode: "07", gstin: "07AAACP1234A1Z3", isDefault: false, active: false },
    ],
  });
});

describe("addRegistration", () => {
  it("first GSTIN → default; state from the prefix; PAN from the GSTIN; NOT_SET → REGISTERED; Customer + workspace mirrors; audit", async () => {
    const id = await company();
    const reg = await svc.addRegistration(id, { gstin: HR.toLowerCase() }, actor);
    expect(reg).toMatchObject({ gstin: HR, state: "Haryana", stateCode: "06", isDefault: true, active: true, legalName: "Osprey Foods Private Limited" });
    const c = await fresh(id);
    expect(c).toMatchObject({ gstNumber: HR, gstRegisteredState: "Haryana", gstRegisteredStateCode: "06", panNumber: PAN, gstStatus: "REGISTERED", gstRegistrationsRev: 1 });
    expect((await ws(id)).gstNumber).toBe(HR);
    const audit: any = await GstRegistrationAudit.findOne({ customerId: id }).lean();
    expect(audit).toMatchObject({ action: "ADD", gstin: HR, actorId: "staff-1", source: "test" });
  });

  it("a second GSTIN is not the default and leaves the mirrors alone", async () => {
    const id = await company();
    await svc.addRegistration(id, { gstin: HR }, actor);
    const ka = await svc.addRegistration(id, { gstin: KA, label: "Bengaluru office" }, actor);
    expect(ka).toMatchObject({ isDefault: false, state: "Karnataka", label: "Bengaluru office" });
    expect((await fresh(id)).gstNumber).toBe(HR);
  });

  it.each([
    ["bad check digit", HR.slice(0, 14) + (HR[14] === "A" ? "B" : "A"), "GSTIN_INVALID"],
    ["not a GSTIN", "06ABC", "GSTIN_INVALID"],
    ["another company's PAN", gstin("06", "AABCK1234Q"), "PAN_MISMATCH"],
    ["state code 25 (pre-2020 Daman & Diu)", gstin("25", PAN), "STATE_CODE_UNKNOWN"],
  ])("refuses %s", async (_l, g, code) => {
    const id = await company({ panNumber: PAN });
    await expectCode(svc.addRegistration(id, { gstin: g }, actor), code, 400);
    expect((await fresh(id)).gstRegistrations ?? []).toHaveLength(0);
  });

  it("refuses the same GSTIN twice in one company, and points at reactivate when it's inactive", async () => {
    const id = await company();
    await svc.addRegistration(id, { gstin: HR }, actor);
    const ka = await svc.addRegistration(id, { gstin: KA }, actor);
    await expectCode(svc.addRegistration(id, { gstin: HR }, actor), "DUPLICATE_IN_COMPANY");
    await svc.deactivateRegistration(id, ka._id, actor);
    await expectCode(svc.addRegistration(id, { gstin: KA }, actor), "INACTIVE_IN_COMPANY");
  });

  it("refuses a GSTIN active on another company — registration or legacy gstNumber — and names it", async () => {
    const other = await company({ name: "Osprey Old", legalName: "Osprey (old record)" });
    await svc.addRegistration(other, { gstin: HR }, actor);
    const legacy = await company({ name: "Osprey Legacy", legalName: "Osprey Legacy Pvt Ltd", gstNumber: KA });
    const id = await company({ name: "Osprey New", legalName: "Osprey New Pvt Ltd" });
    await expect(svc.addRegistration(id, { gstin: HR }, actor)).rejects.toMatchObject({
      code: "GSTIN_ON_OTHER_COMPANY", status: 409, extra: { otherCompany: { customerId: other, name: "Osprey (old record)" } },
    });
    await expect(svc.addRegistration(id, { gstin: KA }, actor)).rejects.toMatchObject({ extra: { otherCompany: { customerId: legacy } } });
  });

  it("an Unregistered (B2C) company takes no GSTIN", async () => {
    const id = await company({ gstStatus: "UNREGISTERED" });
    await expectCode(svc.addRegistration(id, { gstin: HR }, actor), "COMPANY_UNREGISTERED", 409);
  });

  it("D6: the per-registration Plumtrips Bill From must be an ACTIVE Plumtrips profile; blank = company Bill From", async () => {
    const id = await company();
    await expectCode(svc.addRegistration(id, { gstin: HR, defaultSellerGstin: "07AAACP1234A1Z3" }, actor), "DEFAULT_SELLER_GSTIN_NOT_FOUND", 400);
    const r = await svc.addRegistration(id, { gstin: HR, defaultSellerGstin: OUR_KA.toLowerCase() }, actor);
    expect(r.defaultSellerGstin).toBe(OUR_KA);
    const k = await svc.addRegistration(id, { gstin: KA }, actor);
    expect(k.defaultSellerGstin).toBe("");
  });
});

describe("default, edit, deactivate, reactivate", () => {
  it("set default moves every mirror (Customer tax state + workspace GSTIN)", async () => {
    const id = await company();
    await svc.addRegistration(id, { gstin: HR }, actor);
    const ka = await svc.addRegistration(id, { gstin: KA }, actor);
    await svc.setDefaultRegistration(id, ka._id, actor);
    const c = await fresh(id);
    expect(c).toMatchObject({ gstNumber: KA, gstRegisteredState: "Karnataka", gstRegisteredStateCode: "29" });
    expect(c.gstRegistrations.filter((r: any) => r.isDefault).map((r: any) => r.gstin)).toEqual([KA]);
    expect((await ws(id)).gstNumber).toBe(KA);
  });

  it("the default can't be deactivated while others are active; the last active one of a REGISTERED company can't either", async () => {
    const id = await company();
    const hr = await svc.addRegistration(id, { gstin: HR }, actor);
    await expectCode(svc.deactivateRegistration(id, hr._id, actor), "LAST_ACTIVE_REGISTRATION", 409);
    const ka = await svc.addRegistration(id, { gstin: KA }, actor);
    await expectCode(svc.deactivateRegistration(id, hr._id, actor), "DEFAULT_REGISTRATION", 409);
    const r = await svc.deactivateRegistration(id, ka._id, actor);
    expect(r).toMatchObject({ active: false, isDefault: false, deactivatedBy: "staff-1" });
  });

  it("reactivate: back as non-default; refused when another company took the GSTIN meanwhile", async () => {
    const id = await company();
    await svc.addRegistration(id, { gstin: HR }, actor);
    const ka = await svc.addRegistration(id, { gstin: KA }, actor);
    await svc.deactivateRegistration(id, ka._id, actor);
    expect(await svc.reactivateRegistration(id, ka._id, actor)).toMatchObject({ active: true, isDefault: false });
    await svc.deactivateRegistration(id, ka._id, actor);
    const thief = await company({ name: "Other" });
    await svc.addRegistration(thief, { gstin: KA }, actor);
    await expectCode(svc.reactivateRegistration(id, ka._id, actor), "GSTIN_ON_OTHER_COMPANY", 409);
  });

  it("a GSTIN is immutable; other fields edit", async () => {
    const id = await company();
    const hr = await svc.addRegistration(id, { gstin: HR }, actor);
    await expectCode(svc.updateRegistration(id, hr._id, { gstin: KA }, actor), "GSTIN_IMMUTABLE", 400);
    const r = await svc.updateRegistration(id, hr._id, { gstin: HR, label: "Gurugram plant", address: { line1: "Plot 9", city: "Gurugram" } }, actor);
    expect(r).toMatchObject({ label: "Gurugram plant", address: { line1: "Plot 9", city: "Gurugram", country: "India" } });
  });

  it("two concurrent edits never lose one: every success is stored, the loser gets CONCURRENT_EDIT", async () => {
    const id = await company();
    await svc.addRegistration(id, { gstin: HR }, actor);
    const results = await Promise.allSettled([
      svc.addRegistration(id, { gstin: KA }, actor),
      svc.addRegistration(id, { gstin: MH }, actor),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    for (const r of results) if (r.status === "rejected") expect((r.reason as any).code).toBe("CONCURRENT_EDIT");
    expect((await fresh(id)).gstRegistrations).toHaveLength(1 + ok);
  });
});

describe("applyLegacyGstin (old form / API writers)", () => {
  it("new GSTIN → added as the default; same GSTIN → nothing; an existing one → becomes default", async () => {
    const id = await company();
    expect(await svc.applyLegacyGstin(id, HR, actor)).toMatchObject({ gstin: HR, isDefault: true, source: "LEGACY_FIELD" });
    expect(await svc.applyLegacyGstin(id, ` ${HR.toLowerCase()} `, actor)).toBeNull();
    await svc.applyLegacyGstin(id, KA, actor);
    let c = await fresh(id);
    expect(c.gstNumber).toBe(KA);
    expect(c.gstRegistrations.map((r: any) => [r.gstin, r.active, r.isDefault])).toEqual([[HR, true, false], [KA, true, true]]);
    await svc.applyLegacyGstin(id, HR, actor);
    c = await fresh(id);
    expect(c.gstNumber).toBe(HR);
  });

  it("a blank never clears registrations", async () => {
    const id = await company();
    await svc.applyLegacyGstin(id, HR, actor);
    expect(await svc.applyLegacyGstin(id, "", actor)).toBeNull();
    expect((await fresh(id)).gstNumber).toBe(HR);
  });
});

describe("onboarding → registration", () => {
  it("strict (promote) refuses an invalid GSTIN with 422; non-strict (approval) skips it", async () => {
    const id = await company();
    const bad = { gstNumber: HR.slice(0, 14) + "0", gstStatus: "REGISTERED", panNumber: PAN };
    await expectCode(svc.ensureRegistrationFromOnboarding(id, bad, actor, { strict: true }), "GSTIN_INVALID", 422);
    const r = await svc.ensureRegistrationFromOnboarding(id, bad, actor, { strict: false });
    expect(r.skipped?.code).toBe("GSTIN_INVALID");
    expect((await fresh(id)).gstRegistrations ?? []).toHaveLength(0);
  });

  it("a valid form GSTIN becomes the default registration (ONBOARDING); re-running is a no-op", async () => {
    const id = await company();
    const form = { gstin: HR, legalName: "Osprey Foods Pvt Ltd" };
    const r = await svc.ensureRegistrationFromOnboarding(id, form, actor, { strict: true });
    expect(r.registration).toMatchObject({ gstin: HR, isDefault: true, source: "ONBOARDING", legalName: "Osprey Foods Pvt Ltd" });
    expect(await svc.ensureRegistrationFromOnboarding(id, form, actor, { strict: true })).toEqual({});
  });

  it("a company with registrations refuses (strict) a form GSTIN that is not one of them — never swapped in", async () => {
    const id = await company();
    await svc.addRegistration(id, { gstin: HR }, actor);
    await expectCode(svc.ensureRegistrationFromOnboarding(id, { gstNumber: KA }, actor, { strict: true }), "GSTIN_NOT_IN_REGISTRATIONS", 422);
    expect((await fresh(id)).gstNumber).toBe(HR);
  });

  it("an Unregistered form or one without a GSTIN does nothing", async () => {
    const id = await company();
    expect(await svc.ensureRegistrationFromOnboarding(id, { gstStatus: "UNREGISTERED", gstNumber: HR }, actor, { strict: true })).toEqual({});
    expect(await svc.ensureRegistrationFromOnboarding(id, {}, actor, { strict: true })).toEqual({});
  });
});

describe("assertCompanyChangeAllowed", () => {
  it("refuses Unregistered while registrations are active, and a PAN the GSTINs don't carry", async () => {
    const id = await company();
    await svc.addRegistration(id, { gstin: HR }, actor);
    await expectCode(svc.assertCompanyChangeAllowed(id, { gstStatus: "UNREGISTERED" }), "ACTIVE_REGISTRATIONS", 409);
    await expectCode(svc.assertCompanyChangeAllowed(id, { panNumber: "AABCK1234Q" }), "PAN_DIFFERS_FROM_REGISTRATIONS", 409);
    await expect(svc.assertCompanyChangeAllowed(id, { panNumber: PAN.toLowerCase(), gstStatus: "REGISTERED" })).resolves.toBeUndefined();
  });

  it("a company without registrations is unrestricted (legacy behaviour)", async () => {
    const id = await company({ gstNumber: HR });
    await expect(svc.assertCompanyChangeAllowed(id, { gstStatus: "UNREGISTERED", panNumber: "AABCK1234Q" })).resolves.toBeUndefined();
  });
});
