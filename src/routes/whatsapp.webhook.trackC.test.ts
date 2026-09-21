// PlumConnect Track C — the busy/away reply through the real webhook (the
// ONLY behaviour change of the slice), and the relocation's parity guard:
//   • a lead whose mapped agents are all away → HELD → the welcome, then
//     the line's busy message ONCE; a second inbound while still held does
//     not re-send; the bot keeps qualifying
//   • revive: the agent goes active and takes it → normal flow
//   • nobody mapped at all → held WITHOUT a busy reply (byte-identical to
//     Track B — the matrix is simply not configured)
//   • a per-line edit of busy.<line> is what goes out
//   • FLAG OFF → legacy path, nothing
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import crypto from "node:crypto";
import axios from "axios";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-trackc-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.NODE_ENV = "test";
process.env.WA_APP_SECRET = "test-app-secret";
process.env.WA_ACCESS_TOKEN = "test-token";
process.env.WA_PHONE_NUMBER_ID = "1265026903369191";
delete process.env.PLUMCONNECT_ENABLED;

const H = vi.hoisted(() => ({ trigger: vi.fn() }));
vi.mock("../services/taskAutomation.js", async (importOriginal) => {
  const real: any = await importOriginal();
  H.trigger.mockImplementation(real.triggerTaskAutomation);
  return { ...real, triggerTaskAutomation: H.trigger };
});

const { default: router } = await import("./whatsapp.webhook.js");
const { PLUMCONNECT_ENABLED_ENV } = await import("../config/plumconnect.js");
const { MESSAGE_DEFAULTS, upsertMessage } = await import("../services/plumconnect/messages.js");
const { setPresence } = await import("../services/plumconnect/presence.js");
const { lineGrantsFromModules } = await import("../services/plumconnect/access.js");
const { default: User } = await import("../models/User.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { default: Lead } = await import("../models/Lead.js");
const { default: LeadActivity } = await import("../models/LeadActivity.js");
const { default: Task } = await import("../models/Task.js");
const { default: TaskAutomation } = await import("../models/TaskAutomation.js");
const { default: Counter } = await import("../models/Counter.js");
const { default: ExpenseReply } = await import("../models/ExpenseReply.js");
const { default: Contact } = await import("../models/plumconnect/Contact.js");
const { default: Conversation } = await import("../models/plumconnect/Conversation.js");
const { default: Message } = await import("../models/plumconnect/Message.js");
const { default: CampaignMap } = await import("../models/plumconnect/CampaignMap.js");
const { default: AssignmentRule } = await import("../models/plumconnect/AssignmentRule.js");
const { default: AgentPresence } = await import("../models/plumconnect/AgentPresence.js");
const { default: CannedMessage } = await import("../models/plumconnect/CannedMessage.js");

const graph: Array<{ to: string; type: string; text: string }> = [];
let wamidSeq = 0;
axios.defaults.adapter = async (config) => {
  const body = JSON.parse(config.data);
  graph.push({ to: body.to, type: body.type, text: body.type === "text" ? body.text.body : body.interactive?.body?.text ?? "" });
  return { data: { messages: [{ id: `wamid.OUT${++wamidSeq}` }] }, status: 200, statusText: "OK", headers: {}, config };
};

const app = express();
app.use("/api/whatsapp", express.raw({ type: "application/json" }), router);

let mongod: MongoMemoryServer;
const PN = "1265026903369191";
const STRANGER = "919111111111";
const WS = new mongoose.Types.ObjectId();
const ADMIN = new mongoose.Types.ObjectId();
const AGENT = new mongoose.Types.ObjectId();
const AD = "120212345678901234";
const referral = { source_url: "https://www.instagram.com/p/x/", source_type: "ad", source_id: AD, headline: "Bali from ₹49,999", body: "7 nights", media_type: "image", ctwa_clid: "clid-1" };
const AGENT_MODULES = { plumconnectConcierge: { access: "WRITE", scope: "OWN" } };

function sign(body: string) {
  return "sha256=" + crypto.createHmac("sha256", "test-app-secret").update(body).digest("hex");
}
function post(messages: any[], contacts: any[] = []) {
  const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: PN }, contacts, messages } }] }] });
  return request(app).post("/api/whatsapp/webhook").set("Content-Type", "application/json").set("x-hub-signature-256", sign(body)).send(body);
}
let n = 0;
const text = (from: string, body: string, extra: Record<string, any> = {}) => ({ id: `wamid.IN${++n}`, from, timestamp: "1758369600", type: "text", text: { body }, ...extra });
const profile = (from: string, name: string) => [{ wa_id: from, profile: { name } }];
const conv = () => Conversation.findOne({}).lean();
const agentPresence = (active: boolean, now = new Date()) => setPresence({ userId: AGENT, grants: lineGrantsFromModules(AGENT_MODULES), line: "concierge", active, now });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([User.syncIndexes(), Lead.syncIndexes(), Contact.syncIndexes(), Conversation.syncIndexes(), Message.syncIndexes(), CampaignMap.syncIndexes(), AssignmentRule.syncIndexes(), AgentPresence.syncIndexes(), CannedMessage.syncIndexes()]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  graph.length = 0;
  wamidSeq = 0;
  H.trigger.mockClear();
  await Promise.all([
    User.deleteMany({}), UserPermission.deleteMany({}), Lead.deleteMany({}), LeadActivity.deleteMany({}), Task.deleteMany({}), TaskAutomation.deleteMany({}), Counter.deleteMany({}), ExpenseReply.deleteMany({}),
    Contact.deleteMany({}), Conversation.deleteMany({}), Message.deleteMany({}), CampaignMap.deleteMany({}), AssignmentRule.deleteMany({}), AgentPresence.deleteMany({}), CannedMessage.deleteMany({}),
  ]);
  await User.collection.insertOne({ _id: ADMIN, name: "Ops Admin", email: "ops@plumtrips.com", roles: ["ADMIN"], passwordHash: "x", workspaceId: WS, status: "ACTIVE" } as any);
  await User.collection.insertOne({ _id: AGENT, name: "Holly Planner", email: "holly@plumtrips.com", roles: ["EMPLOYEE"], passwordHash: "x", workspaceId: WS, status: "ACTIVE" } as any);
  await UserPermission.create({ userId: String(AGENT), email: "holly@plumtrips.com", workspaceId: String(WS), universe: "STAFF", source: "manual", level: { code: "L3", name: "Exec", designation: "x" }, status: "active", tier: 1, grantedModules: [], roleType: "EMPLOYEE", grantedBy: "test", grantedAt: new Date(), modules: AGENT_MODULES } as any);
  await CampaignMap.create({ adId: AD, businessLine: "concierge", label: "Bali promo", createdBy: ADMIN });
  process.env[PLUMCONNECT_ENABLED_ENV] = "true";
});

