// Onboarding → promote, over real HTTP against a real mongodb-memory-server,
// mounting the real masterData + onboarding routers (never server.ts).
//
// The regression these guard: ABC Cleantech, 2026-09-29. A contact was
// re-invited under the same email. Opening the EXPIRED first invite's details
// page had created a stub Customer; the promote of the second (approved)
// onboarding matched that stub by email, copied the company onto it, and the
// save hit E11000 on legalNameNormalized_unique against the second
// onboarding's own stub — surfacing raw Mongo text in the dialog.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const SECRET = "masterdata-promote-test-secret";
process.env.JWT_SECRET = SECRET;
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/masterdata-promote-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

// No SMTP in tests — every welcome/credentials email goes through sendMail.
vi.mock("../utils/mailer.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  sendMail: vi.fn(async () => ({ messageId: "test" })),
}));

const { default: Customer } = await import("../models/Customer.js");
const { default: User } = await import("../models/User.js");
const { default: Employee } = await import("../models/Employee.js");
const { default: Onboarding } = await import("../models/Onboarding.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: CustomerMember } = await import("../models/CustomerMember.js");
const { default: masterDataRouter } = await import("./masterData.js");
const { default: onboardingRouter } = await import("./onboarding.js");
const { syncCustomerFromOnboarding } = await import("../services/syncCustomerFromOnboarding.js");
const { sendMail } = await import("../utils/mailer.js");
const mail = sendMail as unknown as ReturnType<typeof vi.fn>;
const subjects = () => mail.mock.calls.map((c: any[]) => String(c[0]?.subject || ""));
const ACCESS_ACTIVATED = "Welcome to Plumtrips — Access Activated";
const CLIENT_CREDENTIALS = "Welcome to Plumbox — Your Account is Ready";
const EMPLOYEE_WELCOME = "Welcome to the Team — Your HRMS Access is Ready";

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
  a.use("/api/onboarding", onboardingRouter);
  // The real global handler echoes err.message — exactly how raw E11000
  // text used to reach the dialog. Mirror it so a leak would show here.
  a.use((err: any, _req: any, res: any, _next: any) =>
    res.status(500).json({ error: String(err?.message || err) }),
  );
  return a;
}

const post = (path: string, body: any = {}) =>
  request(app())
    .post(path)
    .set("Authorization", `Bearer ${TOKEN}`)
    .set("x-workspace-id", String(HOUSE_WS))
    .send(body);

const get = (path: string) =>
  request(app())
    .get(path)
    .set("Authorization", `Bearer ${TOKEN}`)
    .set("x-workspace-id", String(HOUSE_WS));

const EMAIL = "rlenka@evrenenergy.com";
const LEGAL = "ABC CLEANTECH PRIVATE LIMITED";
let tokenSeq = 0;

async function onboarding(fields: Record<string, any>) {
  return Onboarding.create({
    workspaceId: HOUSE_WS,
    type: "business",
    email: EMAIL,
    token: `tok-${++tokenSeq}`,
    expiresAt: new Date(Date.now() + 86400_000),
    source: "invite",
    ...fields,
  } as any);
}

