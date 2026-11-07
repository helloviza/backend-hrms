// apps/backend/src/routes/gstRegistrations.access.test.ts
//
// R2 3b: changing a client company's GST registrations needs the Access
// Console key `gstRegistrations` (services/gstRegistrationAccess.ts).
//   - a Plumtrips staff user who can edit Business Profiles but lacks the key:
//     403 on every registration write and on a GSTIN / GST state / GST status
//     change through PATCH /customers/:id, PATCH /master-data/:id and staff
//     PATCH /workspace/settings/pan — nothing changes; other fields still save;
//   - with the key (any level above NONE): works;
//   - platform SuperAdmin: works with no key;
//   - a tenant admin with the key stored on their permission doc: 403.
// Real routers, models, service and permission documents on in-memory Mongo;
// auth and workspace resolution stubbed by headers.
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
  await mongoose.connect(mongod.getUri("gst-registrations-access-test"));
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

/** Every registration write the table can make, against a fresh company. */
const writes = (co: Awaited<ReturnType<typeof registered>>) => [
  ["add", (r: typeof request) => r(app).post(`/api/customers/${co.id}/gst-registrations`).send({ gstin: gstin("07", PAN) })],
  ["Bill From edit", (r: typeof request) => r(app).patch(`/api/customers/${co.id}/gst-registrations/${co.ka}`).send({ defaultSellerGstin: SELLER_KA })],
  ["deactivate", (r: typeof request) => r(app).post(`/api/customers/${co.id}/gst-registrations/${co.ka}/deactivate`)],
  ["reactivate", (r: typeof request) => r(app).post(`/api/customers/${co.id}/gst-registrations/${co.mh}/reactivate`)],
  ["set default", (r: typeof request) => r(app).post(`/api/customers/${co.id}/gst-registrations/${co.mh}/default`)],
] as const;

describe("registrations API (Business Profiles table)", () => {
  it("without the key: 403 on add, Bill From, set default, deactivate, reactivate — nothing changes", async () => {
    const co = await registered();
    const before = await snapshot(co);
    for (const [name, call] of writes(co)) {
      const res = await as(EDITOR, call(request) as request.Test);
      expect(res.status, name).toBe(403);
      expect(res.body.code, name).toBe("GST_REGISTRATIONS_ACCESS_REQUIRED");
    }
    expect(await snapshot(co)).toBe(before);
  });

  it("without the key the list still loads, with canManage false", async () => {
    const co = await registered();
    const res = await as(EDITOR, request(app).get(`/api/customers/${co.id}/gst-registrations`));
    expect(res.status).toBe(200);
    expect(res.body.canManage).toBe(false);
    expect(res.body.registrations).toHaveLength(3);
  });

  it("with the key: every write works, and canManage is true", async () => {
    const co = await registered();
    expect((await as(HOLDER, request(app).get(`/api/customers/${co.id}/gst-registrations`))).body.canManage).toBe(true);
    for (const [name, call] of writes(co)) {
      const res = await as(HOLDER, call(request) as request.Test);
      expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBe(200);
    }
    const c: any = await Customer.findById(co.id).lean();
    const mh = c.gstRegistrations.find((r: any) => String(r._id) === co.mh);
    expect(mh).toMatchObject({ active: true, isDefault: true });
    expect(c.gstRegistrations.find((r: any) => String(r._id) === co.ka).active).toBe(false);
    expect(c.gstNumber).toBe(MH);
  });

  it("platform SuperAdmin passes with no key", async () => {
    const co = await registered();
    const res = await as(SA, request(app).post(`/api/customers/${co.id}/gst-registrations`)).send({ gstin: gstin("07", PAN) });
    expect(res.status).toBe(200);
  });

  it("a suspended grant confers nothing", async () => {
    await UserPermission.updateOne({ userId: String(HOLDER_ID) }, { $set: { status: "suspended" } });
    const co = await registered();
    const res = await as(HOLDER, request(app).post(`/api/customers/${co.id}/gst-registrations`)).send({ gstin: gstin("07", PAN) });
    expect(res.status).toBe(403);
  });
});

