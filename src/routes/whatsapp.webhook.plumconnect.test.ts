// PlumConnect Slice 2 — the webhook end to end against real collections
// (mongodb-memory-server), a REAL HMAC signature, the real env module, and
// no mocks on the expense queues or the dispatcher.
//
// Proves the CORE RULE: with PLUMCONNECT_ENABLED unset, the webhook writes
// the same ExpenseReply / ExpenseCapture rows the inline code did (E2E-C's
// stranger still lands in the expense queue — that IS today's behaviour);
// with the flag on, a stranger gets a support conversation and no expense
// row, a bound employee reaches the chain with the identical row, and the
// stale/fresh edge never writes the chain's collections.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import crypto from "node:crypto";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-webhook-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.NODE_ENV = "test";
process.env.WA_APP_SECRET = "test-app-secret";
delete process.env.PLUMCONNECT_ENABLED;

const { default: router } = await import("./whatsapp.webhook.js");
const { PLUMCONNECT_ENABLED_ENV } = await import("../config/plumconnect.js");
const { EXPENSE_FLOW_TTL_ENV } = await import("../services/plumconnect/expenseInFlow.js");
const { default: User } = await import("../models/User.js");
const { default: ExpenseReply } = await import("../models/ExpenseReply.js");
const { default: ExpenseCapture } = await import("../models/ExpenseCapture.js");
const { default: ExpenseWaSession } = await import("../models/ExpenseWaSession.js");
const { default: Contact } = await import("../models/plumconnect/Contact.js");
const { default: Conversation } = await import("../models/plumconnect/Conversation.js");
const { default: Message } = await import("../models/plumconnect/Message.js");

const app = express();
app.use("/api/whatsapp", express.raw({ type: "application/json" }), router);

let mongod: MongoMemoryServer;
const PN = "1265026903369191";
const STRANGER = "919111111111";
const EMPLOYEE = "919876543210";
const WS = new mongoose.Types.ObjectId();

function sign(body: string) {
  return "sha256=" + crypto.createHmac("sha256", "test-app-secret").update(body).digest("hex");
}

function post(messages: any[], contacts: any[] = []) {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "919972267336", phone_number_id: PN }, contacts, messages } }] }],
  });
  return request(app).post("/api/whatsapp/webhook").set("Content-Type", "application/json").set("x-hub-signature-256", sign(body)).send(body);
}

let n = 0;
const wamid = () => `wamid.HBg${++n}`;
const text = (from: string, body: string, extra: Record<string, any> = {}) => ({ id: wamid(), from, timestamp: "1758369600", type: "text", text: { body }, ...extra });
const image = (from: string) => ({ id: wamid(), from, timestamp: "1758369600", type: "image", image: { id: "MEDIA1", mime_type: "image/jpeg", sha256: "x", caption: "lunch" } });
const button = (from: string, id: string) => ({ id: wamid(), from, timestamp: "1758369600", type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: id } } });

async function raw(model: any, filter: any) {
  const d = await model.collection.findOne(filter);
  if (!d) return null;
  const { _id, __v, createdAt, updatedAt, ...rest } = d;
  return rest;
}

async function chainFingerprint() {
  const a = await ExpenseCapture.collection.find({}).sort({ _id: 1 }).toArray();
  const b = await ExpenseReply.collection.find({}).sort({ _id: 1 }).toArray();
  const c = await ExpenseWaSession.collection.find({}).sort({ _id: 1 }).toArray();
  return crypto.createHash("sha256").update(JSON.stringify([a, b, c])).digest("hex");
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([User.syncIndexes(), ExpenseReply.syncIndexes(), ExpenseCapture.syncIndexes(), ExpenseWaSession.syncIndexes(), Contact.syncIndexes(), Conversation.syncIndexes(), Message.syncIndexes()]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), ExpenseReply.deleteMany({}), ExpenseCapture.deleteMany({}), ExpenseWaSession.deleteMany({}), Contact.deleteMany({}), Conversation.deleteMany({}), Message.deleteMany({})]);
  await User.create({ email: "emp@x.test", passwordHash: "x", workspaceId: WS, name: "Bound Employee", status: "ACTIVE", waId: EMPLOYEE });
});

