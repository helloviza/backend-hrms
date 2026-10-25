// apps/backend/src/routes/public.partnerTrack.test.ts
//
// Student "Track my case" on a partner link:
//   - request-code answers the same for every email; a code is emailed only
//     when this link's partner has a case for that email (case-insensitive);
//     codes and emails are stored hashed;
//   - verify: right code → track token; 5 wrong → locked; expired / used /
//     superseded codes refused;
//   - cases: only this student's cases with this partner — not another
//     student's, not another partner's (a token from partner A reads nothing
//     on partner B's link); nothing priced, no contact details, at any depth;
//   - the track token is not a login token; limits: 3 codes / email / hour,
//     per-IP limiters; bad link → 404; no Turnstile → 400.
//
// Real: the public track router + service, models, email outbox, in-memory
// Mongo, raw-insert cases. Stubbed: mail transport, Turnstile siteverify.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
for (const [k, v] of Object.entries({
  MONGO_URI: "mongodb://127.0.0.1:1/unused",
  JWT_SECRET: "jwt-secret-for-tests",
  JWT_REFRESH_SECRET: "refresh-secret-for-tests",
  FRONTEND_ORIGIN: "http://localhost:5173",
  AWS_REGION: "ap-south-1",
  S3_BUCKET: "test-bucket",
  GEMINI_API_KEY: "test",
})) process.env[k] ||= v;
process.env.TURNSTILE_SECRET = "turnstile-test-secret";

const { mails } = vi.hoisted(() => ({ mails: [] as any[] }));
vi.mock("../utils/mailer.js", () => ({
  sendMail: async (m: any) => {
    mails.push(m);
    return { messageId: "test" };
  },
}));
vi.stubGlobal("fetch", async (_url: any, init: any) => {
  const token = new URLSearchParams(String(init?.body || "")).get("response");
  return { ok: true, json: async () => ({ success: token === "ok" }) } as any;
});

const { default: trackRouter, REQUEST_CODE_ANSWER } = await import("./public.partnerTrack.js");
const { partnerTrackRequestLimiter, partnerTrackVerifyLimiter, partnerTrackCasesLimiter } = await import("../middleware/rateLimit.js");
const { verifyToken } = await import("../utils/jwt.js");
const { isPriceKey } = await import("./approvals.security.js");
const { emailHash } = await import("../services/partnerTrackHash.js");
const { migratePartnerLeadIndexes } = await import("../scripts/migrate-partner-lead-indexes.js");

