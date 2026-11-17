// apps/backend/src/routes/gstRegistrations.unregister.test.ts
//
// The REGISTERED ⇄ UNREGISTERED path for a company with GST registrations
// (prod bug 2026-11-17: a Registered company with one default registration
// could not be marked Unregistered — status change said "deactivate first",
// deactivating the last/default one was refused).
//   - POST /:id/gst-registrations/unregister deactivates every active
//     registration and sets the status in ONE write; mirrors blank; audited;
//     refused (nothing changes) when the confirmed GSTINs are stale;
//   - back to REGISTERED only by adding / reactivating a registration with
//     markRegistered; a bare status flip is refused;
//   - without the gstRegistrations grant: 403 and nothing changes.
// Same harness as gstRegistrations.access.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

vi.mock("../utils/mailer.js", async (orig) => ({ ...(await orig<any>()), sendMail: vi.fn(async () => ({ messageId: "test" })) }));
vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", async (orig) => ({
  ...(await orig<any>()),
  requireWorkspace: (req: any, _res: any, next: any) => {
    const id = String(req.headers["x-test-ws"] || "");
    req.workspaceId = id;
    req.workspaceObjectId = new mongoose.Types.ObjectId(id);
    req.workspace = { _id: req.workspaceObjectId, status: "ACTIVE" };
    next();
  },
}));

const { default: gstRegistrationsRouter } = await import("./gstRegistrations.js");
const { default: customersRouter } = await import("./customers.js");
const { default: masterDataRouter } = await import("./masterData.js");
const { default: workspaceSettingsRouter } = await import("./workspace.settings.js");
const { addRegistration, deactivateRegistration } = await import("../services/gstRegistrations.js");
const { default: Customer } = await import("../models/Customer.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: Onboarding } = await import("../models/Onboarding.js");
const { UserPermission } = await import("../models/UserPermission.js");

const app = express();
app.use(express.json());
app.use("/api/customers", gstRegistrationsRouter);
app.use("/api/customers", customersRouter);
app.use("/api/master-data", masterDataRouter);
app.use("/api/workspace/settings", workspaceSettingsRouter);
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: String(err?.message || err) }));

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function gstin(state: string, pan: string): string {
  const body = `${state}${pan}1Z`;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARS.indexOf(body[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return body + CHARS[(36 - (sum % 36)) % 36];
}
const PAN = "AACCO4321P";
const HR = gstin("06", PAN);
const KA = gstin("29", PAN);
const MH = gstin("27", PAN);
const SELLER_KA = "29AAACP1234A1Z1";

let mongod: MongoMemoryServer;
const oid = () => new mongoose.Types.ObjectId();
const HOUSE = "69679a7628330a58d29f2254";

type Who = { user: Record<string, unknown>; ws: string };
const houseStaff = (id: mongoose.Types.ObjectId, roles = ["ADMIN"]): Who => ({
  user: { _id: String(id), id: String(id), sub: String(id), roles, workspaceId: HOUSE, email: `${id}@plumtrips.com` },
  ws: HOUSE,
});
const EDITOR_ID = oid();
const HOLDER_ID = oid();
const SA_ID = oid();
const TENANT_ID = oid();
const EDITOR = houseStaff(EDITOR_ID); // edits Business Profiles, no gstRegistrations key
const HOLDER = houseStaff(HOLDER_ID); // same, with the key
const SA = houseStaff(SA_ID, ["SUPERADMIN"]);
let TENANT: Who; // a client company's own admin, with the key stored

const as = (who: Who, r: request.Test, ws = who.ws) => r.set("x-test-user", JSON.stringify(who.user)).set("x-test-ws", ws);

async function grant(userId: mongoose.Types.ObjectId, workspaceId: string, modules: Record<string, unknown>) {
  await UserPermission.create({
    userId: String(userId), email: `${userId}@plumtrips.com`, workspaceId, universe: "STAFF",
    level: { code: "L6", name: "Admin" }, modules, grantedBy: String(SA_ID), status: "active",
  } as any);
}

async function company(extra: Record<string, unknown> = {}) {
  const ob: any = await Onboarding.create({
    workspaceId: new mongoose.Types.ObjectId(HOUSE), type: "business", email: `ap-${oid()}@osprey.test`, token: `tok-${oid()}`, status: "approved",
    expiresAt: new Date(Date.now() + 86_400_000), formPayload: { legalName: "Osprey Foods Private Limited", officialEmail: "ap@osprey.test", panNumber: PAN },
  } as any);
  const c: any = await Customer.create({
    name: "Osprey Foods", legalName: "Osprey Foods Private Limited", status: "ACTIVE", panNumber: PAN, gstStatus: "REGISTERED",
    workspaceId: new mongoose.Types.ObjectId(HOUSE), onboardingId: ob._id, ...extra,
  } as any);
  const ws: any = await CustomerWorkspace.create({ customerId: String(c._id), slug: `ws-${c._id}`, companyName: "Osprey Foods", status: "ACTIVE" } as any);
  return { id: String(c._id), ws: String(ws._id), ob: String(ob._id) };
}
/** A company with HR (default) + KA active and MH inactive. */
async function registered() {
  const co = await company();
  const actor = { source: "test" };
  await addRegistration(co.id, { gstin: HR, makeDefault: true }, actor);
  const ka: any = await addRegistration(co.id, { gstin: KA }, actor);
  const mh: any = await addRegistration(co.id, { gstin: MH }, actor);
  await deactivateRegistration(co.id, String(mh._id), actor);
  return { ...co, ka: String(ka._id), mh: String(mh._id) };
}
const snapshot = async (co: { id: string; ws: string }) =>
  JSON.stringify([await Customer.findById(co.id).lean(), await CustomerWorkspace.findById(co.ws).lean(), await mongoose.connection.db!.collection("gstregistrationaudits").countDocuments()]);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("gst-registrations-unregister-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await mongoose.connection.db!.collection("companysettings").insertOne({
    gstProfiles: [
      { state: "Haryana", stateCode: "06", gstin: "06AAACP1234A1Z5", isDefault: true, active: true },
      { state: "Karnataka", stateCode: "29", gstin: SELLER_KA, isDefault: false, active: true },
    ],
  });
  await grant(EDITOR_ID, HOUSE, { masterData: { access: "FULL", scope: "ALL" } });
  await grant(HOLDER_ID, HOUSE, { masterData: { access: "FULL", scope: "ALL" }, gstRegistrations: { access: "READ", scope: "ALL" } });
});

