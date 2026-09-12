// Slice 2 — the migration script against a PROD-SHAPED fixture on
// mongodb-memory-server: raw inserts (no Mongoose defaults, no hooks) in the
// exact shape the leads / leadactivities / crmcompanies collections carry
// today, then dry-run → apply → re-run → rollback, asserting the printed
// counts and what is (and is not) on disk at each step.
//
// main() is never invoked: the module guards its auto-run behind isDirectRun.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumbox_dev";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const {
  preflightCounts, planMigration, applyMigration, backfillBlankNameNormalized,
  validateAfterApply, rollbackMigration, assertTargetAllowed, describeTarget, DEFAULT_RULE_ID,
} = await import("./migrate-lead-opportunity.js");
const { default: Lead } = await import("../models/Lead.js");
const { default: LeadActivity } = await import("../models/LeadActivity.js");
const { default: Opportunity } = await import("../models/Opportunity.js");
const { default: CRMCompany } = await import("../models/CRMCompany.js");

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Opportunity.syncIndexes();
  // prod's unique+partial key index on crmcompanies
  await CRMCompany.collection.createIndex(
    { nameNormalized: 1 },
    { unique: true, name: "nameNormalized_unique", partialFilterExpression: { nameNormalized: { $type: "string", $gt: "" } } },
  );
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all([Lead.deleteMany({}), LeadActivity.deleteMany({}), Opportunity.deleteMany({}), CRMCompany.deleteMany({}),
    mongoose.connection.collection("migrationruns").deleteMany({})]);
});

/* ───────────────────────── prod-shaped fixture ───────────────────────── */

const REP = new mongoose.Types.ObjectId();
const ADMIN = new mongoose.Types.ObjectId();
let seq = 0;

async function prodLead(stage: string, over: Record<string, any> = {}) {
  seq++;
  const res = await Lead.collection.insertOne({
    leadCode: `LEAD-2026-${String(seq).padStart(4, "0")}`,
    type: "company", companyName: `Company ${seq}`, industry: "IT/Technology", companySize: "51-200",
    location: "Bengaluru", address: "", website: "", gstin: "",
    contactName: `Contact ${seq}`, contactPhone: "9999999999", contactEmail: `c${seq}@example.com`, contactDesignation: "",
    source: "linkedin", stage, budget: "", dealValue: 0, currency: "INR", notes: "",
    assignedTo: REP, assignedToName: "Rep One", createdBy: ADMIN,
    followUpNotes: "", lostReason: "", onboardingInviteSent: false, onboardingToken: "",
    convertedToContactId: null, convertedToCompanyId: null, companyId: null,
    createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-02-01"),
    ...over,
  });
  return res.insertedId;
}
async function prodActivity(leadId: mongoose.Types.ObjectId, type: string, over: Record<string, any> = {}) {
  await LeadActivity.collection.insertOne({
    leadId, type, note: "", createdBy: REP, createdByName: "Rep One", createdAt: new Date("2026-01-15"), ...over,
  });
}
async function prodCompany(name: string, nameNormalized: string) {
  const res = await CRMCompany.collection.insertOne({
    companyCode: `COMP-2026-${String(++seq).padStart(4, "0")}`, name, nameNormalized,
    industry: "", companySize: "", website: "", phone: "", email: "", city: "", state: "", country: "", address: "", notes: "",
    leadId: null, contactCount: 0, createdBy: ADMIN, isPrivate: false, createdAt: new Date("2025-06-01"), updatedAt: new Date("2025-06-01"),
  });
  return res.insertedId;
}