afterEach(() => {
  delete process.env[PLUMCONNECT_ENABLED_ENV];
  delete process.env[EXPENSE_FLOW_TTL_ENV];
});

/* ───────────────────────────── FLAG OFF ───────────────────────────── */

describe("PLUMCONNECT_ENABLED off — byte-identical legacy path", () => {
  it("rejects a bad signature (401) and processes nothing", async () => {
    const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: PN }, messages: [text(STRANGER, "hi")] } }] }] });
    const res = await request(app).post("/api/whatsapp/webhook").set("Content-Type", "application/json").set("x-hub-signature-256", "sha256=" + "0".repeat(64)).send(body);
    expect(res.status).toBe(401);
    expect(await ExpenseReply.countDocuments({})).toBe(0);
  });

  it("stranger text → ExpenseReply row (today's expense default), no PlumConnect records", async () => {
    const m = text(STRANGER, "hi");
    expect((await post([m])).status).toBe(200);
    expect(await raw(ExpenseReply, { messageId: m.id })).toEqual({ messageId: m.id, waId: STRANGER, phoneNumberId: PN, text: "hi", status: "queued", attempts: 0 });
    expect(await Contact.countDocuments({})).toBe(0);
    expect(await Conversation.countDocuments({})).toBe(0);
  });

  it("stranger button → ExpenseReply row with the button id as text", async () => {
    const m = button(STRANGER, "submit");
    await post([m]);
    expect(await raw(ExpenseReply, { messageId: m.id })).toEqual({ messageId: m.id, waId: STRANGER, phoneNumberId: PN, text: "submit", status: "queued", attempts: 0 });
  });

  it("stranger image → tenant-less ExpenseCapture row (the worker will mark it unregistered)", async () => {
    const m = image(STRANGER);
    await post([m]);
    expect(await raw(ExpenseCapture, { messageId: m.id })).toEqual({
      messageId: m.id, mediaId: "MEDIA1", mime: "image/jpeg", mediaType: "image", caption: "lunch", waId: STRANGER, phoneNumberId: PN,
      sourceChannel: "whatsapp", status: "queued", attempts: 0, extractionAttempts: 0,
      extraction: { merchant: null, date: null, amount: null, currency: "INR", taxAmount: null, gstin: null, suggestedCategory: null },
    });
  });

  it("bound employee image → the same ExpenseCapture row shape", async () => {
    const m = image(EMPLOYEE);
    await post([m]);
    const row = await raw(ExpenseCapture, { messageId: m.id });
    expect(row).toMatchObject({ messageId: m.id, waId: EMPLOYEE, status: "queued" });
    expect(row).not.toHaveProperty("workspaceId");
  });

  it("audio is dropped, every message in a batch is processed, redelivery is idempotent", async () => {
    const a = text(STRANGER, "one");
    const b = { id: wamid(), from: STRANGER, type: "audio", audio: { id: "AUD" } };
    const c = text(EMPLOYEE, "two");
    await post([a, b, c]);
    await post([a, b, c]);
    expect(await ExpenseReply.countDocuments({})).toBe(2);
    expect(await ExpenseCapture.countDocuments({})).toBe(0);
  });
});

/* ───────────────────────────── FLAG ON ───────────────────────────── */

