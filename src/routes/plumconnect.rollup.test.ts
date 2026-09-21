// PlumConnect Slice 8 — GET /api/plumconnect/campaigns/rollup: the
// Campaign → AdSet → Ad drill-down over seeded leads at known stages,
// joined to the REAL Opportunity / CRMCompany / Invoice chain (raw inserts,
// no hooks). Real router + real line-aware gate over real UserPermission
// rows; auth stubbed via x-test-user like plumconnect.test.ts.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-rollup-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.PLUMCONNECT_ENABLED = "true";

const IDS = {
  admin: new mongoose.Types.ObjectId(),
  manager: new mongoose.Types.ObjectId(), // FULL/ALL on all lines
  rep: new mongoose.Types.ObjectId(), // WRITE/OWN on all lines
  vizaAdmin: new mongoose.Types.ObjectId(), // helloviza FULL/ALL only
  nobody: new mongoose.Types.ObjectId(),
};
const ROLES: Record<string, string[]> = { [String(IDS.admin)]: ["ADMIN"] };

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = String(req.headers["x-test-user"] || "");
    if (!id) return res.status(401).json({ error: "Unauthorized" });
    req.user = { id, sub: id, roles: ROLES[id] || ["EMPLOYEE"], email: `${id}@x.test`, name: "T" };
    next();
  },
  default: (_req: any, _res: any, next: any) => next(),
}));

