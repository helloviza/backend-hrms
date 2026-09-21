// PlumConnect Slice 8 — capture NEVER blocks on enrichment. Through the real
// webhook (HMAC, real dispatcher, real Intent Engine, real flows, real
// senders over a fake Graph adapter that also serves — or refuses — the
// ads_read endpoint):
//   • enrichment disabled (no token): a CTWA lead is created exactly as in
//     Slice 6 — attribution.sourceId, the bot's first question — with no Ad
//     row and no ads_read call
//   • enrichment enabled but Graph DOWN, worker ticking around the capture:
//     the Lead is identical to the disabled-enrichment capture; the tick
//     reports a retry, throws nothing, the Ad stays pending
//   • Graph back: the tick enriches; the Lead document is byte-identical
//     before and after
//   • FLAG OFF: capture takes the legacy path, the tick is idle
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import crypto from "node:crypto";
import axios from "axios";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-8-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.NODE_ENV = "test";
process.env.WA_APP_SECRET = "test-app-secret";
process.env.WA_ACCESS_TOKEN = "test-token";
process.env.WA_PHONE_NUMBER_ID = "1265026903369191";
delete process.env.PLUMCONNECT_ENABLED;
delete process.env.PLUMCONNECT_ADS_READ_TOKEN;

const H = vi.hoisted(() => ({ trigger: vi.fn() }));
vi.mock("../services/taskAutomation.js", async (importOriginal) => {
  const real: any = await importOriginal();
  H.trigger.mockImplementation(real.triggerTaskAutomation);
  return { ...real, triggerTaskAutomation: H.trigger };
});

const { default: router } = await import("./whatsapp.webhook.js");
const { PLUMCONNECT_ENABLED_ENV, PLUMCONNECT_ADS_READ_TOKEN_ENV } = await import("../config/plumconnect.js");
const { runEnrichmentTick, __resetEnrichmentWorkerState } = await import("../workers/plumconnectEnrichmentWorker.js");
const { default: User } = await import("../models/User.js");
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
const { default: Ad } = await import("../models/plumconnect/Ad.js");
const { default: AdSet } = await import("../models/plumconnect/AdSet.js");
const { default: Campaign } = await import("../models/plumconnect/Campaign.js");

/* ── fake Graph: message sends recorded; ads_read served / refused ─────── */
const graph: Array<{ type: string; text: string }> = [];
const adsCalls: string[] = [];
let adsMode: "down" | "up" = "down";
let wamidSeq = 0;
const AD = "120212345678901234";
axios.defaults.adapter = async (config) => {
  const url = String(config.url || "");
  const m = /graph\.facebook\.com\/v[\d.]+\/(\d+)$/.exec(url);
  if (m && config.method?.toLowerCase() === "get") {
    adsCalls.push(m[1]);
    if (adsMode === "down") throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    return { data: { id: m[1], name: "Bali carousel", effective_status: "ACTIVE", adset: { id: "2385001", name: "Bali LAL", effective_status: "ACTIVE", campaign: { id: "2384001", name: "Holidays Sept", effective_status: "ACTIVE", objective: "OUTCOME_LEADS" } } }, status: 200, statusText: "OK", headers: {}, config };
  }
  const body = JSON.parse(config.data);
  graph.push({ type: body.type, text: body.type === "text" ? body.text.body : body.interactive?.body?.text ?? "" });
  return { data: { messages: [{ id: `wamid.OUT${++wamidSeq}` }] }, status: 200, statusText: "OK", headers: {}, config };
};

const app = express();
app.use("/api/whatsapp", express.raw({ type: "application/json" }), router);

let mongod: MongoMemoryServer;
const PN = "1265026903369191";
const WS = new mongoose.Types.ObjectId();
const ADMIN = new mongoose.Types.ObjectId();
const referral = { source_url: "https://www.instagram.com/p/x/", source_type: "ad", source_id: AD, headline: "Bali from ₹49,999", body: "7 nights", media_type: "image", ctwa_clid: "clid-1" };

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