describe("PLUMCONNECT_ENABLED on — context-first dispatcher", () => {
  beforeEach(() => {
    process.env[PLUMCONNECT_ENABLED_ENV] = "true";
  });

  it("E2E-C: stranger 'hi' → NO ExpenseReply, NO expense reply, Conversation OPEN/support, inbound Message persisted", async () => {
    const m = text(STRANGER, "hi", {});
    const res = await post([m], [{ profile: { name: "Curious" }, wa_id: STRANGER }]);
    expect(res.status).toBe(200);

    expect(await ExpenseReply.countDocuments({})).toBe(0);
    expect(await ExpenseCapture.countDocuments({})).toBe(0);
    expect(await ExpenseWaSession.countDocuments({})).toBe(0);

    const contact = await Contact.findOne({ phone: STRANGER }).lean();
    expect(contact).toMatchObject({ displayName: "Curious", identityState: "unknown" });
    const conv = await Conversation.findOne({ contactId: contact!._id }).lean();
    expect(conv).toMatchObject({ kind: "support", status: "OPEN", channel: "whatsapp", channelAccountId: PN });
    const msg = await Message.findOne({ externalId: m.id }).lean();
    expect(msg).toMatchObject({ direction: "INBOUND", type: "text", text: "hi" });
    expect(String(msg!.conversationId)).toBe(String(conv!._id));
  });

  it("E2E-B (enqueue half): bound employee image → the IDENTICAL ExpenseCapture row the legacy path wrote, plus an expense conversation", async () => {
    const m = image(EMPLOYEE);
    // legacy row for the same message shape, captured with the flag off
    delete process.env[PLUMCONNECT_ENABLED_ENV];
    const legacyMsg = image(EMPLOYEE);
    await post([legacyMsg]);
    const legacy = await raw(ExpenseCapture, { messageId: legacyMsg.id });
    process.env[PLUMCONNECT_ENABLED_ENV] = "true";

    await post([m], [{ profile: { name: "Bound Employee" }, wa_id: EMPLOYEE }]);
    const viaDispatcher = await raw(ExpenseCapture, { messageId: m.id });
    expect(viaDispatcher).toEqual({ ...legacy, messageId: m.id });
    expect(viaDispatcher).not.toHaveProperty("workspaceId"); // the chain assigns it, not the router

    const contact = await Contact.findOne({ phone: EMPLOYEE }).lean();
    expect(contact!.identityState).toBe("verified_employee");
    expect(String(contact!.refs.userId)).toBe(String((await User.findOne({ waId: EMPLOYEE }))!._id));
    expect((await Conversation.findOne({ contactId: contact!._id }).lean())!.kind).toBe("expense");
  });

  it("bound employee text and button → identical ExpenseReply rows", async () => {
    const t = text(EMPLOYEE, "confirm");
    const b = button(EMPLOYEE, "add_to_claim");
    await post([t, b]);
    expect(await raw(ExpenseReply, { messageId: t.id })).toEqual({ messageId: t.id, waId: EMPLOYEE, phoneNumberId: PN, text: "confirm", status: "queued", attempts: 0 });
    expect(await raw(ExpenseReply, { messageId: b.id })).toEqual({ messageId: b.id, waId: EMPLOYEE, phoneNumberId: PN, text: "add_to_claim", status: "queued", attempts: 0 });
  });

  it("INACTIVE employee with a waId → NOT routed to expense (support), no row", async () => {
    await User.updateOne({ waId: EMPLOYEE }, { $set: { status: "INACTIVE" } });
    await post([image(EMPLOYEE)]);
    expect(await ExpenseCapture.countDocuments({})).toBe(0);
    expect((await Conversation.findOne({}).lean())!.kind).toBe("support");
  });

  it("soft-matched employee (phone, no waId) sending a receipt → support, no ExpenseCapture, labelled soft_employee", async () => {
    await User.create({ email: "soft@x.test", passwordHash: "x", workspaceId: WS, name: "Soft", phone: "+91 92222 22222" });
    await post([image("919222222222")]);
    expect(await ExpenseCapture.countDocuments({})).toBe(0);
    const contact = await Contact.findOne({ phone: "919222222222" }).lean();
    expect(contact!.identityState).toBe("soft_employee");
    expect(contact!.refs.userId).toBeNull();
  });

  it("CTWA referral from a stranger → lead conversation with referralRaw, no expense row", async () => {
    const referral = { source_url: "https://fb.me/x", source_type: "ad", source_id: "1202", headline: "Bali", body: "7 nights", media_type: "image", ctwa_clid: "AfeXYZ" };
    const m = text(STRANGER, "saw your ad", { referral });
    await post([m]);
    expect(await ExpenseReply.countDocuments({})).toBe(0);
    const conv = await Conversation.findOne({}).lean();
    expect(conv!.kind).toBe("lead");
    expect(conv!.referralRaw).toEqual(referral);
    expect((await Message.findOne({ externalId: m.id }).lean())!.payload).toMatchObject({ referral });
  });

  it("arrival branch still wins before the dispatcher (arr_ button never reaches PlumConnect)", async () => {
    // No ArrivalSession exists, so dispatchArrivalInbound will silently drop it —
    // the point is that the dispatcher never saw it.
    const m = { id: wamid(), from: STRANGER, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "arr_help", title: "Help" } } };
    await post([m]);
    expect(await Message.countDocuments({ externalId: m.id })).toBe(0);
    expect(await ExpenseReply.countDocuments({})).toBe(0);
  });

  it("dispatcher failure is logged and acked, never falls back to the expense default", async () => {
    // A message with an unusable sender phone is 'dropped' inside the dispatcher.
    const m = text("not-a-number", "hi");
    const res = await post([m]);
    expect(res.status).toBe(200);
    expect(await ExpenseReply.countDocuments({})).toBe(0);
    expect(await Conversation.countDocuments({})).toBe(0);
  });

  describe("stale-session edge — read-only over the chain's collections", () => {
    async function seedCapture(status: string, ageMs: number) {
      const t = new Date(Date.now() - ageMs);
      await ExpenseCapture.collection.insertOne({
        messageId: `wamid.seed.${Math.random()}`, mediaId: "m", mime: "image/jpeg", mediaType: "image", waId: EMPLOYEE, phoneNumberId: PN,
        sourceChannel: "whatsapp", status, attempts: 1, extractionAttempts: 1, workspaceId: WS, createdAt: t, updatedAt: t,
      });
    }

    it("a FRESH awaiting_confirmation capture → in-flow route; the chain's collections are untouched except the new reply row", async () => {
      await seedCapture("awaiting_confirmation", 2 * 3600_000);
      const before = await chainFingerprint();
      const m = text(EMPLOYEE, "1");
      await post([m]);
      // the only change to the chain's collections is the ExpenseReply row this message produced
      await ExpenseReply.deleteOne({ messageId: m.id });
      expect(await chainFingerprint()).toBe(before);
      const conv = await Conversation.findOne({}).lean();
      expect(conv!.kind).toBe("expense");
    });

    it("a STALE awaiting_confirmation capture (older than the window) → NOT in-flow; the stale row is not touched", async () => {
      process.env[EXPENSE_FLOW_TTL_ENV] = String(60 * 60 * 1000); // 1h window
      await seedCapture("awaiting_confirmation", 5 * 3600_000);
      const staleBefore = await ExpenseCapture.collection.findOne({ waId: EMPLOYEE });
      const before = await chainFingerprint();

      // With a referral present, a stale flow must NOT hijack the message.
      const m = text(EMPLOYEE, "saw your ad", { referral: { source_type: "ad", source_id: "1", ctwa_clid: "c" } });
      await post([m]);

      expect(await chainFingerprint()).toBe(before); // no ExpenseReply row either: referral routed to lead
      expect(await ExpenseCapture.collection.findOne({ waId: EMPLOYEE })).toEqual(staleBefore);
      expect((await Conversation.findOne({}).lean())!.kind).toBe("lead");
    });

    it("the same stale capture without a referral → verified-employee route (chain reply), stale row still untouched", async () => {
      process.env[EXPENSE_FLOW_TTL_ENV] = String(60 * 60 * 1000);
      await seedCapture("awaiting_confirmation", 5 * 3600_000);
      const staleBefore = await ExpenseCapture.collection.findOne({ waId: EMPLOYEE });
      const m = text(EMPLOYEE, "hello");
      await post([m]);
      expect(await ExpenseCapture.collection.findOne({ waId: EMPLOYEE })).toEqual(staleBefore);
      expect(await ExpenseReply.countDocuments({ messageId: m.id })).toBe(1); // bound employee → chain, as today
    });
  });
});