describe("legacy paths: a GST change needs the key, other fields still save", () => {
  it("PATCH /customers/:id — GSTIN, GST state and GST status changes are 403; nothing saves", async () => {
    const co = await company({ gstNumber: HR, gstRegisteredState: "Haryana", gstRegisteredStateCode: "06" });
    const before = await snapshot(co);
    for (const body of [
      { gstNumber: KA, name: "Renamed" },
      { gstRegisteredState: "Karnataka" },
      { gstStatus: "UNREGISTERED" },
    ]) {
      const res = await as(EDITOR, request(app).patch(`/api/customers/${co.id}`)).send(body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(res.body.code).toBe("GST_REGISTRATIONS_ACCESS_REQUIRED");
    }
    expect(await snapshot(co)).toBe(before);
  });

  it("PATCH /customers/:id — other fields save, and re-sending the unchanged GST values is fine", async () => {
    const co = await company({ gstNumber: HR, gstRegisteredState: "Haryana", gstRegisteredStateCode: "06" });
    const res = await as(EDITOR, request(app).patch(`/api/customers/${co.id}`)).send({
      name: "Osprey Foods Renamed", gstNumber: HR, gstRegisteredState: "Haryana", gstStatus: "REGISTERED",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const c: any = await Customer.findById(co.id).lean();
    expect(c).toMatchObject({ name: "Osprey Foods Renamed", gstNumber: HR, gstRegisteredState: "Haryana" });
    expect(c.gstRegistrations).toBeUndefined();
  });

  it("PATCH /customers/:id with the key: the GSTIN change goes through", async () => {
    const co = await company({ gstNumber: HR, gstRegisteredState: "Haryana", gstRegisteredStateCode: "06" });
    const res = await as(HOLDER, request(app).patch(`/api/customers/${co.id}`)).send({ gstNumber: KA });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(((await Customer.findById(co.id).lean()) as any).gstNumber).toBe(KA);
  });

  it("PATCH /master-data/:id — a GSTIN change is 403 and nothing saves; a name change saves", async () => {
    const co = await company({ gstNumber: HR, gstRegisteredState: "Haryana", gstRegisteredStateCode: "06" });
    const before = await snapshot(co);
    const refused = await as(EDITOR, request(app).patch(`/api/master-data/${co.ob}`)).send({ gstNumber: KA, panNumber: PAN, companyName: "Renamed Pvt Ltd" });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.code).toBe("GST_REGISTRATIONS_ACCESS_REQUIRED");
    const state = await as(EDITOR, request(app).patch(`/api/master-data/${co.ob}`)).send({ gstRegisteredState: "Karnataka" });
    expect(state.status).toBe(403);
    expect(await snapshot(co)).toBe(before);
    expect(((await Onboarding.findById(co.ob).lean()) as any).formPayload.companyName).toBeUndefined();

    const ok = await as(EDITOR, request(app).patch(`/api/master-data/${co.ob}`)).send({ industry: "Food processing" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    const holder = await as(HOLDER, request(app).patch(`/api/master-data/${co.ob}`)).send({ gstNumber: KA, panNumber: PAN, gstRegisteredState: "Karnataka" });
    expect(holder.status, JSON.stringify(holder.body)).toBe(200);
    expect(((await Customer.findById(co.id).lean()) as any).gstNumber).toBe(KA);
  });

  it("staff PATCH /workspace/settings/pan — a GSTIN change is 403; PAN alone saves; with the key it works", async () => {
    const co = await company();
    const refused = await as(EDITOR, request(app).patch("/api/workspace/settings/pan"), co.ws).send({ gstNumber: HR });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("GST_REGISTRATIONS_ACCESS_REQUIRED");
    expect(((await Customer.findById(co.id).lean()) as any).gstNumber).toBeFalsy();

    const pan = await as(EDITOR, request(app).patch("/api/workspace/settings/pan"), co.ws).send({ pan: PAN });
    expect(pan.status).toBe(200);

    const ok = await as(HOLDER, request(app).patch("/api/workspace/settings/pan"), co.ws).send({ gstNumber: HR });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(((await Customer.findById(co.id).lean()) as any).gstRegistrations).toHaveLength(1);
  });

  it("staff PATCH /workspace/settings/pan on a workspace with no company follows the same rule", async () => {
    const ws: any = await CustomerWorkspace.create({ customerId: String(oid()), slug: `saas-${oid()}`, companyName: "SaaS Co", status: "ACTIVE" } as any);
    const refused = await as(EDITOR, request(app).patch("/api/workspace/settings/pan"), String(ws._id)).send({ gstNumber: HR });
    expect(refused.status).toBe(403);
    expect(((await CustomerWorkspace.findById(ws._id).lean()) as any).gstNumber).toBeFalsy();
    const ok = await as(HOLDER, request(app).patch("/api/workspace/settings/pan"), String(ws._id)).send({ gstNumber: HR });
    expect(ok.status).toBe(200);
  });
});

describe("a tenant admin never passes, even with the key stored", () => {
  it("403 on registration writes and on legacy GST changes; nothing changes", async () => {
    const co = await registered();
    TENANT = {
      user: { _id: String(TENANT_ID), id: String(TENANT_ID), sub: String(TENANT_ID), roles: ["ADMIN", "TENANT_ADMIN"], workspaceId: co.ws, customerId: co.id, email: "admin@osprey.test" },
      ws: co.ws,
    };
    await grant(TENANT_ID, co.ws, { masterData: { access: "FULL", scope: "ALL" }, gstRegistrations: { access: "FULL", scope: "ALL" } });
    const before = await snapshot(co);
    for (const [name, call] of writes(co)) {
      const res = await as(TENANT, call(request) as request.Test);
      expect(res.status, name).toBe(403);
    }
    const legacy = await as(TENANT, request(app).patch(`/api/customers/${co.id}`)).send({ gstNumber: KA });
    expect(legacy.status).toBe(403);
    const pan = await as(TENANT, request(app).patch("/api/workspace/settings/pan")).send({ gstNumber: KA });
    expect(pan.status).toBe(403);
    expect(await snapshot(co)).toBe(before);
  });

  it("the grant helper itself refuses a non-HOUSE caller holding the key", async () => {
    const { canManageGstRegistrations } = await import("../services/gstRegistrationAccess.js");
    const co = await company();
    await grant(TENANT_ID, co.ws, { gstRegistrations: { access: "FULL", scope: "ALL" } });
    expect(await canManageGstRegistrations({ user: { _id: String(TENANT_ID), roles: ["ADMIN", "TENANT_ADMIN"], workspaceId: co.ws, customerId: co.id } })).toBe(false);
    expect(await canManageGstRegistrations({ user: { _id: String(HOLDER_ID), roles: ["ADMIN"], workspaceId: HOUSE } })).toBe(true);
    expect(await canManageGstRegistrations({ user: { _id: String(EDITOR_ID), roles: ["ADMIN"], workspaceId: HOUSE } })).toBe(false);
  });
});

describe("level templates and the tenant-admin view never carry the key", () => {
  it("every level template has gstRegistrations NONE", async () => {
    const { LEVEL_TEMPLATES } = await import("../config/levelTemplates.js");
    const templates = Object.values(LEVEL_TEMPLATES) as any[];
    expect(templates.length).toBeGreaterThanOrEqual(8);
    for (const t of templates) expect(t.gstRegistrations).toEqual({ access: "NONE", scope: "NONE" });
  });
});
