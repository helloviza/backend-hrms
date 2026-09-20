// PlumConnect Slice 3b — E2E-A (capture half) through the real webhook:
// a stranger taps a CTWA ad → referral parsed → Contact → Lead (holiday
// motion, WhatsApp transport, attribution) → lead-kind Conversation with the
// verbatim referral + the inbound Message → exactly one lead.created. Then
// dedup on the same phone, the assignee fallback, the two Slice-2 routes
// that must be unchanged, and flag OFF = byte-identical Slice-2 behaviour.
// Nothing is sent: the Cloud service is not mocked and never called.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import crypto from "node:crypto";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-ctwa-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.NODE_ENV = "test";
process.env.WA_APP_SECRET = "test-app-secret";
delete process.env.PLUMCONNECT_ENABLED;

const H = vi.hoisted(() => ({ trigger: vi.fn(), send: vi.fn() }));
vi.mock("../services/taskAutomation.js", async (importOriginal) => {
  const real: any = await importOriginal();
  H.trigger.mockImplementation(real.triggerTaskAutomation);
  return { ...real, triggerTaskAutomation: H.trigger };
});
// Keep the HMAC real; make every sender a spy that must stay uncalled.
vi.mock("../services/whatsappCloud.service.js", async (importOriginal) => {
  const real: any = await importOriginal();
  return {
    ...real,
    sendTextMessage: H.send,
    sendTextMessageResult: H.send,
    sendButtonMessage: H.send,
    sendTemplateMessage: H.send,
    sendTemplateWithImageHeader: H.send,
  };
});

const { default: router } = await import("./whatsapp.webhook.js");
const { PLUMCONNECT_ENABLED_ENV, PLUMCONNECT_HOLIDAY_LEAD_ASSIGNEE_ENV } = await import("../config/plumconnect.js");
const { SYSTEM_WORKSPACE_ID } = await import("../config/defaultTaskAutomations.js");
const { default: User } = await import("../models/User.js");
const { default: Lead } = await import("../models/Lead.js");
const { default: LeadActivity } = await import("../models/LeadActivity.js");
const { default: Task } = await import("../models/Task.js");
const { default: TaskAutomation } = await import("../models/TaskAutomation.js");
const { default: Counter } = await import("../models/Counter.js");
const { default: ExpenseReply } = await import("../models/ExpenseReply.js");
const { default: ExpenseCapture } = await import("../models/ExpenseCapture.js");
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
const ADMIN = new mongoose.Types.ObjectId();
const SALES = new mongoose.Types.ObjectId();

const REFERRAL = {
  source_url: "https://www.instagram.com/p/bali-ad/",
  source_type: "ad",
  source_id: "120212345678901234",
  headline: "Bali from ₹49,999",
  body: "7 nights, flights included",
  media_type: "image",
  ctwa_clid: "AfeXYZ123",
};

function sign(body: string) {
  return "sha256=" + crypto.createHmac("sha256", "test-app-secret").update(body).digest("hex");
}
function post(messages: any[], contacts: any[] = []) {
  const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: PN }, contacts, messages } }] }] });
  return request(app).post("/api/whatsapp/webhook").set("Content-Type", "application/json").set("x-hub-signature-256", sign(body)).send(body);
}
let n = 0;
const wamid = () => `wamid.CTWA${++n}`;
const text = (from: string, body: string, extra: Record<string, any> = {}) => ({ id: wamid(), from, timestamp: "1758369600", type: "text", text: { body }, ...extra });
const profile = (from: string, name: string) => [{ wa_id: from, profile: { name } }];

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([User.syncIndexes(), Lead.syncIndexes(), Contact.syncIndexes(), Conversation.syncIndexes(), Message.syncIndexes()]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  H.trigger.mockClear();
  H.send.mockClear();
  delete process.env.CRM_V2_OPPORTUNITY;
  await Promise.all([User.deleteMany({}), Lead.deleteMany({}), LeadActivity.deleteMany({}), Task.deleteMany({}), TaskAutomation.deleteMany({}), Counter.deleteMany({}), ExpenseReply.deleteMany({}), ExpenseCapture.deleteMany({}), Contact.deleteMany({}), Conversation.deleteMany({}), Message.deleteMany({})]);
  await User.collection.insertOne({ _id: ADMIN, name: "Ops Admin", email: "ops@plumtrips.com", roles: ["ADMIN"], passwordHash: "x", workspaceId: WS } as any);
  await User.collection.insertOne({ _id: SALES, name: "Sana Holiday", email: "sana@plumtrips.com", roles: ["EMPLOYEE"], passwordHash: "x", workspaceId: WS } as any);
  await User.create({ email: "emp@x.test", passwordHash: "x", workspaceId: WS, name: "Bound Employee", status: "ACTIVE", waId: EMPLOYEE });
  process.env[PLUMCONNECT_ENABLED_ENV] = "true";
});

