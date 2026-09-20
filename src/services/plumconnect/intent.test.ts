// PlumConnect Slice 5 — the Intent Engine's parts on their own:
//   • classifyIntent: the DoD examples, the threshold, ties, noise, no LLM
//   • the campaign map: hit / miss / disabled row / sparse-unique keys
//   • the menu helpers: button ids ↔ lines, the 24h re-send guard
//   • sendIntentMenu / recordIntent against real models with the 4a wrapper
//     mocked at its module seam (the send itself is proven E2E in
//     whatsapp.webhook.slice5.test.ts)
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-intent-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const H = vi.hoisted(() => ({ sendButtonsOutcome: vi.fn() }));
vi.mock("./outbound.js", async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real, sendButtonsOutcome: H.sendButtonsOutcome };
});
vi.mock("../../utils/logger.js", () => ({
  whatsappLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  classifyIntent,
  lookupCampaignMap,
  INTENT_THRESHOLD,
  INTENT_KEYWORDS,
  MENU_BUTTONS,
  MENU_BUTTON_IDS,
  MENU_TEXT,
  menuChoiceToBusinessLine,
  isMenuButton,
  menuRecentlySent,
  MENU_RESEND_MS,
  sendIntentMenu,
  recordIntent,
} = await import("./intent.js");
const { default: CampaignMap } = await import("../../models/plumconnect/CampaignMap.js");
const { default: Conversation } = await import("../../models/plumconnect/Conversation.js");
const { default: Contact } = await import("../../models/plumconnect/Contact.js");

let mongod: MongoMemoryServer;
const NOW = new Date("2026-09-21T09:00:00Z");

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([CampaignMap.syncIndexes(), Conversation.syncIndexes(), Contact.syncIndexes()]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await Promise.all([CampaignMap.deleteMany({}), Conversation.deleteMany({}), Contact.deleteMany({})]);
});

/* ───────────────────────────── classifier ───────────────────────────── */

describe("classifyIntent — deterministic keywords", () => {
  it("the DoD examples", () => {
    expect(classifyIntent("I need a visa for Germany")).toMatchObject({ businessLine: "helloviza" });
    expect(classifyIntent("Do you have a corporate travel platform?")).toMatchObject({ businessLine: "plumtrips" });
    expect(classifyIntent("Help me plan a Bali holiday")).toMatchObject({ businessLine: "concierge" });
  });

  it("returns null (→ menu) for greetings, empty, non-string and noise", () => {
    for (const t of ["hi", "hello", "Hello! Can I get more info on this?", "", "   ", null, undefined, 42, {}, "asdfgh qwerty"]) {
      const c = classifyIntent(t);
      expect(c.businessLine, String(t)).toBeNull();
      expect(c.matched).toEqual([]);
    }
  });

  it("a single suggestive (weight 1) term is below the threshold; two of them clear it", () => {
    expect(INTENT_THRESHOLD).toBe(2);
    expect(classifyIntent("about our office").businessLine).toBeNull(); // office = 1
    expect(classifyIntent("our office and our company").businessLine).toBe("plumtrips"); // office + company = 2
    expect(classifyIntent("a trip").businessLine).toBeNull(); // trip = 1
    expect(classifyIntent("a trip to a resort").businessLine).toBe("concierge"); // trip + resort = 2
  });

  it("a tie between lines is ambiguous → null, never a coin flip", () => {
    // visa (helloviza 2) vs holiday (concierge 2)
    const c = classifyIntent("visa and holiday");
    expect(c.businessLine).toBeNull();
    expect(c.confidence).toBeGreaterThan(0); // something matched, but nothing won
  });

  it("the stronger line wins a mixed message", () => {
    expect(classifyIntent("holiday visa for a Schengen tourist visa").businessLine).toBe("helloviza");
    expect(classifyIntent("honeymoon package, maybe a visa too").businessLine).toBe("concierge");
  });

  it("is word-bounded and case/punctuation-insensitive, and handles multi-word terms", () => {
    expect(classifyIntent("VISA!!! for germany?").businessLine).toBe("helloviza");
    expect(classifyIntent("advisable options").businessLine).toBeNull(); // "visa" inside "advisable" must not fire
    expect(classifyIntent("e-visa please").businessLine).toBe("helloviza");
    expect(classifyIntent("visa on arrival for Thailand").businessLine).toBe("helloviza");
    expect(classifyIntent("we run a travel desk for employees").businessLine).toBe("plumtrips");
  });

  it("confidence is 0..1, matched lists only the winner's terms, and the result never echoes the text", () => {
    const c = classifyIntent("Schengen visa appointment at the embassy for my honeymoon");
    expect(c.businessLine).toBe("helloviza");
    expect(c.confidence).toBeLessThanOrEqual(1);
    expect(c.confidence).toBeGreaterThan(0);
    expect(c.matched).toEqual(expect.arrayContaining(["visa", "schengen"]));
    expect(c.matched).not.toContain("honeymoon");
    expect(JSON.stringify(c)).not.toMatch(/my honeymoon/);
  });

  it("never throws on hostile input", () => {
    for (const t of [String.fromCharCode(0, 1), "(((", "$&", "\\", "𝔳𝔦𝔰𝔞", "a".repeat(20_000)]) {
      expect(() => classifyIntent(t)).not.toThrow();
    }
  });

  it("every keyword is lower-case and classifies to its own line on its own when weight 2", () => {
    for (const line of Object.keys(INTENT_KEYWORDS) as Array<keyof typeof INTENT_KEYWORDS>) {
      for (const { term, weight } of INTENT_KEYWORDS[line]) {
        expect(term).toBe(term.toLowerCase());
        if (weight === 2) expect(classifyIntent(term).businessLine, term).toBe(line);
      }
    }
  });
});

/* ───────────────────────────── campaign map ───────────────────────────── */

describe("lookupCampaignMap", () => {
  it("hit by adId; miss → null; disabled row → null; blank keys → null without a query", async () => {
    await CampaignMap.create({ adId: "120212345678901234", businessLine: "concierge", label: "Bali" });
    await CampaignMap.create({ adId: "999", businessLine: "helloviza", enabled: false });
    expect(await lookupCampaignMap({ sourceId: "120212345678901234" })).toBe("concierge");
    expect(await lookupCampaignMap({ sourceId: "unknown" })).toBeNull();
    expect(await lookupCampaignMap({ sourceId: "999" })).toBeNull();
    expect(await lookupCampaignMap({ sourceId: "" })).toBeNull();
    expect(await lookupCampaignMap(null)).toBeNull();
    expect(await lookupCampaignMap(undefined)).toBeNull();
  });

  it("hit by campaignId when the ad id is unmapped", async () => {
    await CampaignMap.create({ campaignId: "C1", businessLine: "plumtrips" });
    expect(await lookupCampaignMap({ sourceId: "ad-not-mapped", campaignId: "C1" })).toBe("plumtrips");
  });

  it("model: one row per ad (sparse unique), a key is required, blanks are dropped not stored as null", async () => {
    await CampaignMap.create({ adId: "A", businessLine: "concierge" });
    await expect(CampaignMap.create({ adId: "A", businessLine: "helloviza" })).rejects.toThrow(/E11000|duplicate/);
    await expect(CampaignMap.create({ businessLine: "concierge" })).rejects.toThrow(/adId or a campaignId/);
    await expect(CampaignMap.create({ adId: "B", businessLine: "sales" })).rejects.toThrow(/businessLine/);
    // two rows with only a campaignId and NO adId must both persist (sparse)
    await CampaignMap.create({ campaignId: "C1", businessLine: "plumtrips", adId: "" });
    await CampaignMap.create({ campaignId: "C2", businessLine: "plumtrips", adId: null as any });
    const rows = await CampaignMap.find({ campaignId: { $in: ["C1", "C2"] } }).lean();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).not.toHaveProperty("adId");
  });
});

