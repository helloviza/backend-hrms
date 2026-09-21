// PlumConnect Slice 5 — the Intent Engine end to end through the real
// webhook (HMAC, real env, real dispatcher, real classifier, real campaign
// map, real senders over a fake Graph adapter that records every send):
//   • keyword classification → helloviza / plumtrips / concierge Leads with
//     the right enquiryType; each line's Slice-6 qualification flow starts
//     (the department flows are proved in whatsapp.webhook.slice6.test.ts —
//     here only their first question is asserted)
//   • bare "hi" → the menu (sent + persisted on the thread), NO Lead; tap
//     Visa → helloviza Lead with intentSource "menu"; "Something else" → support
//   • campaign map hit → intentSource "campaign_map" with no classification;
//     an unmapped referral → keywords, else the menu
//   • concierge byte-parity with 3b/3c; expense + support unchanged; FLAG OFF
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import crypto from "node:crypto";
import axios from "axios";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-5-test";
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
const { MENU_TEXT, MENU_BUTTON_IDS } = await import("../services/plumconnect/intent.js");
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
const { default: CampaignMap } = await import("../models/plumconnect/CampaignMap.js");

/* ── fake Graph: every send recorded, wamid returned ────────────────────── */
type Sent = { to: string; type: string; text: string; buttons?: string[] };
const graph: Sent[] = [];
let wamidSeq = 0;
axios.defaults.adapter = async (config) => {
  const body = JSON.parse(config.data);
  graph.push({
    to: body.to,
    type: body.type,
    text: body.type === "text" ? body.text.body : body.interactive?.body?.text ?? "",
    buttons: body.interactive?.action?.buttons?.map((b: any) => b.reply.id),
  });
  return { data: { messages: [{ id: `wamid.OUT${++wamidSeq}` }] }, status: 200, statusText: "OK", headers: {}, config };
};

const app = express();
app.use("/api/whatsapp", express.raw({ type: "application/json" }), router);

let mongod: MongoMemoryServer;
const PN = "1265026903369191";
const STRANGER = "919111111111";
const STRANGER2 = "919111111112";
const BOUND = "919876543210";
const SOFT = "919222222222";
const WS = new mongoose.Types.ObjectId();
const ADMIN = new mongoose.Types.ObjectId();

const MAPPED_AD = "120212345678901234";
const UNMAPPED_AD = "120299999999999999";
const referral = (source_id: string, headline = "Bali from ₹49,999") => ({
  source_url: "https://www.instagram.com/p/x/",
  source_type: "ad",
  source_id,
  headline,
  body: "7 nights",
  media_type: "image",
  ctwa_clid: `clid-${source_id}`,
});
const MENU_IDS = [MENU_BUTTON_IDS.plumtrips, MENU_BUTTON_IDS.helloviza, MENU_BUTTON_IDS.concierge];

function sign(body: string) {
  return "sha256=" + crypto.createHmac("sha256", "test-app-secret").update(body).digest("hex");
}
function post(messages: any[], contacts: any[] = []) {
  const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: PN }, contacts, messages } }] }] });
  return request(app).post("/api/whatsapp/webhook").set("Content-Type", "application/json").set("x-hub-signature-256", sign(body)).send(body);
}
let n = 0;
const wamid = () => `wamid.IN${++n}`;
const text = (from: string, body: string, extra: Record<string, any> = {}) => ({ id: wamid(), from, timestamp: "1758369600", type: "text", text: { body }, ...extra });
const image = (from: string) => ({ id: wamid(), from, timestamp: "1758369600", type: "image", image: { id: `MEDIA${n}`, mime_type: "image/jpeg" } });
const button = (from: string, id: string) => ({ id: wamid(), from, timestamp: "1758369600", type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: id } } });
const profile = (from: string, name: string) => [{ wa_id: from, profile: { name } }];

