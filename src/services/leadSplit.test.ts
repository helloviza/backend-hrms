// Slice 2 — the split logic. planLeadSplit is pure and is pinned stage by
// stage; applyLeadSplit is exercised against real collections so what lands
// in Mongo (one Opportunity per lead, provenance-stamped activities, an
// untouched Lead.stage) is what is asserted, not a mock's memory of a call.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/leadsplit-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { planLeadSplit, applyLeadSplit, applyLegacyStageTransition, automationTriggerForPlan, reachedOpportunityStage } =
  await import("./leadSplit.js");
const { default: Lead } = await import("../models/Lead.js");
const { default: LeadActivity } = await import("../models/LeadActivity.js");
const { default: Opportunity } = await import("../models/Opportunity.js");
const { CRM_V2_OPPORTUNITY_ENV } = await import("../config/crmV2.js");

const RULE = "migration-test-rule";
const oid = () => new mongoose.Types.ObjectId();

function lead(over: Record<string, any> = {}) {
  return {
    _id: oid(),
    leadCode: "LEAD-2026-0001",
    stage: "new",
    type: "company",
    companyName: "Acme Corp",
    contactName: "Priya",
    source: "linkedin",
    assignedTo: oid(),
    assignedToName: "Rep",
    createdBy: oid(),
    companyId: oid(),
    dealValue: 250000,
    currency: "INR",
    lostReason: "",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-02-01"),
    ...over,
  };
}
const sc = (toStage: string, at = "2026-01-15") => ({ type: "stage_change", toStage, createdAt: new Date(at) });

/* ───────────────────────── plan (pure) ───────────────────────── */

