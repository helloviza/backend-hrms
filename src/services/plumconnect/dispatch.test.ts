// PlumConnect Slice 2 — the context-first dispatcher. Identity, in-flow and
// the chain enqueuers are mocked at their module seams; the dispatcher's own
// models (Contact / Conversation / Message) are real on mongodb-memory-server.
//
// The property test at the bottom is the §9 hard invariant: over a random
// mix of sender states, the chain is enqueued IFF the identity is hard.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-dispatch-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const H = vi.hoisted(() => ({
  resolveIdentity: vi.fn(),
  readExpenseInFlow: vi.fn(),
  enqueueExpenseReply: vi.fn(),
  enqueueExpenseButton: vi.fn(),
  enqueueExpenseCapture: vi.fn(),
  captureLead: vi.fn(),
  sendIntentMenu: vi.fn(),
  lookupCampaignMap: vi.fn(),
  startBot: vi.fn(),
  handleBotTurn: vi.fn(),
  promptForConsent: vi.fn(),
  recordConsentAnswer: vi.fn(),
}));

vi.mock("./resolveIdentity.js", () => ({ resolveIdentity: H.resolveIdentity }));
vi.mock("./expenseInFlow.js", () => ({ readExpenseInFlow: H.readExpenseInFlow }));
vi.mock("./enqueueExpense.js", () => ({
  enqueueExpenseReply: H.enqueueExpenseReply,
  enqueueExpenseButton: H.enqueueExpenseButton,
  enqueueExpenseCapture: H.enqueueExpenseCapture,
}));
vi.mock("./holidayLead.js", async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real, captureLead: H.captureLead };
});
// Slice 5: the classifier and the menu helpers are real (pure); the menu SEND
// and the campaign-map READ are spies, so this file still proves routing only.
vi.mock("./intent.js", async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real, sendIntentMenu: H.sendIntentMenu, lookupCampaignMap: H.lookupCampaignMap };
});
// Slice 3c collaborators are unit-tested on their own; here they are spies so
// this file keeps proving ROUTING only.
vi.mock("./bot.js", async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real, startBot: H.startBot, handleBotTurn: H.handleBotTurn };
});
vi.mock("./consent.js", async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real, promptForConsent: H.promptForConsent, recordConsentAnswer: H.recordConsentAnswer };
});
vi.mock("../../utils/logger.js", () => ({
  whatsappLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { dispatchInbound, buildInboundEnvelope } = await import("./dispatch.js");
const { default: Contact } = await import("../../models/plumconnect/Contact.js");
const { default: Conversation } = await import("../../models/plumconnect/Conversation.js");
const { default: Message } = await import("../../models/plumconnect/Message.js");

let mongod: MongoMemoryServer;
const PN = "1265026903369191";
const WA = "919876543210";
const NOW = new Date("2026-09-20T12:00:00Z");

const NO_SOFT = { users: [], travellerProfiles: [], consumers: [], crmContacts: [] };
const NONE = { inFlow: false, source: null, updatedAt: null, stale: false };
const FRESH = { inFlow: true, source: "capture", updatedAt: new Date(NOW.getTime() - 3600_000), stale: false };
const STALE = { inFlow: false, source: "capture", updatedAt: new Date(NOW.getTime() - 30 * 3600_000), stale: true };

function hard(canonical = WA) {
  return {
    canonical,
    hard: { userId: new mongoose.Types.ObjectId(), workspaceId: new mongoose.Types.ObjectId(), email: "e@x", name: "E", waId: canonical },
    soft: NO_SOFT,
    identityState: "verified_employee",
  };
}
function soft(canonical = WA) {
  return {
    canonical,
    hard: null,
    soft: { ...NO_SOFT, users: [{ userId: new mongoose.Types.ObjectId(), workspaceId: new mongoose.Types.ObjectId(), email: "", name: "", phone: "9876543210" }] },
    identityState: "soft_employee",
  };
}
function unknown(canonical = WA) {
  return { canonical, hard: null, soft: NO_SOFT, identityState: "unknown" };
}

let n = 0;
function env(over: Record<string, any> = {}) {
  n += 1;
  return {
    phoneNumberId: PN,
    from: WA,
    messageId: `wamid.${n}`,
    type: "text",
    text: "hi",
    buttonId: "",
    media: null,
    referral: null,
    context: null,
    profileName: "Priya",
    timestamp: "1758369600",
    ...over,
  };
}
const REFERRAL = { source_type: "ad", source_id: "1202", ctwa_clid: "AfeXYZ", headline: "Bali" };
const IMAGE = { id: "MEDIA1", mime: "image/jpeg", mediaType: "image" as const, caption: "lunch" };

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
  vi.clearAllMocks();
  await Promise.all([Contact.deleteMany({}), Conversation.deleteMany({}), Message.deleteMany({})]);
  H.readExpenseInFlow.mockResolvedValue(NONE);
  H.enqueueExpenseReply.mockResolvedValue({ enqueued: true });
  H.enqueueExpenseButton.mockResolvedValue({ enqueued: true });
  H.enqueueExpenseCapture.mockResolvedValue({ enqueued: true });
  H.captureLead.mockImplementation(async (input: any) => {
    const leadId = new mongoose.Types.ObjectId();
    // mirror the real adapter's one side effect the dispatcher relies on
    input.conversation.leadId = leadId;
    await Conversation.updateOne({ _id: input.conversation._id }, { $set: { leadId } });
    return { touch: "first", created: true, leadId, assignedTo: null, _conversationId: input.conversation._id };
  });
  H.sendIntentMenu.mockResolvedValue(true);
  H.lookupCampaignMap.mockResolvedValue(null);
  H.startBot.mockResolvedValue(undefined);
  H.handleBotTurn.mockResolvedValue({ handled: true, step: "ask_destination", advanced: true, stopped: null });
  H.promptForConsent.mockResolvedValue({ prompted: true });
  H.recordConsentAnswer.mockResolvedValue({ answer: "no", bound: false });
});

const anyEnqueue = () =>
  H.enqueueExpenseReply.mock.calls.length + H.enqueueExpenseButton.mock.calls.length + H.enqueueExpenseCapture.mock.calls.length;

/* ───────────────────────────── envelope ───────────────────────────── */

describe("buildInboundEnvelope", () => {
  it("captures referral, context, profile name, media, and button ids", () => {
    const value = { contacts: [{ wa_id: WA, profile: { name: "Priya" } }], metadata: { phone_number_id: PN } };
    const text = buildInboundEnvelope(
      { id: "w1", from: WA, type: "text", text: { body: "hey" }, referral: REFERRAL, context: { id: "w0" }, timestamp: "1" },
      value,
      PN,
    );
    expect(text).toMatchObject({ from: WA, messageId: "w1", type: "text", text: "hey", referral: REFERRAL, context: { id: "w0" }, profileName: "Priya", media: null, buttonId: "" });

    const img = buildInboundEnvelope({ id: "w2", from: WA, type: "image", image: { id: "M", mime_type: "image/png", caption: "c" } }, value, PN);
    expect(img.media).toEqual({ id: "M", mime: "image/png", mediaType: "image", filename: undefined, caption: "c" });
    expect(img.text).toBe("");

    const btn = buildInboundEnvelope({ id: "w3", from: WA, type: "interactive", interactive: { button_reply: { id: "confirm" } } }, value, PN);
    expect(btn.buttonId).toBe("confirm");
    const list = buildInboundEnvelope({ id: "w4", from: WA, type: "interactive", interactive: { list_reply: { id: "row1" } } }, value, PN);
    expect(list.buttonId).toBe("row1");

    const noProfile = buildInboundEnvelope({ id: "w5", from: "911111111111", type: "text", text: { body: "x" } }, value, PN);
    expect(noProfile.profileName).toBe("");
  });
});

/* ───────────────────────────── routes ───────────────────────────── */

describe("dispatchInbound — precedence", () => {
  it("1. fresh in-flow + hard → expense chain (reply), conversation kind expense", async () => {
    H.resolveIdentity.mockResolvedValue(hard());
    H.readExpenseInFlow.mockResolvedValue(FRESH);
    const out = await dispatchInbound(env({ text: "confirm" }), NOW);
    expect(out.route).toBe("expense_inflow");
    expect(H.enqueueExpenseReply).toHaveBeenCalledWith({ messageId: expect.any(String), waId: WA, phoneNumberId: PN, text: "confirm" });
    expect((await Conversation.findOne({})).kind).toBe("expense");
  });

  it("1'. fresh in-flow but NO hard identity → falls through (never enqueues)", async () => {
    H.resolveIdentity.mockResolvedValue(unknown());
    H.readExpenseInFlow.mockResolvedValue(FRESH);
    const out = await dispatchInbound(env({ text: "confirm" }), NOW);
    expect(out.route).toBe("intent_menu"); // Slice 5: an unrouted stranger is asked, never enqueued
    expect(anyEnqueue()).toBe(0);
  });

  it("1''. STALE in-flow + hard, with a referral → referral wins over the stale flow", async () => {
    H.resolveIdentity.mockResolvedValue(hard());
    H.readExpenseInFlow.mockResolvedValue(STALE);
    const out = await dispatchInbound(env({ referral: REFERRAL }), NOW);
    expect(out.route).toBe("lead_referral");
    expect(anyEnqueue()).toBe(0);
  });

  it("1'''. FRESH in-flow + hard, with a referral → the flow still wins (precedence 1 > 2)", async () => {
    H.resolveIdentity.mockResolvedValue(hard());
    H.readExpenseInFlow.mockResolvedValue(FRESH);
    const out = await dispatchInbound(env({ referral: REFERRAL }), NOW);
    expect(out.route).toBe("expense_inflow");
    expect(anyEnqueue()).toBe(1);
  });

  it("2. referral, no flow, unknown sender → lead conversation with referralRaw verbatim, no enqueue", async () => {
    H.resolveIdentity.mockResolvedValue(unknown());
    H.lookupCampaignMap.mockResolvedValue("concierge"); // Slice 5: Ops mapped this ad to holidays
    const out = await dispatchInbound(env({ referral: REFERRAL, text: "saw your ad" }), NOW);
    expect(out.route).toBe("lead_referral");
    expect(anyEnqueue()).toBe(0);
    const conv = await Conversation.findOne({}).lean();
    expect(conv!.kind).toBe("lead");
    expect(conv!.status).toBe("OPEN");
    expect(conv!.referralRaw).toEqual(REFERRAL);
    expect(conv!.channelAccountId).toBe(PN);
    // Slice 3b: the lead adapter runs for a non-employee, on this thread — as a holiday lead (Slice 5 line)
    expect(H.captureLead).toHaveBeenCalledTimes(1);
    expect(String(H.captureLead.mock.calls[0][0].conversation._id)).toBe(String(conv!._id));
    expect(H.captureLead.mock.calls[0][0]).toMatchObject({ businessLine: "concierge", canonical: WA, profileName: "Priya", referralRaw: REFERRAL });
    expect((out as any).lead).toMatchObject({ touch: "first", created: true });
    expect((out as any).intent).toMatchObject({ businessLine: "concierge", source: "campaign_map" });
    expect(conv).toMatchObject({ businessLine: "concierge", intentSource: "campaign_map" });
    expect(H.lookupCampaignMap).toHaveBeenCalledWith({ sourceId: "1202" });
    expect(H.sendIntentMenu).not.toHaveBeenCalled();
    // Slice 3c: a first-touch lead starts the bot; the adapter's headline is passed through
    expect(H.startBot).toHaveBeenCalledTimes(1);
    expect(H.startBot.mock.calls[0][1]).toBe("Bali");
  });

  it("2'. referral + hard identity (employee clicks an ad) → lead thread, not expense, and NO Lead row (adapter not called)", async () => {
    H.resolveIdentity.mockResolvedValue(hard());
    const out = await dispatchInbound(env({ referral: REFERRAL }), NOW);
    expect(out.route).toBe("lead_referral");
    expect(anyEnqueue()).toBe(0);
    expect(H.captureLead).not.toHaveBeenCalled();
    expect(H.sendIntentMenu).not.toHaveBeenCalled();
    expect((out as any).lead).toBeUndefined();
  });

  it("3. hard identity, media → chain capture with the SAME input shape the legacy path used", async () => {
    H.resolveIdentity.mockResolvedValue(hard());
    const out = await dispatchInbound(env({ type: "image", media: IMAGE }), NOW);
    expect(out.route).toBe("expense_verified");
    expect(H.enqueueExpenseCapture).toHaveBeenCalledWith({
      messageId: expect.any(String),
      waId: WA,
      phoneNumberId: PN,
      mediaId: "MEDIA1",
      mime: "image/jpeg",
      mediaType: "image",
      filename: undefined,
      caption: "lunch",
    });
    expect((out as any).enqueue).toEqual({ enqueued: true, collection: "ExpenseCapture" });
  });

  it("3'. hard identity, button → chain reply with the button id", async () => {
    H.resolveIdentity.mockResolvedValue(hard());
    await dispatchInbound(env({ type: "interactive", buttonId: "add_to_claim" }), NOW);
    expect(H.enqueueExpenseButton).toHaveBeenCalledWith({ messageId: expect.any(String), waId: WA, phoneNumberId: PN, buttonId: "add_to_claim" });
  });

  it("3''. hard identity, plain text (no flow) → chain reply — identical to today for a bound employee", async () => {
    H.resolveIdentity.mockResolvedValue(hard());
    const out = await dispatchInbound(env({ text: "hello" }), NOW);
    expect(out.route).toBe("expense_verified");
    expect(H.enqueueExpenseReply).toHaveBeenCalledTimes(1);
  });

  it("3'''. hard identity, a type the chain cannot consume (audio) → recorded, not enqueued", async () => {
    H.resolveIdentity.mockResolvedValue(hard());
    const out = await dispatchInbound(env({ type: "audio", text: "" }), NOW);
    expect(out.route).toBe("expense_verified");
    expect(anyEnqueue()).toBe(0);
    expect((out as any).enqueue).toEqual({ enqueued: false, collection: null, reason: "chain_has_no_consumer_for_audio" });
    expect((await Message.findOne({})).type).toBe("audio");
  });

  it("4. unknown sender, no referral, no flow → SUPPORT: no enqueue, conversation OPEN/support, inbound Message persisted", async () => {
    H.resolveIdentity.mockResolvedValue(unknown());
    const out = await dispatchInbound(env({ text: "hi" }), NOW);
    // Slice 5: "hi" resolves nothing → the menu goes out; the thread stays a
    // support thread with no Lead until the contact answers.
    expect(out.route).toBe("intent_menu");
    expect((out as any).intent).toMatchObject({ businessLine: null, menuSent: true });
    expect(H.sendIntentMenu).toHaveBeenCalledTimes(1);
    expect(H.captureLead).not.toHaveBeenCalled();
    expect(anyEnqueue()).toBe(0);

    const contact = await Contact.findOne({}).lean();
    expect(contact!.phone).toBe(WA);
    expect(contact!.displayName).toBe("Priya");
    expect(contact!.identityState).toBe("unknown");
    expect(contact!.refs.userId).toBeNull();

    const conv = await Conversation.findOne({}).lean();
    expect(conv).toMatchObject({ kind: "support", status: "OPEN", channel: "whatsapp", channelAccountId: PN, businessLine: null, leadId: null });
    expect(conv!.lastInboundAt).toEqual(NOW);

    const msg = await Message.findOne({}).lean();
    expect(msg).toMatchObject({ direction: "INBOUND", type: "text", text: "hi", externalId: expect.stringMatching(/^wamid\./) });
    expect(String(msg!.conversationId)).toBe(String(conv!._id));
  });

  it("4'. SOFT-matched sender (employee by phone, no waId) sending a RECEIPT → consent prompt (3c); never enqueued, no refs.userId", async () => {
    H.resolveIdentity.mockResolvedValue(soft());
    const out = await dispatchInbound(env({ type: "image", media: IMAGE }), NOW);
    expect(out.route).toBe("consent_prompt");
    expect(H.promptForConsent).toHaveBeenCalledTimes(1);
    expect(anyEnqueue()).toBe(0);
    const contact = await Contact.findOne({}).lean();
    expect(contact!.identityState).toBe("soft_employee");
    expect(contact!.refs.userId).toBeNull(); // a reference is written only from a HARD identity
  });

  it("4''. SOFT-matched sender saying 'hi' → no consent prompt (that is the receipt case only); Slice 5 asks the menu", async () => {
    H.resolveIdentity.mockResolvedValue(soft());
    const out = await dispatchInbound(env({ text: "hi" }), NOW);
    expect(out.route).toBe("intent_menu");
    expect(H.promptForConsent).not.toHaveBeenCalled();
    expect(anyEnqueue()).toBe(0);
  });

  it("unsupported Meta types from a stranger are still recorded as support (location, sticker, reaction)", async () => {
    H.resolveIdentity.mockResolvedValue(unknown());
    for (const t of ["location", "sticker", "reaction", "weird_future_type"]) {
      await dispatchInbound(env({ type: t, text: "" }), NOW);
    }
    const types = (await Message.find({}).lean()).map((m) => m.type).sort();
    expect(types).toEqual(["location", "reaction", "sticker", "unsupported"]);
    expect(anyEnqueue()).toBe(0);
  });
});

/* ───────────────────────────── Slice 5 — the Intent Engine ───────────────────────────── */

describe("dispatchInbound — Intent Engine (non-employee only)", () => {
  const conv = () => Conversation.findOne({}).lean();

  it("keywords: 'visa for Germany' → helloviza Lead (intent_lead, source keyword), NO bot", async () => {
    H.resolveIdentity.mockResolvedValue(unknown());
    const out = await dispatchInbound(env({ text: "Need a visa for Germany next month" }), NOW);
    expect(out.route).toBe("intent_lead");
    expect((out as any).intent).toMatchObject({ businessLine: "helloviza", source: "keyword" });
    expect(H.captureLead).toHaveBeenCalledTimes(1);
    expect(H.captureLead.mock.calls[0][0]).toMatchObject({ businessLine: "helloviza", canonical: WA, referralRaw: undefined });
    expect(H.startBot).not.toHaveBeenCalled();
    expect(H.sendIntentMenu).not.toHaveBeenCalled();
    const c = await conv();
    expect(c).toMatchObject({ kind: "lead", businessLine: "helloviza", intentSource: "keyword" });
    expect(c!.intent).toBe("visa"); // the audit label is the matched term, never the message
    expect(c!.intentConfidence).toBeGreaterThan(0);
  });

  it("keywords: 'corporate travel platform' → plumtrips Lead, NO bot", async () => {
    H.resolveIdentity.mockResolvedValue(unknown());
    const out = await dispatchInbound(env({ text: "Looking for a corporate travel platform for our company" }), NOW);
    expect(out.route).toBe("intent_lead");
    expect((out as any).intent).toMatchObject({ businessLine: "plumtrips", source: "keyword" });
    expect(H.captureLead.mock.calls[0][0]).toMatchObject({ businessLine: "plumtrips" });
    expect(H.startBot).not.toHaveBeenCalled();
  });

  it("keywords: 'plan a Bali holiday' → concierge Lead AND the qualification bot starts (3c flow, no referral headline)", async () => {
    H.resolveIdentity.mockResolvedValue(unknown());
    const out = await dispatchInbound(env({ text: "Want to plan a Bali holiday in December" }), NOW);
    expect(out.route).toBe("intent_lead");
    expect((out as any).intent).toMatchObject({ businessLine: "concierge", source: "keyword" });
    expect(H.captureLead.mock.calls[0][0]).toMatchObject({ businessLine: "concierge" });
    expect(H.startBot).toHaveBeenCalledTimes(1);
    expect(H.startBot.mock.calls[0][1]).toBe(""); // organic: no ad headline
  });

  it("menu: bare 'hi' → menu once; a second 'hello?' inside 24h does NOT re-send; tapping Visa → helloviza Lead with source 'menu'", async () => {
    H.resolveIdentity.mockResolvedValue(unknown());
    const a = await dispatchInbound(env({ text: "hi" }), NOW);
    expect(a.route).toBe("intent_menu");
    expect((a as any).intent.menuSent).toBe(true);
    // the dispatcher re-reads the thread on the next inbound; the real sender stamped intentMenuSentAt
    await Conversation.updateOne({}, { $set: { intentMenuSentAt: NOW } });

    const b = await dispatchInbound(env({ text: "hello?" }), new Date(NOW.getTime() + 60_000));
    expect(b.route).toBe("intent_menu");
    expect((b as any).intent.menuSent).toBe(false);
    expect(H.sendIntentMenu).toHaveBeenCalledTimes(1);
    expect(H.captureLead).not.toHaveBeenCalled();

    const c = await dispatchInbound(env({ type: "interactive", text: "", buttonId: "pc_bl_helloviza" }), new Date(NOW.getTime() + 120_000));
    expect(c.route).toBe("intent_lead");
    expect((c as any).intent).toMatchObject({ businessLine: "helloviza", source: "menu", confidence: 1 });
    expect(H.captureLead).toHaveBeenCalledTimes(1);
    expect(H.captureLead.mock.calls[0][0]).toMatchObject({ businessLine: "helloviza" });
    expect(H.startBot).not.toHaveBeenCalled();
    expect(await conv()).toMatchObject({ kind: "lead", businessLine: "helloviza", intentSource: "menu", intent: "menu:helloviza" });
    expect(await Conversation.countDocuments({})).toBe(1);
  });

  it("menu: tapping Holiday → concierge Lead + bot (exactly the ad path); a later text on that thread is a bot turn, not a re-classification", async () => {
    H.resolveIdentity.mockResolvedValue(unknown());
    await dispatchInbound(env({ text: "hi" }), NOW);
    const b = await dispatchInbound(env({ type: "interactive", text: "", buttonId: "pc_bl_concierge" }), NOW);
    expect(b.route).toBe("intent_lead");
    expect(H.startBot).toHaveBeenCalledTimes(1);
    await Conversation.updateOne({}, { $set: { "bot.active": true, "bot.step": "ask_name" } });
    const c = await dispatchInbound(env({ text: "visa please" }), NOW); // would classify helloviza if the thread were unrouted
    expect(c.route).toBe("bot");
    expect(H.handleBotTurn).toHaveBeenCalledTimes(1);
    expect(H.captureLead).toHaveBeenCalledTimes(1);
    expect((await conv())!.businessLine).toBe("concierge");
  });

  it("menu: 'Something else' (pc_bl_other) → support; no Lead, no bot, no second menu", async () => {
    H.resolveIdentity.mockResolvedValue(unknown());
    await dispatchInbound(env({ text: "hi" }), NOW);
    const b = await dispatchInbound(env({ type: "interactive", text: "", buttonId: "pc_bl_other" }), NOW);
    expect(b.route).toBe("support");
    expect((b as any).intent).toMatchObject({ businessLine: null, source: "menu" });
    expect(H.captureLead).not.toHaveBeenCalled();
    expect(H.startBot).not.toHaveBeenCalled();
    expect(H.sendIntentMenu).toHaveBeenCalledTimes(1);
    expect((await conv())!.kind).toBe("support");
  });

  it("routed department thread: later organic text is plain support for the human queue — no re-classification, no menu, no second Lead", async () => {
    H.resolveIdentity.mockResolvedValue(unknown());
    await dispatchInbound(env({ text: "corporate travel for my company" }), NOW);
    H.captureLead.mockImplementation(async (input: any) => ({ touch: "repeat", created: false, leadId: input.conversation.leadId }));
    const b = await dispatchInbound(env({ text: "we need a holiday package too" }), NOW); // concierge words on a plumtrips thread
    expect(b.route).toBe("support");
    expect(H.captureLead).toHaveBeenCalledTimes(1); // only the first message created a Lead
    expect(H.sendIntentMenu).not.toHaveBeenCalled();
    expect(H.startBot).not.toHaveBeenCalled();
    expect((await conv())!.businessLine).toBe("plumtrips");
  });

  it("referral: a mapped ad routes by the campaign map WITHOUT classifying (text says visa, map says concierge → concierge)", async () => {
    H.resolveIdentity.mockResolvedValue(unknown());
    H.lookupCampaignMap.mockResolvedValue("concierge");
    const out = await dispatchInbound(env({ referral: REFERRAL, text: "visa visa visa" }), NOW);
    expect(out.route).toBe("lead_referral");
    expect((out as any).intent).toMatchObject({ businessLine: "concierge", source: "campaign_map", confidence: 1 });
    expect(H.captureLead.mock.calls[0][0]).toMatchObject({ businessLine: "concierge", referralRaw: REFERRAL });
    expect(H.startBot).toHaveBeenCalledTimes(1);
    expect((await conv())!.intent).toBe("ad:1202");
  });

  it("referral: an UNMAPPED ad with classifiable text → keyword line (helloviza) on a lead_referral, no bot", async () => {
    H.resolveIdentity.mockResolvedValue(unknown());
    const out = await dispatchInbound(env({ referral: REFERRAL, text: "Hi, I saw your ad about Schengen visa" }), NOW);
    expect(out.route).toBe("lead_referral");
    expect((out as any).intent).toMatchObject({ businessLine: "helloviza", source: "keyword" });
    expect(H.captureLead.mock.calls[0][0]).toMatchObject({ businessLine: "helloviza", referralRaw: REFERRAL });
    expect(H.startBot).not.toHaveBeenCalled();
    expect(H.sendIntentMenu).not.toHaveBeenCalled();
  });

  it("referral: an UNMAPPED ad with the default CTWA text → the menu, no Lead yet; a repeat referral on a routed thread is a touch, not a re-route", async () => {
    H.resolveIdentity.mockResolvedValue(unknown());
    const a = await dispatchInbound(env({ referral: REFERRAL, text: "Hello! Can I get more info on this?" }), NOW);
    expect(a.route).toBe("intent_menu");
    expect((a as any).intent.menuSent).toBe(true);
    expect(H.captureLead).not.toHaveBeenCalled();
    expect((await conv())!.kind).toBe("lead"); // the referral thread is a lead thread (3b), still unrouted
    expect((await conv())!.businessLine).toBeNull();

    const b = await dispatchInbound(env({ type: "interactive", text: "", buttonId: "pc_bl_plumtrips" }), NOW);
    expect(b.route).toBe("intent_lead");
    expect(H.captureLead.mock.calls[0][0]).toMatchObject({ businessLine: "plumtrips", referralRaw: undefined });

    H.captureLead.mockImplementation(async (input: any) => ({ touch: "repeat", created: false, leadId: input.conversation.leadId }));
    H.lookupCampaignMap.mockResolvedValue("concierge"); // a DIFFERENT, mapped ad — must not re-route
    const c = await dispatchInbound(env({ referral: { ...REFERRAL, source_id: "1203" }, text: "hi" }), NOW);
    expect(c.route).toBe("lead_referral");
    expect((c as any).intent).toMatchObject({ businessLine: "plumtrips", source: null });
    expect(H.lookupCampaignMap).toHaveBeenCalledTimes(1); // only the first referral was looked up
    expect(H.captureLead).toHaveBeenLastCalledWith(expect.objectContaining({ businessLine: "plumtrips", referralRaw: { ...REFERRAL, source_id: "1203" } }));
    expect(H.startBot).not.toHaveBeenCalled();
  });

  it("a pre-Slice-5 lead thread (leadId, no businessLine) is treated as concierge — never re-asked", async () => {
    H.resolveIdentity.mockResolvedValue(unknown());
    await dispatchInbound(env({ text: "hi" }), NOW);
    await Conversation.updateOne({}, { $set: { kind: "lead", leadId: new mongoose.Types.ObjectId() } });
    H.captureLead.mockImplementation(async (input: any) => ({ touch: "repeat", created: false, leadId: input.conversation.leadId }));
    const b = await dispatchInbound(env({ text: "visa please" }), NOW);
    expect(b.route).toBe("support");
    expect(H.sendIntentMenu).toHaveBeenCalledTimes(1);
    expect(H.captureLead).not.toHaveBeenCalled();
  });

  it("a soft-matched employee with a consent prompt pending gets NO menu on top of it", async () => {
    H.resolveIdentity.mockResolvedValue(soft());
    await dispatchInbound(env({ type: "image", media: IMAGE }), NOW);
    await Contact.updateOne({}, { $set: { "consent.expenseBindAskedAt": NOW } });
    const b = await dispatchInbound(env({ text: "who is this?" }), NOW);
    expect(b.route).toBe("support");
    expect(H.sendIntentMenu).not.toHaveBeenCalled();
  });

  it("the Intent Engine never sees a hard identity: a verified employee's text is the chain's, whatever the words", async () => {
    H.resolveIdentity.mockResolvedValue(hard());
    const out = await dispatchInbound(env({ text: "visa for Germany" }), NOW);
    expect(out.route).toBe("expense_verified");
    expect(H.captureLead).not.toHaveBeenCalled();
    expect(H.sendIntentMenu).not.toHaveBeenCalled();
    expect((await conv())!.businessLine).toBeNull();
  });
});

/* ───────────────────────────── records ───────────────────────────── */

describe("dispatchInbound — its own records", () => {
  it("hard identity stamps Contact.refs.userId (a reference), identityState verified_employee", async () => {
    const id = hard();
    H.resolveIdentity.mockResolvedValue(id);
    await dispatchInbound(env(), NOW);
    const contact = await Contact.findOne({}).lean();
    expect(String(contact!.refs.userId)).toBe(String(id.hard.userId));
    expect(contact!.identityState).toBe("verified_employee");
    expect(contact).not.toHaveProperty("workspaceId");
  });

  it("reuses the contact's open conversation across messages; upgrades kind support→lead on a referral, never downgrades", async () => {
    H.resolveIdentity.mockResolvedValue(unknown());
    const a = await dispatchInbound(env({ text: "hi" }), NOW);
    const b = await dispatchInbound(env({ referral: REFERRAL }), NOW);
    const c = await dispatchInbound(env({ text: "still here" }), NOW);
    expect(String((a as any).conversationId)).toBe(String((b as any).conversationId));
    expect(String((b as any).conversationId)).toBe(String((c as any).conversationId));
    expect(await Conversation.countDocuments({})).toBe(1);
    const conv = await Conversation.findOne({}).lean();
    expect(conv!.kind).toBe("lead");
    expect(conv!.referralRaw).toEqual(REFERRAL);
    expect(await Message.countDocuments({ conversationId: conv!._id })).toBe(3);
  });

  it("a RESOLVED conversation is not reused — a new one opens", async () => {
    H.resolveIdentity.mockResolvedValue(unknown());
    const a = await dispatchInbound(env(), NOW);
    await Conversation.updateOne({ _id: (a as any).conversationId }, { $set: { status: "RESOLVED" } });
    const b = await dispatchInbound(env(), NOW);
    expect(String((a as any).conversationId)).not.toBe(String((b as any).conversationId));
    expect(await Conversation.countDocuments({})).toBe(2);
  });

  it("a redelivered wamid is a duplicate: no second Message, no second enqueue", async () => {
    H.resolveIdentity.mockResolvedValue(hard());
    const e = env({ text: "confirm" });
    const first = await dispatchInbound(e, NOW);
    const second = await dispatchInbound(e, NOW);
    expect(first.route).toBe("expense_verified");
    expect(second).toEqual({ route: "duplicate", canonical: WA, messageId: e.messageId });
    expect(await Message.countDocuments({})).toBe(1);
    expect(H.enqueueExpenseReply).toHaveBeenCalledTimes(1);
  });

  it("unusable phone / missing message id → dropped, no records, no enqueue", async () => {
    H.resolveIdentity.mockResolvedValue(hard());
    expect(await dispatchInbound(env({ from: "abc" }), NOW)).toEqual({ route: "dropped", reason: "unusable_phone", from: "abc" });
    expect(await dispatchInbound(env({ messageId: "" }), NOW)).toEqual({ route: "dropped", reason: "missing_message_id", from: WA });
    expect(await Contact.countDocuments({})).toBe(0);
    expect(anyEnqueue()).toBe(0);
  });

  it("the dispatcher never calls a cloud sender directly (bot/consent → sendAndPersist, menu → the 4a wrapper)", async () => {
    // whatsappCloud.service is not imported by dispatch.ts at all.
    const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("./dispatch.ts", import.meta.url), "utf8"));
    expect(src).not.toMatch(/whatsappCloud\.service/);
    expect(src).not.toMatch(/sendTextMessage|sendButtonMessage|sendTemplateMessage/);
  });
});

