// apps/backend/src/routes/gstRegistrations.writers.test.ts
//
// R2 (P1): every GSTIN writer goes through services/gstRegistrations.ts.
//   - the staff registrations API (Business Profiles table) + its gate
//   - PATCH /customers/:id, PATCH /master-data/:id, promote-customer
//   - onboarding approval (syncCustomerFromOnboarding)
//   - POST /admin/direct-customers
//   - PATCH /workspace/settings/pan (staff) + the portal's read-only list
//   - PUT /workspace/onboarding/configure refuses a GSTIN (decision #8)
// Real routers, models and service on in-memory Mongo; auth stubbed by headers.
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
const { default: directCustomersRouter } = await import("./directCustomers.js");
const { default: workspaceSettingsRouter } = await import("./workspace.settings.js");
const { default: workspaceOnboardingRouter } = await import("./workspace.onboarding.js");
const { syncCustomerFromOnboarding } = await import("../services/syncCustomerFromOnboarding.js");
const { default: Customer } = await import("../models/Customer.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: Onboarding } = await import("../models/Onboarding.js");

const app = express();
app.use(express.json());
app.use("/api/customers", gstRegistrationsRouter);
app.use("/api/customers", customersRouter);
app.use("/api/master-data", masterDataRouter);
app.use("/api/admin/direct-customers", directCustomersRouter);
app.use("/api/workspace/settings", workspaceSettingsRouter);
app.use("/api/workspace/onboarding", workspaceOnboardingRouter);
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

let mongod: MongoMemoryServer;
const oid = () => new mongoose.Types.ObjectId();
const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const STAFF = oid();
const staff = (r: request.Test) =>
  r.set("x-test-user", JSON.stringify({ _id: String(STAFF), id: String(STAFF), sub: String(STAFF), roles: ["SUPERADMIN"], email: "qc@plumtrips.com" })).set("x-test-ws", String(HOUSE));
const leader = (ws: unknown, customerId: unknown) => (r: request.Test) =>
  r
    .set("x-test-user", JSON.stringify({ _id: String(oid()), roles: ["CUSTOMER", "WORKSPACE_LEADER"], customerId: String(customerId), workspaceId: String(ws) }))
    .set("x-test-ws", String(ws));

async function company(extra: Record<string, unknown> = {}) {
  const c: any = await Customer.create({ name: "Osprey Foods", legalName: "Osprey Foods Private Limited", status: "ACTIVE", workspaceId: HOUSE, ...extra } as any);
  const ws: any = await CustomerWorkspace.create({ customerId: String(c._id), slug: `ws-${c._id}`, companyName: "Osprey Foods", status: "ACTIVE" } as any);
  return { id: String(c._id), ws: ws._id };
}
const fresh = async (id: unknown): Promise<any> => Customer.findById(id).lean();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("gst-registrations-writers-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await mongoose.connection.db!.collection("companysettings").insertOne({
    gstProfiles: [{ state: "Haryana", stateCode: "06", gstin: "06AAACP1234A1Z5", isDefault: true, active: true }],
  });
});

