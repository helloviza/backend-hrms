// apps/backend/src/routes/consumer.support.test.ts
//
// ══════════════════════════════════════════════════════════════════════
// THE SECURITY GATE FOR D2C SUPPORT CASES.
//
// A Ticket is a SHARED B2B ops document. It carries assignment, SLA
// timers, a Gemini extraction and an ops tag vocabulary — and now it also
// carries consumer cases. Two things can go wrong, and these tests exist
// to prove neither does:
//
//   1. A consumer reads ops-internal fields, or another consumer's case.
//   2. A consumer FILES a case as somebody else, by naming their own
//      fromEmail or consumerId in the body — which would then make ops
//      reply with a stranger's case details to an attacker's address.
// ══════════════════════════════════════════════════════════════════════
//
// Real router, real requireConsumer, real tokens, real Mongo
// (mongodb-memory-server), real Ticket model with its real pre-save
// ticketRef hook. No mocks — the guard and the hook ARE the things under
// test, and a mocked one proves nothing.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

// Secrets must exist BEFORE any import that reads them — see the identical
// preamble in consumer.profile.test.ts.
const B2B_SECRET = "b2b-jwt-secret-for-tests";
const CONSUMER_SECRET = "consumer-jwt-secret-for-tests";
process.env.JWT_SECRET = B2B_SECRET;
process.env.CONSUMER_JWT_SECRET = CONSUMER_SECRET;
process.env.NODE_ENV = "test";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/consumer-support-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.OPENAI_API_KEY ||= "test-openai-key";

const { default: Consumer } = await import("../models/Consumer.js");
const { default: Ticket } = await import("../models/Ticket.js");
const { default: TicketMessage } = await import("../models/TicketMessage.js");
const { default: Counter } = await import("../models/Counter.js");
const { default: CompanySettings } = await import("../models/CompanySettings.js");
const { default: TicketAttachment } = await import("../models/TicketAttachment.js");
const { default: consumerSupportRouter } = await import("./consumer.support.js");
const { signConsumerAccessToken } = await import("../utils/consumerJwt.js");
const { TICKET_ATTACHMENT_LOCAL_ROOT, openLocalTicketAttachment } = await import(
  "../services/ticketAttachmentStorage.js"
);

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/consumer/support", consumerSupportRouter);

let mongod: MongoMemoryServer;

/** A real consumer plus a real token for them. */
async function makeConsumer(email: string, name: string) {
  const consumer = await Consumer.create({
    email,
    name,
    passwordHash: "not-used-in-these-tests",
  });
  const token = signConsumerAccessToken({
    consumerId: String(consumer._id),
    tokenVersion: (consumer as any).tokenVersion,
  });
  return { consumer, token, auth: `Bearer ${token}` };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();

  // Remove only the ticket directories this run wrote. .devdata/ is
  // gitignored, so this is tidiness rather than safety — but a suite that
  // grows a directory per run forever is its own small problem.
  const { rm } = await import("node:fs/promises");
  const path = (await import("node:path")).default;
  await Promise.all(
    writtenTicketRefs.map((ref) =>
      rm(path.join(TICKET_ATTACHMENT_LOCAL_ROOT, ref), { recursive: true, force: true }),
    ),
  );
});

/** Every ticketRef whose bytes this run put on disk. */
const writtenTicketRefs: string[] = [];

beforeEach(async () => {
  await Promise.all([
    Consumer.deleteMany({}),
    Ticket.deleteMany({}),
    TicketMessage.deleteMany({}),
    TicketAttachment.deleteMany({}),
    Counter.deleteMany({}),
    CompanySettings.deleteMany({}),
  ]);
});