const conv = (phone: string) => Contact.findOne({ phone }).lean().then((c) => Conversation.findOne({ contactId: c!._id }).lean());
const outbound = (conversationId: any) => Message.find({ conversationId, direction: "OUTBOUND" }).sort({ createdAt: 1 }).lean();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([User.syncIndexes(), Lead.syncIndexes(), Contact.syncIndexes(), Conversation.syncIndexes(), Message.syncIndexes(), CampaignMap.syncIndexes()]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  graph.length = 0;
  wamidSeq = 0;
  H.trigger.mockClear();
  delete process.env.CRM_V2_OPPORTUNITY;
  await Promise.all([
    User.deleteMany({}), Lead.deleteMany({}), LeadActivity.deleteMany({}), Task.deleteMany({}), TaskAutomation.deleteMany({}), Counter.deleteMany({}),
    ExpenseReply.deleteMany({}), ExpenseCapture.deleteMany({}), Contact.deleteMany({}), Conversation.deleteMany({}), Message.deleteMany({}), CampaignMap.deleteMany({}),
  ]);
  await User.collection.insertOne({ _id: ADMIN, name: "Ops Admin", email: "ops@plumtrips.com", roles: ["ADMIN"], passwordHash: "x", workspaceId: WS } as any);
  await User.create({ email: "bound@x.test", passwordHash: "x", workspaceId: WS, name: "Bound Employee", status: "ACTIVE", waId: BOUND });
  await User.create({ email: "soft@x.test", passwordHash: "x", workspaceId: WS, name: "Soft Employee", status: "ACTIVE", phone: "+91 92222 22222" });
  await CampaignMap.create({ adId: MAPPED_AD, businessLine: "concierge", label: "Bali promo", createdBy: ADMIN });
  process.env[PLUMCONNECT_ENABLED_ENV] = "true";
});

afterEach(() => {
  delete process.env[PLUMCONNECT_ENABLED_ENV];
});

/* ───────────────────────────── keywords ───────────────────────────── */

describe("keyword classification (organic, non-employee)", () => {
  it("'visa for Germany' → helloviza Lead (enquiryType visa, individual), thread tagged, the helloviza flow's first question (Slice 6)", async () => {
    await post([text(STRANGER, "Hi, I need a visa for Germany next month")], profile(STRANGER, "Priya"));
    const lead: any = await Lead.findOne({}).lean();
    expect(lead).toMatchObject({ enquiryType: "visa", type: "individual", contactName: "Priya", contactPhone: STRANGER, sourceChannel: "whatsapp", source: "other" });
    expect(lead.notes).toBe(""); // the message text is NEVER written onto the Lead
    expect(lead.attribution?.sourceId ?? "").toBe(""); // organic: no lineage
    expect(lead.travelRequirement.destination).toBe(""); // routing reads the text; only the flow's parsers write, and only from answers
    const c = await conv(STRANGER);
    expect(c).toMatchObject({ kind: "lead", businessLine: "helloviza", intentSource: "keyword", intent: "visa" });
    expect(String(c!.leadId)).toBe(String(lead._id));
    expect(c!.intentConfidence).toBeGreaterThan(0);
    expect(c!.bot).toMatchObject({ active: true, step: "ask_name" });
    expect(graph).toHaveLength(1);
    expect(graph[0].text).toBe("Hi! Thanks for reaching out to Helloviza. To get started, what's your name?");
    expect(H.trigger).toHaveBeenCalledTimes(1); // lead.created, like every other lead
  });

  it("'corporate travel platform' → plumtrips Lead (enquiryType corporate_account, company), the plumtrips flow's first question (Slice 6)", async () => {
    await post([text(STRANGER, "We are looking for a corporate travel platform for our company")], profile(STRANGER, "Rahul"));
    const lead: any = await Lead.findOne({}).lean();
    expect(lead).toMatchObject({ enquiryType: "corporate_account", type: "company", contactName: "Rahul", companyName: "" });
    expect(await conv(STRANGER)).toMatchObject({ kind: "lead", businessLine: "plumtrips", intentSource: "keyword", bot: expect.objectContaining({ active: true, step: "ask_name" }) });
    expect(graph).toHaveLength(1);
    expect(graph[0].text).toBe("Hi! Thanks for reaching out to Plumtrips. To get started, what's your name?");
  });

  it("'plan a Bali holiday' → concierge Lead (holiday_package) AND the bot's first question — the 3c flow, organic headline", async () => {
    await post([text(STRANGER, "Can you help me plan a Bali holiday in December?")], profile(STRANGER, "Anita"));
    const lead: any = await Lead.findOne({}).lean();
    expect(lead).toMatchObject({ enquiryType: "holiday_package", type: "individual", contactName: "Anita" });
    const c = await conv(STRANGER);
    expect(c).toMatchObject({ kind: "lead", businessLine: "concierge", intentSource: "keyword" });
    expect(c!.bot).toMatchObject({ active: true, step: "ask_name" });
    expect(graph).toHaveLength(1);
    expect(graph[0].text).toBe("Hi! Thanks for reaching out to Plumtrips. To get started, what's your name?");
    expect((await outbound(c!._id))[0].externalId).toBe("wamid.OUT1");
  });

  it("a department thread never re-routes: later texts are flow answers while the flow runs, then plain human-queue texts — no menu, no second Lead, whatever the words", async () => {
    await post([text(STRANGER, "visa for Germany")]);
    expect(graph).toHaveLength(1); // the flow's first question
    await post([text(STRANGER, "actually also a holiday package and a honeymoon")]); // concierge words — taken as the NAME answer, not re-classified
    await post([text(STRANGER, "hi?")]); // a name is 2+ chars → the country answer, ISO-2 unknown
    expect(await Lead.countDocuments({})).toBe(1);
    expect(graph).toHaveLength(3); // ask_name (welcome) → ask_country → ask_visa_type; no menu anywhere
    expect(graph.every((g) => g.type === "text")).toBe(true);
    const c = await conv(STRANGER);
    expect(c!.businessLine).toBe("helloviza");
    expect(c!.bot).toMatchObject({ active: true, step: "ask_visa_type" });
    expect(await Message.countDocuments({ conversationId: c!._id, direction: "INBOUND" })).toBe(3);
    expect(await Conversation.countDocuments({})).toBe(1);
    // the flow ends; from here the thread is the department's human queue
    await post([text(STRANGER, "tourist")]);
    expect(graph).toHaveLength(4);
    expect((await conv(STRANGER))!.bot).toMatchObject({ active: false, stoppedBy: "complete" });
    await post([text(STRANGER, "visa for France now")]); // classifiable, but the thread is routed and the flow is over
    await post([text(STRANGER, "hi")]);
    expect(graph).toHaveLength(4);
    expect(await Lead.countDocuments({})).toBe(1);
    expect((await conv(STRANGER))!.businessLine).toBe("helloviza");
  });
});

