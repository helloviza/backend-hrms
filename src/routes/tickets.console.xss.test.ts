// apps/backend/src/routes/tickets.console.xss.test.ts
//
// ══════════════════════════════════════════════════════════════════════
// THE STORED-XSS GUARD ON THE TWO WRITE PATHS THE CONSOLE OWNS.
//
// ticketIngestion.xss.test.ts covers the unauthenticated boundary — the
// stranger who emails the inbox. This file covers the other two ways
// markup gets into a stored body:
//
//   1. POST /:id/reply takes bodyHtml OFF THE WIRE. The TipTap editor
//      cannot produce anything dangerous, but the endpoint is not the
//      editor: a hijacked ops session or a leaked token can POST whatever
//      it likes, and what it posts is what a future render loads.
//
//   2. buildQuotedBody() embeds a PRIOR message's body inside the one
//      being composed. That prior body may predate ingest-sanitizing, so
//      the quote trail is how an old dirty row rides into a new message —
//      one that then goes out over Gmail as well as into the collection.
//
// The portal and internal-note branches are used here because they store
// without sending; the Gmail branch would need the network to reach its
// write. The sanitize call under test sits above that fork and runs
// identically on all three.
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

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/tickets-console-xss-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.OPENAI_API_KEY ||= "test-openai-key";

const { default: Ticket } = await import("../models/Ticket.js");
const { default: TicketMessage } = await import("../models/TicketMessage.js");
const { default: Counter } = await import("../models/Counter.js");
const { default: CompanySettings } = await import("../models/CompanySettings.js");
const { default: ticketsConsoleRouter } = await import("./tickets.console.js");
const { buildQuotedBody } = await import("../utils/emailQuoteBuilder.js");
const { signToken } = await import("../utils/jwt.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/admin/tickets", ticketsConsoleRouter);

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

function expectDefanged(stored: string) {
  expect(stored).not.toMatch(/<script/i);
  expect(stored).not.toMatch(/<iframe/i);
  expect(stored).not.toMatch(/<svg/i);
  expect(stored).not.toMatch(/<base/i);
  expect(stored).not.toMatch(/<form/i);
  expect(stored).not.toMatch(/\son[a-z]+\s*=/i);
  expect(stored).not.toMatch(/javascript\s*:/i);
  expect(stored).not.toMatch(/data\s*:\s*text\/html/i);
}

const PAYLOADS: Array<[name: string, html: string]> = [
  ["unquoted on* handler", `<img src=x onerror=alert(1)>`],
  ["unclosed script", `<script src="//evil.example/x.js">`],
  ["entity-encoded scheme", `<a href="&#106;avascript:alert(1)">click</a>`],
  ["svg onload", `<svg onload=alert(1)></svg>`],
  ["iframe data: document", `<iframe src="data:text/html,<script>alert(1)</script>"></iframe>`],
  ["base href hijack", `<base href="//evil.example/">`],
];

describe("POST /:id/reply — portal reply is sanitized before it is stored", () => {
  for (const [name, html] of PAYLOADS) {
    it(`neutralises ${name}`, async () => {
      const ticket = await makeWebTicket();

      const res = await request(app)
        .post(`/api/admin/tickets/${ticket._id}/reply`)
        .set("Authorization", agentAuth)
        .send({ bodyHtml: `<p>Here is your update.</p>${html}`, replyToConsumer: true })
        .expect(200);

      const stored = await TicketMessage.findById(res.body.message._id).lean();
      const body = String((stored as any)?.bodyHtml ?? "");

      expectDefanged(body);
      // The agent's own words are untouched — sanitizing is not censoring.
      expect(body).toContain("Here is your update.");
    });
  }

  it("stores a normal editor reply unchanged", async () => {
    const ticket = await makeWebTicket();
    // Exactly what TipTap (StarterKit + Link) emits for a formatted reply.
    const legit =
      `<p>Hi Aisha,</p>` +
      `<p>Your documents are <strong>verified</strong> and <em>nothing further</em> is needed.</p>` +
      `<ul><li>Passport — received</li><li>Photo — received</li></ul>` +
      `<p><a href="https://helloviza.com/account" target="_blank" rel="noopener noreferrer nofollow">Open your account</a></p>`;

    const res = await request(app)
      .post(`/api/admin/tickets/${ticket._id}/reply`)
      .set("Authorization", agentAuth)
      .send({ bodyHtml: legit, replyToConsumer: true })
      .expect(200);

    const stored = await TicketMessage.findById(res.body.message._id).lean();
    expect(String((stored as any)?.bodyHtml)).toBe(legit);
  });

  it("sanitizes an internal note too", async () => {
    // An internal note is read by agents in the same thread view, so it is
    // the same DOM and the same risk.
    const ticket = await makeWebTicket();

    const res = await request(app)
      .post(`/api/admin/tickets/${ticket._id}/reply`)
      .set("Authorization", agentAuth)
      .send({ bodyHtml: `<p>Chasing embassy</p><img src=x onerror=alert(1)>`, isInternalNote: true })
      .expect(200);

    const stored = await TicketMessage.findById(res.body.message._id).lean();
    const body = String((stored as any)?.bodyHtml ?? "");
    expectDefanged(body);
    expect(body).toContain("Chasing embassy");
  });
});

describe("buildQuotedBody — the quote trail cannot smuggle markup", () => {
  it("strips a payload out of the quoted prior message", () => {
    const out = buildQuotedBody(`<p>Thanks, looking into it.</p>`, [
      {
        fromName: "Traveller",
        fromEmail: "traveller@example.com",
        sentAt: new Date("2026-08-21T09:30:00Z"),
        bodyHtml: `<p>My original mail</p><img src=x onerror=alert(1)><script>alert(2)</script>`,
      },
    ]);

    expectDefanged(out);
    // The agent's new content and the quoted words both survive.
    expect(out).toContain("Thanks, looking into it.");
    expect(out).toContain("My original mail");
    expect(out).toContain("traveller@example.com");
  });

  it("keeps a legitimate quoted table intact", async () => {
    const quoted =
      `<div dir="ltr"><table width="100%" border="1"><tbody><tr>` +
      `<td style="padding:6px">PNR</td><td>ABC123</td></tr></tbody></table></div>`;

    const out = buildQuotedBody(`<p>Confirmed.</p>`, [
      {
        fromName: "Supplier",
        fromEmail: "ops@airline.example",
        sentAt: new Date("2026-08-21T09:30:00Z"),
        bodyHtml: quoted,
      },
    ]);

    expect(out).toContain(quoted);
  });
});
