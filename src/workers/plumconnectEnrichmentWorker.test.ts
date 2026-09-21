// PlumConnect Slice 8 — the enrichment worker over real collections
// (mongodb-memory-server) with a fake Graph adapter that records every
// call: discovery / back-fill, ad → adset → campaign resolution, idempotent
// re-runs, and the failure modes the decisions require — no token, deleted
// ad id (bounded retries → failed), rate limit (no attempt consumed, pause,
// resume), Graph unreachable (stays pending). Flag off → nothing at all.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import axios from "axios";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-enrich-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
delete process.env.PLUMCONNECT_ENABLED;
delete process.env.PLUMCONNECT_ADS_READ_TOKEN;

const {
  runEnrichmentTick, discoverAdIds, enrichOne, classifyGraphError, __resetEnrichmentWorkerState,
  MAX_ATTEMPTS, FAILURE_BACKOFF_MS, RATE_LIMIT_BACKOFF_MS, NETWORK_BACKOFF_MS,
} = await import("./plumconnectEnrichmentWorker.js");
const { PLUMCONNECT_ENABLED_ENV, PLUMCONNECT_ADS_READ_TOKEN_ENV, isEnrichmentEnabled } = await import("../config/plumconnect.js");
const { default: Lead } = await import("../models/Lead.js");
const { default: Counter } = await import("../models/Counter.js");
const { default: Contact } = await import("../models/plumconnect/Contact.js");
const { default: Conversation } = await import("../models/plumconnect/Conversation.js");
const { default: Ad } = await import("../models/plumconnect/Ad.js");
const { default: AdSet } = await import("../models/plumconnect/AdSet.js");
const { default: Campaign } = await import("../models/plumconnect/Campaign.js");

/* ── fake Graph ────────────────────────────────────────────────────────── */
type Call = { url: string; adId: string; fields: string; token: string };
const calls: Call[] = [];
type Behaviour = { data?: any; status?: number; graphError?: { code: number; error_subcode?: number; message: string }; network?: boolean };
const behaviours = new Map<string, Behaviour>();
let defaultBehaviour: Behaviour = { graphError: { code: 100, error_subcode: 33, message: "Unsupported get request. Object with ID does not exist" }, status: 400 };

const AD1 = "120212345678901234";
const AD2 = "120212345678909999";
const AD_BAD = "120200000000000001";
const tree = (adId: string, adsetId: string, campaignId: string, names: { ad: string; adset: string; campaign: string }) => ({
  id: adId,
  name: names.ad,
  effective_status: "ACTIVE",
  adset: { id: adsetId, name: names.adset, effective_status: "ACTIVE", campaign: { id: campaignId, name: names.campaign, effective_status: "ACTIVE", objective: "OUTCOME_LEADS", account_id: "act_1" } },
});

axios.defaults.adapter = async (config) => {
  const url = String(config.url || "");
  const m = /graph\.facebook\.com\/v[\d.]+\/(\d+)$/.exec(url);
  if (!m) throw new Error(`unexpected request ${url}`);
  const adId = m[1];
  calls.push({ url, adId, fields: String(config.params?.fields || ""), token: String(config.params?.access_token || "") });
  const b = behaviours.get(adId) ?? defaultBehaviour;
  if (b.network) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  if (b.graphError) throw { response: { status: b.status ?? 400, statusText: "Bad Request", data: { error: b.graphError } }, message: b.graphError.message };
  return { data: b.data, status: 200, statusText: "OK", headers: {}, config };
};

let mongod: MongoMemoryServer;
const NOW = new Date("2026-09-21T12:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Lead.syncIndexes(), Ad.syncIndexes(), AdSet.syncIndexes(), Campaign.syncIndexes(), Conversation.syncIndexes()]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  calls.length = 0;
  behaviours.clear();
  __resetEnrichmentWorkerState();
  process.env[PLUMCONNECT_ENABLED_ENV] = "true";
  process.env[PLUMCONNECT_ADS_READ_TOKEN_ENV] = "ads-read-token";
  await Promise.all([Lead.deleteMany({}), Counter.deleteMany({}), Contact.deleteMany({}), Conversation.deleteMany({}), Ad.deleteMany({}), AdSet.deleteMany({}), Campaign.deleteMany({})]);
  behaviours.set(AD1, { data: tree(AD1, "23850000000000001", "23840000000000001", { ad: "Bali · carousel", adset: "Bali · lookalike 1%", campaign: "Holidays Sept" }) });
  behaviours.set(AD2, { data: tree(AD2, "23850000000000001", "23840000000000001", { ad: "Bali · video", adset: "Bali · lookalike 1%", campaign: "Holidays Sept" }) });
});
afterEach(() => {
  delete process.env[PLUMCONNECT_ENABLED_ENV];
  delete process.env[PLUMCONNECT_ADS_READ_TOKEN_ENV];
});

