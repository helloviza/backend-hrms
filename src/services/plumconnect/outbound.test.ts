// PlumConnect Slice 4a, Part B — the universal outbound wrapper. Real
// senders over a fake Graph adapter, real PlumConnect models on
// mongodb-memory-server. Flag OFF = pass-through with zero writes; flag ON =
// one OUTBOUND Message per accepted send with the real wamid, on the
// recipient's Contact/Conversation of the right kind; persistence failures
// never break or double a send.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import axios from "axios";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-outbound-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.WA_ACCESS_TOKEN = "test-token";
process.env.WA_PHONE_NUMBER_ID = "1265026903369191";
delete process.env.PLUMCONNECT_ENABLED;

const { outboundFor, persistSend, sendTextOutcome } = await import("./outbound.js");
const { sendAndPersist } = await import("./send.js");
const { default: Contact } = await import("../../models/plumconnect/Contact.js");
const { default: Conversation } = await import("../../models/plumconnect/Conversation.js");
const { default: Message } = await import("../../models/plumconnect/Message.js");

const graph: any[] = [];
let wamidSeq = 0;
let mode: "ok" | "fail" = "ok";
axios.defaults.adapter = async (config) => {
  const body = JSON.parse(config.data);
  graph.push(body);
  if (mode === "fail") {
    const err: any = new Error("Request failed with status code 400");
    err.isAxiosError = true;
    err.config = config;
    err.response = { status: 400, data: { error: { message: "nope", code: 1 } }, headers: {}, config };
    throw err;
  }
  return { data: { messages: [{ id: `wamid.W${++wamidSeq}` }] }, status: 200, statusText: "OK", headers: {}, config };
};

let mongod: MongoMemoryServer;
const TO = "919876543210";
const NOW = new Date("2026-09-20T12:00:00Z");

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Contact.syncIndexes(), Conversation.syncIndexes(), Message.syncIndexes()]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  graph.length = 0;
  wamidSeq = 0;
  mode = "ok";
  vi.restoreAllMocks();
  await Promise.all([Contact.deleteMany({}), Conversation.deleteMany({}), Message.deleteMany({})]);
});

afterEach(() => {
  delete process.env.PLUMCONNECT_ENABLED;
});

const rows = async () => ({ contacts: await Contact.countDocuments({}), conversations: await Conversation.countDocuments({}), messages: await Message.countDocuments({}) });

/* ───────────────────────────── flag OFF ───────────────────────────── */

describe("FLAG OFF — pass-through, zero PlumConnect writes", () => {
  it("a legacy expense send goes out exactly as before and writes nothing", async () => {
    const { sendTextMessage, sendButtonMessage } = outboundFor("expense");
    const r = await sendTextMessage(TO, "You're not registered — please contact your admin");
    await sendButtonMessage(TO, "Receipt read", [{ id: "confirm", title: "Confirm" }]);
    expect(graph).toHaveLength(2);
    expect(graph[0]).toMatchObject({ type: "text", to: TO, text: { body: "You're not registered — please contact your admin" } });
    expect(graph[1]).toMatchObject({ type: "interactive" });
    expect(r.ok).toBe(true); // the outcome is returned, nobody in the chain reads it
    expect(await rows()).toEqual({ contacts: 0, conversations: 0, messages: 0 });
  });

  it("legacy arrival/trip senders keep their boolean contract and write nothing", async () => {
    expect(await outboundFor("arrival").sendTextMessageResult(TO, "hi")).toBe(true);
    expect(await outboundFor("trip").sendTemplateMessage(TO, "flight_disruption", ["AI-101", "BLR→DEL", "delayed", "18:40"])).toBe(true);
    mode = "fail";
    expect(await outboundFor("arrival").sendTextMessageResult(TO, "hi")).toBe(false);
    expect(await outboundFor("trip").sendTemplateMessage(TO, "flight_disruption", [])).toBe(false);
    expect(graph).toHaveLength(4);
    expect(await rows()).toEqual({ contacts: 0, conversations: 0, messages: 0 });
  });

  it("persistSend itself is a no-op with the flag off", async () => {
    const p = await persistSend({ to: TO, type: "text", text: "x", payload: {}, outcome: { ok: true, wamid: "wamid.X", raw: {} } }, { origin: "expense" });
    expect(p).toEqual({ messageId: null, persistFailed: false });
    expect(await rows()).toEqual({ contacts: 0, conversations: 0, messages: 0 });
  });
});

