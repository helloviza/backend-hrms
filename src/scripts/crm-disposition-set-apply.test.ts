// scripts/crm-disposition-set-apply.ts — against real collections
// (mongodb-memory-server). main() never runs: the module guards it behind
// isDirectRun. Proves: zero diff for the seed, validation through the MODEL,
// rename backfill (leads + lostReason) without touching leadactivities,
// the orphan guard, and idempotency.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/set-apply-test";
process.env.JWT_SECRET ||= "test-secret";

const { planSetChange, applySetChange, loadSpec, parseRename, normaliseEntry } = await import("./crm-disposition-set-apply.js");
const { CORPORATE_CALLING_SET } = await import("../models/crmDisposition.js");
const { default: CrmPipeline } = await import("../models/CrmPipeline.js");
const { default: Lead } = await import("../models/Lead.js");
const { default: LeadActivity } = await import("../models/LeadActivity.js");
const { default: Opportunity } = await import("../models/Opportunity.js");
const { ensureDefaultPipeline } = await import("../services/crmPipelines.js");

const KEY = "corporate_calling";
let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await CrmPipeline.syncIndexes();
  await Opportunity.syncIndexes();
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all([CrmPipeline.deleteMany({}), Lead.deleteMany({}), LeadActivity.deleteMany({}), Opportunity.deleteMany({})]);
});

const seed = () => loadSpec("@seed");
const withSub = (set: any[], sub: string, patch: Record<string, unknown>) => set.map((e) => (e.subDisposition === sub ? { ...e, ...patch } : e));
async function leadOn(sub: string, extra: Record<string, unknown> = {}) {
  const e = CORPORATE_CALLING_SET.find((x) => x.subDisposition === sub)!;
  return Lead.create({
    contactName: "A", contactPhone: "9", disposition: e.disposition, subDisposition: e.subDisposition,
    dispositionStage: e.stage, dispositionStatus: e.status, stage: e.legacyStage, status: e.leadStatus, ...extra,
  });
}

