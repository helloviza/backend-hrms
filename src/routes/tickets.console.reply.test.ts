// apps/backend/src/routes/tickets.console.reply.test.ts
//
// ══════════════════════════════════════════════════════════════════════
// THE THREADLESS REPLY GUARD.
//
// POST /admin/tickets/:id/reply sends through Gmail, in a thread. Before
// D2C support existed, every ticket HAD a thread, so the no-thread branch
// was unreachable — and it was written as: log a warning, then create an
// OUTBOUND message stamped deliveryStatus "SENT", stamp firstResponseAt,
// return success:true. Nothing was emailed.
//
// Web cases have no thread, so that branch is reachable now. A reply that
// reports success while sending nothing is the worst failure available:
// the agent believes they answered, the SLA clock stops, and the customer
// waits forever. These tests pin the honest behaviour.
// ══════════════════════════════════════════════════════════════════════
//
// Real router, real requireAuth, real Mongo. No mocks.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const B2B_SECRET = "b2b-jwt-secret-for-tests";
process.env.JWT_SECRET = B2B_SECRET;
process.env.CONSUMER_JWT_SECRET = "consumer-jwt-secret-for-tests";
process.env.NODE_ENV = "test";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/tickets-reply-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.OPENAI_API_KEY ||= "test-openai-key";

const { default: Ticket } = await import("../models/Ticket.js");
const { default: TicketMessage } = await import("../models/TicketMessage.js");
const { default: Counter } = await import("../models/Counter.js");
const { default: CompanySettings } = await import("../models/CompanySettings.js");
const { default: ticketsConsoleRouter } = await import("./tickets.console.js");
const { signToken } = await import("../utils/jwt.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/admin/tickets", ticketsConsoleRouter);

// A SUPERADMIN token — isSuperAdmin() short-circuits requirePermission, so
// the permission layer is not what these tests are probing.
const agentToken = signToken({
  sub: new mongoose.Types.ObjectId().toString(),
  email: "agent@plumtrips.com",
  roles: ["SUPERADMIN"],
} as any);
const agentAuth = `Bearer ${agentToken}`;

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await Promise.all([
    Ticket.deleteMany({}),
    TicketMessage.deleteMany({}),
    Counter.deleteMany({}),
    CompanySettings.deleteMany({}),
  ]);
});

/** A web-origin ticket: sourceChannel WEB, no gmailThreadId. */
async function makeWebTicket() {
  return Ticket.create({
    subject: "Document query",
    fromEmail: "aisha@helloviza.test",
    fromName: "Aisha Alpha",
    sourceChannel: "WEB",
    consumerId: new mongoose.Types.ObjectId(),
    status: "NEW",
  });
}

/** A Gmail-origin ticket, exactly as ticketIngestion.ts writes one. */
async function makeEmailTicket() {
  return Ticket.create({
    subject: "Corporate booking request",
    fromEmail: "ops@bigcorp.test",
    fromName: "Big Corp",
    gmailThreadId: "thread-abc-123",
    status: "NEW",
  });
}