/** The capture-owned shape of a Lead: everything except identity / clock fields (incl. the per-capture attribution.capturedAt / conversationId). */
function captureShape(l: any) {
  const { _id, leadCode, createdAt, updatedAt, __v, contactPhone, attribution, ...rest } = l;
  const { capturedAt, conversationId, ...attributionRest } = attribution ?? {};
  return JSON.parse(JSON.stringify({ ...rest, attribution: attributionRest }));
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([User.syncIndexes(), Lead.syncIndexes(), Contact.syncIndexes(), Conversation.syncIndexes(), Message.syncIndexes(), CampaignMap.syncIndexes(), Ad.syncIndexes()]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  graph.length = 0;
  adsCalls.length = 0;
  adsMode = "down";
  wamidSeq = 0;
  H.trigger.mockClear();
  __resetEnrichmentWorkerState();
  await Promise.all([
    User.deleteMany({}), Lead.deleteMany({}), LeadActivity.deleteMany({}), Task.deleteMany({}), TaskAutomation.deleteMany({}), Counter.deleteMany({}), ExpenseReply.deleteMany({}),
    Contact.deleteMany({}), Conversation.deleteMany({}), Message.deleteMany({}), CampaignMap.deleteMany({}), Ad.deleteMany({}), AdSet.deleteMany({}), Campaign.deleteMany({}),
  ]);
  await User.collection.insertOne({ _id: ADMIN, name: "Ops Admin", email: "ops@plumtrips.com", roles: ["ADMIN"], passwordHash: "x", workspaceId: WS } as any);
  await CampaignMap.create({ adId: AD, businessLine: "concierge", label: "Bali promo", createdBy: ADMIN });
  process.env[PLUMCONNECT_ENABLED_ENV] = "true";
  delete process.env[PLUMCONNECT_ADS_READ_TOKEN_ENV];
});

afterEach(() => {
  delete process.env[PLUMCONNECT_ENABLED_ENV];
  delete process.env[PLUMCONNECT_ADS_READ_TOKEN_ENV];
});