const base = (co: { id: string }) => `/api/customers/${co.id}/gst-registrations`;
const load = async (id: string): Promise<any> => Customer.findById(id).lean();
const audits = async (id: string) =>
  mongoose.connection.db!.collection("gstregistrationaudits").find({ customerId: new mongoose.Types.ObjectId(id) }).sort({ _id: 1 }).toArray();
const activeIds = (c: any) => (c.gstRegistrations || []).filter((r: any) => r.active).map((r: any) => String(r._id));

/** The prod case: Registered, exactly one registration (active, default). */
async function single() {
  const co = await company({ gstRegisteredState: "Haryana", gstRegisteredStateCode: "06" });
  const hr: any = await addRegistration(co.id, { gstin: HR }, { source: "test" });
  return { ...co, hr: String(hr._id) };
}

describe("the deadlock this fixes", () => {
  it("one default registration: deactivate and a plain status change are still refused — unregister is the path", async () => {
    const co = await single();
    const deact = await as(HOLDER, request(app).post(`${base(co)}/${co.hr}/deactivate`));
    expect(deact.status).toBe(409);
    expect(deact.body.code).toBe("LAST_ACTIVE_REGISTRATION");
    const patch = await as(HOLDER, request(app).patch(`/api/customers/${co.id}`)).send({ gstStatus: "UNREGISTERED" });
    expect(patch.status).toBe(409);
    expect(patch.body.code).toBe("ACTIVE_REGISTRATIONS");
    expect(patch.body.active.map((r: any) => r.gstin)).toEqual([HR]);
    expect((await load(co.id)).gstStatus).toBe("REGISTERED");
  });
});