const app = express();
app.use(express.json());
app.use("/api/public", trackRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const AMBER = oid(), AMBER_CUST = oid();
const UNI = oid(), UNI_CUST = oid();
const AMB = "AmbR2026";
const UNIL = "UniLiv01";
let RIYA_AMBER: any, RIYA_AMBER_2: any, ARJUN_AMBER: any, RIYA_UNI: any;

const t = (min: number) => new Date(Date.UTC(2026, 9, 20, 9, min));
function partnerCase(ws: any, cust: any, caseNumber: string, email: string, name: string) {
  return {
    _id: oid(), workspaceId: ws, customerId: String(cust), ticketId: caseNumber, customerName: "X",
    frontlinerId: "intake", frontlinerEmail: "system-partner-intake@plumtrips.com", managerEmail: "system-partner-intake@plumtrips.com",
    status: "approved", adminState: "assigned", stage: "REQUEST_APPROVED", bookingAmount: 5600, actualBookingPrice: 4800,
    cartItems: [{ type: "flight", price: 5600, meta: { origin: "BLR", destination: "DEL", tripType: "oneway", departDate: "2027-04-02", travelScope: "domestic", travellers: [{ kind: "manual", firstName: name, lastName: "X", phone: "9876543210", email }] } }],
    meta: { source: "PARTNER_LINK", travelFlow: "APPROVAL_DIRECT", adminAssigned: { agentName: "Rita Menon", agentEmail: "rita@plumtrips.com" }, partnerLead: { caseNumber, contact: { name, email, phone: "9876543210" }, ipHash: "f".repeat(64) } },
    history: [
      { action: "submitted", at: t(0), by: "s", actorKind: "system" },
      { action: "approved", at: t(0), by: "s", actorKind: "system" },
      { action: "admin_auto_assigned", at: t(1), by: "s", assigneeName: "Rita Menon", assigneeEmail: "rita@plumtrips.com", staffNote: "internal" },
    ],
    createdAt: t(0),
  };
}

const ask = (email: string, over: any = {}) => request(app).post("/api/public/partner-track/request-code").send({ code: AMB, email, turnstileToken: "ok", ...over });
const lastCode = () => {
  const m = mails[mails.length - 1];
  return String(m?.subject || "").match(/(\d{6})/)?.[1] || "";
};
const verify = (email: string, otp: string, code = AMB) => request(app).post("/api/public/partner-track/verify").send({ code, email, otp });
const cases = (token: string, code = AMB) => request(app).get(`/api/public/partner-track/cases?code=${code}`).set("X-Partner-Track-Token", token);
async function tokenFor(email: string, code = AMB) {
  await ask(email, { code });
  const r = await verify(email, lastCode(), code);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.token as string;
}

async function resetLimiters() {
  for (const key of ["::ffff:127.0.0.1", "127.0.0.1", "::1"]) {
    for (const l of [partnerTrackRequestLimiter, partnerTrackVerifyLimiter, partnerTrackCasesLimiter]) await (l as any).resetKey?.(key);
  }
}
function keysDeep(v: any, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.push(k), keysDeep(x, out));
  return out;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("public-partner-track-test"));
}, 120_000);
afterAll(async () => {
  vi.unstubAllGlobals();
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  mails.length = 0;
  await resetLimiters();
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertMany([
    { _id: AMBER, customerId: String(AMBER_CUST), companyName: "Amber Student", status: "ACTIVE" },
    { _id: UNI, customerId: String(UNI_CUST), companyName: "University Living", status: "ACTIVE" },
  ] as any[]);
  await col("partnerlinks").insertMany([
    { code: AMB, workspaceId: AMBER, customerId: String(AMBER_CUST), label: "a", services: ["flight"], active: true },
    { code: UNIL, workspaceId: UNI, customerId: String(UNI_CUST), label: "u", services: ["flight"], active: true },
  ] as any[]);
  const rows = [
    (RIYA_AMBER = partnerCase(AMBER, AMBER_CUST, "PL-AAAAA2", "riya@student.test", "Riya")),
    (RIYA_AMBER_2 = partnerCase(AMBER, AMBER_CUST, "PL-AAAAA3", "riya@student.test", "Riya")),
    (ARJUN_AMBER = partnerCase(AMBER, AMBER_CUST, "PL-AAAAA4", "arjun@student.test", "Arjun")),
    (RIYA_UNI = partnerCase(UNI, UNI_CUST, "PL-UUUUU2", "riya@student.test", "Riya")),
  ];
  await col("approvalrequests").insertMany(rows as any[]);
  await col("manualbookings").insertOne({
    workspaceId: AMBER_CUST, source: "ADMIN_QUEUE", sourceBookingId: RIYA_AMBER._id, bookingRef: "MB-1", type: "FLIGHT", status: "PENDING", subStatus: "Lead Not Contactable",
    isActive: true, updatedAt: t(5), supplierName: "IndiGo", supplierPNR: "PNR123", notes: "net fare", pricing: { actualPrice: 4800, quotedPrice: 5600, grandTotal: 5600 },
    partnerShare: { share: 200 }, passengers: [{ name: "Riya", passportNo: "Z1234567" }], attachments: [{ type: "ticket", originalFilename: "t.pdf", s3Key: "k/t.pdf" }],
  } as any);
});

