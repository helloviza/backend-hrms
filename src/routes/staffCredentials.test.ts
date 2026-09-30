// Staff / employee credentials emails, over real HTTP against a real
// mongodb-memory-server, mounting the real employees + users routers.
//
// Guards: no shared default password ("Welcome@123"), no password or BCC in
// any credentials email, a working 72h set-password link, and the team's
// onboarding-visibility copy being a separate notice with no link, token or
// password in it.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { createHash } from "crypto";

const SECRET = "staff-credentials-test-secret";
process.env.JWT_SECRET = SECRET;
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/staff-credentials-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

vi.mock("../utils/mailer.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  sendMail: vi.fn(async () => ({ messageId: "test" })),
}));

const { default: User } = await import("../models/User.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: employeesRouter } = await import("./employees.js");
const { default: usersRouter } = await import("./users.js");
const { sendRejectionEmail } = await import("../utils/credentialsEmail.js");
const { ONBOARDING_NOTIFY_ADDRESS: NOTIFY } = await import("../utils/onboardingNotice.js");
const { sendMail } = await import("../utils/mailer.js");
const mail = sendMail as unknown as ReturnType<typeof vi.fn>;

let mongod: MongoMemoryServer;

const WS = new mongoose.Types.ObjectId();
const ADMIN_ID = new mongoose.Types.ObjectId();
const TOKEN = jwt.sign(
  { sub: String(ADMIN_ID), id: String(ADMIN_ID), email: "admin@plumtrips.com", roles: ["SUPERADMIN"] },
  SECRET,
  { expiresIn: "1h" },
);

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/employees", employeesRouter);
  a.use("/api/users", usersRouter);
  a.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: String(err?.message || err) }));
  return a;
}

const post = (path: string, body: any = {}) =>
  request(app()).post(path).set("Authorization", `Bearer ${TOKEN}`).set("x-workspace-id", String(WS)).send(body);

const callsTo = (addr: string) => mail.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.to === addr);

/** The email to the employee: link, no password, no BCC, token bound to the right login. */
async function expectSetPasswordEmail(to: string, loginEmail: string) {
  const [sent] = callsTo(to);
  expect(sent).toBeTruthy();
  const html = String(sent.html);
  expect(html).not.toMatch(/Temporary Password/i);
  expect(html).not.toContain("Welcome@123");
  expect(sent.bcc).toBeUndefined();
  const token = html.match(/\/reset-password\?token=([0-9a-f]{64})/)?.[1];
  expect(token).toBeTruthy();
  const login: any = await User.findOne({
    resetTokenHash: createHash("sha256").update(String(token)).digest("hex"),
  }).lean();
  expect(login?.email).toBe(loginEmail);
  const hoursLeft = (new Date(login.resetTokenExpiry).getTime() - Date.now()) / 3_600_000;
  expect(hoursLeft).toBeGreaterThan(71);
  expect(hoursLeft).toBeLessThanOrEqual(72);
  return login;
}

/** The team copy: a separate notice naming type/recipient/company, carrying nothing usable. */
function expectLinkFreeNotice(recipient: string, company: string) {
  const [notice] = callsTo(NOTIFY);
  expect(notice).toBeTruthy();
  const text = `${notice.subject}\n${notice.html}`;
  expect(text).toContain(recipient);
  expect(text).toContain(company);
  expect(text).not.toMatch(/https?:\/\//i);
  expect(text).not.toMatch(/token|reset-password|password/i);
  expect(text).not.toMatch(/[0-9a-f]{32,}/);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await User.init();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  mail.mockClear();
  mail.mockImplementation(async () => ({ messageId: "test" }));
  await Promise.all([User.deleteMany({}), CustomerWorkspace.deleteMany({})]);
  await CustomerWorkspace.collection.insertOne({ _id: WS, customerId: String(WS), companyName: "Acme Test Co", status: "ACTIVE" });
});

describe("POST /api/employees (new employee)", () => {
  it("emails a 72h set-password link, never a password, and sends a link-free notice", async () => {
    const res = await post("/api/employees", { officialEmail: "new.hire@acme.test", name: "New Hire" });
    expect(res.status).toBe(201);

    const login = await expectSetPasswordEmail("new.hire@acme.test", "new.hire@acme.test");
    const stored: any = await User.findById(login._id).select("passwordHash").lean();
    expect(await bcrypt.compare("Welcome@123", stored.passwordHash)).toBe(false);

    expectLinkFreeNotice("new.hire@acme.test", "Acme Test Co");
  });

  it("a failing notice never blocks the employee's email or the create", async () => {
    mail.mockImplementation(async (m: any) => {
      if (m?.to === NOTIFY) throw new Error("notice smtp down");
      return { messageId: "test" };
    });
    const res = await post("/api/employees", { officialEmail: "second.hire@acme.test", name: "Second Hire" });
    expect(res.status).toBe(201);
    await expectSetPasswordEmail("second.hire@acme.test", "second.hire@acme.test");
  });
});

describe("POST /api/users/admin/grant-access", () => {
  it("ignores any password in the body and emails a set-password link instead", async () => {
    const pending: any = await User.create({
      email: "pending@acme.test",
      name: "Pending Person",
      workspaceId: WS,
      passwordHash: await bcrypt.hash("irrelevant", 4),
      roles: ["EMPLOYEE"],
      tempPassword: true,
    });

    const res = await post("/api/users/admin/grant-access", {
      userId: String(pending._id),
      role: "EMPLOYEE",
      password: "AdminTyped123",
    });
    expect(res.status).toBe(200);

    // The credentials email is fire-and-forget after the response.
    await vi.waitFor(() => expect(callsTo(NOTIFY).length).toBe(1), { timeout: 5000 });
    const login = await expectSetPasswordEmail("pending@acme.test", "pending@acme.test");
    const stored: any = await User.findById(login._id).select("passwordHash").lean();
    expect(await bcrypt.compare("AdminTyped123", stored.passwordHash)).toBe(false);

    expectLinkFreeNotice("pending@acme.test", "Acme Test Co");
  });
});

describe("sendRejectionEmail", () => {
  it("has no credentials, so the team copy is a plain BCC to the onboarding-visibility inbox", async () => {
    await sendRejectionEmail({ to: "applicant@acme.test", name: "Applicant" });
    const [sent] = callsTo("applicant@acme.test");
    expect(NOTIFY).toBe("salescynosurechannel@gmail.com");
    expect(sent.bcc).toBe(NOTIFY);
    expect(String(sent.html)).not.toMatch(/password|reset-password|https?:\/\//i);
  });
});