describe("planLeadSplit — reviewer-locked transition table", () => {
  it("new → NEW, no opportunity", () => {
    const p = planLeadSplit(lead({ stage: "new" }));
    expect(p.leadStatus).toBe("NEW");
    expect(p.opportunity).toBeNull();
    expect(p.transition).toBe("new→NEW");
    expect(p.enquiryType).toBe("corporate_account");
    expect(p.sourceChannel).toBe("linkedin");
  });

  it.each(["email_sent", "contacted"])("%s → CONTACTED, no opportunity", (stage) => {
    const p = planLeadSplit(lead({ stage }));
    expect(p.leadStatus).toBe("CONTACTED");
    expect(p.opportunity).toBeNull();
  });

  it("follow_up → CONTACTED, nextFollowUpDate preserved (warns when absent)", () => {
    const p = planLeadSplit(lead({ stage: "follow_up", nextFollowUpDate: new Date("2026-03-01") }));
    expect(p.leadStatus).toBe("CONTACTED");
    expect(p.preserveFollowUp).toBe(true);
    expect(p.warnings).toEqual([]);
    const q = planLeadSplit(lead({ stage: "follow_up" }));
    expect(q.warnings).toContain("follow_up without nextFollowUpDate");
  });

  it("demo_scheduled → ENGAGED + demo activity, no opportunity", () => {
    const p = planLeadSplit(lead({ stage: "demo_scheduled" }));
    expect(p.leadStatus).toBe("ENGAGED");
    expect(p.logDemo).toBe(true);
    expect(p.opportunity).toBeNull();
    expect(p.transition).toBe("demo_scheduled→ENGAGED+demo");
  });

  it("proposal_sent → CONVERTED + Opportunity(proposal) [corporate] / (options_sent) [travel_enquiry]", () => {
    const c = planLeadSplit(lead({ stage: "proposal_sent" }));
    expect(c.leadStatus).toBe("CONVERTED");
    expect(c.opportunity).toMatchObject({ pipeline: "corporate", stage: "proposal", closedAt: null });
    const i = planLeadSplit(lead({ stage: "proposal_sent", type: "individual" }));
    expect(i.opportunity).toMatchObject({ pipeline: "travel_enquiry", stage: "options_sent" });
    expect(i.enquiryType).toBe("");
    expect(i.warnings.some((w) => w.startsWith("enquiryType left blank"))).toBe(true);
  });

  it("negotiation → CONVERTED + Opportunity(negotiation / decision)", () => {
    expect(planLeadSplit(lead({ stage: "negotiation" })).opportunity).toMatchObject({ pipeline: "corporate", stage: "negotiation" });
    expect(planLeadSplit(lead({ stage: "negotiation", type: "individual" })).opportunity).toMatchObject({ stage: "decision" });
  });

  it("won → CONVERTED + Opportunity(closed_won); closedAt = wonDate ?? won activity ?? updatedAt", () => {
    const wonDate = new Date("2026-02-10");
    const a = planLeadSplit(lead({ stage: "won", wonDate }));
    expect(a.opportunity).toMatchObject({ stage: "closed_won", closedAt: wonDate, closedAtSource: "wonDate" });
    expect(a.warnings).toEqual([]);

    const b = planLeadSplit(lead({ stage: "won" }), [{ type: "won", createdAt: new Date("2026-02-11") }]);
    expect(b.opportunity!.closedAtSource).toBe("won_activity");

    const c = planLeadSplit(lead({ stage: "won" }));
    expect(c.opportunity!.closedAtSource).toBe("lead_updatedAt");
    expect(c.warnings.some((w) => w.includes("approximated"))).toBe(true);
  });

  it("lost with no commercial history → LOST at lead grain, reason kept", () => {
    const p = planLeadSplit(lead({ stage: "lost", lostReason: "No budget" }), [sc("contacted"), sc("demo_scheduled")]);
    expect(p.leadStatus).toBe("LOST");
    expect(p.lostAt).toBe("lead");
    expect(p.opportunity).toBeNull();
    expect(p.transition).toBe("lost→LOST(lead)");
    const q = planLeadSplit(lead({ stage: "lost" }));
    expect(q.warnings).toContain("lost without a reason");
  });

  it("lost after reaching proposal_sent / negotiation / won → CONVERTED + Opportunity(closed_lost) with reason", () => {
    const hist = [sc("contacted", "2026-01-05"), sc("proposal_sent", "2026-01-10"), { type: "lost", createdAt: new Date("2026-01-20") }];
    const p = planLeadSplit(lead({ stage: "lost", lostReason: "Went with competitor" }), hist);
    expect(p.leadStatus).toBe("CONVERTED");
    expect(p.lostAt).toBe("opportunity");
    expect(p.opportunity).toMatchObject({ stage: "closed_lost", lostReason: "Went with competitor", closedAtSource: "lost_activity" });
    expect(p.opportunity!.closedAt!.toISOString()).toBe("2026-01-20T00:00:00.000Z");
    // a `won` activity or wonDate also counts as "reached"
    expect(reachedOpportunityStage(lead({ stage: "lost" }), [{ type: "won" }])).toBe(true);
    expect(reachedOpportunityStage(lead({ stage: "lost", wonDate: new Date() }), [])).toBe(true);
    expect(reachedOpportunityStage(lead({ stage: "lost" }), [sc("demo_scheduled")])).toBe(false);
  });

  it("a blank / unknown stage is UNMAPPED and never applied", async () => {
    const p = planLeadSplit(lead({ stage: "" }));
    expect(p.unmapped).toMatch(/not a legacy stage/);
    await expect(applyLeadSplit(lead({ stage: "" }), p, { ruleId: RULE })).rejects.toThrow(/unmapped/);
  });

  it("idempotency (migration mode): converted or already-statused rows are skipped; live mode never skips", () => {
    expect(planLeadSplit(lead({ stage: "proposal_sent", opportunityId: oid() })).skipped).toBe("already_converted");
    expect(planLeadSplit(lead({ stage: "contacted", status: "CONTACTED" })).skipped).toBe("already_migrated");
    expect(planLeadSplit(lead({ stage: "proposal_sent", status: "CONVERTED" })).skipped).toBeNull(); // opp still missing → apply
    expect(planLeadSplit(lead({ stage: "contacted", status: "CONTACTED" }), [], { mode: "live" }).skipped).toBeNull();
  });
});