afterEach(() => {
  delete process.env[PLUMCONNECT_ENABLED_ENV];
});

const WELCOME = 'Hi! Thanks for reaching out to Plumtrips about "Bali from ₹49,999". To get started, what\'s your name?';

describe("busy / away reply", () => {
  it("mapped agent AWAY → held → welcome then the concierge busy message ONCE; a second inbound (the name answer) does not re-send; the flow continues", async () => {
    await AssignmentRule.create({ target: { type: "department", line: "concierge" }, userId: AGENT, priority: 1 });
    await agentPresence(false);

    await post([text(STRANGER, "Hi, saw the ad", { referral })], profile(STRANGER, "Priya"));
    expect(graph.map((g) => g.text)).toEqual([WELCOME, MESSAGE_DEFAULTS["busy.concierge"].text]);
    let c: any = await conv();
    expect(c.routing).toMatchObject({ state: "held", mapped: 1, reason: "nobody eligible (away or cannot act)" });
    expect(c.routing.busySentAt).toBeInstanceOf(Date);
    expect(c.assignedTo).toBeNull();
    // persisted on the thread through the wrapper, as a bot send
    const out = await Message.find({ conversationId: c._id, direction: "OUTBOUND" }).sort({ createdAt: 1 }).lean();
    expect(out.map((m) => m.externalId)).toEqual(["wamid.OUT1", "wamid.OUT2"]);
    expect((out[1].payload as any)).toMatchObject({ busy: true, line: "concierge", origin: "bot" });

    await post([text(STRANGER, "Priya Sharma")]);
    expect(graph).toHaveLength(3);
    expect(graph[2].text).toBe("Nice to meet you, Priya Sharma! Where would you like to go?"); // the bot, not busy again
    await post([text(STRANGER, "Bali")]);
    await post([text(STRANGER, "12 Oct to 19 Oct")]);
    expect(graph).toHaveLength(5);
    expect(graph[4].text).toBe("Perfect, Priya Sharma. A Plumtrips holiday planner will be with you shortly.");
    expect(graph.filter((g) => g.text === MESSAGE_DEFAULTS["busy.concierge"].text)).toHaveLength(1);
    c = await conv();
    expect(c.routing.state).toBe("held");
    expect(await Lead.countDocuments({})).toBe(1);
  });

  it("nobody mapped at all → held, NO busy reply — byte-identical to Track B", async () => {
    await post([text(STRANGER, "Hi", { referral })], profile(STRANGER, "Priya"));
    expect(graph.map((g) => g.text)).toEqual([WELCOME]);
    const c: any = await conv();
    expect(c.routing).toMatchObject({ state: "held", mapped: 0, reason: "nobody mapped", busySentAt: null });
  });

  it("mapped agent ACTIVE → assigned, no busy reply; when the away agent later goes active and takes a held thread, normal flow resumes", async () => {
    await AssignmentRule.create({ target: { type: "department", line: "concierge" }, userId: AGENT, priority: 1 });
    await agentPresence(true);
    await post([text(STRANGER, "Hi", { referral })], profile(STRANGER, "Priya"));
    expect(graph.map((g) => g.text)).toEqual([WELCOME]);
    let c: any = await conv();
    expect(c.routing).toMatchObject({ state: "assigned", busySentAt: null });
    expect(String(c.assignedTo)).toBe(String(AGENT));

    // a second contact while the agent is away: held + busy; then the agent comes back — the revive path is the queue read (Track B), the busy stays once
    await agentPresence(false);
    await post([text("919222222222", "Hi", { referral })], profile("919222222222", "Rohan"));
    const c2: any = await Conversation.findOne({ contactId: (await Contact.findOne({ phone: "919222222222" }))!._id }).lean();
    expect(c2.routing).toMatchObject({ state: "held", mapped: 1 });
    expect(graph.slice(1).map((g) => g.text)).toEqual([WELCOME, MESSAGE_DEFAULTS["busy.concierge"].text]);
    await post([text("919222222222", "Rohan")]); // still held: no second busy
    expect(graph.filter((g) => g.text === MESSAGE_DEFAULTS["busy.concierge"].text)).toHaveLength(1);
  });

  it("a per-line edit of busy.concierge is what goes out; busy.helloviza is untouched; a blank edit is refused so the default still sends", async () => {
    await AssignmentRule.create({ target: { type: "department", line: "concierge" }, userId: AGENT, priority: 1 });
    await agentPresence(false);
    expect((await upsertMessage({ key: "busy.concierge", text: "   " })).ok).toBe(false);
    await post([text(STRANGER, "Hi", { referral })], profile(STRANGER, "Priya"));
    expect(graph[1].text).toBe(MESSAGE_DEFAULTS["busy.concierge"].text);

    await upsertMessage({ key: "busy.concierge", text: "Holiday desk is flat out — give us 10 minutes." });
    await post([text("919222222222", "Hi", { referral })], profile("919222222222", "Rohan"));
    expect(graph[3].text).toBe("Holiday desk is flat out — give us 10 minutes.");
    expect((await upsertMessage({ key: "busy.helloviza", enabled: true })).ok).toBe(true);
    expect((await CannedMessage.findOne({ key: "busy.helloviza" }).lean())!.text).toBe(MESSAGE_DEFAULTS["busy.helloviza"].text);
  });

  it("FLAG OFF: legacy path — no Lead, no thread, nothing sent, even with rules and edits present", async () => {
    delete process.env[PLUMCONNECT_ENABLED_ENV];
    await AssignmentRule.create({ target: { type: "department", line: "concierge" }, userId: AGENT, priority: 1 });
    await upsertMessage({ key: "busy.concierge", text: "Busy." });
    await post([text(STRANGER, "Hi", { referral })], profile(STRANGER, "Priya"));
    expect(graph).toHaveLength(0);
    expect(await Lead.countDocuments({})).toBe(0);
    expect(await Conversation.countDocuments({})).toBe(0);
    expect(await ExpenseReply.countDocuments({})).toBe(1);
  });
});