describe("POST /:id/reply — threadless ticket (web case)", () => {
  it("refuses with 409 NO_EMAIL_THREAD instead of reporting a phantom success", async () => {
    const ticket = await makeWebTicket();

    const res = await request(app)
      .post(`/api/admin/tickets/${ticket._id}/reply`)
      .set("Authorization", agentAuth)
      .send({ bodyHtml: "<p>Thanks for writing in.</p>" })
      .expect(409);

    expect(res.body.success).toBe(false);
    expect(res.body.reason).toBe("NO_EMAIL_THREAD");
    expect(res.body.error).toMatch(/no email thread/i);
  });

  it("does NOT write a message, and never one stamped SENT", async () => {
    const ticket = await makeWebTicket();

    await request(app)
      .post(`/api/admin/tickets/${ticket._id}/reply`)
      .set("Authorization", agentAuth)
      .send({ bodyHtml: "<p>Thanks for writing in.</p>" })
      .expect(409);

    expect(await TicketMessage.countDocuments({ ticketId: ticket._id })).toBe(0);
    expect(
      await TicketMessage.countDocuments({ ticketId: ticket._id, deliveryStatus: "SENT" }),
    ).toBe(0);
  });

  it("does NOT stamp firstResponseAt — the SLA clock must keep running", async () => {
    const ticket = await makeWebTicket();
    expect((ticket as any).firstResponseAt).toBeUndefined();

    await request(app)
      .post(`/api/admin/tickets/${ticket._id}/reply`)
      .set("Authorization", agentAuth)
      .send({ bodyHtml: "<p>Thanks for writing in.</p>" })
      .expect(409);

    const after = await Ticket.findById(ticket._id).lean();
    expect((after as any).firstResponseAt).toBeFalsy();
  });

  it("still allows an INTERNAL NOTE on a web case — the guard sits after that branch", async () => {
    const ticket = await makeWebTicket();

    const res = await request(app)
      .post(`/api/admin/tickets/${ticket._id}/reply`)
      .set("Authorization", agentAuth)
      .send({ bodyHtml: "<p>Chasing the embassy.</p>", isInternalNote: true })
      .expect(200);

    expect(res.body.success).toBe(true);

    const msgs = await TicketMessage.find({ ticketId: ticket._id }).lean();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].channel).toBe("SYSTEM");
    expect(msgs[0].direction).toBe("OUTBOUND");

    // An internal note is not a customer response, so it must not stop the
    // SLA clock either — unchanged behaviour, pinned here because the guard
    // sits next to it.
    const after = await Ticket.findById(ticket._id).lean();
    expect((after as any).firstResponseAt).toBeFalsy();
  });
});

describe("POST /:id/reply — thread-having ticket (Gmail case) is unchanged", () => {
  it("does NOT hit the threadless guard; it proceeds to the Gmail send path", async () => {
    const ticket = await makeEmailTicket();

    const res = await request(app)
      .post(`/api/admin/tickets/${ticket._id}/reply`)
      .set("Authorization", agentAuth)
      .send({ bodyHtml: "<p>Happy to help.</p>" });

    // With no Gmail credentials in a test environment the send fails, and
    // the EXISTING catch turns that into 502. The point of this assertion
    // is the negative: a threaded ticket must never be diverted into the
    // new 409 guard.
    expect(res.status).not.toBe(409);
    expect(res.body.reason).toBeUndefined();
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Gmail/i);
  });

  it("writes no message and stamps no firstResponseAt when the Gmail send fails", async () => {
    const ticket = await makeEmailTicket();

    await request(app)
      .post(`/api/admin/tickets/${ticket._id}/reply`)
      .set("Authorization", agentAuth)
      .send({ bodyHtml: "<p>Happy to help.</p>" })
      .expect(502);

    expect(await TicketMessage.countDocuments({ ticketId: ticket._id })).toBe(0);
    const after = await Ticket.findById(ticket._id).lean();
    expect((after as any).firstResponseAt).toBeFalsy();
  });

  it("still rejects invalid agent-supplied recipients before any send is attempted", async () => {
    const ticket = await makeEmailTicket();

    const res = await request(app)
      .post(`/api/admin/tickets/${ticket._id}/reply`)
      .set("Authorization", agentAuth)
      .send({ bodyHtml: "<p>hi</p>", to: "not-an-email" })
      .expect(400);

    expect(res.body.error).toMatch(/Invalid email address/i);
  });

  it("returns 404 for a ticket that does not exist", async () => {
    await request(app)
      .post(`/api/admin/tickets/${new mongoose.Types.ObjectId()}/reply`)
      .set("Authorization", agentAuth)
      .send({ bodyHtml: "<p>hi</p>" })
      .expect(404);
  });
});