describe("REGISTERED → UNREGISTERED in one step", () => {
  it("one default registration: deactivated, status set, mirrors blank, audited", async () => {
    const co = await single();
    const auditsBefore = (await audits(co.id)).length;
    const res = await as(HOLDER, request(app).post(`${base(co)}/unregister`)).send({ registrationIds: [co.hr] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.deactivated.map((r: any) => r.gstin)).toEqual([HR]);

    const c = await load(co.id);
    expect(c.gstStatus).toBe("UNREGISTERED");
    expect(c.gstRegistrations).toHaveLength(1);
    expect(c.gstRegistrations[0]).toMatchObject({ gstin: HR, active: false, isDefault: false, deactivatedBy: String(HOLDER_ID) });
    expect(c.gstRegistrations[0].deactivatedAt).toBeTruthy();
    // Same as a company whose registrations are all inactive: no GSTIN on the
    // Customer or the workspace; the GST state kept (invoices use it for tax).
    expect(c.gstNumber).toBe("");
    expect(c.gstRegisteredState).toBe("Haryana");
    expect(((await CustomerWorkspace.findById(co.ws).lean()) as any).gstNumber).toBe("");

    const rows = (await audits(co.id)).slice(auditsBefore);
    expect(rows.map((r) => r.action)).toEqual(["DEACTIVATE", "UNREGISTER"]);
    for (const r of rows) expect(r).toMatchObject({ actorId: String(HOLDER_ID), source: "businessProfiles:unregister" });
    expect(rows[0]).toMatchObject({ gstin: HR, before: { active: true, isDefault: true }, after: { active: false, isDefault: false } });
    expect(rows[1]).toMatchObject({
      before: { gstStatus: "REGISTERED", gstNumber: HR, activeGstins: [HR] },
      after: { gstStatus: "UNREGISTERED", gstNumber: "" },
    });

    const list = await as(HOLDER, request(app).get(base(co)));
    expect(list.body.gstStatus).toBe("UNREGISTERED");
  });

  it("several registrations (default + other + an inactive one): every active one deactivated in one write", async () => {
    const co = await registered();
    const before = await load(co.id);
    const ids = activeIds(before);
    expect(ids).toHaveLength(2);
    const res = await as(HOLDER, request(app).post(`${base(co)}/unregister`)).send({ registrationIds: ids });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const c = await load(co.id);
    expect(c.gstStatus).toBe("UNREGISTERED");
    expect(activeIds(c)).toEqual([]);
    expect(c.gstRegistrations.some((r: any) => r.isDefault)).toBe(false);
    const mhBefore = before.gstRegistrations.find((r: any) => String(r._id) === co.mh);
    const mhAfter = c.gstRegistrations.find((r: any) => String(r._id) === co.mh);
    expect(String(mhAfter.deactivatedAt)).toBe(String(mhBefore.deactivatedAt)); // already inactive: untouched
    expect(c.gstRegistrationsRev).toBe(before.gstRegistrationsRev + 1);
    expect((await audits(co.id)).map((r) => r.action).slice(-3)).toEqual(["DEACTIVATE", "DEACTIVATE", "UNREGISTER"]);
  });

  it("stale confirmation (the person was not shown every active GSTIN): 409 with the current list; nothing changes", async () => {
    const co = await registered();
    const before = await snapshot(co);
    const [first] = activeIds(await load(co.id));
    const res = await as(HOLDER, request(app).post(`${base(co)}/unregister`)).send({ registrationIds: [first] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONFIRMATION_STALE");
    expect(res.body.active.map((r: any) => r.gstin).sort()).toEqual([HR, KA].sort());
    const none = await as(HOLDER, request(app).post(`${base(co)}/unregister`)).send({});
    expect(none.status).toBe(409);
    expect(await snapshot(co)).toBe(before);
  });

  it("repeating it on an already Unregistered company is a no-op", async () => {
    const co = await single();
    await as(HOLDER, request(app).post(`${base(co)}/unregister`)).send({ registrationIds: [co.hr] });
    const before = await snapshot(co);
    const again = await as(HOLDER, request(app).post(`${base(co)}/unregister`)).send({ registrationIds: [co.hr] });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(await snapshot(co)).toBe(before);
  });

  it("the form save that follows (status re-sent with other fields) goes through on both form paths", async () => {
    const co = await single();
    await as(HOLDER, request(app).post(`${base(co)}/unregister`)).send({ registrationIds: [co.hr] });
    const res = await as(HOLDER, request(app).patch(`/api/customers/${co.id}`)).send({ gstStatus: "UNREGISTERED", industry: "Food" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await load(co.id)).toMatchObject({ gstStatus: "UNREGISTERED", industry: "Food", gstNumber: "" });
    const md = await as(HOLDER, request(app).patch(`/api/master-data/${co.ob}`)).send({ gstStatus: "UNREGISTERED", industry: "Foods" });
    expect(md.status, JSON.stringify(md.body)).toBe(200);
  });
});

describe("UNREGISTERED → REGISTERED needs a registration", () => {
  async function unregistered() {
    const co = await single();
    const res = await as(HOLDER, request(app).post(`${base(co)}/unregister`)).send({ registrationIds: [co.hr] });
    expect(res.status).toBe(200);
    return co;
  }

  it("a bare status flip is refused on both form paths; nothing changes", async () => {
    const co = await unregistered();
    const before = await snapshot(co);
    const patch = await as(HOLDER, request(app).patch(`/api/customers/${co.id}`)).send({ gstStatus: "REGISTERED" });
    expect(patch.status).toBe(409);
    expect(patch.body.code).toBe("REGISTRATION_REQUIRED");
    const md = await as(HOLDER, request(app).patch(`/api/master-data/${co.ob}`)).send({ gstStatus: "REGISTERED" });
    expect(md.status).toBe(409);
    expect(md.body.code).toBe("REGISTRATION_REQUIRED");
    expect(await snapshot(co)).toBe(before);
  });

  it("add / reactivate without markRegistered are refused (never a silent status change)", async () => {
    const co = await unregistered();
    const before = await snapshot(co);
    const add = await as(HOLDER, request(app).post(base(co))).send({ gstin: KA });
    expect(add.status).toBe(409);
    expect(add.body.code).toBe("COMPANY_UNREGISTERED");
    const re = await as(HOLDER, request(app).post(`${base(co)}/${co.hr}/reactivate`));
    expect(re.status).toBe(409);
    expect(re.body.code).toBe("COMPANY_UNREGISTERED");
    expect(await snapshot(co)).toBe(before);
  });

  it("reactivate with markRegistered: Registered again, default restored, mirrors back, audited", async () => {
    const co = await unregistered();
    const res = await as(HOLDER, request(app).post(`${base(co)}/${co.hr}/reactivate`)).send({ markRegistered: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const c = await load(co.id);
    expect(c.gstStatus).toBe("REGISTERED");
    expect(c.gstRegistrations[0]).toMatchObject({ gstin: HR, active: true, isDefault: true, deactivatedAt: null });
    expect(c.gstNumber).toBe(HR);
    expect(c.gstRegisteredState).toBe("Haryana");
    expect(((await CustomerWorkspace.findById(co.ws).lean()) as any).gstNumber).toBe(HR);
    expect((await audits(co.id)).at(-1)).toMatchObject({
      action: "REACTIVATE", gstin: HR, before: { gstStatus: "UNREGISTERED" }, after: { gstStatus: "REGISTERED", active: true },
    });
  });

  it("add with markRegistered: Registered with the new GSTIN as default", async () => {
    const co = await unregistered();
    const res = await as(HOLDER, request(app).post(base(co))).send({ gstin: KA, markRegistered: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const c = await load(co.id);
    expect(c.gstStatus).toBe("REGISTERED");
    expect(c.gstNumber).toBe(KA);
    expect(c.gstRegisteredState).toBe("Karnataka");
    expect((await audits(co.id)).at(-1)).toMatchObject({ action: "ADD", gstin: KA, before: { gstStatus: "UNREGISTERED" }, after: { gstStatus: "REGISTERED" } });
  });

  it("the round trip can repeat", async () => {
    const co = await unregistered();
    await as(HOLDER, request(app).post(`${base(co)}/${co.hr}/reactivate`)).send({ markRegistered: true });
    const res = await as(HOLDER, request(app).post(`${base(co)}/unregister`)).send({ registrationIds: [co.hr] });
    expect(res.status).toBe(200);
    expect((await load(co.id)).gstStatus).toBe("UNREGISTERED");
  });
});

describe("permission: without the gstRegistrations grant", () => {
  it("unregister is 403 and nothing changes (nor through the form's status field)", async () => {
    const co = await single();
    const before = await snapshot(co);
    const res = await as(EDITOR, request(app).post(`${base(co)}/unregister`)).send({ registrationIds: [co.hr] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("GST_REGISTRATIONS_ACCESS_REQUIRED");
    const patch = await as(EDITOR, request(app).patch(`/api/customers/${co.id}`)).send({ gstStatus: "UNREGISTERED" });
    expect(patch.status).toBe(403);
    expect(await snapshot(co)).toBe(before);
  });

  it("reactivate / add with markRegistered and a status flip back are 403; nothing changes", async () => {
    const co = await single();
    await as(HOLDER, request(app).post(`${base(co)}/unregister`)).send({ registrationIds: [co.hr] });
    const before = await snapshot(co);
    const re = await as(EDITOR, request(app).post(`${base(co)}/${co.hr}/reactivate`)).send({ markRegistered: true });
    expect(re.status).toBe(403);
    const add = await as(EDITOR, request(app).post(base(co))).send({ gstin: KA, markRegistered: true });
    expect(add.status).toBe(403);
    const patch = await as(EDITOR, request(app).patch(`/api/customers/${co.id}`)).send({ gstStatus: "REGISTERED" });
    expect(patch.status).toBe(403);
    expect(await snapshot(co)).toBe(before);
  });

  it("a tenant admin holding the key is 403 too", async () => {
    const co = await single();
    const tenant: Who = {
      user: { _id: String(TENANT_ID), id: String(TENANT_ID), sub: String(TENANT_ID), roles: ["ADMIN", "TENANT_ADMIN"], workspaceId: co.ws, customerId: co.id, email: "admin@osprey.test" },
      ws: co.ws,
    };
    await grant(TENANT_ID, co.ws, { masterData: { access: "FULL", scope: "ALL" }, gstRegistrations: { access: "FULL", scope: "ALL" } });
    const before = await snapshot(co);
    const res = await as(tenant, request(app).post(`${base(co)}/unregister`)).send({ registrationIds: [co.hr] });
    expect(res.status).toBe(403);
    expect(await snapshot(co)).toBe(before);
  });

  it("platform SuperAdmin passes with no key", async () => {
    const co = await single();
    const res = await as(SA, request(app).post(`${base(co)}/unregister`)).send({ registrationIds: [co.hr] });
    expect(res.status).toBe(200);
  });
});
