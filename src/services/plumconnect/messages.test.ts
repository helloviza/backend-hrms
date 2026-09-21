// PlumConnect Track C — the canned-message store over real collections:
// defaults = today's strings, line override → global → default resolution,
// missing-key safety, blank / placeholder rejection, idempotent seed,
// edit-live reads through the bot, and the intent menu / consent copy from
// the store.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import axios from "axios";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-messages-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.WA_ACCESS_TOKEN = "test-token";
process.env.WA_PHONE_NUMBER_ID = "1265026903369191";
process.env.PLUMCONNECT_ENABLED = "true";

const { MESSAGE_DEFAULTS, MESSAGE_KEYS, getMessage, resolveMessageText, renderMessage, placeholdersIn, defaultMessage, seedCannedMessages, listMessages, upsertMessage, deleteLineOverride, isMessageKey } = await import("./messages.js");
const { startBot, handleBotTurn } = await import("./bot.js");
const { menuCopy, sendIntentMenu, MENU_TEXT, MENU_BUTTONS } = await import("./intent.js");
const { promptForConsent } = await import("./consent.js");
const { CONTACT_NAME_FALLBACK } = await import("./holidayLead.js");
const { default: CannedMessage } = await import("../../models/plumconnect/CannedMessage.js");
const { default: Lead } = await import("../../models/Lead.js");
const { default: Counter } = await import("../../models/Counter.js");
const { default: Contact } = await import("../../models/plumconnect/Contact.js");
const { default: Conversation } = await import("../../models/plumconnect/Conversation.js");
const { default: Message } = await import("../../models/plumconnect/Message.js");

const sent: Array<{ text: string; buttons?: string[] }> = [];
let wamidSeq = 0;
axios.defaults.adapter = async (config) => {
  const body = JSON.parse(config.data);
  sent.push({ text: body.type === "text" ? body.text.body : body.interactive?.body?.text ?? "", buttons: body.interactive?.action?.buttons?.map((b: any) => b.reply.title) });
  return { data: { messages: [{ id: `wamid.C${++wamidSeq}` }] }, status: 200, statusText: "OK", headers: {}, config };
};

let mongod: MongoMemoryServer;
const TO = "919876543210";
const NOW = new Date("2026-09-22T12:00:00Z");

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([CannedMessage.syncIndexes(), Lead.syncIndexes(), Message.syncIndexes()]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  sent.length = 0;
  await Promise.all([CannedMessage.deleteMany({}), Lead.deleteMany({}), Counter.deleteMany({}), Contact.deleteMany({}), Conversation.deleteMany({}), Message.deleteMany({})]);
});

describe("defaults and rendering", () => {
  it("every default is non-empty, declares exactly the placeholders it uses, and the busy family covers all four lines", () => {
    for (const [key, d] of Object.entries(MESSAGE_DEFAULTS)) {
      expect(d.text.trim(), key).not.toBe("");
      expect(placeholdersIn(d.text).sort(), key).toEqual([...d.variables].sort());
    }
    for (const line of ["plumtrips", "helloviza", "concierge", "support"]) expect(isMessageKey(`busy.${line}`)).toBe(true);
    expect(MESSAGE_DEFAULTS["busy.support"].text).toBe("Our support team is busy, please allow us a moment or request a callback");
    expect(MENU_TEXT).toBe(MESSAGE_DEFAULTS["menu.text"].text);
    expect(MENU_BUTTONS.map((b) => b.title)).toEqual(["Corporate travel", "Visa", "Holiday"]);
  });

  it("renderMessage substitutes declared placeholders deterministically and leaves anything else as typed; no code runs", () => {
    expect(renderMessage("Hi {name}, {name}!", { name: "Priya" })).toBe("Hi Priya, Priya!");
    expect(renderMessage("Hi {name} {unknown}", { name: "P" })).toBe("Hi P {unknown}");
    expect(renderMessage("{name}", { name: '${process.exit(1)} {headline}' })).toBe('${process.exit(1)} {headline}');
    expect(renderMessage("no vars", {})).toBe("no vars");
    expect(defaultMessage("concierge.handover", { name: "Priya" })).toBe("Perfect, Priya. A Plumtrips holiday planner will be with you shortly.");
  });
});