afterEach(() => {
  delete process.env[PLUMCONNECT_ENABLED_ENV];
  delete process.env[PLUMCONNECT_HOLIDAY_LEAD_ASSIGNEE_ENV];
});

describe("E2E-A capture half — stranger taps a CTWA ad", () => {
  it("referral → Contact → holiday Lead with attribution → lead Conversation + inbound Message; one lead.created; nothing sent", async () => {
    process.env[PLUMCONNECT_HOLIDAY_LEAD_ASSIGNEE_ENV] = String(SALES);
    await TaskAutomation.create({ workspaceId: SYSTEM_WORKSPACE_ID, triggerKey: "lead.created", label: "welcome", entityType: "LEAD", titleTemplate: "Welcome {{leadName}}", dueOffsetMinutes: 60, priority: "MEDIUM", assigneeRule: { type: "OWNER" }, tags: [] });

    const m = text(STRANGER, "Hi, saw your Bali ad", { referral: REFERRAL });
    const res = await post([m], profile(STRANGER, "Curious Traveller"));
    expect(res.status).toBe(200);

    // Contact
    const contact = await Contact.findOne({ phone: STRANGER }).lean();
    expect(contact).toMatchObject({ displayName: "Curious Traveller", identityState: "unknown" });
    expect(contact!.refs.userId).toBeNull();

    // Lead
    const leads = await Lead.find({}).lean();
    expect(leads).toHaveLength(1);
    const lead: any = leads[0];
    expect(lead).toMatchObject({
      type: "individual",
      contactName: "Curious Traveller",
      contactPhone: STRANGER,
      enquiryType: "holiday_package",
      sourceChannel: "whatsapp",
      source: "instagram",
      stage: "new",
      assignedToName: "Sana Holiday",
      companyId: null,
    });
    expect(String(lead.assignedTo)).toBe(String(SALES));
    expect(lead.attribution).toMatchObject({
      channel: "whatsapp",
      sourceType: "ad",
      sourceId: "120212345678901234",
      sourceUrl: REFERRAL.source_url,
      ctwaClid: "AfeXYZ123",
      headline: "Bali from ₹49,999",
      body: "7 nights, flights included",
      mediaType: "image",
    });
    expect(lead.attribution.capturedAt).toBeInstanceOf(Date);

    // Conversation + Message
    const conv = await Conversation.findOne({ contactId: contact!._id }).lean();
    expect(conv).toMatchObject({ kind: "lead", status: "OPEN", channelAccountId: PN });
    expect(conv!.referralRaw).toEqual(REFERRAL);
    expect(String(conv!.leadId)).toBe(String(lead._id));
    expect(String(lead.attribution.conversationId)).toBe(String(conv!._id));
    expect(contact!.refs.leadIds.map(String)).toEqual([String(lead._id)]);
    const msg = await Message.findOne({ externalId: m.id }).lean();
    expect(msg).toMatchObject({ direction: "INBOUND", type: "text", text: "Hi, saw your Bali ad" });
    expect((msg!.payload as any).referral).toEqual(REFERRAL);

    // exactly one lead.created; the Task lands via the handle the adapter ignored
    expect(H.trigger).toHaveBeenCalledTimes(1);
    expect(H.trigger.mock.calls[0][0]).toBe("lead.created");
    await H.trigger.mock.results[0].value;
    expect(await Task.countDocuments({})).toBe(1);

    // no expense side-effects, no outbound
    expect(await ExpenseReply.countDocuments({})).toBe(0);
    expect(await ExpenseCapture.countDocuments({})).toBe(0);
    expect(H.send).not.toHaveBeenCalled();
  });

  it("dedup: the same phone tapping a second ad → NO second Lead; touch recorded; first attribution intact; leadIds still 1", async () => {
    const first = text(STRANGER, "saw the Bali ad", { referral: REFERRAL });
    await post([first], profile(STRANGER, "Curious"));
    const leadBefore: any = await Lead.findOne({}).lean();

    const second = text(STRANGER, "continue my Bali trip", { referral: { ...REFERRAL, headline: "Bali — last seats!", ctwa_clid: "AfeSECOND" } });
    await post([second], profile(STRANGER, "Curious"));

    expect(await Lead.countDocuments({})).toBe(1);
    const leadAfter: any = await Lead.findOne({}).lean();
    expect(leadAfter.attribution).toEqual(leadBefore.attribution); // first touch wins
    expect(leadAfter.attribution.ctwaClid).toBe("AfeXYZ123");

    expect(await Conversation.countDocuments({})).toBe(1);
    const conv = await Conversation.findOne({}).lean();
    expect(conv!.referralRaw).toEqual(REFERRAL); // the verbatim FIRST referral stays on the thread
    const msgs = await Message.find({ conversationId: conv!._id }).sort({ createdAt: 1 }).lean();
    expect(msgs.map((x) => x.type)).toEqual(["text", "text", "system"]); // two inbounds + the touch record
    expect(msgs[2].text).toContain("Bali — last seats!");
    expect((msgs[2].payload as any).inboundExternalId).toBe(second.id);

    const acts = await LeadActivity.find({ leadId: leadAfter._id }).lean();
    expect(acts.filter((a) => a.note.includes("repeat touch"))).toHaveLength(1);
    expect((await Contact.findOne({ phone: STRANGER }).lean())!.refs.leadIds).toHaveLength(1);
    expect(H.trigger).toHaveBeenCalledTimes(1); // lead.created fired once, on the first touch only
    expect(H.send).not.toHaveBeenCalled();
  });

  it("assignee fallback: config unset → first admin; config set → that user", async () => {
    await post([text(STRANGER, "ad", { referral: REFERRAL })], profile(STRANGER, "A"));
    let lead: any = await Lead.findOne({ contactName: "A" }).lean();
    expect(String(lead.assignedTo)).toBe(String(ADMIN));
    expect(lead.assignedToName).toBe("Ops Admin");

    process.env[PLUMCONNECT_HOLIDAY_LEAD_ASSIGNEE_ENV] = String(SALES);
    await post([text("919222222222", "ad", { referral: REFERRAL })], profile("919222222222", "B"));
    lead = await Lead.findOne({ contactName: "B" }).lean();
    expect(String(lead.assignedTo)).toBe(String(SALES));
    expect(lead.assignedToName).toBe("Sana Holiday");
  });

  it("no profile name → 'WhatsApp contact' placeholder; a redelivered wamid does not create a second Lead", async () => {
    const m = text(STRANGER, "ad", { referral: REFERRAL });
    await post([m]);
    await post([m]);
    expect(await Lead.countDocuments({})).toBe(1);
    expect((await Lead.findOne({}).lean())!.contactName).toBe("WhatsApp contact");
    expect(await Message.countDocuments({ externalId: m.id })).toBe(1);
    expect(H.trigger).toHaveBeenCalledTimes(1);
  });
});