async function seedLead(sourceId: string, over: Record<string, unknown> = {}) {
  return Lead.create({ contactName: "Priya", contactPhone: "919111111111", type: "individual", enquiryType: "holiday_package", sourceChannel: "whatsapp", attribution: { channel: "whatsapp", sourceType: "ad", sourceId, capturedAt: NOW }, ...over });
}
const adRow = (metaId: string): Promise<any> => Ad.findOne({ metaId }).lean();

/* ───────────────────────────── discovery / back-fill ───────────────────────────── */

describe("discovery — the back-fill sweep", () => {
  it("a historical lead with a bare sourceId and no Ad row gets a pending Ad; a conversation-only referral is discovered too; junk ids are ignored", async () => {
    await seedLead(AD1);
    await seedLead(AD1); // two leads, one ad
    await seedLead("not-an-id");
    const contact = await Contact.create({ phone: "919222222222" });
    await Conversation.create({ contactId: contact._id, kind: "lead", referralRaw: { source_type: "ad", source_id: AD2, headline: "x" } });
    const created = await discoverAdIds(NOW);
    expect(created).toBe(2);
    expect((await adRow(AD1))!).toMatchObject({ discoveredFrom: "lead", name: "", enrichment: { status: "pending", attempts: 0 } });
    expect((await adRow(AD2))!).toMatchObject({ discoveredFrom: "conversation", enrichment: { status: "pending" } });
    expect(await Ad.countDocuments({})).toBe(2);
    expect(calls).toHaveLength(0); // discovery never calls Graph
    // idempotent
    expect(await discoverAdIds(NOW)).toBe(0);
    expect(await Ad.countDocuments({})).toBe(2);
  });

  it("no token: discovery still runs (raw ids captured as pending rows), enrichment does not, zero Graph calls, zero errors", async () => {
    delete process.env[PLUMCONNECT_ADS_READ_TOKEN_ENV];
    expect(isEnrichmentEnabled()).toBe(false);
    await seedLead(AD1);
    const r = await runEnrichmentTick(NOW);
    expect(r).toMatchObject({ ran: true, discovered: 1, enriched: 0, failed: 0, paused: false });
    expect((await adRow(AD1))!.enrichment.status).toBe("pending");
    expect(calls).toHaveLength(0);
    // and a lead is exactly what capture wrote — nothing on it changed
    const l: any = await Lead.findOne({}).lean();
    expect(l.attribution.sourceId).toBe(AD1);
  });

  it("FLAG OFF: the tick does nothing — no discovery, no Graph, no rows", async () => {
    delete process.env[PLUMCONNECT_ENABLED_ENV];
    await seedLead(AD1);
    expect(await runEnrichmentTick(NOW)).toMatchObject({ ran: false, discovered: 0, enriched: 0 });
    expect(await Ad.countDocuments({})).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

/* ───────────────────────────── enrichment ───────────────────────────── */

describe("enrichment — ad → adset → campaign", () => {
  it("resolves names and links, stamps lastEnrichedAt; two ads in one adset share ONE adset and ONE campaign row; the token is sent, never stored", async () => {
    await seedLead(AD1);
    await seedLead(AD2);
    const r = await runEnrichmentTick(NOW);
    expect(r).toMatchObject({ ran: true, discovered: 2, enriched: 2, failed: 0, paused: false });
    expect(calls).toHaveLength(2);
    expect(calls[0].token).toBe("ads-read-token");
    expect(calls[0].fields).toContain("adset{id,name,effective_status,campaign{id,name");

    const campaign: any = await Campaign.findOne({ metaId: "23840000000000001" }).lean();
    expect(campaign).toMatchObject({ name: "Holidays Sept", status: "ACTIVE", objective: "OUTCOME_LEADS", accountId: "act_1" });
    expect(campaign.lastEnrichedAt).toEqual(NOW);
    const adset: any = await AdSet.findOne({ metaId: "23850000000000001" }).lean();
    expect(adset).toMatchObject({ name: "Bali · lookalike 1%", metaCampaignId: "23840000000000001" });
    expect(String(adset.campaignId)).toBe(String(campaign._id));
    const ad1: any = await adRow(AD1);
    expect(ad1).toMatchObject({ name: "Bali · carousel", status: "ACTIVE", metaAdSetId: "23850000000000001", metaCampaignId: "23840000000000001", enrichment: { status: "enriched", attempts: 0, lastError: "" } });
    expect(String(ad1.adSetId)).toBe(String(adset._id));
    expect(String(ad1.campaignId)).toBe(String(campaign._id));
    expect(ad1.lastEnrichedAt).toEqual(NOW);
    expect(JSON.stringify(ad1)).not.toContain("ads-read-token");
    expect(await Campaign.countDocuments({})).toBe(1);
    expect(await AdSet.countDocuments({})).toBe(1);
    expect(await Ad.countDocuments({})).toBe(2);
  });

  it("re-run is idempotent: no duplicate entities, no second Graph call for an enriched ad; the Lead is never written", async () => {
    const lead = await seedLead(AD1);
    const before: any = await Lead.findById(lead._id).lean();
    await runEnrichmentTick(NOW);
    await runEnrichmentTick(at(60_000));
    await runEnrichmentTick(at(120_000));
    expect(calls).toHaveLength(1);
    expect(await Campaign.countDocuments({})).toBe(1);
    expect(await AdSet.countDocuments({})).toBe(1);
    expect(await Ad.countDocuments({})).toBe(1);
    const after: any = await Lead.findById(lead._id).lean();
    expect(after).toEqual(before);
  });

  it("a deleted / invalid ad id: one attempt per failure with exponential backoff, then FAILED after MAX_ATTEMPTS — never retried again", async () => {
    await seedLead(AD_BAD); // default behaviour = Graph code 100 / subcode 33
    let t = NOW;
    let r = await runEnrichmentTick(t);
    expect(r).toMatchObject({ enriched: 0, retried: 1, failed: 0 });
    let row: any = await adRow(AD_BAD);
    expect(row.enrichment).toMatchObject({ status: "pending", attempts: 1, lastErrorCode: "100" });
    expect(row.enrichment.lastError).toContain("does not exist");
    expect(row.enrichment.nextAttemptAt).toEqual(at(FAILURE_BACKOFF_MS[0]));
    expect(calls).toHaveLength(1);

    // too early → not claimed
    await runEnrichmentTick(at(FAILURE_BACKOFF_MS[0] - 1000));
    expect(calls).toHaveLength(1);

    for (let attempt = 2; attempt < MAX_ATTEMPTS; attempt += 1) {
      row = await adRow(AD_BAD);
      t = new Date(row.enrichment.nextAttemptAt);
      r = await runEnrichmentTick(t);
      expect(r.retried).toBe(1);
      row = await adRow(AD_BAD);
      expect(row.enrichment).toMatchObject({ status: "pending", attempts: attempt });
      expect(row.enrichment.nextAttemptAt).toEqual(new Date(t.getTime() + FAILURE_BACKOFF_MS[attempt - 1]));
    }
    row = await adRow(AD_BAD);
    r = await runEnrichmentTick(new Date(row.enrichment.nextAttemptAt));
    expect(r).toMatchObject({ failed: 1, retried: 0 });
    row = await adRow(AD_BAD);
    expect(row.enrichment).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS, nextAttemptAt: null, claimedAt: null });
    expect(calls).toHaveLength(MAX_ATTEMPTS);

    // never again
    await runEnrichmentTick(at(365 * 24 * 3600_000));
    expect(calls).toHaveLength(MAX_ATTEMPTS);
    expect(await Campaign.countDocuments({})).toBe(0);
  });

  it("Graph rate limit: no attempt consumed, the row waits, the whole worker pauses, then resumes and enriches", async () => {
    await seedLead(AD1);
    await seedLead(AD2);
    behaviours.set(AD1, { graphError: { code: 4, message: "Application request limit reached" }, status: 400 });
    const r = await runEnrichmentTick(NOW);
    expect(r).toMatchObject({ enriched: 0, failed: 0, retried: 0, paused: true });
    expect(calls).toHaveLength(1); // stopped after the first signal — AD2 was not tried
    let row: any = await adRow(AD1);
    expect(row.enrichment).toMatchObject({ status: "pending", attempts: 0, lastErrorCode: "4" });
    expect(row.enrichment.nextAttemptAt).toEqual(at(RATE_LIMIT_BACKOFF_MS));

    // still paused
    expect((await runEnrichmentTick(at(60_000))).paused).toBe(true);
    expect(calls).toHaveLength(1);

    // resumes after the backoff; AD1 now answers
    behaviours.set(AD1, { data: tree(AD1, "23850000000000001", "23840000000000001", { ad: "Bali · carousel", adset: "Bali · lookalike 1%", campaign: "Holidays Sept" }) });
    const r2 = await runEnrichmentTick(at(RATE_LIMIT_BACKOFF_MS));
    expect(r2).toMatchObject({ enriched: 2, paused: false });
    expect((await adRow(AD1))!.enrichment.status).toBe("enriched");
    expect((await adRow(AD2))!.enrichment.status).toBe("enriched");
  });

  it("HTTP 429 counts as a rate limit too", () => {
    expect(classifyGraphError({ response: { status: 429, data: {} } }).kind).toBe("rate_limit");
    expect(classifyGraphError({ response: { status: 400, data: { error: { code: 80004, message: "x" } } } }).kind).toBe("rate_limit");
    expect(classifyGraphError({ response: { status: 400, data: { error: { code: 190, message: "Invalid OAuth access token" } } } })).toMatchObject({ kind: "error", code: "190" });
    expect(classifyGraphError(Object.assign(new Error("timeout"), { code: "ECONNABORTED" }))).toMatchObject({ kind: "network", code: "ECONNABORTED" });
  });

  it("Graph unreachable: the row goes back to pending with a short delay, no attempt consumed, no error thrown; enriches when Graph is back", async () => {
    await seedLead(AD1);
    behaviours.set(AD1, { network: true });
    const r = await runEnrichmentTick(NOW);
    expect(r).toMatchObject({ enriched: 0, failed: 0, retried: 1, paused: false });
    let row: any = await adRow(AD1);
    expect(row.enrichment).toMatchObject({ status: "pending", attempts: 0, lastErrorCode: "ECONNREFUSED" });
    expect(row.enrichment.nextAttemptAt).toEqual(at(NETWORK_BACKOFF_MS));
    behaviours.set(AD1, { data: tree(AD1, "23850000000000001", "23840000000000001", { ad: "Bali · carousel", adset: "Bali · lookalike 1%", campaign: "Holidays Sept" }) });
    expect((await runEnrichmentTick(at(NETWORK_BACKOFF_MS))).enriched).toBe(1);
    row = await adRow(AD1);
    expect(row.enrichment).toMatchObject({ status: "enriched", attempts: 0, lastError: "" });
  });

  it("an invalid token (Graph 190) is a real failure on the ad — bounded, not a crash; a stale processing claim is reclaimed", async () => {
    await seedLead(AD1);
    behaviours.set(AD1, { graphError: { code: 190, message: "Invalid OAuth access token" }, status: 400 });
    expect((await runEnrichmentTick(NOW)).retried).toBe(1);
    // simulate a crashed tick: leave the row "processing" from long ago
    await Ad.updateOne({ metaId: AD1 }, { $set: { "enrichment.status": "processing", "enrichment.claimedAt": at(-3600_000) } });
    behaviours.set(AD1, { data: tree(AD1, "23850000000000001", "23840000000000001", { ad: "Bali · carousel", adset: "Bali · lookalike 1%", campaign: "Holidays Sept" }) });
    expect(await enrichOne("ads-read-token", at(FAILURE_BACKOFF_MS[0]))).toBe("enriched");
  });

  it("re-enriching an already-enriched ad (a manual re-queue) refreshes names in place — still one row per Meta id", async () => {
    await seedLead(AD1);
    await runEnrichmentTick(NOW);
    behaviours.set(AD1, { data: tree(AD1, "23850000000000001", "23840000000000001", { ad: "Bali · carousel v2", adset: "Bali · lookalike 2%", campaign: "Holidays Sept (renamed)" }) });
    await Ad.updateOne({ metaId: AD1 }, { $set: { "enrichment.status": "pending", "enrichment.nextAttemptAt": null } });
    await runEnrichmentTick(at(1000));
    expect((await adRow(AD1))!.name).toBe("Bali · carousel v2");
    expect((await AdSet.findOne({ metaId: "23850000000000001" }).lean())!.name).toBe("Bali · lookalike 2%");
    expect((await Campaign.findOne({ metaId: "23840000000000001" }).lean())!.name).toBe("Holidays Sept (renamed)");
    expect(await Campaign.countDocuments({})).toBe(1);
    expect(await AdSet.countDocuments({})).toBe(1);
    expect(await Ad.countDocuments({})).toBe(1);
  });
});