describe("resolution: line override → global → default", () => {
  it("no rows → default for every key on every line; a typo'd key resolves to '' text default but never throws (callers only pass known keys)", async () => {
    for (const key of MESSAGE_KEYS) {
      expect(await resolveMessageText(key, "helloviza")).toEqual({ text: MESSAGE_DEFAULTS[key].text, source: "default" });
      expect(await resolveMessageText(key, null)).toEqual({ text: MESSAGE_DEFAULTS[key].text, source: "default" });
    }
    expect(await getMessage("busy.plumtrips", "plumtrips")).toBe(MESSAGE_DEFAULTS["busy.plumtrips"].text);
  });

  it("a per-line override changes only that line; another line still reads the global; an unset key falls back to the seed", async () => {
    await upsertMessage({ key: "busy.support", line: "helloviza", text: "Visa desk is swamped — one moment." });
    expect(await getMessage("busy.support", "helloviza")).toBe("Visa desk is swamped — one moment.");
    expect(await getMessage("busy.support", "plumtrips")).toBe(MESSAGE_DEFAULTS["busy.support"].text); // still the default
    expect(await getMessage("busy.support", null)).toBe(MESSAGE_DEFAULTS["busy.support"].text);
    await upsertMessage({ key: "busy.support", line: null, text: "Global busy." });
    expect(await getMessage("busy.support", "plumtrips")).toBe("Global busy."); // global row now
    expect(await getMessage("busy.support", "helloviza")).toBe("Visa desk is swamped — one moment."); // line row still wins
    expect(await deleteLineOverride("busy.support", "helloviza")).toBe(true);
    expect(await getMessage("busy.support", "helloviza")).toBe("Global busy.");
    expect(await deleteLineOverride("busy.support", "helloviza")).toBe(false);
    expect(await getMessage("busy.helloviza", "helloviza")).toBe(MESSAGE_DEFAULTS["busy.helloviza"].text); // untouched key → seed
  });

  it("a disabled row is skipped (falls through); a blank stored text is skipped too — never an empty send", async () => {
    await upsertMessage({ key: "concierge.ask_dates", line: null, text: "When?" });
    await upsertMessage({ key: "concierge.ask_dates", line: null, enabled: false });
    expect(await resolveMessageText("concierge.ask_dates", "concierge")).toEqual({ text: MESSAGE_DEFAULTS["concierge.ask_dates"].text, source: "default" });
    await CannedMessage.updateOne({ key: "concierge.ask_dates", line: null }, { $set: { enabled: true, text: "   " } }); // bypassing the validator
    expect((await resolveMessageText("concierge.ask_dates", "concierge")).source).toBe("default");
  });
});

describe("edits", () => {
  it("blank text is rejected; unknown key rejected; unknown placeholder rejected; a button title over 20 chars rejected; a valid edit is live", async () => {
    expect(await upsertMessage({ key: "concierge.ask_dates", text: "   " })).toEqual({ ok: false, error: "A canned message cannot be empty." });
    expect((await upsertMessage({ key: "nope.key", text: "x" })).ok).toBe(false);
    expect((await upsertMessage({ key: "concierge.ask_dates", text: "Dates for {name}?" })).ok).toBe(false);
    expect((await upsertMessage({ key: "concierge.ask_destination", text: "Where to, {name}?" })).ok).toBe(true);
    expect((await upsertMessage({ key: "menu.button.visa" as any, text: "x" })).ok).toBe(false);
    expect((await upsertMessage({ key: "menu.button.helloviza", text: "Visas and immigration help" })).ok).toBe(false);
    expect((await upsertMessage({ key: "consent.prompt.yes", text: "Yes please, link it now" })).ok).toBe(false);
    expect((await upsertMessage({ key: "concierge.ask_dates", line: "bogus" })).ok).toBe(false);
    expect((await upsertMessage({ key: "concierge.ask_dates" })).ok).toBe(false); // nothing to change
    const r = await upsertMessage({ key: "concierge.ask_dates", text: "  When would you like to travel?\r\n " });
    expect(r.ok).toBe(true);
    expect(await getMessage("concierge.ask_dates", "concierge")).toBe("When would you like to travel?");
    expect(await CannedMessage.countDocuments({})).toBe(2);
  });

  it("listMessages: every key once (global) + each line override; overridden flags", async () => {
    const before = await listMessages();
    expect(before).toHaveLength(MESSAGE_KEYS.length);
    expect(before.every((m) => m.line === null && !m.overridden && m.enabled && m.text === m.defaultText)).toBe(true);
    await upsertMessage({ key: "busy.support", text: "Global busy." });
    await upsertMessage({ key: "busy.support", line: "concierge", text: "Holiday desk busy." });
    await upsertMessage({ key: "menu.text", enabled: false });
    const after = await listMessages();
    expect(after).toHaveLength(MESSAGE_KEYS.length + 1);
    expect(after.find((m) => m.key === "busy.support" && m.line === null)).toMatchObject({ text: "Global busy.", overridden: true, enabled: true });
    expect(after.find((m) => m.key === "busy.support" && m.line === "concierge")).toMatchObject({ text: "Holiday desk busy.", overridden: true });
    expect(after.find((m) => m.key === "menu.text")).toMatchObject({ text: MESSAGE_DEFAULTS["menu.text"].text, overridden: false, enabled: false });
  });

  it("seed is idempotent and never overwrites an edit; after seeding every getMessage still returns today's string", async () => {
    await upsertMessage({ key: "concierge.ask_dates", text: "Edited before seed" });
    const first = await seedCannedMessages();
    expect(first).toEqual({ created: MESSAGE_KEYS.length - 1, total: MESSAGE_KEYS.length });
    expect(await seedCannedMessages()).toEqual({ created: 0, total: MESSAGE_KEYS.length });
    expect(await CannedMessage.countDocuments({})).toBe(MESSAGE_KEYS.length);
    expect(await getMessage("concierge.ask_dates", "concierge")).toBe("Edited before seed");
    for (const key of MESSAGE_KEYS.filter((k) => k !== "concierge.ask_dates")) {
      expect(await getMessage(key, "helloviza"), key).toBe(MESSAGE_DEFAULTS[key].text);
    }
    const views = await listMessages();
    expect(views.filter((v) => v.overridden).map((v) => v.key)).toEqual(["concierge.ask_dates"]);
  });
});