/* ───────────────────────────── flag ON ───────────────────────────── */

describe("FLAG ON — every accepted send persists once, on the right thread", () => {
  beforeEach(() => {
    process.env.PLUMCONNECT_ENABLED = "true";
  });

  it("bot send (known conversation) → one OUTBOUND Message with the real wamid on that conversation", async () => {
    const contact = await Contact.create({ phone: TO, identityState: "unknown" });
    const conv = await Conversation.create({ contactId: contact._id, kind: "lead" });
    const r = await sendAndPersist({ conversationId: conv._id as any, to: TO, text: "what's your name?", payload: { bot: "ask_name" }, now: NOW });
    expect(r).toMatchObject({ sent: true, wamid: "wamid.W1", persistFailed: false });
    const msgs = await Message.find({ conversationId: conv._id }).lean();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ direction: "OUTBOUND", externalId: "wamid.W1", type: "text", text: "what's your name?", deliveryStatus: "sent", authorUserId: null });
    expect((msgs[0].payload as any)).toMatchObject({ origin: "bot", bot: "ask_name" });
    expect(await rows()).toEqual({ contacts: 1, conversations: 1, messages: 1 });
    expect((await Conversation.findById(conv._id).lean())!.lastOutboundAt).toEqual(NOW);
  });

  it("legacy ARRIVAL send (no conversation known) → Contact + arrival Conversation resolved, one Message; a second send reuses the thread", async () => {
    const { sendTextMessageResult, sendButtonMessage } = outboundFor("arrival");
    expect(await sendTextMessageResult(TO, "Welcome to Bali!")).toBe(true);
    await sendButtonMessage(TO, "How can I help?", [{ id: "arr_hotel", title: "Hotel" }, { id: "arr_help", title: "Help" }]);

    const contact = await Contact.findOne({ phone: TO }).lean();
    expect(contact).toMatchObject({ identityState: "unknown" });
    expect(contact!.firstSeenAt).toBeInstanceOf(Date);
    const convs = await Conversation.find({ contactId: contact!._id }).lean();
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ kind: "arrival", status: "OPEN", channelAccountId: "1265026903369191" });
    const msgs = await Message.find({ conversationId: convs[0]._id }).sort({ createdAt: 1 }).lean();
    expect(msgs.map((m) => [m.type, m.externalId])).toEqual([["text", "wamid.W1"], ["interactive", "wamid.W2"]]);
    expect((msgs[1].payload as any)).toMatchObject({ origin: "arrival", buttons: ["arr_hotel", "arr_help"] });
  });

  it("legacy TRIP template send → trip Conversation, template Message with name/params", async () => {
    expect(await outboundFor("trip").sendTemplateMessage(TO, "flight_disruption", ["AI-101", "BLR→DEL", "delayed 40m", "18:40"])).toBe(true);
    const conv = await Conversation.findOne({}).lean();
    expect(conv!.kind).toBe("trip");
    const msg = await Message.findOne({}).lean();
    expect(msg).toMatchObject({ type: "template", externalId: "wamid.W1" });
    expect(msg!.text).toBe("[template flight_disruption] AI-101 · BLR→DEL · delayed 40m · 18:40");
    expect((msg!.payload as any)).toMatchObject({ origin: "trip", template: "flight_disruption", params: ["AI-101", "BLR→DEL", "delayed 40m", "18:40"], language: "en" });
  });

  it("legacy EXPENSE send to a bound employee lands on the dispatcher's existing expense thread (no new conversation)", async () => {
    const contact = await Contact.create({ phone: TO, identityState: "verified_employee", refs: { userId: new mongoose.Types.ObjectId() } });
    const conv = await Conversation.create({ contactId: contact._id, kind: "expense" });
    await outboundFor("expense").sendButtonMessage(TO, "🧾 Receipt read:", [{ id: "confirm", title: "Confirm" }, { id: "fix_amount", title: "Fix amount" }, { id: "cancel", title: "Cancel" }]);
    expect(await rows()).toEqual({ contacts: 1, conversations: 1, messages: 1 });
    const msg = await Message.findOne({}).lean();
    expect(String(msg!.conversationId)).toBe(String(conv._id));
    // identity on the contact is never touched by a legacy send
    expect((await Contact.findById(contact._id).lean())!.identityState).toBe("verified_employee");
  });

  it("image-header template send (Sales Pulse shape) → persisted with the header media id", async () => {
    const r = await outboundFor("expense").sendTemplateWithImageHeader(TO, "plumtrips_report_ready", "en", "MEDIA-7", ["EOD", "20 Sep"]);
    expect(r).toMatchObject({ sent: true, wamid: "wamid.W1" });
    const msg = await Message.findOne({}).lean();
    expect((msg!.payload as any)).toMatchObject({ template: "plumtrips_report_ready", headerMediaId: "MEDIA-7", params: ["EOD", "20 Sep"] });
  });

  it("forced Message-write failure: the send still happened ONCE, no throw, the legacy caller still sees true", async () => {
    const spy = vi.spyOn(Message, "create").mockRejectedValueOnce(new Error("disk full"));
    const ok = await outboundFor("arrival").sendTextMessageResult(TO, "still sent");
    expect(ok).toBe(true);
    expect(graph).toHaveLength(1);
    expect(await Message.countDocuments({})).toBe(0);
    // the outcome-level API reports it
    const w = await sendTextOutcome(TO, "again", { origin: "arrival" });
    expect(w.persisted.persistFailed).toBe(false);
    expect(graph).toHaveLength(2);
    spy.mockRestore();
  });

  it("Meta rejects (400): legacy caller sees false, nothing persisted, no Contact created", async () => {
    mode = "fail";
    expect(await outboundFor("arrival").sendTextMessageResult(TO, "x")).toBe(false);
    expect(await outboundFor("trip").sendTemplateMessage(TO, "t", [])).toBe(false);
    const o = await outboundFor("expense").sendTextMessage(TO, "x");
    expect(o.ok).toBe(false);
    expect(graph).toHaveLength(3);
    expect(await rows()).toEqual({ contacts: 0, conversations: 0, messages: 0 });
  });

  it("an unusable recipient is sent as the caller asked but never persisted", async () => {
    await outboundFor("expense").sendTextMessage("not-a-number", "x");
    expect(graph).toHaveLength(1);
    expect(await rows()).toEqual({ contacts: 0, conversations: 0, messages: 0 });
  });

  it("button fallback: interactive rejected → text fallback sent → the persisted Message is the text that actually went out", async () => {
    let n = 0;
    const saved = axios.defaults.adapter;
    axios.defaults.adapter = async (config) => {
      const body = JSON.parse(config.data);
      graph.push(body);
      n += 1;
      if (n === 1) {
        const err: any = new Error("Request failed with status code 400");
        err.isAxiosError = true;
        err.config = config;
        err.response = { status: 400, data: { error: { message: "no buttons for you" } }, headers: {}, config };
        throw err;
      }
      return { data: { messages: [{ id: "wamid.FALLBACK" }] }, status: 200, statusText: "OK", headers: {}, config };
    };
    try {
      await outboundFor("expense").sendButtonMessage(TO, "Receipt read", [{ id: "confirm", title: "Confirm" }]);
      expect(graph.map((g) => g.type)).toEqual(["interactive", "text"]);
      const msg = await Message.findOne({}).lean();
      expect(msg!.externalId).toBe("wamid.FALLBACK");
      expect(await Message.countDocuments({})).toBe(1);
    } finally {
      axios.defaults.adapter = saved;
    }
  });
});

describe("no interceptor, no async-context plumbing remains", () => {
  it("send.ts and outbound.ts contain neither", async () => {
    const fs = await import("node:fs");
    for (const f of ["send.ts", "outbound.ts"]) {
      const src = fs.readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(src).not.toMatch(/interceptors\.response\.use/);
      expect(src).not.toMatch(/new AsyncLocalStorage|from "node:async_hooks"/);
    }
  });
});