describe("capture never blocks on enrichment", () => {
  it("enrichment disabled (no token): the CTWA lead is the Slice 6 lead — raw ad id on attribution, bot's first question; no Ad row, no ads_read call", async () => {
    await post([text("919111111111", "Hi, saw the ad", { referral })], profile("919111111111", "Priya"));
    const lead: any = await Lead.findOne({}).lean();
    expect(lead).toMatchObject({ enquiryType: "holiday_package", type: "individual", contactName: "Priya", source: "instagram", sourceChannel: "whatsapp" });
    expect(lead.attribution).toMatchObject({ channel: "whatsapp", sourceType: "ad", sourceId: AD, ctwaClid: "clid-1", headline: "Bali from ₹49,999" });
    expect(graph.map((g) => g.text)).toEqual(['Hi! Thanks for reaching out to Plumtrips about "Bali from ₹49,999". To get started, what\'s your name?']);
    expect((await Conversation.findOne({}).lean())!.bot).toMatchObject({ active: true, step: "ask_name" });
    expect(adsCalls).toHaveLength(0);
    expect(await Ad.countDocuments({})).toBe(0);
    expect(H.trigger).toHaveBeenCalledTimes(1);

    // the worker ticking without a token: discovers the id, touches nothing else, calls nothing
    const tick = await runEnrichmentTick(new Date());
    expect(tick).toMatchObject({ ran: true, discovered: 1, enriched: 0, failed: 0 });
    expect(adsCalls).toHaveLength(0);
    expect((await Ad.findOne({ metaId: AD }).lean())!.enrichment.status).toBe("pending");
    expect(captureShape(await Lead.findOne({}).lean())).toEqual(captureShape(lead));
  });

  it("enrichment enabled, Graph DOWN, worker ticking before and after: the lead is identical to the disabled-enrichment capture; the tick retries, throws nothing; the flow continues", async () => {
    // baseline: capture with enrichment disabled
    await post([text("919111111111", "Hi, saw the ad", { referral })], profile("919111111111", "Priya"));
    const baseline = captureShape(await Lead.findOne({ contactPhone: "919111111111" }).lean());
    const baselineSends = graph.map((g) => g.text);
    graph.length = 0;

    // now with a token and a broken Graph, and the worker running around the capture
    process.env[PLUMCONNECT_ADS_READ_TOKEN_ENV] = "ads-read-token";
    const t1 = await runEnrichmentTick(new Date());
    expect(t1).toMatchObject({ ran: true, retried: 1, enriched: 0, failed: 0 });
    await post([text("919222222222", "Hi, saw the ad", { referral })], profile("919222222222", "Priya"));
    const t2 = await runEnrichmentTick(new Date(Date.now() + 10 * 60_000));
    expect(t2).toMatchObject({ ran: true, enriched: 0, failed: 0 });

    const captured = captureShape(await Lead.findOne({ contactPhone: "919222222222" }).lean());
    expect(captured).toEqual(baseline);
    expect(graph.map((g) => g.text)).toEqual(baselineSends);
    expect((await Ad.findOne({ metaId: AD }).lean())!.enrichment).toMatchObject({ status: "pending", attempts: 0, lastErrorCode: "ETIMEDOUT" });
    expect(await Ad.countDocuments({})).toBe(1); // one ad, two leads
    expect(await Lead.countDocuments({})).toBe(2);

    // the qualification flow is unaffected
    await post([text("919222222222", "Priya Sharma")]);
    expect(graph.at(-1)!.text).toBe("Nice to meet you, Priya Sharma! Where would you like to go?");
  });

  it("Graph back: the tick enriches the ad; the Lead document is byte-identical before and after; the roll-up sees the campaign", async () => {
    await post([text("919111111111", "Hi", { referral })], profile("919111111111", "Priya"));
    const before: any = await Lead.findOne({}).lean();
    process.env[PLUMCONNECT_ADS_READ_TOKEN_ENV] = "ads-read-token";
    adsMode = "up";
    const tick = await runEnrichmentTick(new Date());
    expect(tick).toMatchObject({ discovered: 1, enriched: 1 });
    expect(adsCalls).toEqual([AD]);
    const ad: any = await Ad.findOne({ metaId: AD }).lean();
    expect(ad).toMatchObject({ name: "Bali carousel", metaAdSetId: "2385001", metaCampaignId: "2384001", enrichment: { status: "enriched" } });
    expect((await Campaign.findOne({ metaId: "2384001" }).lean())!.name).toBe("Holidays Sept");
    expect((await AdSet.findOne({ metaId: "2385001" }).lean())!.name).toBe("Bali LAL");
    const after: any = await Lead.findOne({}).lean();
    expect(after).toEqual(before); // including updatedAt: the Lead was never written
    expect(String(after.attribution.sourceId)).toBe(String(ad.metaId)); // the link IS the id
  });

  it("FLAG OFF: capture takes the legacy expense path (no Lead, no PlumConnect rows), the tick is idle, no ads_read call even with a token", async () => {
    delete process.env[PLUMCONNECT_ENABLED_ENV];
    process.env[PLUMCONNECT_ADS_READ_TOKEN_ENV] = "ads-read-token";
    adsMode = "up";
    await post([text("919111111111", "Hi", { referral })], profile("919111111111", "Priya"));
    expect(await runEnrichmentTick(new Date())).toMatchObject({ ran: false });
    expect(await Lead.countDocuments({})).toBe(0);
    expect(await Conversation.countDocuments({})).toBe(0);
    expect(await Ad.countDocuments({})).toBe(0);
    expect(adsCalls).toHaveLength(0);
    expect(graph).toHaveLength(0);
    expect(await ExpenseReply.countDocuments({})).toBe(1); // legacy default intact
  });
});