describe("the read path is live", () => {
  async function fixture(line: "concierge" | "helloviza" = "concierge") {
    const to = line === "concierge" ? TO : "919876543211";
    const contact = await Contact.create({ phone: to });
    const lead = await Lead.create({ contactName: CONTACT_NAME_FALLBACK, contactPhone: to, type: "individual", enquiryType: line === "concierge" ? "holiday_package" : "visa", sourceChannel: "whatsapp" });
    const conversation = await Conversation.create({ contactId: contact._id, kind: "lead", leadId: lead._id, businessLine: line });
    const ctx = async () => ({ conversation: (await Conversation.findById(conversation._id))!, to, leadId: lead._id as any, now: NOW });
    return { lead, conversation, ctx };
  }

  it("bot: an edit to a key (global, then a helloviza override) is what the next send uses — no restart; the concierge flow keeps the default", async () => {
    const f = await fixture("concierge");
    await startBot(await f.ctx(), "Bali");
    expect(sent[0].text).toBe('Hi! Thanks for reaching out to Plumtrips about "Bali". To get started, what\'s your name?');
    await upsertMessage({ key: "concierge.ask_destination", text: "Lovely, {name}. Where are we going?" });
    await handleBotTurn(await f.ctx(), "Priya");
    expect(sent[1].text).toBe("Lovely, Priya. Where are we going?");
    await upsertMessage({ key: "concierge.ask_dates", text: "Travel dates?" });
    await upsertMessage({ key: "concierge.ask_dates", line: "helloviza", text: "should never be read by concierge" });
    await handleBotTurn(await f.ctx(), "Goa");
    expect(sent[2].text).toBe("Travel dates?");
    await upsertMessage({ key: "concierge.handover", text: "Done, {name} — a planner is coming." });
    await handleBotTurn(await f.ctx(), "2026-11-05");
    expect(sent[3].text).toBe("Done, Priya — a planner is coming.");

    const g = await fixture("helloviza");
    await upsertMessage({ key: "helloviza.welcome", line: "helloviza", text: "Namaste! Visa help — your name?" });
    await startBot(await g.ctx(), "");
    expect(sent[4].text).toBe("Namaste! Visa help — your name?");
  });

  it("menu + consent copy come from the store; button titles are capped at 20 chars", async () => {
    let m = await menuCopy();
    expect(m.text).toBe(MENU_TEXT);
    expect(m.buttons.map((b) => b.title)).toEqual(["Corporate travel", "Visa", "Holiday"]);
    await upsertMessage({ key: "menu.text", text: "Hello! Which team do you need?" });
    await upsertMessage({ key: "menu.button.concierge", text: "Holidays & trips" });
    m = await menuCopy();
    expect(m.text).toBe("Hello! Which team do you need?");
    expect(m.buttons.map((b) => b.title)).toEqual(["Corporate travel", "Visa", "Holidays & trips"]);
    const contact = await Contact.create({ phone: TO });
    const conversation = await Conversation.create({ contactId: contact._id, kind: "support" });
    expect(await sendIntentMenu(conversation._id as any, TO, NOW)).toBe(true);
    expect(sent[0]).toEqual({ text: "Hello! Which team do you need?", buttons: ["Corporate travel", "Visa", "Holidays & trips"] });

    await upsertMessage({ key: "consent.prompt", text: "Is this your Plumtrips number? YES links it." });
    const c2 = await Contact.create({ phone: "919222222222" });
    const conv2 = await Conversation.create({ contactId: c2._id, kind: "support" });
    const out = await promptForConsent({ contactId: c2._id as any, conversationId: conv2._id as any, canonical: "919222222222", identity: { canonical: "919222222222", hard: null, soft: { users: [], travellerProfiles: [], consumers: [], crmContacts: [] }, identityState: "soft_employee" } as any, consent: undefined, now: NOW });
    expect(out).toEqual({ prompted: true });
    expect(sent[1]).toEqual({ text: "Is this your Plumtrips number? YES links it.", buttons: ["Yes, link it", "No"] });
  });
});
