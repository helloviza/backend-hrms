// apps/backend/src/services/ticketIngestion.xss.test.ts
//
// ══════════════════════════════════════════════════════════════════════
// THE STORED-XSS GUARD ON THE INGEST BOUNDARY.
//
// The ticket console renders a stored message body as MARKUP. bodyHtml on
// an INBOUND message is whatever a stranger's mail client sent to the
// ticketing inbox, which made "email support@" an unauthenticated write
// into the DOM of an authenticated ops session.
//
// Before this guard existed the only defence was four regexes in
// TicketDetail.tsx, and every payload below walked past them: the on*
// rules only matched quoted values, the <script> rule needed a closing
// tag, and the javascript: rule never saw an entity-encoded scheme.
//
// These tests pin BOTH halves of the fix, because half of it is a
// regression waiting to happen:
//   1. dangerous markup does not survive ingestion, and
//   2. a legitimate email is stored BYTE-IDENTICAL.
//
// (2) is not a nicety. A sanitizer that mangles a supplier's fare table
// will be turned off by the first ops user who loses a booking to it.
// ══════════════════════════════════════════════════════════════════════
//
// Real Mongo, real ingestEmailToTicket, no mocks.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/ticket-ingestion-xss-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: Ticket } = await import("../models/Ticket.js");
const { default: TicketMessage } = await import("../models/TicketMessage.js");
const { default: TicketLead } = await import("../models/TicketLead.js");
const { default: Counter } = await import("../models/Counter.js");
const { ingestEmailToTicket } = await import("./ticketIngestion.js");

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
    TicketLead.deleteMany({}),
    Counter.deleteMany({}),
  ]);
});

const THREAD_ID = "thread-xss-guard";

/**
 * A Gmail message carrying `html` as its body.
 *
 * NO `id` FIELD, ON PURPOSE. parsed.gmailId gates the two calls in
 * ingestEmailToTicket that would reach the network (fetchAttachmentData and
 * markMessageAsProcessed), so omitting it keeps this test offline while
 * leaving the code path under test — the body write — completely real.
 */
function gmailMessage(html: string) {
  return {
    threadId: THREAD_ID,
    payload: {
      mimeType: "text/html",
      headers: [
        { name: "From", value: "Traveller <traveller@example.com>" },
        { name: "To", value: "booking@plumtrips.com" },
        { name: "Subject", value: "Re: booking query" },
        { name: "Message-Id", value: "<inbound-1@example.com>" },
      ],
      body: { data: Buffer.from(html, "utf8").toString("base64url") },
    },
  } as any;
}

/**
 * Ingestion onto an EXISTING thread. A follow-up is the ordinary case, and
 * it also means isNewTicket is false — which skips the Gemini extraction and
 * the auto-ack send, the other two things that would leave the machine.
 */
async function ingestOntoExistingThread(html: string) {
  await Ticket.create({
    subject: "booking query",
    fromEmail: "traveller@example.com",
    fromName: "Traveller",
    gmailThreadId: THREAD_ID,
    status: "NEW",
  });

  const result = await ingestEmailToTicket(gmailMessage(html));
  if ("skipped" in result) throw new Error(`ingestion skipped: ${result.reason}`);

  // Read back from Mongo rather than trusting the returned document — what
  // matters is what a future render will load, not what the writer held.
  const stored = await TicketMessage.findById(result.message._id).lean();
  return String((stored as any)?.bodyHtml ?? "");
}

/** Markup that must never reach an ops user's DOM, whatever else survives. */
function expectDefanged(stored: string) {
  expect(stored).not.toMatch(/<script/i);
  expect(stored).not.toMatch(/<iframe/i);
  expect(stored).not.toMatch(/<svg/i);
  expect(stored).not.toMatch(/<base/i);
  expect(stored).not.toMatch(/<form/i);
  expect(stored).not.toMatch(/<object|<embed/i);
  // No event handler of any spelling, quoted or bare.
  expect(stored).not.toMatch(/\son[a-z]+\s*=/i);
  // No executable scheme, including the entity-decoded spellings — the
  // sanitizer decodes before it decides, so this catches &#106;avascript:.
  expect(stored).not.toMatch(/javascript\s*:/i);
  expect(stored).not.toMatch(/data\s*:\s*text\/html/i);
  expect(stored).not.toMatch(/vbscript\s*:/i);
}

describe("ticket ingestion — stored XSS", () => {
  // The four payloads that defeated the old regex sanitizer, plus three more
  // it never even attempted. Each name is the reason the old code failed.
  const PAYLOADS: Array<[name: string, html: string]> = [
    ["unquoted on* handler (old rule only matched quoted)", `<img src=x onerror=alert(1)>`],
    ["unclosed <script> (old rule needed a closing tag)", `<script src="//evil.example/x.js">`],
    ["entity-encoded scheme (old rule matched literal text)", `<a href="&#106;avascript:alert(1)">click</a>`],
    ["svg onload (old rules did not consider svg)", `<svg onload=alert(1)></svg>`],
    ["iframe with data: document", `<iframe src="data:text/html,<script>alert(1)</script>"></iframe>`],
    ["base href hijack of every relative URL", `<base href="//evil.example/">`],
    ["data: URI anchor", `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`],
  ];

  for (const [name, html] of PAYLOADS) {
    it(`neutralises ${name}`, async () => {
      const stored = await ingestOntoExistingThread(html);
      expectDefanged(stored);
    });
  }

  it("stores a plain formatted email unchanged", async () => {
    const legit =
      `<p>Hi team,</p>` +
      `<p>Please confirm <strong>PNR ABC123</strong> for the <em>Mumbai</em> leg.</p>` +
      `<ul><li>Outbound 12 Sep</li><li>Return 19 Sep</li></ul>` +
      `<p><a href="https://plumtrips.com/booking/ABC123" target="_blank" rel="noopener noreferrer nofollow">View booking</a></p>`;

    const stored = await ingestOntoExistingThread(legit);
    expect(stored).toBe(legit);
  });

  it("stores a table-and-image supplier email unchanged", async () => {
    // THE REGRESSION THIS FIX MUST NOT CAUSE. Real mail is tables, divs,
    // inline style and a logo. If the allowlist ever narrows to the editor's
    // own tag set, this is the test that fails instead of an ops user.
    const supplier =
      `<div dir="ltr">` +
      `<table width="100%" cellpadding="0" cellspacing="0" border="1">` +
      `<tbody><tr><td style="padding:6px;color:#111" colspan="2">PNR</td><td>ABC123</td></tr></tbody>` +
      `</table>` +
      `<img src="https://airline.example/logo.png" alt="logo" width="120" height="40">` +
      `<font color="#888888" size="2">Sent from Outlook</font>` +
      `</div>`;

    const stored = await ingestOntoExistingThread(supplier);
    expect(stored).toBe(supplier);
  });

  it("keeps the readable words of a payload while removing its teeth", async () => {
    // Sanitizing is not deleting. The agent still needs to read what was
    // sent — a support ticket whose body silently became empty is its own
    // kind of incident.
    const stored = await ingestOntoExistingThread(
      `<p>My flight is delayed<img src=x onerror=alert(1)> please help</p>`,
    );
    expect(stored).toContain("My flight is delayed");
    expect(stored).toContain("please help");
    expectDefanged(stored);
  });

  it("is idempotent — re-ingesting an already-clean body changes nothing", async () => {
    const once = await ingestOntoExistingThread(`<p>Hello <strong>there</strong></p>`);
    await TicketMessage.deleteMany({});
    await Ticket.deleteMany({});
    const twice = await ingestOntoExistingThread(once);
    expect(twice).toBe(once);
  });
});