/* ───────────────────────────── §9 property ───────────────────────────── */

describe("§9 property — enqueue IFF hard identity, over a random mix", () => {
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  }

  it("300 random senders", async () => {
    const rand = rng(20260920);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    let cases = 0;
    let enqueues = 0;

    for (let i = 0; i < 300; i++) {
      const identityKind = pick(["hard", "soft", "none"] as const);
      const referral = pick([true, false]);
      const flow = pick(["fresh", "stale", "none"] as const);
      const type = pick(["text", "interactive", "image", "document", "audio"] as const);
      const phone = `9198765${String(i).padStart(5, "0")}`;

      H.resolveIdentity.mockResolvedValue(identityKind === "hard" ? hard(phone) : identityKind === "soft" ? soft(phone) : unknown(phone));
      H.readExpenseInFlow.mockResolvedValue(flow === "fresh" ? FRESH : flow === "stale" ? STALE : NONE);
      const before = anyEnqueue();

      const out = await dispatchInbound(
        env({
          from: phone,
          type,
          text: type === "text" ? "x" : "",
          buttonId: type === "interactive" ? "confirm" : "",
          media: type === "image" || type === "document" ? { ...IMAGE, mediaType: type } : null,
          referral: referral ? REFERRAL : null,
        }),
        NOW,
      );
      const fired = anyEnqueue() - before;
      cases += 1;
      enqueues += fired;

      // The invariant, both directions.
      if (identityKind !== "hard") {
        expect(fired, `non-hard sender must never enqueue (${identityKind}/${referral}/${flow}/${type})`).toBe(0);
        expect(out.route).not.toMatch(/expense/);
      } else {
        const chainConsumable = type !== "audio";
        const expectedRoute = flow === "fresh" ? "expense_inflow" : referral ? "lead_referral" : "expense_verified";
        expect(out.route).toBe(expectedRoute);
        if (expectedRoute !== "lead_referral") expect(fired).toBe(chainConsumable ? 1 : 0);
        else expect(fired).toBe(0);
      }
      // Nothing the dispatcher writes carries a tenant.
      const contact = await Contact.findOne({ phone }).lean();
      expect(contact).not.toHaveProperty("workspaceId");
      if (identityKind !== "hard") expect(contact!.refs.userId).toBeNull();
    }
    expect(cases).toBe(300);
    expect(enqueues).toBeGreaterThan(0); // the property is not vacuous
  }, 60_000);
});