describe("staff registrations API (Business Profiles table)", () => {
  it("check → add → list → set default → deactivate, over HTTP", async () => {
    const { id, ws } = await company();
    const chk = await staff(request(app).get(`/api/customers/gst-registrations/check?gstin=${HR}&customerId=${id}`));
    expect(chk.status).toBe(200);
    expect(chk.body.check).toMatchObject({ ok: true, state: "Haryana", stateCode: "06" });

    const add = await staff(request(app).post(`/api/customers/${id}/gst-registrations`)).send({ gstin: HR, label: "Gurugram plant" });
    expect(add.status).toBe(200);
    const ka = await staff(request(app).post(`/api/customers/${id}/gst-registrations`)).send({ gstin: KA });
    const list = await staff(request(app).get(`/api/customers/${id}/gst-registrations`));
    expect(list.body).toMatchObject({ companyPan: PAN, gstStatus: "REGISTERED" });
    expect(list.body.registrations.map((r: any) => [r.gstin, r.isDefault])).toEqual([[HR, true], [KA, false]]);

    const def = await staff(request(app).post(`/api/customers/${id}/gst-registrations/${ka.body.registration._id}/default`));
    expect(def.status).toBe(200);
    expect((await CustomerWorkspace.findById(ws).lean() as any).gstNumber).toBe(KA);

    const deact = await staff(request(app).post(`/api/customers/${id}/gst-registrations/${ka.body.registration._id}/deactivate`));
    expect(deact.status).toBe(409);
    expect(deact.body.code).toBe("DEFAULT_REGISTRATION");
  });

  it("refuses with a link to the other company that holds the GSTIN", async () => {
    const a = await company({ legalName: "Osprey (old)" });
    await staff(request(app).post(`/api/customers/${a.id}/gst-registrations`)).send({ gstin: HR });
    const b = await company({ legalName: "Osprey (new)", name: "Osprey new" });
    const res = await staff(request(app).post(`/api/customers/${b.id}/gst-registrations`)).send({ gstin: HR });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "GSTIN_ON_OTHER_COMPANY", otherCompany: { customerId: a.id, name: "Osprey (old)" } });
  });

  it("D2: a client's own leader can't use it", async () => {
    const { id, ws } = await company();
    const res = await leader(ws, id)(request(app).post(`/api/customers/${id}/gst-registrations`)).send({ gstin: HR });
    expect(res.status).toBe(403);
    expect((await fresh(id)).gstRegistrations ?? []).toHaveLength(0);
  });
});

describe("PATCH /customers/:id", () => {
  it("a GSTIN becomes the default registration; gstRegistrations can't be set directly; a contradicting state is refused", async () => {
    const { id } = await company();
    const res = await staff(request(app).patch(`/api/customers/${id}`)).send({ gstNumber: HR, gstStatus: "REGISTERED" });
    expect(res.status).toBe(200);
    expect(await fresh(id)).toMatchObject({ gstNumber: HR, gstRegisteredState: "Haryana" });

    const direct = await staff(request(app).patch(`/api/customers/${id}`)).send({ gstRegistrations: [] });
    expect(direct.status).toBe(400);
    expect(direct.body.code).toBe("USE_GST_REGISTRATIONS");

    const state = await staff(request(app).patch(`/api/customers/${id}`)).send({ gstRegisteredState: "Karnataka" });
    expect(state.status).toBe(400);
    expect(state.body.code).toBe("STATE_FROM_GSTIN");
    const same = await staff(request(app).patch(`/api/customers/${id}`)).send({ gstRegisteredState: "Haryana", website: "osprey.test" });
    expect(same.status).toBe(200);

    const unreg = await staff(request(app).patch(`/api/customers/${id}`)).send({ gstStatus: "UNREGISTERED" });
    expect(unreg.status).toBe(409);
    expect((await fresh(id)).gstStatus).toBe("REGISTERED");
  });

  it("a company with no registrations still takes a typed state (GSTIN-less)", async () => {
    const { id } = await company({ gstStatus: "NOT_SET" });
    const res = await staff(request(app).patch(`/api/customers/${id}`)).send({ gstRegisteredState: "Delhi", gstRegisteredStateCode: "07" });
    expect(res.status).toBe(200);
    expect(await fresh(id)).toMatchObject({ gstRegisteredState: "Delhi" });
  });
});