describe("Slice-2 routes unchanged by 3b", () => {
  it("non-referral stranger → support conversation, no Lead", async () => {
    await post([text(STRANGER, "hi")], profile(STRANGER, "Curious"));
    expect(await Lead.countDocuments({})).toBe(0);
    expect((await Conversation.findOne({}).lean())!.kind).toBe("support");
    expect(H.trigger).not.toHaveBeenCalled();
  });

  it("bound employee text → expense wrap (ExpenseReply row), no Lead", async () => {
    const m = text(EMPLOYEE, "confirm");
    await post([m]);
    expect(await ExpenseReply.countDocuments({ messageId: m.id })).toBe(1);
    expect(await Lead.countDocuments({})).toBe(0);
    expect((await Conversation.findOne({}).lean())!.kind).toBe("expense");
  });

  it("bound employee WITH a referral → lead thread, no Lead row, no expense row", async () => {
    const m = text(EMPLOYEE, "saw the ad", { referral: REFERRAL });
    await post([m]);
    expect(await Lead.countDocuments({})).toBe(0);
    expect(await ExpenseReply.countDocuments({})).toBe(0);
    const conv = await Conversation.findOne({}).lean();
    expect(conv!.kind).toBe("lead");
    expect(conv!.referralRaw).toEqual(REFERRAL);
    expect(conv!.leadId).toBeNull();
    expect(H.trigger).not.toHaveBeenCalled();
  });
});

describe("FLAG OFF — byte-identical to Slice 2 / legacy", () => {
  it("a CTWA referral from a stranger creates NO Lead, NO Conversation, NO Contact; the legacy expense default still fires", async () => {
    delete process.env[PLUMCONNECT_ENABLED_ENV];
    const m = text(STRANGER, "saw your ad", { referral: REFERRAL });
    expect((await post([m], profile(STRANGER, "Curious"))).status).toBe(200);
    expect(await Lead.countDocuments({})).toBe(0);
    expect(await Conversation.countDocuments({})).toBe(0);
    expect(await Contact.countDocuments({})).toBe(0);
    expect(await Message.countDocuments({})).toBe(0);
    expect(H.trigger).not.toHaveBeenCalled();
    expect(await ExpenseReply.countDocuments({ messageId: m.id })).toBe(1); // today's behaviour, untouched
  });
});