/** 14 leads covering every legacy stage and both lost branches + 5 companies. */
async function seedFixture() {
  seq = 0;
  const ids: Record<string, mongoose.Types.ObjectId> = {};
  ids.new = await prodLead("new");
  ids.email_sent = await prodLead("email_sent");
  ids.contacted = await prodLead("contacted");
  ids.follow_up = await prodLead("follow_up", { nextFollowUpDate: new Date("2026-03-01"), followUpNotes: "call back" });
  ids.follow_up_nodate = await prodLead("follow_up");
  ids.demo = await prodLead("demo_scheduled");
  await prodActivity(ids.demo, "stage_change", { fromStage: "contacted", toStage: "demo_scheduled" });
  ids.proposal = await prodLead("proposal_sent", { dealValue: 500000 });
  await prodActivity(ids.proposal, "stage_change", { fromStage: "demo_scheduled", toStage: "proposal_sent" });
  ids.proposal_ind = await prodLead("proposal_sent", { type: "individual", companyName: "", dealValue: 80000 });
  ids.negotiation = await prodLead("negotiation", { dealValue: 1200000, currency: "USD" });
  ids.won = await prodLead("won", { dealValue: 900000, wonDate: new Date("2026-02-10"), convertedToContactId: new mongoose.Types.ObjectId() });
  await prodActivity(ids.won, "won", { createdAt: new Date("2026-02-10") });
  ids.won_nodate = await prodLead("won", { dealValue: 300000 });
  ids.lost_lead = await prodLead("lost", { lostReason: "No travel need" });
  await prodActivity(ids.lost_lead, "stage_change", { fromStage: "new", toStage: "contacted" });
  await prodActivity(ids.lost_lead, "lost", { createdAt: new Date("2026-01-20") });
  ids.lost_opp = await prodLead("lost", { lostReason: "Chose competitor", dealValue: 400000 });
  await prodActivity(ids.lost_opp, "stage_change", { fromStage: "demo_scheduled", toStage: "proposal_sent", createdAt: new Date("2026-01-10") });
  await prodActivity(ids.lost_opp, "lost", { createdAt: new Date("2026-01-25") });
  ids.lost_noreason = await prodLead("lost");

  // companies: 2 keyed (lead-created), 3 blank (manual) — one blank clashes
  // with a keyed row, two blanks share a name with each other.
  await prodCompany("Zetwerk", "zetwerk");
  await prodCompany("Sarvam AI", "sarvam ai");
  await prodCompany("zetwerk", "");            // clash with keyed row
  await prodCompany("Ather Energy", "");       // clean backfill
  await prodCompany("ather  energy", "");      // clashes with the row above (claimed in this run)
  return ids;
}

/* ───────────────────────── target guard ───────────────────────── */

describe("assertTargetAllowed (risk M13)", () => {
  it("accepts local plumbox_dev, refuses Atlas, remote hosts and an unnamed db", () => {
    expect(() => assertTargetAllowed("mongodb://127.0.0.1:27017/plumbox_dev", null)).not.toThrow();
    expect(() => assertTargetAllowed("mongodb+srv://u:p@main-prod-cluster.x.mongodb.net/plumbox", null)).toThrow(/mongodb\+srv/);
    expect(() => assertTargetAllowed("mongodb://u:p@10.0.0.5:27017/plumbox_dev", null)).toThrow(/non-local/);
    expect(() => assertTargetAllowed("mongodb://localhost:27017/plumbox_prodcopy", null)).toThrow(/expected 'plumbox_dev'/);
    expect(() => assertTargetAllowed("mongodb://localhost:27017/plumbox_prodcopy", "plumbox_prodcopy")).not.toThrow();
    expect(() => assertTargetAllowed("mongodb://localhost:27017/plumbox_dev", "plumbox_prodcopy")).toThrow(/expected 'plumbox_prodcopy'/);
    expect(() => assertTargetAllowed("", null)).toThrow(/empty/);
    expect(describeTarget("mongodb://a:b@127.0.0.1:27017,localhost:27018/plumbox_dev?rs=x")).toEqual({ hosts: ["127.0.0.1", "localhost"], db: "plumbox_dev", srv: false });
  });
});

/* ───────────────────────── dry run ───────────────────────── */

