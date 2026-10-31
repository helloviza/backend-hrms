// promote-customer / promote-vendor create a PERSON login, never one named
// after the company (docs/audits/company-vs-person-name-audit.md §6.2).
// Real HTTP against mongodb-memory-server, real masterData router.
//
// Order (customer): key contact with the promoted email → first key contact →
// signatory → invitee name. Vendor: contact person → invitee. The dialog's
// `personName` wins when sent ("" = unknown). A name equal to the company is
// dropped; unknown leaves the login unnamed.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const SECRET = "promote-person-name-test-secret";
process.env.JWT_SECRET = SECRET;
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/promote-person-name-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

vi.mock("../utils/mailer.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  sendMail: vi.fn(async () => ({ messageId: "test" })),
}));

const { default: Customer } = await import("../models/Customer.js");
const { default: User } = await import("../models/User.js");
const { default: Onboarding } = await import("../models/Onboarding.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: CustomerMember } = await import("../models/CustomerMember.js");
const { default: masterDataRouter } = await import("./masterData.js");
const { sendMail } = await import("../utils/mailer.js");
const mail = sendMail as unknown as ReturnType<typeof vi.fn>;
const welcome = () =>
  mail.mock.calls.map((c: any[]) => c[0]).find((m: any) => /Your Account is Ready/.test(String(m?.subject || "")));

let mongod: MongoMemoryServer;
const HOUSE_WS = new mongoose.Types.ObjectId();
const ADMIN_ID = new mongoose.Types.ObjectId();
const TOKEN = jwt.sign(
  { sub: String(ADMIN_ID), id: String(ADMIN_ID), email: "admin@plumtrips.com", roles: ["SUPERADMIN"] },
  SECRET,
  { expiresIn: "1h" },
);

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/master-data", masterDataRouter);
  a.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: String(err?.message || err) }));
  return a;
}
const post = (path: string, body: any = {}) =>
  request(app()).post(path).set("Authorization", `Bearer ${TOKEN}`).set("x-workspace-id", String(HOUSE_WS)).send(body);
const get = (path: string) =>
  request(app()).get(path).set("Authorization", `Bearer ${TOKEN}`).set("x-workspace-id", String(HOUSE_WS));

const EMAIL = "ops@peachmint.test";
const LEGAL = "PEACHMINT FOODS PRIVATE LIMITED";
let seq = 0;

async function onboarding(fields: Record<string, any>) {
  return Onboarding.create({
    workspaceId: HOUSE_WS,
    type: "business",
    status: "approved",
    email: EMAIL,
    token: `tok-${++seq}`,
    expiresAt: new Date(Date.now() + 86400_000),
    source: "invite",
    ...fields,
  } as any);
}
const bizForm = (extra: Record<string, any> = {}) => ({
  legalName: LEGAL,
  officialEmail: EMAIL,
  gstNumber: "27AAWCA7112J1ZA",
  panNumber: "AAWCA7112J",
  ...extra,
});
const promote = (id: unknown, body: Record<string, any> = {}) =>
  post(`/api/master-data/${id}/promote-customer`, { sendEmail: true, ...body });
const login = async (email = EMAIL) => (await User.findOne({ email }).lean()) as any;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Customer.init(), User.init(), CustomerMember.init()]);
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  mail.mockClear();
  await Promise.all([Customer, User, Onboarding, CustomerWorkspace, CustomerMember].map((m: any) => m.deleteMany({})));
});