describe("crm-disposition-set-apply", () => {
  it("the seed as the spec against a seeded DB → zero differences, nothing written", async () => {
    const p = await ensureDefaultPipeline();
    const plan = await planSetChange({ pipelineKey: KEY, spec: seed(), renames: [] });
    expect(plan.problems).toEqual([]);
    expect(plan.changes).toEqual([]);
    expect(plan.orderChanged).toBe(false);
    expect(plan.setChanged).toBe(false);
    const r = await applySetChange({ pipelineKey: KEY, spec: seed(), renames: [] });
    expect(r.setWritten).toBe("unchanged");
    expect((await CrmPipeline.findById(p._id).lean())!.updatedAt).toEqual(p.updatedAt);
  });

  it("no row yet → --apply creates it from the spec (the seed path)", async () => {
    const plan = await planSetChange({ pipelineKey: KEY, spec: seed(), renames: [] });
    expect(plan.exists).toBe(false);
    expect((await applySetChange({ pipelineKey: KEY, spec: seed(), renames: [] })).setWritten).toBe("created");
    expect((await CrmPipeline.findOne({ key: KEY }).lean())!.dispositionSet).toHaveLength(CORPORATE_CALLING_SET.length);
  });

  it("reports added / changed / removed with lead counts; a bad spec is refused before any write", async () => {
    await ensureDefaultPipeline();
    await leadOn("Trust Issue");
    await leadOn("Trust Issue", { dispositionStatus: "Lost" });
    let spec = withSub(seed(), "Ringing Only", { nextTouch: false }).filter((e) => e.subDisposition !== "Trust Issue");
    spec.push(normaliseEntry({ disposition: "Call Back", subDisposition: "Call Back Tomorrow", stage: "In-progress", status: "Open", nextTouch: true, opportunityEffect: "none", leadStatus: "CONTACTED", legacyStage: "follow_up" }));
    const plan = await planSetChange({ pipelineKey: KEY, spec, renames: [] });
    expect(plan.changes.find((c) => c.kind === "added")?.sub).toBe("Call Back Tomorrow");
    expect(plan.changes.find((c) => c.kind === "changed")).toMatchObject({ sub: "Ringing Only", fields: [{ field: "nextTouch", before: true, after: false }] });
    expect(plan.changes.find((c) => c.kind === "removed")).toMatchObject({ sub: "Trust Issue", leads: 2 });
    // the orphan guard
    await expect(applySetChange({ pipelineKey: KEY, spec, renames: [] })).rejects.toThrow(/leads still sit on: "Trust Issue" \(2\)/);

    // invalid: bad legacyStage, case-insensitive duplicate, open with a stage the deal pipeline lacks
    spec = seed();
    spec[0] = { ...spec[0], legacyStage: "folow_up" as any };
    spec.push({ ...spec[1], subDisposition: spec[1].subDisposition.toUpperCase() });
    spec = withSub(spec, "Proposal Mail Sent", { opportunityStage: "options_sent" });
    const bad = await planSetChange({ pipelineKey: KEY, spec, renames: [] });
    expect(bad.problems.join(" | ")).toMatch(/bad legacyStage folow_up/);
    expect(bad.problems.join(" | ")).toMatch(/duplicate sub-disposition/i);
    expect(bad.problems.join(" | ")).toMatch(/"options_sent" is not a stage of corporate/);
    const before = (await CrmPipeline.findOne({ key: KEY }).lean())!.updatedAt;
    await expect(applySetChange({ pipelineKey: KEY, spec, renames: [] })).rejects.toThrow(/Spec invalid/);
    expect((await CrmPipeline.findOne({ key: KEY }).lean())!.updatedAt).toEqual(before);
  });

  it("the model rejects an invalid set even when the plan is bypassed (save validates)", async () => {
    const p = await ensureDefaultPipeline();
    p.dispositionSet[0].leadStatus = "CALLED" as any;
    await expect(p.save()).rejects.toThrow(/bad leadStatus CALLED/);
  });

  it("--rename backfills leads + lostReason, never leadactivities, and is idempotent", async () => {
    await ensureDefaultPipeline();
    const onOld = await leadOn("Trust Issue", { lostReason: "Trust Issue" });
    const untouched = await leadOn("Ringing Only");
    const opp = await Opportunity.create({ pipeline: "corporate", stage: "closed_lost", leadId: onOld._id, lostReason: "Trust Issue" });
    const act = await LeadActivity.create({ leadId: onOld._id, type: "disposition", note: "x", disposition: { from: { disposition: "", subDisposition: "", stage: "Prospect", status: "Open" }, to: { disposition: "Not Interested", subDisposition: "Trust Issue", stage: "Lost", status: "Lost" } } });

    const spec = withSub(seed(), "Trust Issue", { subDisposition: "Trust Concerns" });
    const renames = [parseRename("Trust Issue=>Trust Concerns")];
    const plan = await planSetChange({ pipelineKey: KEY, spec, renames });
    expect(plan.problems).toEqual([]);
    expect(plan.changes).toEqual([expect.objectContaining({ kind: "renamed", from: "Trust Issue", sub: "Trust Concerns", leads: 1 })]);
    expect(plan.renames[0]).toMatchObject({ leads: 1, lostReasonLeads: 1, lostReasonOpps: 1, alreadyApplied: false });

    const r = await applySetChange({ pipelineKey: KEY, spec, renames });
    expect(r.setWritten).toBe("updated");
    expect(r.backfill[0]).toMatchObject({ leads: 1, lostReasonLeads: 1, lostReasonOpps: 1 });
    const l = (await Lead.findById(onOld._id).lean())!;
    expect(l).toMatchObject({ disposition: "Not Interested", subDisposition: "Trust Concerns", dispositionStage: "Lost", dispositionStatus: "Lost", stage: "lost", status: "LOST", lostReason: "Trust Concerns" });
    expect((await Opportunity.findById(opp._id).lean())!.lostReason).toBe("Trust Concerns");
    expect((await Lead.findById(untouched._id).lean())!.subDisposition).toBe("Ringing Only");
    // history is append-only
    const a = (await LeadActivity.findById(act._id).lean())!;
    expect(a.disposition!.to.subDisposition).toBe("Trust Issue");

    // second run: nothing to change
    const again = await planSetChange({ pipelineKey: KEY, spec, renames });
    expect(again.setChanged).toBe(false);
    expect(again.renames[0].alreadyApplied).toBe(true);
    const r2 = await applySetChange({ pipelineKey: KEY, spec, renames });
    expect(r2.setWritten).toBe("unchanged");
    expect(r2.backfill[0]).toMatchObject({ leads: 0, lostReasonLeads: 0, lostReasonOpps: 0 });
  });

  it("a rename whose target is missing from the spec, or whose source is still in it, is a problem", async () => {
    await ensureDefaultPipeline();
    const p1 = await planSetChange({ pipelineKey: KEY, spec: seed(), renames: [parseRename("Trust Issue=>Trust Concerns")] });
    expect(p1.problems.join(" ")).toMatch(/"Trust Concerns" is not in the spec/);
    const spec = [...seed(), normaliseEntry({ ...CORPORATE_CALLING_SET.find((e) => e.subDisposition === "Trust Issue"), subDisposition: "Trust Concerns" })];
    const p2 = await planSetChange({ pipelineKey: KEY, spec, renames: [parseRename("Trust Issue=>Trust Concerns")] });
    expect(p2.problems.join(" ")).toMatch(/"Trust Issue" is still in the spec/);
    expect(() => parseRename("no arrow")).toThrow(/Old Sub=>New Sub/);
  });

  it("deactivating a sub is a field change (no orphan refusal)", async () => {
    await ensureDefaultPipeline();
    await leadOn("Repeated RNR");
    const spec = withSub(seed(), "Repeated RNR", { active: false });
    const plan = await planSetChange({ pipelineKey: KEY, spec, renames: [] });
    expect(plan.changes).toEqual([expect.objectContaining({ kind: "changed", sub: "Repeated RNR", leads: 1, fields: [{ field: "active", before: true, after: false }] })]);
    expect((await applySetChange({ pipelineKey: KEY, spec, renames: [] })).setWritten).toBe("updated");
    const stored = (await CrmPipeline.findOne({ key: KEY }).lean())!.dispositionSet.find((e: any) => e.subDisposition === "Repeated RNR")!;
    expect(stored.active).toBe(false);
  });
});