/* ───────────────────────────── menu ───────────────────────────── */

describe("menu fallback", () => {
  it("bare 'hi' → the 3-button menu sent + persisted on the thread with origin support; NO Lead; thread stays support", async () => {
    await post([text(STRANGER, "hi")], profile(STRANGER, "Priya"));
    expect(await Lead.countDocuments({})).toBe(0);
    expect(graph).toHaveLength(1);
    expect(graph[0]).toMatchObject({ to: STRANGER, type: "interactive", text: MENU_TEXT, buttons: MENU_IDS });
    const c = await conv(STRANGER);
    expect(c).toMatchObject({ kind: "support", businessLine: null, intentSource: null, leadId: null });
    expect(c!.intentMenuSentAt).toBeInstanceOf(Date);
    const out = await outbound(c!._id);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ externalId: "wamid.OUT1", type: "interactive", text: MENU_TEXT });
    expect((out[0].payload as any).origin).toBe("support");
    expect((out[0].payload as any).intentMenu).toBe(true);
    expect(H.trigger).not.toHaveBeenCalled();
  });

  it("'hello?' again inside 24h → NOT re-sent; tap Visa → helloviza Lead with intentSource 'menu'; the thread upgrades in place", async () => {
    await post([text(STRANGER, "hi")], profile(STRANGER, "Priya"));
    await post([text(STRANGER, "hello?")]);
    expect(graph).toHaveLength(1);
    expect(await Lead.countDocuments({})).toBe(0);

    await post([button(STRANGER, MENU_BUTTON_IDS.helloviza)], profile(STRANGER, "Priya")); // Meta sends contacts on every webhook
    const lead: any = await Lead.findOne({}).lean();
    expect(lead).toMatchObject({ enquiryType: "visa", type: "individual", contactName: "Priya", contactPhone: STRANGER });
    const c = await conv(STRANGER);
    expect(c).toMatchObject({ kind: "lead", businessLine: "helloviza", intentSource: "menu", intentConfidence: 1, intent: "menu:helloviza" });
    expect(String(c!.leadId)).toBe(String(lead._id));
    expect(await Conversation.countDocuments({})).toBe(1);
    expect(graph).toHaveLength(2); // the menu, then the helloviza flow's first question (Slice 6)
    expect(graph[1].text).toBe("Hi! Thanks for reaching out to Helloviza. To get started, what's your name?");
    expect(c!.bot).toMatchObject({ active: true, step: "ask_name" });
    expect(await Message.countDocuments({ conversationId: c!._id, direction: "INBOUND" })).toBe(3);
  });

  it("tap Holiday → concierge Lead + the bot starts (exactly the CTWA path, minus the headline)", async () => {
    await post([text(STRANGER, "hi")], profile(STRANGER, "Priya"));
    await post([button(STRANGER, MENU_BUTTON_IDS.concierge)]);
    expect(await Lead.countDocuments({ enquiryType: "holiday_package" })).toBe(1);
    expect(graph).toHaveLength(2);
    expect(graph[1].text).toBe("Hi! Thanks for reaching out to Plumtrips. To get started, what's your name?");
    expect((await conv(STRANGER))!.bot).toMatchObject({ active: true, step: "ask_name" });
    // and the bot proceeds on the next text
    await post([text(STRANGER, "Priya Sharma")]);
    expect(graph).toHaveLength(3);
    expect((await Lead.findOne({}).lean())!.contactName).toBe("Priya Sharma");
  });

  it("tap Corporate travel → plumtrips Lead (company / corporate_account) + the plumtrips flow starts", async () => {
    await post([text(STRANGER, "hi")]);
    await post([button(STRANGER, MENU_BUTTON_IDS.plumtrips)]);
    expect(await Lead.findOne({}).lean()).toMatchObject({ enquiryType: "corporate_account", type: "company" });
    expect((await conv(STRANGER))!.businessLine).toBe("plumtrips");
    expect(graph).toHaveLength(2);
    expect(graph[1].text).toBe("Hi! Thanks for reaching out to Plumtrips. To get started, what's your name?");
  });

  it("'Something else' typed after the menu → general support: no Lead, no re-sent menu, the thread waits for a human", async () => {
    await post([text(STRANGER, "hi")]);
    await post([text(STRANGER, "Something else — I want to talk to a person about my booking")]);
    expect(await Lead.countDocuments({})).toBe(0);
    expect(graph).toHaveLength(1);
    const c = await conv(STRANGER);
    expect(c).toMatchObject({ kind: "support", status: "OPEN", businessLine: null });
    expect(await Message.countDocuments({ conversationId: c!._id, direction: "INBOUND" })).toBe(2);
  });

  it("the menu is per-thread: two strangers each get one; one tapping does not route the other", async () => {
    await post([text(STRANGER, "hi")]);
    await post([text(STRANGER2, "hello")]);
    expect(graph.map((g) => g.to)).toEqual([STRANGER, STRANGER2]);
    await post([button(STRANGER2, MENU_BUTTON_IDS.helloviza)]);
    expect(await Lead.countDocuments({})).toBe(1);
    expect((await Lead.findOne({}).lean())!.contactPhone).toBe(STRANGER2);
    expect((await conv(STRANGER))!.businessLine).toBeNull();
    expect((await conv(STRANGER2))!.businessLine).toBe("helloviza");
  });
});