describe("dry run", () => {
  it("prints the plan counts and writes nothing", async () => {
    await seedFixture();
    const pre = await preflightCounts();
    expect(pre.leads).toBe(14);
    expect(pre.byStage).toEqual({ new: 1, email_sent: 1, contacted: 1, follow_up: 2, demo_scheduled: 1, proposal_sent: 2, negotiation: 1, won: 2, lost: 3 });
    expect(pre.byType).toEqual({ company: 13, individual: 1 });
    expect(pre.withDealValueByCurrency).toEqual({ INR: 5, USD: 1 });
    expect(pre.alreadyHaveStatus).toBe(0);
    expect(pre.crmCompaniesBlankKey).toBe(3);
    expect(pre.nameNormalizedIndexes.join()).toMatch(/nameNormalized_unique \(unique\) \(partial\)/);

    const plan = await planMigration();
    const s = plan.summary;
    expect(s.planned).toBe(14);
    expect(s.unmapped).toEqual([]);
    expect(s.becomeOpportunities).toBe(6);   // proposal×2, negotiation, won×2, lost-after-proposal
    expect(s.stayLeads).toBe(8);             // new, email_sent, contacted, follow_up×2, demo, lost×2 at lead grain
    expect(s.byTransition).toEqual({
      "new→NEW": 1,
      "email_sent→CONTACTED": 1,
      "contacted→CONTACTED": 1,
      "follow_up→CONTACTED": 2,
      "demo_scheduled→ENGAGED+demo": 1,
      "proposal_sent→CONVERTED+Opportunity(proposal)": 1,
      "proposal_sent→CONVERTED+Opportunity(options_sent)": 1,
      "negotiation→CONVERTED+Opportunity(negotiation)": 1,
      "won→CONVERTED+Opportunity(closed_won)": 2,
      "lost→LOST(lead)": 2,
      "lost→CONVERTED+Opportunity(closed_lost)": 1,
    });
    expect(s.opportunitiesByPipelineStage).toEqual({
      "corporate/proposal": 1, "travel_enquiry/options_sent": 1, "corporate/negotiation": 1,
      "corporate/closed_won": 2, "corporate/closed_lost": 1,
    });
    expect(s.demoActivities).toBe(1);
    expect(s.followUpDatesPreserved).toBe(1);
    expect(s.lostAtLead).toBe(2);
    expect(s.lostAtOpportunity).toBe(1);
    expect(s.closedAtSources).toEqual({ none: 3, wonDate: 1, lead_updatedAt: 1, lost_activity: 1 });
    expect(s.warningsByKind["follow_up without nextFollowUpDate"]).toBe(1);
    expect(s.warningsByKind["lost without a reason"]).toBe(1);
    expect(s.warningsByKind["won without wonDate or `won` activity — closedAt approximated from lead.updatedAt"]).toBe(1);
    expect(s.warningsByKind["enquiryType left blank (individual lead — service not recoverable from legacy row)"]).toBe(1);

    const blanks = await backfillBlankNameNormalized(true);
    expect(blanks).toMatchObject({ blanks: 3, backfilled: 1, unkeyable: 0 });
    expect(blanks.clashes.map((c) => c.name).sort()).toEqual(["ather  energy", "zetwerk"]);

    // NOTHING written
    expect(await Opportunity.countDocuments({})).toBe(0);
    expect(await Lead.countDocuments({ status: { $type: "string" } })).toBe(0);
    expect(await Lead.countDocuments({ opportunityId: { $type: "objectId" } })).toBe(0);
    expect(await LeadActivity.countDocuments({ automatedByRule: DEFAULT_RULE_ID })).toBe(0);
    expect(await CRMCompany.countDocuments({ nameNormalized: "" })).toBe(3);
  });
});

/* ───────────────────────── apply / re-run / rollback ───────────────────────── */