const { default: router } = await import("./plumconnect.js");
const { requireAuth } = await import("../middleware/auth.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { default: User } = await import("../models/User.js");
const { default: Lead } = await import("../models/Lead.js");
const { default: Opportunity } = await import("../models/Opportunity.js");
const { default: CRMCompany } = await import("../models/CRMCompany.js");
const { default: Invoice } = await import("../models/Invoice.js");
const { default: Contact } = await import("../models/plumconnect/Contact.js");
const { default: Conversation } = await import("../models/plumconnect/Conversation.js");
const { default: Ad } = await import("../models/plumconnect/Ad.js");
const { default: AdSet } = await import("../models/plumconnect/AdSet.js");
const { default: Campaign } = await import("../models/plumconnect/Campaign.js");
const { UNATTRIBUTED_NAME } = await import("../services/plumconnect/campaignRollup.js");

const app = express();
app.use(express.json());
app.use("/api/plumconnect", requireAuth as any, router);
const as = (id: mongoose.Types.ObjectId) => ({ "x-test-user": String(id) });
const get = (who: mongoose.Types.ObjectId, q = "") => request(app).get(`/api/plumconnect/campaigns/rollup${q}`).set(as(who));

let mongod: MongoMemoryServer;
const NOW = new Date("2026-09-21T12:00:00Z");
const OLD = new Date("2026-06-01T00:00:00Z");
const A1 = "120200000000000101", A2 = "120200000000000102", A3 = "120200000000000103", A4 = "120200000000000104", A5 = "120200000000000105", A6 = "120200000000000106";
const W1 = new mongoose.Types.ObjectId(), W2 = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Lead.syncIndexes(), Ad.syncIndexes(), AdSet.syncIndexes(), Campaign.syncIndexes()]);
  const ws = new mongoose.Types.ObjectId();
  for (const [k, id] of Object.entries(IDS)) {
    await User.collection.insertOne({ _id: id, name: `User ${k}`, email: `${k}@x.test`, roles: ROLES[String(id)] || ["EMPLOYEE"], passwordHash: "x", workspaceId: ws, status: "ACTIVE" } as any);
  }
  const grant = (userId: mongoose.Types.ObjectId, modules: any) =>
    UserPermission.create({ userId: String(userId), email: `${userId}@x.test`, workspaceId: String(ws), universe: "STAFF", source: "manual", level: { code: "L3", name: "Exec", designation: "x" }, status: "active", tier: 1, grantedModules: [], roleType: "EMPLOYEE", grantedBy: "test", grantedAt: new Date(), modules } as any);
  const all = (g: any) => ({ plumconnectPlumtrips: g, plumconnectHelloviza: g, plumconnectConcierge: g, plumconnectSupport: g });
  await grant(IDS.manager, all({ access: "FULL", scope: "ALL" }));
  await grant(IDS.rep, all({ access: "WRITE", scope: "OWN" }));
  await grant(IDS.vizaAdmin, { plumconnectHelloviza: { access: "FULL", scope: "ALL" } });

  /* ── the hierarchy (as the worker would have written it) ── */
  const c1 = await Campaign.create({ metaId: "C1", name: "Holidays Sept", status: "ACTIVE", objective: "OUTCOME_LEADS", lastEnrichedAt: NOW });
  const c2 = await Campaign.create({ metaId: "C2", name: "Corporate Q4", status: "PAUSED", lastEnrichedAt: NOW });
  const s1 = await AdSet.create({ metaId: "S1", name: "Bali LAL 1%", status: "ACTIVE", campaignId: c1._id, metaCampaignId: "C1", lastEnrichedAt: NOW });
  const s2 = await AdSet.create({ metaId: "S2", name: "Goa broad", status: "ACTIVE", campaignId: c1._id, metaCampaignId: "C1", lastEnrichedAt: NOW });
  const s3 = await AdSet.create({ metaId: "S3", name: "CFOs", status: "PAUSED", campaignId: c2._id, metaCampaignId: "C2", lastEnrichedAt: NOW });
  const enriched = (metaId: string, name: string, set: any, camp: any) =>
    Ad.create({ metaId, name, status: "ACTIVE", adSetId: set._id, metaAdSetId: set.metaId, campaignId: camp._id, metaCampaignId: camp.metaId, lastEnrichedAt: NOW, enrichment: { status: "enriched" } });
  await enriched(A1, "Bali carousel", s1, c1);
  await enriched(A2, "Bali video", s1, c1);
  await enriched(A3, "Goa static", s2, c1);
  await enriched(A4, "CFO whitepaper", s3, c2);
  await Ad.create({ metaId: A5, enrichment: { status: "pending" } }); // discovered, not enriched
  // A6: referenced by a lead but the worker has not discovered it yet

  /* ── accounts + invoices (raw: no hooks) ── */
  const compX = new mongoose.Types.ObjectId(), compY = new mongoose.Types.ObjectId();
  await CRMCompany.collection.insertMany([
    { _id: compX, name: "Acme", customerWorkspaceId: String(W1), createdAt: NOW, updatedAt: NOW },
    { _id: compY, name: "Globex", customerWorkspaceId: String(W2), createdAt: NOW, updatedAt: NOW },
  ] as any[]);
  await Invoice.collection.insertMany([
    { invoiceNo: "INV-1", workspaceId: W1, status: "PAID", grandTotal: 10000, invoiceDate: NOW, bookingIds: [], lineItems: [] },
    { invoiceNo: "INV-2", workspaceId: W1, status: "SENT", grandTotal: 5000, invoiceDate: NOW, bookingIds: [], lineItems: [] },
    { invoiceNo: "INV-3", workspaceId: W1, status: "DRAFT", grandTotal: 999, invoiceDate: NOW, bookingIds: [], lineItems: [] },
    { invoiceNo: "INV-4", workspaceId: W1, status: "CANCELLED", grandTotal: 777, invoiceDate: NOW, bookingIds: [], lineItems: [] },
    { invoiceNo: "INV-5", workspaceId: W2, status: "PAID", grandTotal: 30000, invoiceDate: NOW, bookingIds: [], lineItems: [] },
  ] as any[]);

  /* ── opportunities (raw: no hooks) ── */
  const oppWon1 = new mongoose.Types.ObjectId(), oppOpen = new mongoose.Types.ObjectId(), oppWon2 = new mongoose.Types.ObjectId();
  await Opportunity.collection.insertMany([
    { _id: oppWon1, opportunityCode: "OPP-1", name: "Acme Bali", pipeline: "holiday", stage: "closed_won", dealValue: 50000, currency: "INR", createdAt: NOW, updatedAt: NOW },
    { _id: oppOpen, opportunityCode: "OPP-2", name: "Acme Goa", pipeline: "holiday", stage: "options_sent", dealValue: 20000, currency: "INR", createdAt: NOW, updatedAt: NOW },
    { _id: oppWon2, opportunityCode: "OPP-3", name: "Globex corporate", pipeline: "corporate", stage: "closed_won", dealValue: 100000, currency: "INR", createdAt: NOW, updatedAt: NOW },
  ] as any[]);

  /* ── leads at known stages (raw: attribution + status as capture/bot write them) ── */
  const lead = (sourceId: string, over: any = {}) => ({
    contactName: "X", contactPhone: "919111111111", type: "individual", stage: "new", enquiryType: "holiday_package", sourceChannel: "whatsapp",
    attribution: { channel: "whatsapp", sourceType: "ad", sourceId, capturedAt: NOW }, createdAt: NOW, updatedAt: NOW, ...over,
  });
  await Lead.collection.insertMany([
    lead(A1, { status: "QUALIFIED" }),
    lead(A1, { status: "CONVERTED", opportunityId: oppWon1, companyId: compX }),
    lead(A1, { status: "NEW" }),
    lead(A2, { status: "CONVERTED", opportunityId: oppOpen, companyId: compX }), // same account as A1's won lead → invoices counted ONCE at the adset
    lead(A3, { status: null }),
    lead(A4, { status: "CONVERTED", opportunityId: oppWon2, companyId: compY }),
    lead(A4, { status: "CONTACTED" }),
    lead(A5, { status: "NEW" }),
    lead(A6, { status: "NEW" }),
    lead(A1, { status: "NEW", createdAt: OLD, updatedAt: OLD }), // outside a from= range
    { contactName: "organic", contactPhone: "919111111112", type: "individual", stage: "new", attribution: { channel: "", sourceId: "" }, createdAt: NOW, updatedAt: NOW }, // no ad → not in the tree
  ] as any[]);

  /* ── conversations that tapped the ads ── */
  let n = 0;
  const conv = async (sourceId: string | null, over: any = {}) => {
    const c = await Contact.create({ phone: `9193000000${String(++n).padStart(2, "0")}` });
    return Conversation.create({ contactId: c._id, kind: "lead", referralRaw: sourceId ? { source_type: "ad", source_id: sourceId } : null, ...over });
  };
  for (let i = 0; i < 4; i += 1) await conv(A1);
  await conv(A2);
  await conv(A4);
  await conv(A4);
  await conv(A6);
  await conv(null); // organic
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(() => {
  process.env.PLUMCONNECT_ENABLED = "true";
});