/* ───────────────────────────── referrals ───────────────────────────── */

describe("CTWA referrals", () => {
  it("MAPPED ad → intentSource campaign_map, NO classification (text says visa, map says concierge), attribution kept on the Lead; the 3b/3c flow byte for byte", async () => {
    process.env.CRM_V2_OPPORTUNITY = "true";
    await post([text(STRANGER, "I want a visa visa visa", { referral: referral(MAPPED_AD) })], profile(STRANGER, "Priya"));
    const lead: any = await Lead.findOne({}).lean();
    expect(lead).toMatchObject({ enquiryType: "holiday_package", type: "individual", source: "instagram", sourceChannel: "whatsapp" });
    expect(lead.attribution).toMatchObject({ channel: "whatsapp", sourceType: "ad", sourceId: MAPPED_AD, ctwaClid: `clid-${MAPPED_AD}` });
    expect(lead.notes).toContain("Bali from ₹49,999");
    const c = await conv(STRANGER);
    expect(c).toMatchObject({ kind: "lead", businessLine: "concierge", intentSource: "campaign_map", intentConfidence: 1, intent: `ad:${MAPPED_AD}` });
    expect(c!.referralRaw).toEqual(referral(MAPPED_AD));
    expect(c!.bot).toMatchObject({ active: true, step: "ask_name" });
    expect(graph).toHaveLength(1);
    expect(graph[0].text).toBe('Hi! Thanks for reaching out to Plumtrips about "Bali from ₹49,999". To get started, what\'s your name?');
    expect(H.trigger).toHaveBeenCalledTimes(1);
  });

  it("UNMAPPED ad + classifiable text → keyword line (helloviza) with the referral's attribution; the flow opens with the ad headline", async () => {
    await post([text(STRANGER, "Saw your ad — do you do Schengen visas?", { referral: referral(UNMAPPED_AD, "Europe visas") })], profile(STRANGER, "Priya"));
    const lead: any = await Lead.findOne({}).lean();
    expect(lead).toMatchObject({ enquiryType: "visa", type: "individual" });
    expect(lead.attribution.sourceId).toBe(UNMAPPED_AD);
    expect(await conv(STRANGER)).toMatchObject({ kind: "lead", businessLine: "helloviza", intentSource: "keyword" });
    expect(graph).toHaveLength(1);
    expect(graph[0].text).toBe('Hi! Thanks for reaching out to Helloviza about "Europe visas". To get started, what\'s your name?');
  });

  it("UNMAPPED ad + Meta's default text → the menu (no Lead yet); tap → Lead WITH the referral's attribution from the thread", async () => {
    await post([text(STRANGER, "Hello! Can I get more info on this?", { referral: referral(UNMAPPED_AD, "Corporate travel made easy") })], profile(STRANGER, "Rahul"));
    expect(await Lead.countDocuments({})).toBe(0);
    expect(graph).toHaveLength(1);
    expect(graph[0].buttons).toEqual(MENU_IDS);
    let c = await conv(STRANGER);
    expect(c).toMatchObject({ kind: "lead", businessLine: null }); // a referral thread is a lead thread (3b), still unrouted
    expect(c!.referralRaw).toEqual(referral(UNMAPPED_AD, "Corporate travel made easy"));

    await post([button(STRANGER, MENU_BUTTON_IDS.plumtrips)], profile(STRANGER, "Rahul"));
    const lead: any = await Lead.findOne({}).lean();
    expect(lead).toMatchObject({ enquiryType: "corporate_account", type: "company", contactName: "Rahul" });
    // the tap itself carries no referral, so the Lead is organic-shaped on attribution — the lineage stays on the thread (Slice 8)
    expect(lead.attribution?.sourceId ?? "").toBe("");
    c = await conv(STRANGER);
    expect(c).toMatchObject({ businessLine: "plumtrips", intentSource: "menu" });
    expect(c!.referralRaw).toEqual(referral(UNMAPPED_AD, "Corporate travel made easy"));
    expect(graph).toHaveLength(2); // menu, then the plumtrips flow's first question
    // the tap carries no referral, so — exactly like the concierge menu path — the welcome has no headline
    expect(graph[1].text).toBe("Hi! Thanks for reaching out to Plumtrips. To get started, what's your name?");
  });

  it("a repeat referral on a routed department thread is a touch (3b dedup), never a re-route — even when the second ad is mapped elsewhere; mid-flow the text is the answer", async () => {
    await post([text(STRANGER, "corporate travel for my company", { referral: referral(UNMAPPED_AD) })], profile(STRANGER, "Rahul"));
    expect(await Lead.countDocuments({})).toBe(1);
    expect(graph).toHaveLength(1); // the plumtrips flow's first question
    await post([text(STRANGER, "saw this too", { referral: referral(MAPPED_AD) })]); // mapped to concierge
    expect(await Lead.countDocuments({})).toBe(1);
    const c = await conv(STRANGER);
    expect(c!.businessLine).toBe("plumtrips");
    expect(c!.referralRaw).toEqual(referral(UNMAPPED_AD)); // first referral stays
    expect(await Message.countDocuments({ conversationId: c!._id, type: "system" })).toBe(1); // the touch record
    expect(await LeadActivity.countDocuments({ note: /repeat touch/ })).toBe(1);
    // the text on the repeat tap is the answer the flow was waiting for (the 3c dedup rule, now for every department)
    expect(graph).toHaveLength(2);
    expect(graph[1].text).toBe("Nice to meet you, saw this too! Which company are you with?");
    expect((await Lead.findOne({}).lean())!.contactName).toBe("saw this too");
    expect(c!.bot).toMatchObject({ active: true, step: "ask_company" });
  });

  it("a verified employee tapping an ad: lead thread, no Lead, no menu, no classification", async () => {
    await post([text(BOUND, "visa for Germany", { referral: referral(UNMAPPED_AD) })]);
    expect(await Lead.countDocuments({})).toBe(0);
    expect(graph).toHaveLength(0);
    expect(await conv(BOUND)).toMatchObject({ kind: "lead", businessLine: null });
  });
});