describe("automationTriggerForPlan", () => {
  it("names the new-taxonomy key for what the plan did", () => {
    expect(automationTriggerForPlan(planLeadSplit(lead({ stage: "contacted" })))).toEqual({ key: "lead.status_contacted", entityType: "LEAD" });
    expect(automationTriggerForPlan(planLeadSplit(lead({ stage: "demo_scheduled" })))).toEqual({ key: "lead.status_engaged", entityType: "LEAD" });
    expect(automationTriggerForPlan(planLeadSplit(lead({ stage: "proposal_sent" })))).toEqual({ key: "opportunity.stage_proposal", entityType: "OPPORTUNITY" });
    expect(automationTriggerForPlan(planLeadSplit(lead({ stage: "negotiation", type: "individual" })))).toEqual({ key: "opportunity.stage_negotiation", entityType: "OPPORTUNITY" });
    expect(automationTriggerForPlan(planLeadSplit(lead({ stage: "won" })))).toEqual({ key: "opportunity.won", entityType: "OPPORTUNITY" });
    expect(automationTriggerForPlan(planLeadSplit(lead({ stage: "lost" }), [sc("negotiation")]))).toEqual({ key: "opportunity.lost", entityType: "OPPORTUNITY" });
    expect(automationTriggerForPlan(planLeadSplit(lead({ stage: "new" })))).toBeNull();
    expect(automationTriggerForPlan(planLeadSplit(lead({ stage: "lost" })))).toBeNull();
  });
});

/* ───────────────────────── apply (real collections) ───────────────────────── */

let mongod: MongoMemoryServer;
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

/** A lead as prod stores it (raw insert: no status, no opportunityId). */
async function insertProdLead(over: Record<string, any> = {}) {
  const doc = { ...lead(over) };
  delete (doc as any)._id;
  const res = await Lead.collection.insertOne({
    contactPhone: "9999999999", contactEmail: "", industry: "", companySize: "", location: "",
    address: "", website: "", gstin: "", contactDesignation: "", budget: "", notes: "",
    followUpNotes: "", onboardingInviteSent: false, onboardingToken: "",
    convertedToContactId: null, convertedToCompanyId: null, ...doc,
  });
  return (await Lead.findById(res.insertedId).lean()) as any;
}