describe("crm-disposition-set-apply — prod's real shape (entries with no active key)", () => {
  it("dry run of the seed against a raw row with no active keys → no differences; --apply writes nothing", async () => {
    const set = CORPORATE_CALLING_SET.map((e: any) => {
      if (e.active === false) return e; // a retired sub carries the key; an active one may not
      const { active: _drop, ...rest } = e;
      return rest;
    });
    const { CORPORATE_CALLING_PIPELINE } = await import("../models/crmDisposition.js");
    const now = new Date();
    const _id = new mongoose.Types.ObjectId();
    await CrmPipeline.collection.insertOne({ _id, ...CORPORATE_CALLING_PIPELINE, dispositionSet: set, teamIds: [], active: true, createdAt: now, updatedAt: now } as any);
    // a lead on a sub, so the orphan check has something to count
    await leadOn("Trust Issue");
    const plan = await planSetChange({ pipelineKey: KEY, spec: seed(), renames: [] });
    expect(plan.problems).toEqual([]);
    expect(plan.changes).toEqual([]);
    expect(plan.orderChanged).toBe(false);
    expect(plan.setChanged).toBe(false);
    const r = await applySetChange({ pipelineKey: KEY, spec: seed(), renames: [] });
    expect(r.setWritten).toBe("unchanged");
    const raw: any = await CrmPipeline.collection.findOne({ _id });
    expect(raw.updatedAt).toEqual(now);
    expect(raw.dispositionSet.filter((e: any) => "active" in e)).toHaveLength(11);
  });

  it("retiring one sub on such a row reports only that sub's active change", async () => {
    const set = CORPORATE_CALLING_SET.map((e: any) => {
      if (e.active === false) return e; // a retired sub carries the key; an active one may not
      const { active: _drop, ...rest } = e;
      return rest;
    });
    const { CORPORATE_CALLING_PIPELINE } = await import("../models/crmDisposition.js");
    await CrmPipeline.collection.insertOne({ ...CORPORATE_CALLING_PIPELINE, dispositionSet: set, teamIds: [], active: true } as any);
    const plan = await planSetChange({ pipelineKey: KEY, spec: withSub(seed(), "Repeated RNR", { active: false }), renames: [] });
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({ kind: "changed", sub: "Repeated RNR", fields: [{ field: "active", before: true, after: false }] });
  });
});

/* ─────────── v1 → v2 (Imran's set of 2026-11-12): the real transition ─────────── */