describe("onboarding → registration", () => {
  async function onboarding(form: Record<string, unknown>, status = "approved") {
    return Onboarding.create({
      workspaceId: HOUSE, type: "business", email: `ap-${oid()}@osprey.test`, token: `tok-${oid()}`, status,
      expiresAt: new Date(Date.now() + 86_400_000), formPayload: { legalName: "Osprey Foods Private Limited", officialEmail: "ap@osprey.test", ...form },
    } as any);
  }

  it("PATCH /master-data/:id (promoted company): the GSTIN goes through the service, not the raw sync", async () => {
    const ob: any = await onboarding({ gstNumber: HR, panNumber: PAN });
    const c: any = await Customer.create({ name: "Osprey Foods", legalName: "Osprey Foods Private Limited", onboardingId: ob._id, gstStatus: "REGISTERED" } as any);
    await CustomerWorkspace.create({ customerId: String(c._id), slug: "osprey-md", companyName: "Osprey" } as any);
    const res = await staff(request(app).patch(`/api/master-data/${ob._id}`)).send({ gstNumber: KA, panNumber: PAN, gstRegisteredState: "Karnataka" });
    expect(res.status).toBe(200);
    const after = await fresh(c._id);
    expect(after).toMatchObject({ gstNumber: KA, gstRegisteredState: "Karnataka", gstRegisteredStateCode: "29" });
    expect(after.gstRegistrations.map((r: any) => r.gstin)).toEqual([KA]);
    expect(((await CustomerWorkspace.findOne({ customerId: String(c._id) }).lean()) as any).gstNumber).toBe(KA);

    const bad = await staff(request(app).patch(`/api/master-data/${ob._id}`)).send({ gstNumber: gstin("29", "AABCK1234Q") });
    // Caught by master-data's own REGISTERED check (code GSTIN_INVALID, PAN message).
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/does not belong to PAN/);
    expect((await fresh(c._id)).gstNumber).toBe(KA);
  });

  it("promote: an invalid form GSTIN refuses BEFORE anything is created; a valid one becomes the default registration + workspace mirror", async () => {
    const badOb: any = await onboarding({ gstNumber: HR.slice(0, 14) + (HR[14] === "A" ? "B" : "A"), panNumber: PAN });
    const refused = await staff(request(app).post(`/api/master-data/${badOb._id}/promote-customer`)).send({ sendEmail: false });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("GSTIN_INVALID");
    expect(await Customer.countDocuments({ onboardingId: badOb._id })).toBe(0);

    const ob: any = await onboarding({ gstNumber: HR, panNumber: PAN });
    const ok = await staff(request(app).post(`/api/master-data/${ob._id}/promote-customer`)).send({ sendEmail: false });
    expect(ok.status).toBeLessThan(300);
    const c: any = await Customer.findOne({ onboardingId: ob._id }).lean();
    expect(c).toMatchObject({ gstNumber: HR, gstStatus: "REGISTERED", gstRegisteredState: "Haryana" });
    expect(c.gstRegistrations).toHaveLength(1);
    expect(c.gstRegistrations[0]).toMatchObject({ gstin: HR, isDefault: true, source: "ONBOARDING" });
    expect(((await CustomerWorkspace.findOne({ customerId: String(c._id) }).lean()) as any).gstNumber).toBe(HR);
  });

  it("approval: the submitted stub has no GSTIN; approval turns a valid one into the registration, skips an invalid one", async () => {
    const ob: any = await onboarding({ gstNumber: HR, panNumber: PAN }, "submitted");
    await syncCustomerFromOnboarding(ob);
    const stub: any = await Customer.findOne({ onboardingId: ob._id }).lean();
    expect(stub.gstNumber ?? "").toBe("");
    expect(stub.gstRegistrations ?? []).toHaveLength(0);
    ob.status = "approved";
    await syncCustomerFromOnboarding(ob);
    expect(await fresh(stub._id)).toMatchObject({ gstNumber: HR, gstRegisteredState: "Haryana" });

    const bad: any = await onboarding({ gstNumber: "06BADGSTIN00001", legalName: "Wren Textiles" }, "submitted");
    await syncCustomerFromOnboarding(bad);
    bad.status = "approved";
    await expect(syncCustomerFromOnboarding(bad)).resolves.toBeUndefined();
    const wren: any = await Customer.findOne({ onboardingId: bad._id }).lean();
    expect(wren.gstRegistrations ?? []).toHaveLength(0);
  });

  it("approval with no stub from submit: the stub made at approval still gets the GSTIN as its registration", async () => {
    const ob: any = await onboarding({ gstNumber: HR, panNumber: PAN }, "approved");
    expect(await Customer.findOne({ onboardingId: ob._id }).lean()).toBeNull();
    await syncCustomerFromOnboarding(ob);
    const c: any = await Customer.findOne({ onboardingId: ob._id }).lean();
    expect(c).toMatchObject({ gstNumber: HR, gstStatus: "REGISTERED", gstRegisteredState: "Haryana" });
    expect(c.gstRegistrations).toHaveLength(1);
    expect(c.gstRegistrations[0]).toMatchObject({ gstin: HR, isDefault: true });
  });
});