const bizForm = (legalName = LEGAL) => ({
  legalName,
  officialEmail: EMAIL,
  gstNumber: "27AAWCA7112J1ZA",
  panNumber: "AAWCA7112J",
  keyContacts: [{ name: "Ranjeet Kumar Lenka", email: EMAIL }],
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  // Not declared on the schema — prod's copy was built by the
  // merge-duplicate-customers migration. Without it no test could collide.
  await Customer.collection.createIndex(
    { legalNameNormalized: 1 },
    { unique: true, sparse: true, name: "legalNameNormalized_unique" },
  );
  await Promise.all([Customer.init(), User.init(), Employee.init(), CustomerMember.init()]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  mail.mockClear();
  await Promise.all(
    [Customer, User, Employee, Onboarding, CustomerWorkspace, CustomerMember].map((m: any) =>
      m.deleteMany({}),
    ),
  );
});

describe("viewing an onboarding is read-only (FIX 1)", () => {
  it("opening an unsubmitted business invite creates no Customer", async () => {
    const ob = await onboarding({ status: "sent", inviteeName: "Ranjeet Lenka" });
    const res = await get(`/api/onboarding/${ob._id}/details`);
    expect(res.status).toBe(200);
    expect(await Customer.countDocuments()).toBe(0);
  });

  it("opening an expired or approved invite creates no Customer either", async () => {
    const expired = await onboarding({ status: "expired" });
    const approved = await onboarding({ status: "approved", formPayload: bizForm() });
    expect((await get(`/api/onboarding/${expired._id}/details`)).status).toBe(200);
    expect((await get(`/api/onboarding/${approved._id}/details`)).status).toBe(200);
    expect(await Customer.countDocuments()).toBe(0);
  });

  it("opening an employee invite creates no login", async () => {
    const ob = await onboarding({ type: "employee", email: "new.hire@gmail.com", status: "sent" });
    expect((await get(`/api/onboarding/${ob._id}/details`)).status).toBe(200);
    expect(await User.countDocuments()).toBe(0);
  });

  it("the stub sync ignores unsubmitted invites but still runs on a submitted one", async () => {
    await syncCustomerFromOnboarding(await onboarding({ status: "sent" }));
    await syncCustomerFromOnboarding(await onboarding({ status: "expired" }));
    expect(await Customer.countDocuments()).toBe(0);

    await syncCustomerFromOnboarding(await onboarding({ status: "submitted", formPayload: bizForm() }));
    expect(await Customer.countDocuments({ legalName: LEGAL })).toBe(1);
  });

  it("a submitted company that already exists as a customer does not throw at submit", async () => {
    await Customer.create({ name: LEGAL, legalName: LEGAL, email: "someone@else.com" });
    const ob = await onboarding({ status: "submitted", formPayload: bizForm() });
    await expect(syncCustomerFromOnboarding(ob)).resolves.toBeUndefined();
    expect(await Customer.countDocuments()).toBe(1);
  });
});

describe("promote-customer: re-invited contact (FIX 2)", () => {
  async function reinviteScenario() {
    // First invite: expired, never submitted — its junk stub (the old
    // details-page behaviour) carries only the contact's name + email.
    const oldOb = await onboarding({ status: "expired", inviteeName: "Ranjeet Lenka" });
    const oldStub = await Customer.create({ name: "Ranjeet Lenka", legalName: "", email: EMAIL, onboardingId: oldOb._id });
    // Second invite: submitted + approved, with its own stub from submit.
    const ob = await onboarding({ status: "approved", inviteeName: "Ranjeet Kumar", formPayload: bizForm() });
    await syncCustomerFromOnboarding(ob);
    const stub = await Customer.findOne({ onboardingId: ob._id }).lean();
    return { oldOb, oldStub, ob, stub: stub! };
  }

  it("promotes the stub of THIS onboarding and leaves the other onboarding's stub alone", async () => {
    const { oldStub, ob, stub } = await reinviteScenario();

    const res = await post(`/api/master-data/${ob._id}/promote-customer`, { sendEmail: true });
    expect(res.status).toBe(200);
    expect(res.body.alreadyExists).toBe(true);
    expect(String(res.body.customer._id)).toBe(String(stub._id));

    const promoted: any = await Customer.findById(stub._id).lean();
    expect(promoted.customerCode).toMatch(/^B_PTS\d{5}$/);
    expect(promoted.legalNameNormalized).toBe("abc cleantech private limited");
    const ws: any = await CustomerWorkspace.findOne({ customerId: String(stub._id) }).lean();
    expect(String(promoted.workspaceId)).toBe(String(ws._id));

    const user: any = await User.findOne({ email: EMAIL }).lean();
    expect(user.role).toBe("WORKSPACE_LEADER");
    expect(String(user.workspaceId)).toBe(String(ws._id));

    // The other onboarding's stub is untouched — not renamed, not promoted.
    const old: any = await Customer.findById(oldStub._id).lean();
    expect(old.name).toBe("Ranjeet Lenka");
    expect(old.legalName).toBe("");
    expect(old.customerCode).toBeUndefined();
  });

  it("creates a new customer (not overwrite) when only another onboarding's customer shares the email", async () => {
    const oldOb = await onboarding({ status: "expired" });
    const other = await Customer.create({ name: "Ranjeet Lenka", legalName: "", email: EMAIL, onboardingId: oldOb._id });
    const ob = await onboarding({ status: "approved", formPayload: bizForm() });

    const res = await post(`/api/master-data/${ob._id}/promote-customer`, { sendEmail: false });
    expect(res.status).toBe(200);
    expect(res.body.alreadyExists).toBe(false);
    expect(String(res.body.customer._id)).not.toBe(String(other._id));
    expect(((await Customer.findById(other._id).lean()) as any).name).toBe("Ranjeet Lenka");
  });

  it("still adopts a legacy customer with no onboarding link, matched by email", async () => {
    const legacy = await Customer.create({ name: "Old record", legalName: LEGAL, email: EMAIL });
    const ob = await onboarding({ status: "approved", formPayload: bizForm() });

    const res = await post(`/api/master-data/${ob._id}/promote-customer`, { sendEmail: false });
    expect(res.status).toBe(200);
    expect(String(res.body.customer._id)).toBe(String(legacy._id));
    expect(await Customer.countDocuments()).toBe(1);
  });

  it("refuses to guess between two unlinked customers sharing the email", async () => {
    await Customer.create({ name: "One", legalName: "One Pvt Ltd", email: EMAIL });
    await Customer.create({ name: "Two", legalName: "Two Pvt Ltd", email: EMAIL });
    const ob = await onboarding({ status: "approved", formPayload: bizForm() });

    const res = await post(`/api/master-data/${ob._id}/promote-customer`, { sendEmail: false });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CUSTOMER_EMAIL_AMBIGUOUS");
    expect(res.body.customerIds).toHaveLength(2);
  });
});

describe("promote-customer: legal-name pre-check + friendly 409 (FIX 3, FIX 4)", () => {
  it("create path: catches a legalName clash the old invitee-name check missed", async () => {
    const existing = await Customer.create({
      name: "ABC Cleantech",
      legalName: "ABC  Cleantech Private Limited",
      email: "accounts@abccleantech.com",
      customerCode: "B_PTS00805",
    });
    // Invitee name "Ranjeet Kumar" normalizes to something else entirely —
    // the old check compared THAT and let create() hit E11000.
    const ob = await onboarding({ status: "approved", inviteeName: "Ranjeet Kumar", formPayload: bizForm() });

    const res = await post(`/api/master-data/${ob._id}/promote-customer`, { sendEmail: false });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CUSTOMER_NAME_EXISTS");
    expect(res.body.existingId).toBe(String(existing._id));
    expect(res.body.existingCustomerCode).toBe("B_PTS00805");
    expect(res.body.error).toMatch(/A customer named "ABC {2}Cleantech Private Limited" already exists/);
    expect(JSON.stringify(res.body)).not.toMatch(/E11000|duplicate key|legalNameNormalized_unique/);
    expect(await User.countDocuments()).toBe(0);
  });

  it("update path: the onboarding's own stub renamed onto an existing name → 409, not E11000", async () => {
    await Customer.create({ name: LEGAL, legalName: LEGAL, email: "accounts@abccleantech.com" });
    const ob = await onboarding({ status: "approved", formPayload: bizForm() });
    // Its stub predates the legal name (e.g. created before the form was filled).
    const stub = await Customer.create({ name: "Ranjeet Kumar", legalName: "", email: EMAIL, onboardingId: ob._id });

    const res = await post(`/api/master-data/${ob._id}/promote-customer`, { sendEmail: false });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CUSTOMER_NAME_EXISTS");
    expect(JSON.stringify(res.body)).not.toMatch(/E11000/);
    expect(((await Customer.findById(stub._id).lean()) as any).legalName).toBe("");
  });

  it("re-promoting the same customer does not trip over its own name", async () => {
    const ob = await onboarding({ status: "approved", formPayload: bizForm() });
    expect((await post(`/api/master-data/${ob._id}/promote-customer`, { sendEmail: false })).status).toBe(200);
    const again = await post(`/api/master-data/${ob._id}/promote-customer`, { sendEmail: false });
    expect(again.status).toBe(200);
    expect(again.body.alreadyExists).toBe(true);
    expect(await Customer.countDocuments()).toBe(1);
  });

  it("a duplicate-key race that slips past the pre-check still comes back as a clean 409", async () => {
    const ob = await onboarding({ status: "approved", formPayload: bizForm() });
    const raced = Object.assign(
      new Error('E11000 duplicate key error collection: test.customers index: legalNameNormalized_unique dup key: { legalNameNormalized: "abc cleantech private limited" }'),
      { code: 11000, keyPattern: { legalNameNormalized: 1 }, keyValue: { legalNameNormalized: "abc cleantech private limited" } },
    );
    const spy = vi.spyOn(Customer, "create").mockRejectedValueOnce(raced);
    try {
      const res = await post(`/api/master-data/${ob._id}/promote-customer`, { sendEmail: false });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("CUSTOMER_NAME_EXISTS");
      expect(JSON.stringify(res.body)).not.toMatch(/E11000|duplicate key|legalNameNormalized_unique/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("promote-customer: clean first-time customer (unchanged behaviour)", () => {
  it("creates customer, code, own workspace, leader login, member and permission", async () => {
    const ob = await onboarding({ status: "approved", inviteeName: "Ranjeet Kumar", formPayload: bizForm() });

    const res = await post(`/api/master-data/${ob._id}/promote-customer`, { sendEmail: false });
    expect(res.status).toBe(200);
    expect(res.body.alreadyExists).toBe(false);
    expect(res.body.customerCode).toBe("B_PTS00801");
    expect(res.body.tempPassword).toMatch(/^PLMX-/);

    const c: any = await Customer.findOne({ onboardingId: ob._id }).lean();
    expect(c.legalName).toBe(LEGAL);
    const ws: any = await CustomerWorkspace.findOne({ customerId: String(c._id) }).lean();
    expect(ws.companyName).toBe(LEGAL);
    expect(String(c.workspaceId)).toBe(String(ws._id));
    const user: any = await User.findOne({ email: EMAIL }).lean();
    expect(user.role).toBe("WORKSPACE_LEADER");
    const member: any = await CustomerMember.findOne({ customerId: String(c._id) }).lean();
    expect(member.role).toBe("WORKSPACE_LEADER");
  });
});

describe("promote-employee: same lookup order + graceful conflicts (FIX 5)", () => {
  const empForm = (fullName: string) => ({
    fullName,
    contact: { personalEmail: `${fullName.split(" ")[0].toLowerCase()}@gmail.com` },
    employment: { dateOfJoining: "2026-10-01" },
  });

  async function employeeOnboarding(fullName: string) {
    return onboarding({ type: "employee", status: "approved", email: `${fullName.split(" ")[0].toLowerCase()}@gmail.com`, inviteeName: fullName, formPayload: empForm(fullName) });
  }

  it("refuses an email that belongs to an employee from a different onboarding", async () => {
    const first = await employeeOnboarding("Asha Rao");
    expect((await post(`/api/master-data/${first._id}/promote-employee`, { officialEmail: "asha@plumtrips.com" })).status).toBe(200);
    const before: any = await User.findOne({ email: "asha@plumtrips.com" }).lean();

    const second = await employeeOnboarding("Ravi Menon");
    const res = await post(`/api/master-data/${second._id}/promote-employee`, { officialEmail: "asha@plumtrips.com" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("USER_FROM_OTHER_ONBOARDING");
    expect(res.body.error).toMatch(/different onboarding/);

    const after: any = await User.findById(before._id).lean();
    expect(after.name).toBe(before.name);
    expect(String(after.onboardingId)).toBe(String(first._id));
  });

  it("refuses to turn a client login into an employee", async () => {
    const client = await User.create({
      email: "shared@plumtrips.com",
      name: "Client",
      role: "WORKSPACE_LEADER",
      roles: ["WORKSPACE_LEADER"],
      passwordHash: "x",
      workspaceId: new mongoose.Types.ObjectId(),
    });
    const ob = await employeeOnboarding("Kiran Das");
    const res = await post(`/api/master-data/${ob._id}/promote-employee`, { officialEmail: "shared@plumtrips.com" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EMAIL_IN_USE");
    expect(((await User.findById(client._id).lean()) as any).role).toBe("WORKSPACE_LEADER");
  });

  it("re-promoting the same onboarding updates its own login and Employee row", async () => {
    const ob = await employeeOnboarding("Meera Iyer");
    const r1 = await post(`/api/master-data/${ob._id}/promote-employee`, { officialEmail: "meera@plumtrips.com" });
    expect(r1.status).toBe(200);
    const r2 = await post(`/api/master-data/${ob._id}/promote-employee`, { officialEmail: "meera@plumtrips.com" });
    expect(r2.status).toBe(200);
    expect(r2.body.alreadyExists).toBe(true);
    expect(await User.countDocuments({ email: "meera@plumtrips.com" })).toBe(1);
    expect(await Employee.countDocuments({ onboardingId: ob._id })).toBe(1);
  });

  it("two employees in one workspace both promote (no userId-null collision)", async () => {
    const a = await employeeOnboarding("Anil Kumar");
    const b = await employeeOnboarding("Bina Shah");
    expect((await post(`/api/master-data/${a._id}/promote-employee`, { officialEmail: "anil@plumtrips.com" })).status).toBe(200);
    expect((await post(`/api/master-data/${b._id}/promote-employee`, { officialEmail: "bina@plumtrips.com" })).status).toBe(200);
    expect(await Employee.countDocuments({ workspaceId: HOUSE_WS })).toBe(2);
  });

  it("does not overwrite another employee's HR row that shares the email", async () => {
    const otherOb = new mongoose.Types.ObjectId();
    const otherRow = await Employee.create({ workspaceId: HOUSE_WS, name: "Old Person", email: "neha@plumtrips.com", onboardingId: otherOb } as any);
    const ob = await employeeOnboarding("Neha Gupta");

    const res = await post(`/api/master-data/${ob._id}/promote-employee`, { officialEmail: "neha@plumtrips.com" });
    expect(res.status).toBe(200);
    expect(((await Employee.findById(otherRow._id).lean()) as any).name).toBe("Old Person");
    expect(await Employee.countDocuments({ onboardingId: ob._id })).toBe(1);
  });

  it("an email duplicate-key race comes back as a clean 409", async () => {
    const ob = await employeeOnboarding("Tara Singh");
    const raced = Object.assign(new Error("E11000 duplicate key error collection: test.users index: email_1 dup key"), {
      code: 11000,
      keyPattern: { email: 1 },
      keyValue: { email: "tara@plumtrips.com" },
    });
    const spy = vi.spyOn(User, "create").mockRejectedValueOnce(raced);
    try {
      const res = await post(`/api/master-data/${ob._id}/promote-employee`, { officialEmail: "tara@plumtrips.com" });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("EMAIL_IN_USE");
      expect(JSON.stringify(res.body)).not.toMatch(/E11000|email_1/);
    } finally {
      spy.mockRestore();
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Fields the routes always wrote but the strict Onboarding / Customer
 * schemas silently dropped. Each test below failed before they were declared.
 * ──────────────────────────────────────────────────────────────────────── */
describe("onboarding fields now persist", () => {
  const decide = (token: string, body: Record<string, any>) => post(`/api/onboarding/${token}/decision`, body);

  it("welcome email: approval sends it once; promote-after-approval sends no second welcome", async () => {
    const ob = await onboarding({ status: "submitted", inviteeName: "Ranjeet Kumar", formPayload: bizForm() });

    expect((await decide(ob.token as string, { action: "approved" })).status).toBe(200);
    expect(subjects()).toEqual([ACCESS_ACTIVATED]);
    expect(((await Onboarding.findById(ob._id).lean()) as any).welcomeEmailSent).toBe(true);

    mail.mockClear();
    const res = await post(`/api/master-data/${ob._id}/promote-customer`, { sendEmail: true });
    expect(res.status).toBe(200);
    // Only the new login's credentials — the welcome was approval's.
    expect(subjects()).toEqual([CLIENT_CREDENTIALS]);

    mail.mockClear();
    expect((await post(`/api/master-data/${ob._id}/promote-customer`, { sendEmail: true })).status).toBe(200);
    expect(subjects()).toEqual([]);
  });

  it("re-approving does not re-send the welcome", async () => {
    const ob = await onboarding({ status: "submitted", formPayload: bizForm() });
    await decide(ob.token as string, { action: "approved" });
    await decide(ob.token as string, { action: "approved" });
    expect(subjects().filter((s) => s === ACCESS_ACTIVATED)).toHaveLength(1);
  });

  it("promote still sends the welcome when approval never did, then never again", async () => {
    const ob = await onboarding({ status: "approved", formPayload: bizForm() }); // no welcomeEmailSent
    expect((await post(`/api/master-data/${ob._id}/promote-customer`, { sendEmail: true })).status).toBe(200);
    expect(subjects().sort()).toEqual([ACCESS_ACTIVATED, CLIENT_CREDENTIALS].sort());

    mail.mockClear();
    await post(`/api/master-data/${ob._id}/promote-customer`, { sendEmail: true });
    expect(subjects()).toEqual([]);
  });

  it("a new employee login still gets its temp-password email after approval sent the welcome", async () => {
    const ob = await onboarding({
      type: "employee",
      status: "approved",
      email: "dev.new@gmail.com",
      inviteeName: "Dev New",
      welcomeEmailSent: true,
      formPayload: { fullName: "Dev New", employment: { dateOfJoining: "2026-10-01" } },
    });
    const res = await post(`/api/master-data/${ob._id}/promote-employee`, { officialEmail: "dev@plumtrips.com" });
    expect(res.status).toBe(200);
    expect(subjects()).toHaveLength(1);
    expect(subjects()[0].startsWith(EMPLOYEE_WELCOME)).toBe(true);
    expect(String(mail.mock.calls[0][0].html)).toMatch(/Temporary Password/);
  });

  it("an existing employee login gets no second welcome once approval sent one", async () => {
    const ob = await onboarding({
      type: "employee",
      status: "approved",
      email: "old.hand@gmail.com",
      welcomeEmailSent: true,
      formPayload: { fullName: "Old Hand" },
    });
    expect((await post(`/api/master-data/${ob._id}/promote-employee`, { officialEmail: "oldhand@plumtrips.com" })).status).toBe(200);
    mail.mockClear();
    expect((await post(`/api/master-data/${ob._id}/promote-employee`, { officialEmail: "oldhand@plumtrips.com" })).status).toBe(200);
    expect(subjects()).toEqual([]);
  });

  it("display name: the submitted company name persists and becomes the customer's name", async () => {
    const ob = await onboarding({ status: "sent", inviteeName: "Ranjeet Kumar" });
    const submit = await request(app())
      .post(`/api/onboarding/submit/${ob.token}`)
      .send({ core: bizForm() });
    expect(submit.status).toBe(200);
    expect(((await Onboarding.findById(ob._id).lean()) as any).name).toBe(LEGAL);

    await decide(ob.token as string, { action: "approved" });
    const res = await post(`/api/master-data/${ob._id}/promote-customer`, { sendEmail: false });
    expect(res.status).toBe(200);
    const c: any = await Customer.findOne({ onboardingId: ob._id }).lean();
    expect(c.name).toBe(LEGAL);
    expect(c.legalName).toBe(LEGAL);
  });

  it("display name: an onboarding submitted before `name` persisted still gets the company, not the contact", async () => {
    // Exactly ABC Cleantech's shape: no onboarding.name, legal name only in the form.
    const ob = await onboarding({ status: "approved", inviteeName: "Ranjeet Kumar", formPayload: bizForm() });
    await syncCustomerFromOnboarding(ob);
    const res = await post(`/api/master-data/${ob._id}/promote-customer`, { sendEmail: false });
    expect(res.status).toBe(200);
    expect(((await Customer.findOne({ onboardingId: ob._id }).lean()) as any).name).toBe(LEGAL);
  });

  it("remarks persist on approve and reject and come back on the details view", async () => {
    const a = await onboarding({ status: "submitted", formPayload: bizForm() });
    const r = await onboarding({ status: "submitted", formPayload: bizForm("Other Co Pvt Ltd") });
    await decide(a.token as string, { action: "approved", remarks: "KYC verified" });
    await decide(r.token as string, { action: "rejected", remarks: "GST certificate unreadable" });

    expect(((await Onboarding.findById(a._id).lean()) as any).remarks).toBe("KYC verified");
    expect(((await Onboarding.findById(r._id).lean()) as any).remarks).toBe("GST certificate unreadable");
    expect((await get(`/api/onboarding/${r._id}/details`)).body.remarks).toBe("GST certificate unreadable");
  });

  it("promote links persist: onboarding → customer + code + login, customer → login", async () => {
    const ob = await onboarding({ status: "approved", formPayload: bizForm() });
    const res = await post(`/api/master-data/${ob._id}/promote-customer`, { sendEmail: false });
    const o: any = await Onboarding.findById(ob._id).lean();
    const c: any = await Customer.findById(res.body.customer._id).lean();
    const u: any = await User.findOne({ email: EMAIL }).lean();
    expect(String(o.linkedCustomerId)).toBe(String(c._id));
    expect(o.customerCode).toBe(res.body.customerCode);
    expect(String(c.linkedUserId)).toBe(String(u._id));
  });

  it("Master Data active/inactive: toggle persists; legacy rows without the flag count as active", async () => {
    const legacy = await onboarding({ status: "approved", formPayload: bizForm() });
    const toggled = await onboarding({ status: "approved", formPayload: bizForm("Toggle Co Pvt Ltd") });

    const t = await request(app())
      .patch(`/api/master-data/${toggled._id}/status`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("x-workspace-id", String(HOUSE_WS))
      .send({ status: "Inactive" });
    expect(t.status).toBe(200);
    expect(((await Onboarding.findById(toggled._id).lean()) as any).isActive).toBe(false);

    const ids = async (status: string) =>
      (await get(`/api/master-data?status=${status}`)).body.items.map((i: any) => i.id);
    expect(await ids("Active")).toContain(String(legacy._id));
    expect(await ids("Active")).not.toContain(String(toggled._id));
    expect(await ids("Inactive")).toEqual([String(toggled._id)]);
  });
});