/* ───────────────────────────── untouched paths ───────────────────────────── */

describe("expense, consent and support paths are untouched", () => {
  it("a bound employee's text — whatever it says — is the chain's: enqueued, no Lead, no menu, no businessLine", async () => {
    const m = text(BOUND, "visa for Germany and a Bali holiday");
    await post([m]);
    expect(await ExpenseReply.countDocuments({ messageId: m.id })).toBe(1);
    expect(await Lead.countDocuments({})).toBe(0);
    expect(graph).toHaveLength(0);
    expect(await conv(BOUND)).toMatchObject({ kind: "expense", businessLine: null });
  });

  it("a soft employee's receipt → the consent prompt (not the menu); 'hi' while consent is pending → nothing more; YES binds", async () => {
    await post([image(SOFT)]);
    expect(graph).toHaveLength(1);
    expect(graph[0].buttons).toEqual(["pc_bind_yes", "pc_bind_no"]);
    await post([text(SOFT, "hi")]);
    expect(graph).toHaveLength(1); // no menu on top of the bind prompt
    await post([button(SOFT, "pc_bind_yes")]);
    expect(graph).toHaveLength(2);
    expect(await User.countDocuments({ waId: SOFT })).toBe(1);
    expect(await Lead.countDocuments({})).toBe(0);
    expect(await ExpenseCapture.countDocuments({})).toBe(0);
  });

  it("a soft employee saying 'hi' with nothing pending gets the menu like any non-verified contact — and is never enqueued", async () => {
    await post([text(SOFT, "hi")]);
    expect(graph).toHaveLength(1);
    expect(graph[0].buttons).toEqual(MENU_IDS);
    expect(await ExpenseReply.countDocuments({})).toBe(0);
    expect((await conv(SOFT))!.kind).toBe("support");
  });

  it("FLAG OFF: keyword text, a menu-looking tap and a mapped ad produce ZERO Graph calls, no PlumConnect records, legacy expense default intact", async () => {
    delete process.env[PLUMCONNECT_ENABLED_ENV];
    await post([text(STRANGER, "visa for Germany")]);
    await post([button(STRANGER, MENU_BUTTON_IDS.helloviza)]);
    await post([text(STRANGER2, "hi", { referral: referral(MAPPED_AD) })]);
    expect(graph).toHaveLength(0);
    expect(await Lead.countDocuments({})).toBe(0);
    expect(await Conversation.countDocuments({})).toBe(0);
    expect(await Contact.countDocuments({})).toBe(0);
    expect(await Message.countDocuments({})).toBe(0);
    expect(await ExpenseReply.countDocuments({})).toBe(3); // legacy: everything is an expense reply
  });
});
