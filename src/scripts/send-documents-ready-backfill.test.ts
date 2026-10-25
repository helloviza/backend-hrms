// apps/backend/src/scripts/send-documents-ready-backfill.test.ts
//
// Refuses without / with the wrong --expect-db; the dry run lists exactly the
// booked requests whose booking-done email carried no files but which now
// hold customer documents — with their recipients (a partner lead case: the
// student only) — and writes / sends nothing; --apply sends one "documents
// ready" email each, records meta.documentsEmailed, and a re-run sends none.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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

const { sendDocumentsReadyBackfill } = await import("./send-documents-ready-backfill.js");

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const DB = "documents-ready-backfill-test";
const WS = oid();
const quiet = () => {};
const R = { flow3: oid(), partner: oid(), carried: oid(), recorded: oid(), open: oid(), noDocs: oid() };

const ticket = (name: string) => ({ type: "ticket", filename: name, s3Key: `bookings/attachments/x/${name}`, attachmentId: String(oid()), manualBookingId: String(oid()), mime: "application/pdf" });
const notified = (comment: string) => ({ action: "admin_notify_sent", at: new Date(), comment });
const req = (_id: any, over: any) => ({
  _id, workspaceId: WS, customerId: "C1", customerName: "Acme", ticketId: `TKT-${String(_id).slice(-4)}`, status: "approved", stage: "COMPLETED", adminState: "done",
  frontlinerEmail: "asha@acme.test", frontlinerName: "Asha Rao", managerEmail: "meera@acme.test", cartItems: [],
  meta: { bookingDocuments: [ticket("E-Ticket.pdf")] }, history: [notified("Notified: to=asha@acme.test cc=meera@acme.test")], ...over,
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(DB));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  mails.length = 0;
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertOne({ _id: WS, customerId: "C1", name: "Acme", status: "ACTIVE", config: {} } as any);
  await col("users").insertMany(["asha@acme.test", "meera@acme.test"].map((email) => ({ email, workspaceId: WS, status: "ACTIVE", roles: ["CUSTOMER"], name: email, passwordHash: "x" })) as any[]);
  await col("approvalrequests").insertMany([
    req(R.flow3, {}),
    req(R.partner, {
      frontlinerEmail: "partner-intake@plumtrips.com", managerEmail: "partner-intake@plumtrips.com",
      meta: { source: "PARTNER_LINK", partnerLead: { caseNumber: "PL-T46PH8", contact: { name: "Aditya", email: "aditya@student.test" } }, bookingDocuments: [ticket("E-Ticket MR ADITYA.pdf")] },
      history: [notified("Notified: to=aditya@student.test")],
    }),
    // not selected
    req(R.carried, { history: [notified("Notified: to=asha@acme.test attachments=1")] }),
    req(R.recorded, { meta: { bookingDocuments: [ticket("t.pdf")], documentsEmailed: [] } }),
    req(R.open, { stage: "BOOKING_IN_PROGRESS", adminState: "in_progress" }),
    req(R.noDocs, { meta: { bookingDocuments: [{ ...ticket("x.pdf"), type: "internal" }] } }),
  ] as any[]);
});

const snapshot = async () => JSON.stringify(await col("approvalrequests").find({}).sort({ _id: 1 }).toArray());

describe("send-documents-ready-backfill", () => {
  it("refuses without --expect-db, or with the wrong one", async () => {
    await expect(sendDocumentsReadyBackfill({ apply: false, log: quiet })).rejects.toThrow(/REFUSING/);
    await expect(sendDocumentsReadyBackfill({ expectDb: "Plumtrips_hrms", apply: true, log: quiet })).rejects.toThrow(/REFUSING/);
  });

  it("dry run lists each request with its files and recipients; writes and sends nothing", async () => {
    const before = await snapshot();
    const r = await sendDocumentsReadyBackfill({ expectDb: DB, apply: false, log: quiet });
    expect(r.lines.map((l) => [l.requestId, l.files, l.to, l.cc])).toEqual([
      [String(R.flow3), ["E-Ticket.pdf"], ["asha@acme.test"], ["meera@acme.test"]],
      [String(R.partner), ["E-Ticket MR ADITYA.pdf"], ["aditya@student.test"], []],
    ]);
    expect(r.skipped).toEqual([{ requestId: String(R.carried), why: "booking done already carried 1 file(s)" }]);
    expect(await snapshot()).toBe(before);
    expect(mails).toHaveLength(0);
  });

  it("--apply sends one documents-ready email each, records them, and a re-run sends none", async () => {
    const r = await sendDocumentsReadyBackfill({ expectDb: DB, apply: true, log: quiet });
    expect(r.sent).toBe(2);
    expect(mails.map((m) => [m.subject, m.to, (m.attachments || []).map((a: any) => a.filename)])).toEqual([
      ["Your travel documents — Acme (TKT-" + String(R.flow3).slice(-4) + ")", "asha@acme.test", ["E-Ticket.pdf"]],
      [expect.stringContaining("Your travel documents"), "aditya@student.test", ["E-Ticket MR ADITYA.pdf"]],
    ]);
    for (const m of mails) expect(m.html).not.toMatch(/₹|\/customer\/|\/login/);
    const flow3: any = await col("approvalrequests").findOne({ _id: R.flow3 });
    expect(flow3.meta.documentsEmailed).toEqual([flow3.meta.bookingDocuments[0].attachmentId]);
    expect(flow3.history.at(-1)).toMatchObject({ action: "admin_notify_sent", comment: expect.stringMatching(/^Documents ready: to=asha@acme.test cc=meera@acme.test attachments=1$/) });

    mails.length = 0;
    const again = await sendDocumentsReadyBackfill({ expectDb: DB, apply: true, log: quiet });
    expect([again.lines.length, again.sent, mails.length]).toEqual([0, 0, 0]);
  });
});
