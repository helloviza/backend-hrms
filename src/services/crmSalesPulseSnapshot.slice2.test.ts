// Slice 2 — the LIVE Sales Pulse report (risk M4) and the owner-status
// aggregation it reuses must be right on pre-migration data, post-migration
// data and the mix in between. Seeds legacy-vocabulary rows AND new-taxonomy
// rows written "today", then asserts the milestone KPIs are identical under
// both flag states while the vocabulary of the distribution switches.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/pulse-slice2-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: Lead } = await import("../models/Lead.js");
const { default: LeadActivity } = await import("../models/LeadActivity.js");
const { default: Opportunity } = await import("../models/Opportunity.js");
const { computeSalesPulseSnapshot } = await import("./crmSalesPulseSnapshot.js");
const { buildOwnerStatusReport } = await import("./ownerStatusReport.js");
const { CRM_V2_OPPORTUNITY_ENV } = await import("../config/crmV2.js");

let mongod: MongoMemoryServer;
const REP = new mongoose.Types.ObjectId();
const REP2 = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Opportunity.syncIndexes();
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all([Lead.deleteMany({}), LeadActivity.deleteMany({}), Opportunity.deleteMany({})]);
});
afterEach(() => {
  delete process.env[CRM_V2_OPPORTUNITY_ENV];
});
const flag = (on: boolean) => (on ? (process.env[CRM_V2_OPPORTUNITY_ENV] = "true") : delete process.env[CRM_V2_OPPORTUNITY_ENV]);

async function rawLead(over: Record<string, any>) {
  const res = await Lead.collection.insertOne({
    contactName: "C", contactPhone: "1", companyName: "Co", type: "company", source: "manual",
    dealValue: 0, currency: "INR", assignedTo: REP, assignedToName: "Rep One",
    createdAt: new Date(), updatedAt: new Date(), ...over,
  });
  return res.insertedId;
}
const now = () => new Date();

/** A mixed-vocabulary day: 2 legacy rows, 2 new-taxonomy lead rows, 2 opportunity rows. */
async function seedMixedDay() {
  const a = await rawLead({ stage: "demo_scheduled" });
  const b = await rawLead({ stage: "proposal_sent", dealValue: 100000 });
  const c = await rawLead({ stage: "demo_scheduled", status: "ENGAGED" });
  const d = await rawLead({ stage: "won", status: "CONVERTED", dealValue: 50000, assignedTo: REP2, assignedToName: "Rep Two" });
  const oppD = await Opportunity.create({ leadId: d, pipeline: "corporate", stage: "closed_won", dealValue: 50000, ownerUserId: REP2 });
  const e = await rawLead({ stage: "negotiation", status: "CONVERTED", dealValue: 70000 });
  const oppE = await Opportunity.create({ leadId: e, pipeline: "corporate", stage: "negotiation", dealValue: 70000, ownerUserId: REP });
  await Lead.collection.updateOne({ _id: d }, { $set: { opportunityId: oppD._id } });
  await Lead.collection.updateOne({ _id: e }, { $set: { opportunityId: oppE._id } });

  // legacy vocabulary (pre-migration rows as prod writes them today)
  await LeadActivity.collection.insertOne({ leadId: a, type: "stage_change", fromStage: "contacted", toStage: "demo_scheduled", createdAt: now() });
  await LeadActivity.collection.insertOne({ leadId: b, type: "stage_change", fromStage: "demo_scheduled", toStage: "proposal_sent", createdAt: now() });
  // new taxonomy — lead rows
  await LeadActivity.create({ leadId: c, subject: { type: "LEAD", id: c }, type: "stage_change", fromStage: "contacted", toStage: "demo_scheduled", fromStatus: "CONTACTED", toStatus: "ENGAGED" });
  await LeadActivity.create({ leadId: c, subject: { type: "LEAD", id: c }, type: "demo", note: "held" });
  // new taxonomy — opportunity rows
  await LeadActivity.create({ leadId: d, subject: { type: "OPPORTUNITY", id: oppD._id }, type: "stage_change", fromStage: "negotiation", toStage: "closed_won" });
  await LeadActivity.create({ leadId: e, subject: { type: "OPPORTUNITY", id: oppE._id }, type: "stage_change", fromStage: "proposal", toStage: "negotiation" });
  return { a, b, c, d, e };
}

function kpi(snap: any, key: string) {
  return snap.kpis.find((k: any) => k.key === key)!.value;
}