describe("POST /admin/direct-customers", () => {
  it("a GSTIN is validated and becomes the registration; a state that contradicts it is refused", async () => {
    const wrong = await staff(request(app).post("/api/admin/direct-customers")).send({ displayName: "Asha Rao", email: "asha@rao.test", gstNumber: HR, gstRegisteredState: "Delhi" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("STATE_FROM_GSTIN");
    const bad = await staff(request(app).post("/api/admin/direct-customers")).send({ displayName: "Asha Rao", email: "asha@rao.test", gstNumber: "06AACCO4321P1ZZ" });
    expect(bad.status).toBe(400);
    const ok = await staff(request(app).post("/api/admin/direct-customers")).send({ displayName: "Asha Rao", email: "asha@rao.test", gstNumber: HR });
    expect(ok.status).toBe(201);
    expect(ok.body.customer.gstNumber).toBe(HR);
    const c: any = await fresh(ok.body.customer._id);
    expect(c).toMatchObject({ gstStatus: "REGISTERED", gstRegisteredState: "Haryana", panNumber: PAN });
    expect(c.gstRegistrations).toHaveLength(1);
  });
});

describe("workspace settings", () => {
  it("staff PATCH /pan with a GSTIN → the company's default registration; the client still can't", async () => {
    const { id, ws } = await company();
    const res = await staff(request(app).patch("/api/workspace/settings/pan")).set("x-test-ws", String(ws)).send({ gstNumber: HR });
    expect(res.status).toBe(200);
    expect(res.body.gstNumber).toBe(HR);
    expect((await fresh(id)).gstRegistrations).toHaveLength(1);

    const client = await leader(ws, id)(request(app).patch("/api/workspace/settings/pan")).send({ gstNumber: KA });
    expect(client.status).toBe(403);
    expect(client.body.code).toBe("GST_LOCKED");
  });

  it("GET /gst-registrations: the client sees its own active registrations, read-only, default first", async () => {
    const { id, ws } = await company();
    await staff(request(app).post(`/api/customers/${id}/gst-registrations`)).send({ gstin: KA });
    await staff(request(app).post(`/api/customers/${id}/gst-registrations`)).send({ gstin: HR, label: "Gurugram" });
    const res = await leader(ws, id)(request(app).get("/api/workspace/settings/gst-registrations"));
    expect(res.status).toBe(200);
    expect(res.body.registrations.map((r: any) => [r.gstin, r.isDefault, r.label])).toEqual([[KA, true, ""], [HR, false, "Gurugram"]]);
  });

  it("decision #8: PUT /workspace/onboarding/configure refuses a GSTIN (never silently drops it); without one it saves", async () => {
    const { id, ws } = await company();
    for (const key of ["gstNumber", "gst", "gstin"]) {
      const res = await leader(ws, id)(request(app).put("/api/workspace/onboarding/configure")).send({ [key]: HR, pan: PAN });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("GST_NOT_ACCEPTED_HERE");
    }
    expect(((await CustomerWorkspace.findById(ws).lean()) as any).pan ?? "").toBe("");
    const ok = await leader(ws, id)(request(app).put("/api/workspace/onboarding/configure")).send({ pan: PAN, address: "Plot 9" });
    expect(ok.status).toBe(200);
    const after: any = await CustomerWorkspace.findById(ws).lean();
    expect(after.pan).toBe(PAN);
    expect(after.gstNumber ?? "").toBe("");
  });
});