describe("apply", () => {
  it("writes exactly the plan, leaves Lead.stage and history untouched, validates, is idempotent, and rolls back", async () => {
    const ids = await seedFixture();
    const pre = await preflightCounts();
    const activitiesBefore = await LeadActivity.find({}).sort({ _id: 1 }).lean();
    const plan = await planMigration();

    const applied = await applyMigration(plan, DEFAULT_RULE_ID);
    expect(applied).toMatchObject({ applied: 14, opportunitiesCreated: 6, opportunitiesAdvanced: 0, skipped: 0, refusedUnmapped: 0, failures: [] });
    expect(applied.activitiesWritten).toBe(7); // 6 opportunity stage_change + 1 demo
    expect(applied.leadsUpdated).toBe(14);

    const keyed = await backfillBlankNameNormalized(false);
    expect(keyed.backfilled).toBe(1);
    expect(keyed.clashes).toHaveLength(2);
    expect((await CRMCompany.findOne({ name: "Ather Energy" }).lean())!.nameNormalized).toBe("ather energy");
    expect(await CRMCompany.countDocuments({ nameNormalized: "" })).toBe(2); // clashes left for a merge decision

    const v = await validateAfterApply(pre.leads, pre.byStage, plan.summary.becomeOpportunities, DEFAULT_RULE_ID);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.opportunitiesByRule).toBe(6);

    // Lead.stage distribution identical; every lead has a status; history rows byte-identical.
    expect((await preflightCounts()).byStage).toEqual(pre.byStage);
    expect(await Lead.countDocuments({ status: { $type: "string" } })).toBe(14);
    const activitiesAfter = await LeadActivity.find({ _id: { $in: activitiesBefore.map((a: any) => a._id) } }).sort({ _id: 1 }).lean();
    expect(activitiesAfter).toEqual(activitiesBefore);

    // Spot checks against the fixture
    const won = await Opportunity.findOne({ leadId: ids.won }).lean();
    expect(won).toMatchObject({ stage: "closed_won", dealValue: 900000, legacyLeadStage: "won" });
    expect(won!.closedAt!.toISOString()).toBe("2026-02-10T00:00:00.000Z");
    expect(String(won!.primaryContactId)).toBe(String((await Lead.findById(ids.won).lean())!.convertedToContactId));
    const usd = await Opportunity.findOne({ leadId: ids.negotiation }).lean();
    expect(usd).toMatchObject({ currency: "USD", dealValue: 1200000, stage: "negotiation", probability: 80 });
    const lostOpp = await Opportunity.findOne({ leadId: ids.lost_opp }).lean();
    expect(lostOpp).toMatchObject({ stage: "closed_lost", lostReason: "Chose competitor" });
    expect(await Opportunity.countDocuments({ leadId: ids.lost_lead })).toBe(0);
    expect((await Lead.findById(ids.lost_lead).lean())!.status).toBe("LOST");
    expect((await Lead.findById(ids.lost_opp).lean())!.status).toBe("CONVERTED");
    expect((await Lead.findById(ids.follow_up).lean())!.nextFollowUpDate!.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(await LeadActivity.countDocuments({ leadId: ids.demo, type: "demo", automatedByRule: DEFAULT_RULE_ID })).toBe(1);
    const ind = await Lead.findById(ids.proposal_ind).lean();
    expect(ind!.enquiryType ?? "").toBe(""); // never fabricated for an individual
    expect((await Opportunity.findOne({ leadId: ids.proposal_ind }).lean())!.pipeline).toBe("travel_enquiry");

    // ── Re-run: everything skipped, nothing new ──
    const plan2 = await planMigration();
    expect(plan2.summary.planned).toBe(0);
    expect(plan2.summary.skipped).toEqual({ already_converted: 6, already_migrated: 8 });
    const applied2 = await applyMigration(plan2, DEFAULT_RULE_ID);
    expect(applied2).toMatchObject({ applied: 0, skipped: 14, opportunitiesCreated: 0, activitiesWritten: 0 });
    expect(await Opportunity.countDocuments({})).toBe(6);
    expect(await LeadActivity.countDocuments({ automatedByRule: DEFAULT_RULE_ID })).toBe(7);

    // ── Rollback: dry run counts, then apply restores the pre-migration shape ──
    const dry = await rollbackMigration(DEFAULT_RULE_ID, true);
    expect(dry).toMatchObject({ opportunitiesToDelete: 6, activitiesToDelete: 7, leadsToReset: 14, opportunitiesDeleted: 0 });
    expect(await Opportunity.countDocuments({})).toBe(6);

    const rb = await rollbackMigration(DEFAULT_RULE_ID, false);
    expect(rb).toMatchObject({ opportunitiesDeleted: 6, activitiesDeleted: 7, leadsReset: 14 });
    expect(await Opportunity.countDocuments({})).toBe(0);
    expect(await Lead.countDocuments({ $or: [{ status: { $type: "string" } }, { opportunityId: { $type: "objectId" } }] })).toBe(0);
    expect(await Lead.countDocuments({ sourceChannel: { $nin: [null, ""] } })).toBe(0);
    expect((await preflightCounts()).byStage).toEqual(pre.byStage);
    expect(await LeadActivity.find({}).sort({ _id: 1 }).lean()).toEqual(activitiesBefore);
    // the key backfill is data hygiene and is NOT reverted
    expect((await CRMCompany.findOne({ name: "Ather Energy" }).lean())!.nameNormalized).toBe("ather energy");
  });

  it("rollback leaves a LIVE (non-migration) opportunity and its lead alone", async () => {
    await seedFixture();
    const plan = await planMigration();
    await applyMigration(plan, DEFAULT_RULE_ID);
    // a lead converted live after the migration (ruleId "")
    const liveLead = await prodLead("proposal_sent");
    const liveLeadDoc = (await Lead.findById(liveLead).lean()) as any;
    const { planLeadSplit, applyLeadSplit } = await import("../services/leadSplit.js");
    await applyLeadSplit(liveLeadDoc, planLeadSplit(liveLeadDoc, []), { ruleId: "" });
    expect(await Opportunity.countDocuments({})).toBe(7);

    const rb = await rollbackMigration(DEFAULT_RULE_ID, false);
    expect(rb.opportunitiesDeleted).toBe(6);
    expect(rb.leadsReset).toBe(14);
    expect(await Opportunity.countDocuments({ leadId: liveLead })).toBe(1);
    expect((await Lead.findById(liveLead).lean())!.status).toBe("CONVERTED");
  });

  it("refuses unmapped rows and reports them without aborting the rest", async () => {
    await seedFixture();
    const bad = await prodLead("", {}); // blank stage — does not map
    const plan = await planMigration();
    expect(plan.summary.unmapped).toHaveLength(1);
    expect(plan.summary.unmapped[0].leadId).toBe(String(bad));
    const applied = await applyMigration(plan, DEFAULT_RULE_ID);
    expect(applied.refusedUnmapped).toBe(1);
    expect(applied.applied).toBe(14);
    expect((await Lead.collection.findOne({ _id: bad }))!.status).toBeUndefined();
  });
});