const byMeta = (nodes: any[], metaId: string | null) => nodes.find((n) => n.metaId === metaId);

describe("GET /campaigns/rollup", () => {
  it("returns the Campaign → AdSet → Ad tree with conversations / leads / qualified / opportunities / won / revenue from the real chain", async () => {
    const r = await get(IDS.manager);
    expect(r.status).toBe(200);
    const body = r.body;
    expect(body.pendingEnrichment).toBe(2); // A5 pending + A6 undiscovered

    // overall: 8 ad-tapped conversations, 10 ad leads (9 recent + 1 old), 4 qualified, 3 opps, 2 won
    expect(body.totals).toEqual({ conversations: 8, leads: 10, qualified: 4, opportunities: 3, won: 2, wonValue: 150000, invoiced: 45000, paid: 40000 });

    expect(body.campaigns.map((c: any) => c.name)).toEqual(["Holidays Sept", "Corporate Q4", UNATTRIBUTED_NAME]);

    const c1 = byMeta(body.campaigns, "C1");
    expect(c1).toMatchObject({ name: "Holidays Sept", status: "ACTIVE", objective: "OUTCOME_LEADS" });
    expect(c1.totals).toEqual({ conversations: 5, leads: 6, qualified: 3, opportunities: 2, won: 1, wonValue: 50000, invoiced: 15000, paid: 10000 });
    expect(c1.adSets.map((s: any) => s.metaId)).toEqual(["S1", "S2"]);

    const s1 = byMeta(c1.adSets, "S1");
    expect(s1.name).toBe("Bali LAL 1%");
    // A1 and A2 share account Acme: invoices 15000/10000 appear once at the adset, not twice
    expect(s1.totals).toEqual({ conversations: 5, leads: 5, qualified: 3, opportunities: 2, won: 1, wonValue: 50000, invoiced: 15000, paid: 10000 });
    const a1 = byMeta(s1.ads, A1);
    expect(a1).toMatchObject({ name: "Bali carousel", enrichment: "enriched" });
    expect(a1.totals).toEqual({ conversations: 4, leads: 4, qualified: 2, opportunities: 1, won: 1, wonValue: 50000, invoiced: 15000, paid: 10000 });
    expect(byMeta(s1.ads, A2).totals).toEqual({ conversations: 1, leads: 1, qualified: 1, opportunities: 1, won: 0, wonValue: 0, invoiced: 15000, paid: 10000 });
    expect(byMeta(c1.adSets, "S2").totals).toEqual({ conversations: 0, leads: 1, qualified: 0, opportunities: 0, won: 0, wonValue: 0, invoiced: 0, paid: 0 });

    const c2 = byMeta(body.campaigns, "C2");
    expect(c2.totals).toEqual({ conversations: 2, leads: 2, qualified: 1, opportunities: 1, won: 1, wonValue: 100000, invoiced: 30000, paid: 30000 });
    expect(c2.adSets[0].ads[0]).toMatchObject({ metaId: A4, name: "CFO whitepaper" });

    // the pending + undiscovered ads are never hidden
    const un = byMeta(body.campaigns, null);
    expect(un.name).toBe(UNATTRIBUTED_NAME);
    expect(un.totals).toEqual({ conversations: 1, leads: 2, qualified: 0, opportunities: 0, won: 0, wonValue: 0, invoiced: 0, paid: 0 });
    expect(un.adSets).toHaveLength(1);
    expect(un.adSets[0].ads.map((a: any) => [a.metaId, a.enrichment]).sort()).toEqual([[A5, "pending"], [A6, "undiscovered"]]);
  });

  it("from= / to= narrow leads and conversations by createdAt; an invalid date → 400", async () => {
    const r = await get(IDS.manager, "?from=2026-09-01T00:00:00Z");
    expect(r.status).toBe(200);
    expect(r.body.totals.leads).toBe(9); // the June lead drops out
    expect(byMeta(byMeta(r.body.campaigns, "C1").adSets, "S1").totals.leads).toBe(4);
    expect(r.body.range).toEqual({ from: "2026-09-01T00:00:00.000Z", to: null });
    const none = await get(IDS.manager, "?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z");
    expect(none.body.totals).toEqual({ conversations: 0, leads: 0, qualified: 0, opportunities: 0, won: 0, wonValue: 0, invoiced: 0, paid: 0 });
    expect(none.body.campaigns).toEqual([]);
    expect((await get(IDS.manager, "?from=yesterday")).status).toBe(400);
  });

  it("needs FULL on a line (or ADMIN): manager / admin / helloviza-FULL → 200; WRITE/OWN rep → 403; no grant → 403; flag OFF → 404", async () => {
    expect((await get(IDS.admin)).status).toBe(200);
    expect((await get(IDS.vizaAdmin)).status).toBe(200);
    expect((await get(IDS.rep)).status).toBe(403);
    expect((await get(IDS.nobody)).status).toBe(403);
    expect((await request(app).get("/api/plumconnect/campaigns/rollup")).status).toBe(401);
    delete process.env.PLUMCONNECT_ENABLED;
    expect((await get(IDS.admin)).status).toBe(404);
  });
});
