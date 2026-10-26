// apps/backend/src/routes/public.partnerTrack.documents.test.ts
//
// Track my case: the student downloads their own ticket / voucher / document
// through a signed 5-minute link streamed by the API (rate-limited, staff
// audit row). Internal / other files, another student's or partner's file,
// expired / tampered links are refused; the partner's Student Cases stays
// status only. Harness: public.partnerTrack.test.ts's (copied).

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
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: async () => ({ bucket: "b", key: "k", url: "" }),
  getObjectBuffer: async (key: string) => Buffer.from(`BYTES:${key}`),
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


/* ═══════════════ the student's own documents: signed link, streamed ═══════════════ */
const { partnerTrackDocumentLimiter } = await import("../middleware/rateLimit.js");
const { default: partnerCasesRouter } = await import("./partner.cases.js");
const { FILE_LINK_TTL_S } = await import("../services/partnerTrack.js");
const jwtLib = (await import("jsonwebtoken")).default;

// The partner's Student Cases API on the same in-memory data (its workspace from a header).
const partnerApp = express();
partnerApp.use(async (req: any, res, next) => {
  const ws = await col("customerworkspaces").findOne({ _id: new mongoose.Types.ObjectId(String(req.headers["x-test-ws"])) });
  req.workspace = ws;
  req.workspaceObjectId = ws?._id;
  req.user = { sub: String(oid()), roles: ["WORKSPACE_LEADER"], email: "lead@amber.test" };
  next();
}, partnerCasesRouter);

const SENT = "INTERNAL-SENTINEL-supplier-invoice";
const F = { ticket: oid(), voucher: oid(), visa: oid(), internal: oid(), other: oid(), arjun: oid() };
const att = (_id: any, type: string, name: string) => ({ _id, type, originalFilename: name, s3Key: `bookings/attachments/x/${name}`, size: 10, mimeType: "application/pdf", uploadedAt: t(6) });

async function seedFiles() {
  await col("manualbookings").deleteMany({});
  await col("customerworkspaces").updateOne({ _id: AMBER }, { $set: { "config.features.partnerCasesEnabled": true } });
  await col("manualbookings").insertMany([
    { workspaceId: AMBER_CUST, source: "ADMIN_QUEUE", sourceBookingId: RIYA_AMBER._id, bookingRef: "MB-1", type: "FLIGHT", status: "CONFIRMED", isActive: true, updatedAt: t(5),
      attachments: [att(F.ticket, "ticket", "E-Ticket Riya.pdf"), att(F.internal, "internal", `${SENT}.pdf`), att(F.other, "other", "legacy-other.pdf")] },
    { workspaceId: AMBER_CUST, source: "ADMIN_QUEUE", sourceBookingId: RIYA_AMBER._id, bookingRef: "MB-2", type: "VISA", status: "CONFIRMED", isActive: true, updatedAt: t(6),
      attachments: [att(F.visa, "document", "Visa Riya.pdf")] },
    { workspaceId: AMBER_CUST, source: "ADMIN_QUEUE", sourceBookingId: ARJUN_AMBER._id, bookingRef: "MB-3", type: "HOTEL", status: "CONFIRMED", isActive: true, updatedAt: t(6),
      attachments: [att(F.arjun, "voucher", "Arjun voucher.pdf")] },
  ] as any[]);
  for (const key of ["::ffff:127.0.0.1", "127.0.0.1", "::1"]) await (partnerTrackDocumentLimiter as any).resetKey?.(key);
}
const linkFor = (token: string, caseNumber: string, fileId: any, code = AMB) =>
  request(app).post(`/api/public/partner-track/document-link?code=${code}`).set("X-Partner-Track-Token", token).send({ caseNumber, fileId: String(fileId) });
const download = (path: string) =>
  request(app).get(`/api${path}`).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });

describe("Track my case — the student downloads their own documents", () => {
  it("cases list each case's ticket / voucher / document files (never internal / other); the partner gets status only", async () => {
    await seedFiles();
    const token = await tokenFor("riya@student.test");
    const mine = (await cases(token)).body.cases.find((c: any) => c.caseNumber === "PL-AAAAA2");
    expect(mine.files).toEqual([
      { id: String(F.ticket), name: "E-Ticket Riya.pdf", type: "Ticket", service: "Flight" },
      { id: String(F.visa), name: "Visa Riya.pdf", type: "Document", service: "Visa" },
    ]);
    // Partner Student Cases: the same row, status only — no files, names or ids.
    const p = await request(partnerApp).get("/PL-AAAAA2").set("x-test-ws", String(AMBER));
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.case.files).toBeUndefined();
    expect(Object.keys(p.body.case).sort()).toEqual(["bucket", "caseNumber", "createdAt", "currentStep", "documents", "outcome", "rmName", "services", "steps", "studentName"]);
    expect(p.body.case.documents).toEqual([
      { service: "Flight", ticketIssued: true, voucherIssued: false, documentIssued: false },
      { service: "Visa", ticketIssued: false, voucherIssued: false, documentIssued: true },
    ]);
    for (const bad of ["E-Ticket Riya", "Visa Riya", String(F.ticket), SENT, String(F.internal)]) expect(JSON.stringify(p.body), bad).not.toContain(bad);
  });

  it("a signed link streams the file (attachment, no-store) and writes a staff-only audit row", async () => {
    await seedFiles();
    const token = await tokenFor("riya@student.test");
    const link = await linkFor(token, "PL-AAAAA2", F.ticket);
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    expect(link.body.path).toMatch(/^\/public\/partner-track\/document\?code=AmbR2026&t=/);
    const file = await download(link.body.path);
    expect(file.status).toBe(200);
    expect(String(file.body)).toBe("BYTES:bookings/attachments/x/E-Ticket Riya.pdf");
    expect(file.headers["content-disposition"]).toBe('attachment; filename="E-Ticket Riya.pdf"');
    expect(file.headers["cache-control"]).toBe("no-store");
    const kase: any = await col("approvalrequests").findOne({ _id: RIYA_AMBER._id });
    expect(kase.history.at(-1)).toMatchObject({ action: "student_document_downloaded", comment: "The student downloaded E-Ticket Riya.pdf (MB-1)" });
    // …which the student's own tracker never shows.
    expect(JSON.stringify((await cases(token)).body)).not.toContain("downloaded");
  });

  it("internal / other files, another student's file and an unknown id get no link", async () => {
    await seedFiles();
    const token = await tokenFor("riya@student.test");
    for (const id of [F.internal, F.other, F.arjun, oid()]) {
      const r = await linkFor(token, "PL-AAAAA2", id);
      expect([r.status, r.body.code], String(id)).toEqual([404, "FILE_NOT_FOUND"]);
    }
    expect((await linkFor(token, "PL-AAAAA4", F.arjun)).status, "Arjun's case").toBe(404);
    expect((await linkFor("", "PL-AAAAA2", F.ticket)).status, "no track token").toBe(401);
    const uniToken = await tokenFor("riya@student.test", UNIL);
    expect((await linkFor(uniToken, "PL-AAAAA2", F.ticket)).status, "another partner's token").toBe(401);
  });

  it("expired, tampered, another student's or another partner's link → refused; a file retyped to internal stops downloading", async () => {
    await seedFiles();
    const token = await tokenFor("riya@student.test");
    const { path } = (await linkFor(token, "PL-AAAAA2", F.ticket)).body;
    const t0 = decodeURIComponent(path.split("&t=")[1]);
    const swap = (tok: string) => path.replace(/&t=.*/, `&t=${encodeURIComponent(tok)}`);

    const tampered = t0.slice(0, -3) + (t0.endsWith("aaa") ? "bbb" : "aaa");
    expect((await download(swap(tampered))).status, "tampered").toBe(404);

    // Same payload, re-signed with the wrong key (a track token's), or expired.
    const payload: any = jwtLib.decode(t0);
    const { iat: _i, exp: _e, aud: _a, ...claims } = payload;
    expect((await download(swap(jwtLib.sign(claims, "not-the-key", { audience: "partner-track-file" })))).status, "wrong key").toBe(404);
    expect((await download(swap(token))).status, "a track token is not a link").toBe(404);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (FILE_LINK_TTL_S + 5) * 1000);
    expect((await download(path)).status, "expired").toBe(404);
    vi.useRealTimers();

    // Another student's link on Riya's file: the case isn't theirs.
    const arjunToken = await tokenFor("arjun@student.test");
    expect((await linkFor(arjunToken, "PL-AAAAA2", F.ticket)).status).toBe(404);
    // Riya's link opened on another partner's page.
    expect((await download(path.replace("code=AmbR2026", `code=${UNIL}`))).status).toBe(404);

    // Retyped to internal after the link was made: refused.
    await col("manualbookings").updateOne({ bookingRef: "MB-1", "attachments._id": F.ticket }, { $set: { "attachments.$.type": "internal" } });
    expect((await download(path)).status).toBe(404);
  });

  it("deep scan: no internal file anywhere the student or the partner can reach", async () => {
    await seedFiles();
    const token = await tokenFor("riya@student.test");
    const seen = [
      JSON.stringify((await cases(token)).body),
      JSON.stringify((await request(partnerApp).get("/").set("x-test-ws", String(AMBER))).body),
      JSON.stringify((await request(partnerApp).get("/PL-AAAAA2").set("x-test-ws", String(AMBER))).body),
      JSON.stringify((await linkFor(token, "PL-AAAAA2", F.internal)).body),
    ];
    for (const s of seen) {
      expect(s).not.toContain(SENT);
      expect(s).not.toContain(String(F.internal));
      expect(s).not.toContain("bookings/attachments");
    }
  });
});