describe("promote-customer: the login is the person", () => {
  it("the key contact with the promoted email wins; first / last / name; customerId set; welcome greets the person", async () => {
    const ob = await onboarding({
      inviteeName: "Invitee Person",
      formPayload: bizForm({
        keyContacts: [{ name: "Ravi Menon", email: "ravi@peachmint.test" }, { name: "Asha Rao Iyer", email: EMAIL }],
        signatory: { name: "Signatory Person" },
      }),
    });
    const res = await promote(ob._id);
    expect(res.status).toBe(200);

    const u = await login();
    expect([u.firstName, u.lastName, u.name]).toEqual(["Asha", "Rao Iyer", "Asha Rao Iyer"]);
    const c: any = await Customer.findOne({ onboardingId: ob._id }).lean();
    expect(u.customerId).toBe(String(c._id));

    const w = welcome();
    expect(w.html).toContain("Welcome to Plumbox, Asha!");
    expect(w.html).toContain(LEGAL);
    expect(w.html).not.toContain("Welcome to Plumbox, PEACHMINT");
  });

  it("then the first key contact, then the signatory, then the invitee", async () => {
    const a = await onboarding({ formPayload: bizForm({ keyContacts: [{ name: "Ravi Menon", email: "x@y.test" }], signatory: { name: "Sig Nat" } }) });
    await promote(a._id);
    expect((await login()).name).toBe("Ravi Menon");

    await Promise.all([Customer, User, CustomerWorkspace, CustomerMember].map((m: any) => m.deleteMany({})));
    const b = await onboarding({ formPayload: bizForm({ signatory: { name: "Sig Nat" } }), inviteeName: "Invitee Person" });
    await promote(b._id);
    expect((await login()).name).toBe("Sig Nat");

    await Promise.all([Customer, User, CustomerWorkspace, CustomerMember].map((m: any) => m.deleteMany({})));
    const c = await onboarding({ formPayload: bizForm(), inviteeName: "Invitee Person" });
    await promote(c._id);
    expect((await login()).name).toBe("Invitee Person");
  });

  it("unknown → no name at all (never the company); welcome says 'there'", async () => {
    const ob = await onboarding({ formPayload: bizForm(), inviteeName: "Peachmint Foods Pvt. Ltd." });
    expect((await promote(ob._id)).status).toBe(200);
    const u = await login();
    expect(u.name).toBeUndefined();
    expect(u.firstName).toBeUndefined();
    expect(welcome().html).toContain("Welcome to Plumbox, there!");
  });

  it("the dialog's personName wins; '' means unknown; the company typed in is dropped", async () => {
    const form = bizForm({ keyContacts: [{ name: "Ravi Menon", email: EMAIL }] });
    await promote((await onboarding({ formPayload: form }))._id, { personName: "  Meera   K  Nair " });
    expect([(await login()).firstName, (await login()).lastName]).toEqual(["Meera", "K Nair"]);

    await Promise.all([Customer, User, CustomerWorkspace, CustomerMember].map((m: any) => m.deleteMany({})));
    await promote((await onboarding({ formPayload: form }))._id, { personName: "" });
    expect((await login()).name).toBeUndefined();

    await Promise.all([Customer, User, CustomerWorkspace, CustomerMember].map((m: any) => m.deleteMany({})));
    await promote((await onboarding({ formPayload: form }))._id, { personName: "Peachmint Foods Private Limited" });
    expect((await login()).name).toBeUndefined();
  });

  it("re-promoting an existing login keeps its name (no cleanup here)", async () => {
    const ob = await onboarding({ formPayload: bizForm({ keyContacts: [{ name: "Ravi Menon", email: EMAIL }] }) });
    expect((await promote(ob._id)).status).toBe(200);
    expect((await promote(ob._id, { personName: "Someone Else" })).status).toBe(200);
    expect((await login()).name).toBe("Ravi Menon");
  });

  it("GET /:id/login-person returns the same suggestion the promote would use", async () => {
    const ob = await onboarding({
      formPayload: bizForm({ keyContacts: [{ name: "Ravi Menon", email: "x@y.test" }, { name: "Asha Rao", email: EMAIL }] }),
    });
    const res = await get(`/api/master-data/${ob._id}/login-person`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: EMAIL, personName: "Asha Rao", source: "keyContactEmail" });

    const none = await onboarding({ formPayload: bizForm(), inviteeName: LEGAL });
    expect((await get(`/api/master-data/${none._id}/login-person`)).body).toMatchObject({ personName: "", source: "none" });
  });
});

describe("promote-vendor: the login is the contact person", () => {
  const vendorOb = (form: Record<string, any>, extra: Record<string, any> = {}) =>
    onboarding({ type: "vendor", email: "desk@acmetravels.test", formPayload: { companyName: "Acme Travels LLP", ...form }, ...extra });

  it("contactPerson.name → first / last / name; dialog value wins", async () => {
    const ob = await vendorOb({ contactPerson: { name: "Kiran Mehta" } });
    const res = await post(`/api/master-data/${ob._id}/promote-vendor`, {});
    expect(res.status).toBe(200);
    const u = await login("desk@acmetravels.test");
    expect([u.firstName, u.lastName, u.name]).toEqual(["Kiran", "Mehta", "Kiran Mehta"]);
    expect(welcome().html).toContain("Welcome to Plumbox, Kiran!");
  });

  it("no contact person and the invitee is the company → unnamed login", async () => {
    const ob = await vendorOb({}, { inviteeName: "Acme Travels" });
    expect((await post(`/api/master-data/${ob._id}/promote-vendor`, {})).status).toBe(200);
    expect((await login("desk@acmetravels.test")).name).toBeUndefined();
  });
});