describe("applyLeadSplit", () => {
  it("proposal_sent: creates the Opportunity, one provenance-stamped activity, sets lead fields — never stage", async () => {
    const l = await insertProdLead({ stage: "proposal_sent", convertedToContactId: oid() });
    const plan = planLeadSplit(l, []);
    const r = await applyLeadSplit(l, plan, { ruleId: RULE });
    expect(r.opportunityCreated).toBe(true);
    expect(r.activitiesWritten).toBe(1);
    expect(r.leadUpdated).toBe(true);

    const opp = await Opportunity.findOne({ leadId: l._id }).lean();
    expect(opp).toMatchObject({
      pipeline: "corporate", stage: "proposal", probability: 65, dealValue: 250000, currency: "INR",
      legacyLeadStage: "proposal_sent", automatedByRule: RULE, ownerName: "Rep", name: "Acme Corp",
    });
    expect(String(opp!.companyId)).toBe(String(l.companyId));
    expect(String(opp!.primaryContactId)).toBe(String(l.convertedToContactId));
    expect(String(opp!.ownerUserId)).toBe(String(l.assignedTo));

    const raw = await Lead.collection.findOne({ _id: l._id });
    expect(raw!.stage).toBe("proposal_sent");
    expect(raw!.status).toBe("CONVERTED");
    expect(String(raw!.opportunityId)).toBe(String(opp!._id));
    expect(raw!.sourceChannel).toBe("linkedin");
    expect(raw!.enquiryType).toBe("corporate_account");
    expect(raw!.updatedAt.toISOString()).toBe(l.updatedAt.toISOString()); // raw $set, no timestamp bump

    const acts = await LeadActivity.find({ leadId: l._id }).lean();
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ type: "stage_change", toStage: "proposal", automatedByRule: RULE });
    expect((acts[0] as any).subject).toMatchObject({ type: "OPPORTUNITY" });
  });

  it("is idempotent: a second pass over the same lead plans `skipped` and writes nothing", async () => {
    const l = await insertProdLead({ stage: "won", wonDate: new Date("2026-02-10") });
    await applyLeadSplit(l, planLeadSplit(l, []), { ruleId: RULE });
    const again = (await Lead.findById(l._id).lean()) as any;
    const plan2 = planLeadSplit(again, []);
    expect(plan2.skipped).toBe("already_converted");
    const r2 = await applyLeadSplit(again, plan2, { ruleId: RULE });
    expect(r2.opportunityCreated).toBe(false);
    expect(r2.activitiesWritten).toBe(0);
    expect(await Opportunity.countDocuments({})).toBe(1);
    expect(await LeadActivity.countDocuments({})).toBe(1);
  });

  it("demo_scheduled: writes ONE demo activity even if applied twice, no opportunity", async () => {
    const l = await insertProdLead({ stage: "demo_scheduled" });
    await applyLeadSplit(l, planLeadSplit(l, []), { ruleId: RULE });
    await applyLeadSplit(l, planLeadSplit(l, [], { mode: "live" }), { ruleId: RULE });
    const demos = await LeadActivity.find({ leadId: l._id, type: "demo" }).lean();
    expect(demos).toHaveLength(1);
    expect(demos[0].automatedByRule).toBe(RULE);
    expect(await Opportunity.countDocuments({})).toBe(0);
    expect((await Lead.collection.findOne({ _id: l._id }))!.status).toBe("ENGAGED");
  });

  it("follow_up: status CONTACTED and nextFollowUpDate untouched", async () => {
    const when = new Date("2026-03-03");
    const l = await insertProdLead({ stage: "follow_up", nextFollowUpDate: when });
    await applyLeadSplit(l, planLeadSplit(l, []), { ruleId: RULE });
    const raw = await Lead.collection.findOne({ _id: l._id });
    expect(raw!.status).toBe("CONTACTED");
    expect(raw!.nextFollowUpDate.toISOString()).toBe(when.toISOString());
    expect(raw!.stage).toBe("follow_up");
  });

  it("lost after proposal: Opportunity closed_lost carries the reason and the lost timestamp", async () => {
    const l = await insertProdLead({ stage: "lost", lostReason: "Budget cut" });
    const hist = [sc("proposal_sent", "2026-01-10"), { type: "lost", createdAt: new Date("2026-01-20") }];
    await applyLeadSplit(l, planLeadSplit(l, hist), { ruleId: RULE });
    const opp = await Opportunity.findOne({ leadId: l._id }).lean();
    expect(opp).toMatchObject({ stage: "closed_lost", lostReason: "Budget cut", probability: 0 });
    expect(opp!.closedAt!.toISOString()).toBe("2026-01-20T00:00:00.000Z");
    expect((await Lead.collection.findOne({ _id: l._id }))!.status).toBe("CONVERTED");
  });

  it("advances an existing Opportunity instead of creating a second (unique leadId)", async () => {
    const l = await insertProdLead({ stage: "proposal_sent" });
    await applyLeadSplit(l, planLeadSplit(l, []), { ruleId: RULE });
    const moved = { ...(await Lead.findById(l._id).lean()), stage: "negotiation" } as any;
    const r = await applyLeadSplit(moved, planLeadSplit(moved, [], { mode: "live" }), { ruleId: "" });
    expect(r.opportunityAdvanced).toBe(true);
    expect(await Opportunity.countDocuments({ leadId: l._id })).toBe(1);
    const opp = await Opportunity.findOne({ leadId: l._id }).lean();
    expect(opp!.stage).toBe("negotiation");
    expect(opp!.probability).toBe(80);
    const acts = await LeadActivity.find({ leadId: l._id, "subject.type": "OPPORTUNITY" }).sort({ createdAt: 1 }).lean();
    expect(acts.map((a: any) => a.toStage)).toEqual(["proposal", "negotiation"]);
    expect(acts[1].automatedByRule).toBe("");
  });
});

describe("applyLegacyStageTransition (live routes)", () => {
  it("throws CrmV2DisabledError when the flag is off", async () => {
    const l = await insertProdLead({ stage: "proposal_sent" });
    await expect(applyLegacyStageTransition(l, {})).rejects.toMatchObject({ code: "CRM_V2_OPPORTUNITY_DISABLED" });
    expect(await Opportunity.countDocuments({})).toBe(0);
  });

  it("flag on: re-plans from stored history and applies in live mode", async () => {
    process.env[CRM_V2_OPPORTUNITY_ENV] = "true";
    const l = await insertProdLead({ stage: "lost", lostReason: "Ghosted" });
    await LeadActivity.create({ leadId: l._id, type: "stage_change", fromStage: "contacted", toStage: "negotiation" });
    const { plan, result } = await applyLegacyStageTransition(l, { actorName: "Rep" });
    expect(plan.lostAt).toBe("opportunity");
    expect(result.opportunityCreated).toBe(true);
    expect((await Opportunity.findOne({ leadId: l._id }).lean())!.stage).toBe("closed_lost");
  });
});