describe("request a code", () => {
  it("an unknown email gets the same answer, and nothing is sent or stored", async () => {
    const r = await ask("nobody@student.test");
    expect([r.status, r.body]).toEqual([200, REQUEST_CODE_ANSWER]);
    expect(mails).toHaveLength(0);
    expect(await col("partnertrackotps").countDocuments({})).toBe(0);
  });

  it("an email with cases only under ANOTHER partner gets nothing either", async () => {
    await col("approvalrequests").deleteMany({ workspaceId: AMBER });
    const r = await ask("riya@student.test");
    expect(r.body).toEqual(REQUEST_CODE_ANSWER);
    expect(mails).toHaveLength(0);
  });

  it("a known email (any case) gets the same answer and one code email; only hashes are stored", async () => {
    const r = await ask("  Riya@Student.TEST ");
    expect([r.status, r.body]).toEqual([200, REQUEST_CODE_ANSWER]);
    expect(mails).toHaveLength(1);
    expect([mails[0].to].flat()).toEqual(["riya@student.test"]);
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);
    const html = String(mails[0].html);
    for (const bad of ["₹", "INR", "5600", "href=\"http", "/login", "PL-AAAAA"]) expect(html, bad).not.toContain(bad);
    const row: any = await col("partnertrackotps").findOne({});
    expect(JSON.stringify(row)).not.toContain("riya");
    expect(JSON.stringify(row)).not.toContain(code);
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it("at most 3 codes per email per hour; the answer never changes", async () => {
    for (let i = 0; i < 4; i++) expect((await ask("riya@student.test")).body).toEqual(REQUEST_CODE_ANSWER);
    expect(mails).toHaveLength(3);
  });

  it("per-IP limiter, bad link, missing Turnstile, invalid email", async () => {
    await resetLimiters();
    expect((await ask("x@student.test", { code: "Zz9Zz9Zz" })).status).toBe(404);
    expect((await ask("x@student.test", { turnstileToken: undefined })).status).toBe(400);
    expect((await ask("not-an-email")).status).toBe(400);
    await resetLimiters();
    for (let i = 0; i < 5; i++) await ask(`n${i}@student.test`);
    expect((await ask("n6@student.test")).status).toBe(429);
  });
});

describe("verify", () => {
  it("the right code gives a track token, once", async () => {
    await ask("riya@student.test");
    const code = lastCode();
    const ok = await verify("riya@student.test", code);
    expect(ok.status).toBe(200);
    expect(typeof ok.body.token).toBe("string");
    const again = await verify("riya@student.test", code);
    expect([again.status, again.body.code]).toEqual([400, "INVALID_CODE"]);
  });

  it("5 wrong tries lock the code; the right one then fails too", async () => {
    await ask("riya@student.test");
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) codes.push((await verify("riya@student.test", wrong)).body.code);
    expect(codes).toEqual(["INVALID_CODE", "INVALID_CODE", "INVALID_CODE", "INVALID_CODE", "LOCKED"]);
    const right = await verify("riya@student.test", code);
    expect([right.status, right.body.code]).toEqual([400, "LOCKED"]);
  });

  it("an expired code, or one replaced by a newer code, is refused", async () => {
    await ask("riya@student.test");
    const first = lastCode();
    await col("partnertrackotps").updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await verify("riya@student.test", first)).body.code).toBe("INVALID_CODE");
    await ask("riya@student.test");
    const second = lastCode();
    await ask("riya@student.test");
    const third = lastCode();
    if (second !== third) expect((await verify("riya@student.test", second)).body.code).toBe("INVALID_CODE");
    expect((await verify("riya@student.test", third)).status).toBe(200);
  });

  it("per-IP limiter: the 11th verify in 15 minutes is 429", async () => {
    for (let i = 0; i < 10; i++) expect((await verify("ghost@student.test", "123456")).status).toBe(400);
    expect((await verify("ghost@student.test", "123456")).status).toBe(429);
  });

  it("the code is for this partner's link only", async () => {
    await ask("riya@student.test");
    const r = await verify("riya@student.test", lastCode(), UNIL);
    expect([r.status, r.body.code]).toEqual([400, "INVALID_CODE"]);
  });
});