/** Collects a binary response body — supertest only fills res.text for text. */
function binaryParser(res: any, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

/* ══════════════════════════════════════════════════════════════════════
 * CREATION
 * ══════════════════════════════════════════════════════════════════════ */

describe("POST /cases — filing a web case", () => {
  it("creates a real Ticket with a PT ref, sourceChannel WEB and consumerId", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");

    const res = await request(app)
      .post("/api/consumer/support/cases")
      .set("Authorization", a.auth)
      .send({ subject: "Document query", message: "Is my bank statement recent enough?" })
      .expect(201);

    expect(res.body.ok).toBe(true);
    // The pre-save hook minted a ref — proof the service used .create().
    expect(res.body.case.ticketRef).toMatch(/^PT\d{4}\d{3,}$/);
    expect(res.body.case.status).toBe("Received");

    const ticket = await Ticket.findOne({ ticketRef: res.body.case.ticketRef }).lean();
    expect(ticket).toBeTruthy();
    expect((ticket as any).sourceChannel).toBe("WEB");
    expect(String((ticket as any).consumerId)).toBe(String(a.consumer._id));
    expect((ticket as any).status).toBe("NEW");
    // A consumer has no employer, so no Customer workspace.
    expect((ticket as any).workspaceId).toBeNull();

    // The first message is INBOUND, matching how ingestion writes an email.
    const msgs = await TicketMessage.find({ ticketId: (ticket as any)._id }).lean();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].direction).toBe("INBOUND");
    expect(msgs[0].bodyText).toContain("Is my bank statement recent enough?");
  });

  it("takes fromEmail from the SESSION, ignoring a client-supplied email", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");

    const res = await request(app)
      .post("/api/consumer/support/cases")
      .set("Authorization", a.auth)
      .send({
        subject: "Payment or refund",
        message: "I was charged twice.",
        // The attack: name someone else as the sender.
        email: "attacker@evil.test",
        fromEmail: "attacker@evil.test",
        fromName: "Not Aisha",
      })
      .expect(201);

    const ticket = await Ticket.findOne({ ticketRef: res.body.case.ticketRef }).lean();
    expect((ticket as any).fromEmail).toBe("aisha@helloviza.test");
    expect((ticket as any).fromName).toBe("Aisha Alpha");

    const msg = await TicketMessage.findOne({ ticketId: (ticket as any)._id }).lean();
    expect((msg as any).fromEmail).toBe("aisha@helloviza.test");
  });

  it("ignores a client-supplied consumerId and files against the session identity", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");
    const b = await makeConsumer("bilal@helloviza.test", "Bilal Beta");

    const res = await request(app)
      .post("/api/consumer/support/cases")
      .set("Authorization", a.auth)
      // The attack: file this case onto B's account.
      .send({
        subject: "Something else",
        message: "Filing this against someone else.",
        consumerId: String(b.consumer._id),
      })
      .expect(201);

    const ticket = await Ticket.findOne({ ticketRef: res.body.case.ticketRef }).lean();
    expect(String((ticket as any).consumerId)).toBe(String(a.consumer._id));
    expect(String((ticket as any).consumerId)).not.toBe(String(b.consumer._id));
  });

  it("rejects a subject outside the allowlist", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");

    for (const subject of ["Free text subject", "", "DROP TABLE tickets", null]) {
      const res = await request(app)
        .post("/api/consumer/support/cases")
        .set("Authorization", a.auth)
        .send({ subject, message: "hello" })
        .expect(400);
      expect(res.body.field).toBe("subject");
    }

    expect(await Ticket.countDocuments({})).toBe(0);
  });

  it("rejects an empty or whitespace-only message", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");

    for (const message of ["", "   ", null]) {
      await request(app)
        .post("/api/consumer/support/cases")
        .set("Authorization", a.auth)
        .send({ subject: "Document query", message })
        .expect(400);
    }

    expect(await Ticket.countDocuments({})).toBe(0);
  });

  it("routes a callback request down the SAME path, tagged, with the phone in the body", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");

    const res = await request(app)
      .post("/api/consumer/support/cases")
      .set("Authorization", a.auth)
      .send({
        subject: "Request a callback",
        message: "Please call me about my Schengen case.",
        callbackPhone: "+919876543210",
      })
      .expect(201);

    const ticket = await Ticket.findOne({ ticketRef: res.body.case.ticketRef }).lean();
    expect((ticket as any).sourceChannel).toBe("WEB");
    expect((ticket as any).tags).toContain("callback");

    const msg = await TicketMessage.findOne({ ticketId: (ticket as any)._id }).lean();
    expect((msg as any).bodyText).toContain("+919876543210");
  });

  it("requires a phone number when the subject is a callback request", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");

    const res = await request(app)
      .post("/api/consumer/support/cases")
      .set("Authorization", a.auth)
      .send({ subject: "Request a callback", message: "Call me" })
      .expect(400);

    expect(res.body.field).toBe("callbackPhone");
    expect(await Ticket.countDocuments({})).toBe(0);
  });

  it("refuses an unauthenticated caller", async () => {
    await request(app)
      .post("/api/consumer/support/cases")
      .send({ subject: "Document query", message: "hello" })
      .expect(401);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * OWN-SCOPE ISOLATION
 * ══════════════════════════════════════════════════════════════════════ */

describe("GET /cases — own-scope isolation", () => {
  it("returns only the caller's own cases; a second consumer sees none", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");
    const b = await makeConsumer("bilal@helloviza.test", "Bilal Beta");

    await request(app)
      .post("/api/consumer/support/cases")
      .set("Authorization", a.auth)
      .send({ subject: "Document query", message: "A's private question" })
      .expect(201);

    const aList = await request(app)
      .get("/api/consumer/support/cases")
      .set("Authorization", a.auth)
      .expect(200);
    expect(aList.body.cases).toHaveLength(1);
    expect(aList.body.cases[0].yourMessage).toContain("A's private question");

    const bList = await request(app)
      .get("/api/consumer/support/cases")
      .set("Authorization", b.auth)
      .expect(200);
    expect(bList.body.cases).toHaveLength(0);
    expect(JSON.stringify(bList.body)).not.toContain("A's private question");
  });

  it("never returns a Gmail-ingested B2B ticket, which has no consumerId", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");

    // A B2B ticket shaped exactly as ticketIngestion.ts writes one.
    await Ticket.create({
      subject: "Corporate booking request",
      fromEmail: "ops@bigcorp.test",
      fromName: "Big Corp",
      gmailThreadId: "thread-abc",
      status: "NEW",
    });

    const res = await request(app)
      .get("/api/consumer/support/cases")
      .set("Authorization", a.auth)
      .expect(200);

    expect(res.body.cases).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain("Corporate booking");
  });

  it("refuses an unauthenticated caller", async () => {
    await request(app).get("/api/consumer/support/cases").expect(401);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * THE PROJECTION — what a consumer may NOT see
 * ══════════════════════════════════════════════════════════════════════ */

describe("GET /cases — consumer-safe projection", () => {
  it("omits every ops-internal field and never leaks the raw status enum", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");

    const created = await request(app)
      .post("/api/consumer/support/cases")
      .set("Authorization", a.auth)
      .send({ subject: "Visa refused or rejected", message: "My visa was refused." })
      .expect(201);

    // Ops work the case: assign it, extract fields, tag it, set SLA timers.
    const assignee = new mongoose.Types.ObjectId();
    await Ticket.findOneAndUpdate(
      { ticketRef: created.body.case.ticketRef },
      {
        $set: {
          assignedTo: assignee,
          status: "WAITING_SUPPLIER",
          priority: "URGENT",
          slaDueBy: new Date(),
          firstResponseAt: new Date(),
          gmailThreadId: "should-never-surface",
          gmailHistoryId: "also-never",
          leadId: new mongoose.Types.ObjectId(),
          workspaceId: new mongoose.Types.ObjectId(),
          extractedFields: { summary: "internal gemini guess", destination: "Paris" },
          tags: ["d2c-support", "internal-escalation"],
        },
      },
    );

    const res = await request(app)
      .get("/api/consumer/support/cases")
      .set("Authorization", a.auth)
      .expect(200);

    const body = JSON.stringify(res.body);
    const row = res.body.cases[0];

    // What IS exposed.
    expect(Object.keys(row).sort()).toEqual(
      [
        "createdAt",
        "lastActivityAt",
        "status",
        "subject",
        "ticketRef",
        "yourMessage",
        // A COUNT of the reader's own uploads — not filenames, not links.
        "attachmentCount",
        // Agent replies marked visibleToConsumer. Empty here: this case was
        // worked by ops but never answered, and none of the internal work
        // above sets that flag.
        "replies",
      ].sort(),
    );
    expect(row.replies).toEqual([]);

    // WAITING_SUPPLIER must read as plain progress — never the word supplier.
    expect(row.status).toBe("In progress");
    expect(body).not.toContain("supplier");
    expect(body).not.toContain("SUPPLIER");
    expect(body).not.toContain("WAITING_");

    // What is NOT exposed.
    expect(body).not.toContain(String(assignee));
    expect(body).not.toContain("should-never-surface");
    expect(body).not.toContain("also-never");
    expect(body).not.toContain("internal gemini guess");
    expect(body).not.toContain("internal-escalation");
    expect(body).not.toContain("URGENT");
    for (const forbidden of [
      "assignedTo",
      "extractedFields",
      "slaDueBy",
      "firstResponseAt",
      "gmailThreadId",
      "gmailHistoryId",
      "leadId",
      "workspaceId",
      "tags",
      "priority",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("maps every raw status to its consumer label", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");
    const expected: Record<string, string> = {
      NEW: "Received",
      IN_PROGRESS: "In progress",
      WAITING_CLIENT: "Action needed from you",
      WAITING_SUPPLIER: "In progress",
      CLOSED: "Resolved",
    };

    for (const [raw, label] of Object.entries(expected)) {
      await Ticket.deleteMany({});
      const created = await request(app)
        .post("/api/consumer/support/cases")
        .set("Authorization", a.auth)
        .send({ subject: "Processing time or status", message: "status please" })
        .expect(201);

      await Ticket.findOneAndUpdate(
        { ticketRef: created.body.case.ticketRef },
        { $set: { status: raw } },
      );

      const res = await request(app)
        .get("/api/consumer/support/cases")
        .set("Authorization", a.auth)
        .expect(200);
      expect(res.body.cases[0].status).toBe(label);
    }
  });

  it("reports a COUNT of the reader's own attachments, never filenames or links", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");
    const created = await request(app)
      .post("/api/consumer/support/cases")
      .set("Authorization", a.auth)
      .send({ subject: "Document query", message: "statements attached" })
      .expect(201);
    writtenTicketRefs.push(created.body.case.ticketRef);

    await request(app)
      .post(`/api/consumer/support/cases/${created.body.case.ticketRef}/attachments`)
      .set("Authorization", a.auth)
      .attach("files", Buffer.from("%PDF-1.4 statement"), "bank-statement.pdf")
      .expect(201);

    const res = await request(app)
      .get("/api/consumer/support/cases")
      .set("Authorization", a.auth)
      .expect(200);

    expect(res.body.cases[0].attachmentCount).toBe(1);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("bank-statement.pdf");
    expect(body).not.toContain("storageKey");
    expect(body).not.toContain("s3Key");
  });

  it("does NOT expose agent-authored messages — no internal note can leak", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");

    const created = await request(app)
      .post("/api/consumer/support/cases")
      .set("Authorization", a.auth)
      .send({ subject: "Document query", message: "my own question" })
      .expect(201);

    const ticket = await Ticket.findOne({ ticketRef: created.body.case.ticketRef });

    // An agent's internal note, exactly as tickets.console.ts writes one.
    await TicketMessage.create({
      ticketId: (ticket as any)._id,
      direction: "OUTBOUND",
      channel: "SYSTEM",
      fromEmail: "agent@plumtrips.com",
      toEmail: [],
      subject: "Document query",
      bodyHtml: "CONFIDENTIAL — refund this one, the client is a repeat complainer",
      bodyText: "CONFIDENTIAL — refund this one, the client is a repeat complainer",
      deliveryStatus: "SENT",
    });

    // And an OUTBOUND EMAIL message, which is likewise not exposed in v1.
    await TicketMessage.create({
      ticketId: (ticket as any)._id,
      direction: "OUTBOUND",
      channel: "EMAIL",
      fromEmail: "agent@plumtrips.com",
      toEmail: ["aisha@helloviza.test"],
      subject: "Document query",
      bodyHtml: "agent reply text",
      bodyText: "agent reply text",
      deliveryStatus: "SENT",
    });

    const res = await request(app)
      .get("/api/consumer/support/cases")
      .set("Authorization", a.auth)
      .expect(200);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain("CONFIDENTIAL");
    expect(body).not.toContain("repeat complainer");
    expect(body).not.toContain("agent reply text");
    expect(body).not.toContain("agent@plumtrips.com");
    // The consumer's own words still come back.
    expect(res.body.cases[0].yourMessage).toContain("my own question");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ATTACHMENTS
 *
 * The bytes are the point. These tests read the stored object back and
 * compare it to what went up — a row that says "19776 bytes" proves
 * nothing about whether the support team can open the file.
 * ══════════════════════════════════════════════════════════════════════ */

const PDF_BYTES = Buffer.from("%PDF-1.4\nrefusal letter\n%%EOF");
// A real 1x1 PNG, so image handling meets an actual image rather than a
// buffer that merely claims to be one.
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100" +
    "05fe02fa0000000049454e44ae426082",
  "hex",
);

async function caseFor(auth: string, subject = "Visa refused or rejected") {
  const res = await request(app)
    .post("/api/consumer/support/cases")
    .set("Authorization", auth)
    .send({ subject, message: "Please see the attached documents." })
    .expect(201);
  writtenTicketRefs.push(res.body.case.ticketRef);
  return res.body.case.ticketRef as string;
}

describe("POST /cases/:ticketRef/attachments", () => {
  it("stores a PDF and an image, linking both to the ticket AND its inbound message", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");
    const ref = await caseFor(a.auth);

    const res = await request(app)
      .post(`/api/consumer/support/cases/${ref}/attachments`)
      .set("Authorization", a.auth)
      .attach("files", PDF_BYTES, "refusal-letter.pdf")
      .attach("files", PNG_BYTES, "screenshot.png")
      .expect(201);

    expect(res.body.ok).toBe(true);
    expect(res.body.attachments).toHaveLength(2);

    const ticket = await Ticket.findOne({ ticketRef: ref }).lean();
    const atts = await TicketAttachment.find({ ticketId: (ticket as any)._id }).lean();
    expect(atts).toHaveLength(2);

    const msg = await TicketMessage.findOne({
      ticketId: (ticket as any)._id,
      direction: "INBOUND",
    }).lean();

    for (const att of atts) {
      // BOTH links. messageId alone leaves the file invisible in the
      // console, which filters chips on msg.attachmentRefs.
      expect(String(att.messageId)).toBe(String((msg as any)._id));
      expect((msg as any).attachmentRefs.map(String)).toContain(String(att._id));
      expect(att.driver).toBe("local-disk");
      expect(att.storageKey).toContain(`tickets/${ref}/`);
    }
  });

  it("writes the REAL BYTES — what comes back out equals what went in", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");
    const ref = await caseFor(a.auth);

    await request(app)
      .post(`/api/consumer/support/cases/${ref}/attachments`)
      .set("Authorization", a.auth)
      .attach("files", PDF_BYTES, "refusal-letter.pdf")
      .attach("files", PNG_BYTES, "screenshot.png")
      .expect(201);

    const ticket = await Ticket.findOne({ ticketRef: ref }).lean();
    const atts = await TicketAttachment.find({ ticketId: (ticket as any)._id }).lean();

    for (const att of atts) {
      const expected = att.fileName.endsWith(".pdf") ? PDF_BYTES : PNG_BYTES;
      const stream = await openLocalTicketAttachment(att.storageKey);
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
      const actual = Buffer.concat(chunks);

      expect(actual.equals(expected)).toBe(true);
      expect(att.size).toBe(expected.length);
    }
  });

  it("accepts ANY format — an .exe and a .zip are not rejected", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");
    const ref = await caseFor(a.auth);

    await request(app)
      .post(`/api/consumer/support/cases/${ref}/attachments`)
      .set("Authorization", a.auth)
      .attach("files", Buffer.from("MZ fake"), "thing.exe")
      .attach("files", Buffer.from("PK fake"), "docs.zip")
      .expect(201);

    expect(await TicketAttachment.countDocuments({})).toBe(2);
  });

  it("rejects a file over the 10MB limit", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");
    const ref = await caseFor(a.auth);

    const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1024, 0x41);
    const res = await request(app)
      .post(`/api/consumer/support/cases/${ref}/attachments`)
      .set("Authorization", a.auth)
      .attach("files", tooBig, "huge.pdf");

    expect(res.status).toBe(413);
    expect(await TicketAttachment.countDocuments({})).toBe(0);
  });

  it("rejects more than 5 files in one request", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");
    const ref = await caseFor(a.auth);

    let req6 = request(app)
      .post(`/api/consumer/support/cases/${ref}/attachments`)
      .set("Authorization", a.auth);
    for (let i = 0; i < 6; i++) req6 = req6.attach("files", Buffer.from(`f${i}`), `f${i}.txt`);

    const res = await req6;
    expect(res.status).toBe(400);
  });

  it("enforces the 5-file cap ACROSS requests, not just within one", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");
    const ref = await caseFor(a.auth);

    let first = request(app)
      .post(`/api/consumer/support/cases/${ref}/attachments`)
      .set("Authorization", a.auth);
    for (let i = 0; i < 4; i++) first = first.attach("files", Buffer.from(`a${i}`), `a${i}.txt`);
    await first.expect(201);

    // 4 + 2 = 6. Multer would allow this second request on its own — the
    // cap has to be re-checked against what the case already holds.
    const res = await request(app)
      .post(`/api/consumer/support/cases/${ref}/attachments`)
      .set("Authorization", a.auth)
      .attach("files", Buffer.from("b0"), "b0.txt")
      .attach("files", Buffer.from("b1"), "b1.txt");

    expect(res.status).toBe(400);
    expect(await TicketAttachment.countDocuments({})).toBe(4);
  });

  it("rejects a request with no files", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");
    const ref = await caseFor(a.auth);

    await request(app)
      .post(`/api/consumer/support/cases/${ref}/attachments`)
      .set("Authorization", a.auth)
      .expect(400);
  });
});