/* ───────────────────────────── menu helpers ───────────────────────────── */

describe("menu", () => {
  it("three reply buttons (WhatsApp's cap), one per line; 'other' is a typed fallback, not a button", () => {
    expect(MENU_BUTTONS.map((b) => b.id)).toEqual([MENU_BUTTON_IDS.plumtrips, MENU_BUTTON_IDS.helloviza, MENU_BUTTON_IDS.concierge]);
    expect(MENU_BUTTONS.map((b) => b.title)).toEqual(["Corporate travel", "Visa", "Holiday"]);
    for (const b of MENU_BUTTONS) expect(b.title.length).toBeLessThanOrEqual(20); // Meta's title cap
    expect(MENU_TEXT).toMatch(/something else/i);
  });

  it("button ids map to lines; 'other' and foreign ids do not; isMenuButton knows all four", () => {
    expect(menuChoiceToBusinessLine("pc_bl_plumtrips")).toBe("plumtrips");
    expect(menuChoiceToBusinessLine("pc_bl_helloviza")).toBe("helloviza");
    expect(menuChoiceToBusinessLine("pc_bl_concierge")).toBe("concierge");
    expect(menuChoiceToBusinessLine("pc_bl_other")).toBeNull();
    expect(menuChoiceToBusinessLine("pc_bind_yes")).toBeNull();
    expect(menuChoiceToBusinessLine("")).toBeNull();
    expect(isMenuButton("pc_bl_other")).toBe(true);
    expect(isMenuButton("pc_bind_yes")).toBe(false);
    expect(isMenuButton("confirm")).toBe(false);
  });

  it("menuRecentlySent: within 24h true, at/after 24h false, never sent false", () => {
    expect(MENU_RESEND_MS).toBe(24 * 3600 * 1000);
    expect(menuRecentlySent(null, NOW)).toBe(false);
    expect(menuRecentlySent(undefined, NOW)).toBe(false);
    expect(menuRecentlySent(new Date(NOW.getTime() - 1000), NOW)).toBe(true);
    expect(menuRecentlySent(new Date(NOW.getTime() - MENU_RESEND_MS + 1), NOW)).toBe(true);
    expect(menuRecentlySent(new Date(NOW.getTime() - MENU_RESEND_MS), NOW)).toBe(false);
  });

  it("sendIntentMenu: goes through the 4a wrapper on THIS thread with origin support; stamps intentMenuSentAt only on an accepted send", async () => {
    const contact = await Contact.create({ phone: "919111111111" });
    const conv = await Conversation.create({ contactId: contact._id, kind: "support" });

    H.sendButtonsOutcome.mockResolvedValue({ outcome: { ok: false, wamid: null, raw: null, error: "boom" }, persisted: null });
    expect(await sendIntentMenu(conv._id as any, "919111111111", NOW)).toBe(false);
    expect((await Conversation.findById(conv._id).lean())!.intentMenuSentAt).toBeNull();

    H.sendButtonsOutcome.mockResolvedValue({ outcome: { ok: true, wamid: "wamid.M1", raw: {} }, persisted: {} });
    expect(await sendIntentMenu(conv._id as any, "919111111111", NOW)).toBe(true);
    expect(H.sendButtonsOutcome).toHaveBeenLastCalledWith("919111111111", MENU_TEXT, MENU_BUTTONS, expect.objectContaining({ origin: "support", conversationId: conv._id, now: NOW }));
    expect((await Conversation.findById(conv._id).lean())!.intentMenuSentAt).toEqual(NOW);
  });

  it("recordIntent: stamps line/source/confidence/label and upgrades the thread to a lead thread", async () => {
    const contact = await Contact.create({ phone: "919111111112" });
    const conv = await Conversation.create({ contactId: contact._id, kind: "support" });
    await recordIntent(conv._id as any, "plumtrips", "keyword", 0.5, "corporate travel");
    expect(await Conversation.findById(conv._id).lean()).toMatchObject({
      kind: "lead",
      businessLine: "plumtrips",
      intentSource: "keyword",
      intentConfidence: 0.5,
      intent: "corporate travel",
    });
  });
});

/* ───────────────────────────── orthogonality ───────────────────────────── */

describe("business line vs campaign lineage stay orthogonal", () => {
  it("intent.ts never reads attribution / referral / Lead; the classifier's only input is the text", async () => {
    const raw = await import("node:fs").then((fs) => fs.readFileSync(new URL("./intent.ts", import.meta.url), "utf8"));
    // code only: comments explain the rule, the code must obey it
    const src = raw
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(src).not.toMatch(/attribution/i);
    expect(src).not.toMatch(/referralRaw|ctwa_clid|ctwaClid|source_url/);
    expect(src).not.toMatch(/models\/Lead\.js|LeadActivity|createLead/);
    expect(src).not.toMatch(/gemini|openai|llm|plutoInvoke/i);
  });
});