describe("Sales Pulse — milestone KPIs are vocabulary-independent", () => {
  it.each([false, true])("flag=%s: demos=3 proposals=1 negotiation=1 won=1 lost=0 from a mixed day", async (on) => {
    await seedMixedDay();
    flag(on);
    const snap = await computeSalesPulseSnapshot({ conversionTracker: true, leadAgeing: true } as any);
    // demos: legacy toStage demo_scheduled (a) + new toStatus ENGAGED (c) + demo type (c)
    expect(kpi(snap, "demos")).toBe(3);
    expect(kpi(snap, "proposals")).toBe(1);   // legacy proposal_sent (b); opportunity "negotiation" row is not a proposal
    expect(kpi(snap, "negotiation")).toBe(1); // opportunity row (e)
    expect(kpi(snap, "won")).toBe(1);         // opportunity closed_won (d)
    expect(kpi(snap, "lost")).toBe(0);
    expect(kpi(snap, "new_leads")).toBe(5);

    // conversion funnel (ever-reached): demos a,b(current stage? no — b is proposal_sent),c ; proposals b,e? …
    const steps = Object.fromEntries(snap.conversion.steps.map((s: any) => [s.key, s.count]));
    expect(steps.leads).toBe(5);
    expect(steps.demos).toBe(2);      // a (current stage + history), c (status ENGAGED + rows)
    expect(steps.proposals).toBe(1);  // b
    expect(steps.won).toBe(1);        // d

    const rep2 = snap.repCards.find((r: any) => r.ownerId === String(REP2));
    expect(rep2?.won).toBe(1);
    const rep1 = snap.repCards.find((r: any) => r.ownerId === String(REP));
    expect(rep1?.demos).toBe(3);
  });

  it("flag OFF: distribution/movement speak the 9 legacy stages; flag ON: lead statuses + deal rows", async () => {
    await seedMixedDay();
    flag(false);
    let snap = await computeSalesPulseSnapshot();
    expect(snap.movement.map((m) => m.stage)).toEqual(["new", "email_sent", "contacted", "demo_scheduled", "proposal_sent", "negotiation", "follow_up", "won", "lost"]);
    expect(snap.movement.find((m) => m.stage === "demo_scheduled")!.count).toBe(2); // a + c (both wrote toStage demo_scheduled)
    expect(snap.stageDistribution.map((s) => s.stage)).toContain("proposal_sent");

    flag(true);
    snap = await computeSalesPulseSnapshot();
    const keys = snap.movement.map((m) => m.stage);
    expect(keys.slice(0, 8)).toEqual(["NEW", "ASSIGNED", "CONTACTED", "ENGAGED", "QUALIFIED", "CONVERTED", "NURTURE", "LOST"]);
    expect(keys.slice(8)).toEqual(["opp:proposal", "opp:negotiation", "opp:won", "opp:lost"]);
    expect(snap.movement.find((m) => m.stage === "ENGAGED")!.count).toBe(1); // only c carries toStatus
    expect(snap.movement.find((m) => m.stage === "opp:won")!.count).toBe(1);
    const dist = Object.fromEntries(snap.stageDistribution.map((s) => [s.stage, s.count]));
    expect(dist).toMatchObject({ ENGAGED: 2, CONVERTED: 3, NEW: 0 }); // a,c engaged; b (derived), d, e converted
    // ageing: converted leads are the Opportunity's business now
    expect(snap.ageingAlert.map((r) => r.stage).sort()).toEqual(["ENGAGED", "ENGAGED"]);
    expect(snap.meta.movementNote).toMatch(/Deal rows/);
  });
});

describe("owner-status report — money follows the Opportunity under the flag", () => {
  it("flag OFF sums Lead.dealValue on open legacy stages; flag ON sums open Opportunity dealValue and counts deal outcomes", async () => {
    await seedMixedDay();
    flag(false);
    let r = await buildOwnerStatusReport({});
    expect(r.pipeline.totalPipelineValue).toBe(170000); // b 100000 + e 70000 (won d excluded)
    expect(r.statusSnapshot.map((s) => s.stage)).toContain("follow_up");
    let rep1 = r.performance.find((p) => p.ownerId === String(REP))!;
    expect(rep1).toMatchObject({ total: 4, won: 0, lost: 0 });

    flag(true);
    r = await buildOwnerStatusReport({});
    expect(r.statusSnapshot.map((s) => s.stage)).toEqual(["NEW", "ASSIGNED", "CONTACTED", "ENGAGED", "QUALIFIED", "CONVERTED", "NURTURE", "LOST"]);
    expect(r.totals.byStatus).toMatchObject({ ENGAGED: 2, CONVERTED: 3 });
    // b is CONVERTED (derived) but has NO opportunity row yet (unmigrated) → contributes nothing; e's open opp → 70000
    expect(r.pipeline.totalPipelineValue).toBe(70000);
    rep1 = r.performance.find((p) => p.ownerId === String(REP))!;
    expect(rep1).toMatchObject({ total: 4, won: 0, lost: 0 });
    const rep2 = r.performance.find((p) => p.ownerId === String(REP2))!;
    expect(rep2).toMatchObject({ total: 1, won: 1, lost: 0, closed: 1, winPct: 100 });
    // open for ageing = a, c (lead-open) + e (open deal); b and d are closed at both grains
    expect(r.ageing.openTotal).toBe(3);
  });

});