describe("attachment own-scope fence", () => {
  it("consumer B CANNOT attach to consumer A's case", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");
    const b = await makeConsumer("bilal@helloviza.test", "Bilal Beta");
    const refA = await caseFor(a.auth);

    const res = await request(app)
      .post(`/api/consumer/support/cases/${refA}/attachments`)
      .set("Authorization", b.auth)
      .attach("files", Buffer.from("intruder"), "intruder.pdf");

    // The same 404 an unknown reference gets — no oracle telling B which
    // references are real.
    expect(res.status).toBe(404);
    expect(await TicketAttachment.countDocuments({})).toBe(0);
  });

  it("gives the SAME 404 for a reference that does not exist at all", async () => {
    const b = await makeConsumer("bilal@helloviza.test", "Bilal Beta");

    const res = await request(app)
      .post("/api/consumer/support/cases/PT9999999/attachments")
      .set("Authorization", b.auth)
      .attach("files", Buffer.from("x"), "x.pdf");

    expect(res.status).toBe(404);
  });

  it("cannot attach to a Gmail-ingested B2B ticket", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");
    const b2b = await Ticket.create({
      subject: "Corporate booking request",
      fromEmail: "ops@bigcorp.test",
      gmailThreadId: "thread-abc",
      status: "NEW",
    });

    const res = await request(app)
      .post(`/api/consumer/support/cases/${b2b.ticketRef}/attachments`)
      .set("Authorization", a.auth)
      .attach("files", Buffer.from("x"), "x.pdf");

    expect(res.status).toBe(404);
    expect(await TicketAttachment.countDocuments({})).toBe(0);
  });

  it("refuses an unauthenticated caller", async () => {
    const a = await makeConsumer("aisha@helloviza.test", "Aisha Alpha");
    const ref = await caseFor(a.auth);

    await request(app)
      .post(`/api/consumer/support/cases/${ref}/attachments`)
      .attach("files", Buffer.from("x"), "x.pdf")
      .expect(401);
  });
});