describe("the student's cases", () => {
  it("only this student's cases with this partner, from the allowlist", async () => {
    const token = await tokenFor("riya@student.test");
    const r = await cases(token);
    expect(r.status).toBe(200);
    expect(r.body.cases.map((c: any) => c.caseNumber).sort()).toEqual(["PL-AAAAA2", "PL-AAAAA3"]);
    const one = r.body.cases.find((c: any) => c.caseNumber === "PL-AAAAA2");
    expect(one.currentStep).toMatchObject({ label: "Pending", subStatus: "Lead Not Contactable" });
    expect(one.rmName).toBe("Rita Menon");
    expect(one.documents).toEqual([{ service: "Flight", ticketIssued: true, voucherIssued: false, documentIssued: false }]);
    const keys = keysDeep(r.body);
    const FORBIDDEN = ["contact", "phone", "email", "notes", "staffNote", "supplierName", "supplierPNR", "partnerShare", "pricing", "passengers", "travellers", "ipHash", "contactEmailHash", "s3Key", "_id", "workspaceId", "customerId", "adminAssigned"];
    expect(keys.filter((k) => FORBIDDEN.includes(k))).toEqual([]);
    expect(keys.filter(isPriceKey)).toEqual([]);
    const text = JSON.stringify(r.body);
    for (const bad of ["@", "9876543210", "4800", "5600", "IndiGo", "PNR123", "Z1234567", "internal", "PL-AAAAA4", "PL-UUUUU2"]) expect(text, bad).not.toContain(bad);
  });

  it("a token from partner A reads nothing on partner B's link; a forged or missing token reads nothing", async () => {
    const amberToken = await tokenFor("riya@student.test");
    expect((await cases(amberToken, UNIL)).status).toBe(401);
    expect((await cases(amberToken.slice(0, -2) + "xx")).status).toBe(401);
    expect((await cases("")).status).toBe(401);
    const uniToken = await tokenFor("riya@student.test", UNIL);
    expect((await cases(uniToken, UNIL)).body.cases.map((c: any) => c.caseNumber)).toEqual(["PL-UUUUU2"]);
  });

  it("another student's token never returns these cases", async () => {
    const token = await tokenFor("arjun@student.test");
    expect((await cases(token)).body.cases.map((c: any) => c.caseNumber)).toEqual(["PL-AAAAA4"]);
  });

  it("cases with the stored hash are found by it; an old case without it is found by the fallback", async () => {
    // RIYA_AMBER: hash stamped, stored email different, so only the hash can match it.
    // RIYA_AMBER_2: no hash (pre-field case), found by hashing its stored email.
    await col("approvalrequests").updateOne(
      { _id: RIYA_AMBER._id },
      { $set: { "meta.partnerLead.contactEmailHash": emailHash("riya@student.test"), "meta.partnerLead.contact.email": "renamed@student.test" } },
    );
    // A hashed case of another student, with Riya's address left in contact: the hash wins, it is not Riya's.
    await col("approvalrequests").updateOne({ _id: ARJUN_AMBER._id }, { $set: { "meta.partnerLead.contactEmailHash": emailHash("arjun@student.test"), "meta.partnerLead.contact.email": "riya@student.test" } });
    const token = await tokenFor("riya@student.test");
    expect((await cases(token)).body.cases.map((c: any) => c.caseNumber).sort()).toEqual(["PL-AAAAA2", "PL-AAAAA3"]);
  });

  it("the hash lookup runs on the partner_lead_contact_email_hash index", async () => {
    await migratePartnerLeadIndexes({ expectDb: mongoose.connection.name, apply: true, log: () => {} });
    const plan: any = await col("approvalrequests")
      .find({ workspaceId: AMBER, customerId: String(AMBER_CUST), "meta.source": "PARTNER_LINK", "meta.partnerLead.contactEmailHash": emailHash("riya@student.test") })
      .explain("queryPlanner");
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain("partner_lead_contact_email_hash");
  });

  it("the track token is not a login token", async () => {
    const token = await tokenFor("riya@student.test");
    expect(() => verifyToken(token)).toThrow();
  });
});