describe("crm-disposition-set-apply — v1 → v2", () => {
  const V1 = loadSpec(new URL("./disposition-sets/corporate-calling-v1.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const V2_FILE = new URL("./disposition-sets/corporate-calling-v2.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

  it("the v2 spec file is the seed", () => {
    expect(loadSpec(V2_FILE)).toEqual(seed());
  });

  it("v1 row (no active keys) → v2: 8 added, 7 changed, 11 retired, nothing removed; leads, deals and history untouched; idempotent", async () => {
    const { CORPORATE_CALLING_PIPELINE } = await import("../models/crmDisposition.js");
    expect(V1).toHaveLength(24);
    const v1Raw = V1.map(({ active: _drop, ...rest }: any) => rest); // prod's shape: no active key
    await CrmPipeline.collection.insertOne({ ...CORPORATE_CALLING_PIPELINE, dispositionSet: v1Raw, teamIds: [], active: true } as any);
    const v1 = (sub: string) => V1.find((e) => e.subDisposition === sub)!;
    const leadV1 = (sub: string, extra: Record<string, unknown> = {}) => {
      const e = v1(sub);
      return Lead.create({ contactName: sub, contactPhone: "9", disposition: e.disposition, subDisposition: e.subDisposition, dispositionStage: e.stage, dispositionStatus: e.status, stage: e.legacyStage, status: e.leadStatus, ...extra });
    };
    const onTrust = await leadV1("Trust Issue", { lostReason: "Trust Issue" });
    const onFollow = await leadV1("Follow up Required");
    const onDemo = await leadV1("Demo Scheduled");
    const onIntro = await leadV1("Introduction Email Sent");
    await Opportunity.create({ pipeline: "corporate", stage: "discovery", leadId: onDemo._id });
    await LeadActivity.create({ leadId: onTrust._id, type: "disposition", note: "x", disposition: { from: { disposition: "", subDisposition: "", stage: "Prospect", status: "Open" }, to: { disposition: "Not Interested", subDisposition: "Trust Issue", stage: "Lost", status: "Lost" } } });
    const snap = async () => JSON.stringify([await Lead.find({}).sort({ _id: 1 }).lean(), await Opportunity.find({}).sort({ _id: 1 }).lean(), await LeadActivity.find({}).sort({ _id: 1 }).lean()]);
    const before = await snap();

    const plan = await planSetChange({ pipelineKey: KEY, spec: seed(), renames: [] });
    expect(plan.problems).toEqual([]);
    const kinds = (k: string) => plan.changes.filter((c) => c.kind === k).map((c) => c.sub);
    expect(kinds("removed")).toEqual([]);
    expect(kinds("renamed")).toEqual([]);
    expect(kinds("added")).toEqual(["Asked to follow up", "Demo Done", "Onboarding link sent", "Nurture", "Repeated RNR", "Competitor onboarded", "Global tie up mandate", "Proposal rejected"]);
    const changed = plan.changes.filter((c) => c.kind === "changed");
    const retired = changed.filter((c) => c.fields.length === 1 && c.fields[0].field === "active").map((c) => c.sub);
    expect(retired).toHaveLength(11);
    expect(changed.filter((c) => !retired.includes(c.sub)).map((c) => c.sub)).toEqual(["Introduction Email Sent", "Call Back Time Not Given", "Demo Scheduled", "Proposal Mail Sent", "Negotiation in Progress", "Agreement in Progress", "NDA in Progress"]);
    expect(changed.find((c) => c.sub === "Trust Issue")).toMatchObject({ leads: 1, fields: [{ field: "active", before: true, after: false }] });
    expect(changed.find((c) => c.sub === "Demo Scheduled")!.fields.map((x) => x.field)).toEqual(["nextTouch", "opportunityEffect", "opportunityStage", "leadStatus", "legacyStage"]);
    expect(changed.find((c) => c.sub === "Introduction Email Sent")!.fields.map((x) => x.field)).toEqual(["disposition", "nextTouch", "opportunityEffect", "opportunityStage", "leadStatus", "legacyStage"]);

    expect((await applySetChange({ pipelineKey: KEY, spec: seed(), renames: [] })).setWritten).toBe("updated");
    expect(await snap()).toBe(before); // no lead, opportunity or activity was written
    for (const l of [onTrust, onFollow, onDemo, onIntro]) expect((await Lead.findById(l._id).lean())!.subDisposition).toBe(l.subDisposition);

    const again = await planSetChange({ pipelineKey: KEY, spec: seed(), renames: [] });
    expect(again.changes).toEqual([]);
    expect(again.setChanged).toBe(false);
  });
});
