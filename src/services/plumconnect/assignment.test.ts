// PlumConnect Track B — the assignment matrix + presence-aware router over
// real collections (mongodb-memory-server): priority + presence, WRITE+
// tightening, campaign-over-department, ties, hold + revive through the
// light re-resolve, and the CRUD validators.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-assignment-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { resolveAssignee, resolveTarget, applyRouting, reResolveHeld, validateRuleTarget, validateRuleUser } = await import("./assignment.js");
const { setPresence } = await import("./presence.js");
const { lineGrantsFromModules } = await import("./access.js");
const { default: AssignmentRule, assignmentTargetKey } = await import("../../models/plumconnect/AssignmentRule.js");
const { default: AgentPresence } = await import("../../models/plumconnect/AgentPresence.js");
const { default: Ad } = await import("../../models/plumconnect/Ad.js");
const { default: Campaign } = await import("../../models/plumconnect/Campaign.js");
const { default: CampaignMap } = await import("../../models/plumconnect/CampaignMap.js");
const { default: User } = await import("../../models/User.js");
const { UserPermission } = await import("../../models/UserPermission.js");
const { default: Lead } = await import("../../models/Lead.js");
const { default: Contact } = await import("../../models/plumconnect/Contact.js");
const { default: Conversation } = await import("../../models/plumconnect/Conversation.js");

let mongod: MongoMemoryServer;
const NOW = new Date("2026-09-22T09:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const WS = new mongoose.Types.ObjectId();
const AD = "120200000000000101";
const AD2 = "120200000000000102";
const CAMPAIGN = "2384000000000001";

const IDS = {
  p1: new mongoose.Types.ObjectId(), // helloviza WRITE/OWN
  p2: new mongoose.Types.ObjectId(), // helloviza WRITE/OWN
  reader: new mongoose.Types.ObjectId(), // helloviza READ/ALL
  corp: new mongoose.Types.ObjectId(), // plumtrips WRITE only
  admin: new mongoose.Types.ObjectId(),
  inactive: new mongoose.Types.ObjectId(),
};
const W = (line: string) => ({ [`plumconnect${line[0].toUpperCase()}${line.slice(1)}`]: { access: "WRITE", scope: "OWN" } });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([AssignmentRule.syncIndexes(), AgentPresence.syncIndexes(), Ad.syncIndexes(), Campaign.syncIndexes(), CampaignMap.syncIndexes(), Conversation.syncIndexes()]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

async function perm(userId: mongoose.Types.ObjectId, modules: any) {
  await UserPermission.create({ userId: String(userId), email: `${userId}@x.test`, workspaceId: String(WS), universe: "STAFF", source: "manual", level: { code: "L3", name: "Exec", designation: "x" }, status: "active", tier: 1, grantedModules: [], roleType: "EMPLOYEE", grantedBy: "test", grantedAt: new Date(), modules } as any);
}
async function present(userId: mongoose.Types.ObjectId, line: any, active = true, now = NOW) {
  const row: any = await UserPermission.findOne({ userId: String(userId) }).lean();
  const grants = String(userId) === String(IDS.admin) ? lineGrantsFromModules({ [`plumconnect${line[0].toUpperCase()}${line.slice(1)}`]: { access: "FULL", scope: "ALL" } }) : lineGrantsFromModules(row?.modules);
  const r = await setPresence({ userId, grants, line, active, now });
  if (r.ok === false) throw new Error(`presence: ${r.reason}`);
}
const rule = (userId: mongoose.Types.ObjectId, target: any, priority = 100, enabled = true) => AssignmentRule.create({ target, userId, priority, enabled });
let n = 0;
async function thread(line: "plumtrips" | "helloviza" | "concierge", over: any = {}) {
  const contact = await Contact.create({ phone: `9199000000${String(++n).padStart(2, "0")}` });
  return Conversation.create({ contactId: contact._id, kind: "lead", businessLine: line, ...over });
}

beforeEach(async () => {
  n = 0;
  await Promise.all([AssignmentRule.deleteMany({}), AgentPresence.deleteMany({}), Ad.deleteMany({}), Campaign.deleteMany({}), CampaignMap.deleteMany({}), User.deleteMany({}), UserPermission.deleteMany({}), Lead.deleteMany({}), Contact.deleteMany({}), Conversation.deleteMany({})]);
  await User.collection.insertMany([
    { _id: IDS.p1, name: "Priya One", email: "p1@x.test", roles: ["EMPLOYEE"], passwordHash: "x", workspaceId: WS, status: "ACTIVE" },
    { _id: IDS.p2, name: "Parth Two", email: "p2@x.test", roles: ["EMPLOYEE"], passwordHash: "x", workspaceId: WS, status: "ACTIVE" },
    { _id: IDS.reader, name: "Ria Reader", email: "r@x.test", roles: ["EMPLOYEE"], passwordHash: "x", workspaceId: WS, status: "ACTIVE" },
    { _id: IDS.corp, name: "Cory Corp", email: "c@x.test", roles: ["EMPLOYEE"], passwordHash: "x", workspaceId: WS, status: "ACTIVE" },
    { _id: IDS.admin, name: "Ops Admin", email: "a@x.test", roles: ["ADMIN"], passwordHash: "x", workspaceId: WS, status: "ACTIVE" },
    { _id: IDS.inactive, name: "Gone", email: "g@x.test", roles: ["EMPLOYEE"], passwordHash: "x", workspaceId: WS, status: "INACTIVE" },
  ] as any[]);
  await perm(IDS.p1, W("helloviza"));
  await perm(IDS.p2, W("helloviza"));
  await perm(IDS.reader, { plumconnectHelloviza: { access: "READ", scope: "ALL" } });
  await perm(IDS.corp, W("plumtrips"));
  await perm(IDS.inactive, W("helloviza"));
});

const DEPT = (line: string) => ({ type: "department", line });

describe("priority + presence", () => {
  it("P1 active → P1; P1 away, P2 active → P2; both away → HELD (never the first admin, even when the admin is present)", async () => {
    await rule(IDS.p1, DEPT("helloviza"), 1);
    await rule(IDS.p2, DEPT("helloviza"), 2);
    await present(IDS.admin, "helloviza");

    await present(IDS.p1, "helloviza", true);
    await present(IDS.p2, "helloviza", true);
    let d = await resolveAssignee({ conversation: await thread("helloviza"), now: at(1000) });
    expect(d).toMatchObject({ state: "assigned", line: "helloviza", target: { type: "department", key: "department:helloviza" }, mapped: 2, reason: "priority 1" });
    expect(String(d.assignee!.id)).toBe(String(IDS.p1));
    expect(d.assignee!.name).toBe("Priya One");

    await present(IDS.p1, "helloviza", false, at(2000));
    d = await resolveAssignee({ conversation: await thread("helloviza"), now: at(3000) });
    expect(String(d.assignee!.id)).toBe(String(IDS.p2));
    expect(d.reason).toBe("priority 2");

    await present(IDS.p2, "helloviza", false, at(4000));
    d = await resolveAssignee({ conversation: await thread("helloviza"), now: at(5000) });
    expect(d).toMatchObject({ state: "held", assignee: null, candidates: [], mapped: 2, reason: "nobody eligible (away or cannot act)" });
  });

  it("nobody mapped at all → held with reason 'nobody mapped'; a disabled rule does not count; an INACTIVE user does not count", async () => {
    expect(await resolveAssignee({ conversation: await thread("helloviza"), now: NOW })).toMatchObject({ state: "held", mapped: 0, reason: "nobody mapped" });
    await rule(IDS.p1, DEPT("helloviza"), 1, false);
    await present(IDS.p1, "helloviza");
    expect(await resolveAssignee({ conversation: await thread("helloviza"), now: at(1000) })).toMatchObject({ state: "held", mapped: 0 });
    await rule(IDS.inactive, DEPT("helloviza"), 1);
    await present(IDS.inactive, "helloviza");
    expect(await resolveAssignee({ conversation: await thread("helloviza"), now: at(2000) })).toMatchObject({ state: "held", mapped: 1 });
  });

  it("WRITE+ tightening: a mapped agent who is PRESENT but only READ on the line is not eligible", async () => {
    await rule(IDS.reader, DEPT("helloviza"), 1);
    await present(IDS.reader, "helloviza"); // Track A lets a READ holder go active…
    const d = await resolveAssignee({ conversation: await thread("helloviza"), now: at(1000) });
    expect(d).toMatchObject({ state: "held", mapped: 1, reason: "nobody eligible (away or cannot act)" }); // …the router does not route to them
    // a stale "active" (past the TTL) is away too
    await rule(IDS.p1, DEPT("helloviza"), 1);
    await present(IDS.p1, "helloviza", true, NOW);
    expect((await resolveAssignee({ conversation: await thread("helloviza"), now: at(9 * 3600_000) })).state).toBe("held");
    expect((await resolveAssignee({ conversation: await thread("helloviza"), now: at(1000) })).state).toBe("assigned");
  });

  it("a rule for another line never applies: the plumtrips rep mapped on plumtrips does not receive a helloviza lead", async () => {
    await rule(IDS.corp, DEPT("plumtrips"), 1);
    await present(IDS.corp, "plumtrips");
    expect((await resolveAssignee({ conversation: await thread("helloviza"), now: at(1000) })).state).toBe("held");
    expect(String((await resolveAssignee({ conversation: await thread("plumtrips"), now: at(1000) })).assignee!.id)).toBe(String(IDS.corp));
  });
});

describe("campaign over department", () => {
  beforeEach(async () => {
    await Campaign.create({ metaId: CAMPAIGN, name: "Visa Q4" });
    await Ad.create({ metaId: AD, metaCampaignId: CAMPAIGN, enrichment: { status: "enriched" } });
    await present(IDS.p1, "helloviza");
    await present(IDS.p2, "helloviza");
  });

  it("an ad whose campaign has a rule routes by the campaign row (P2), not the department row (P1); an unmapped ad falls back to the department row", async () => {
    await rule(IDS.p1, DEPT("helloviza"), 1);
    await rule(IDS.p2, { type: "campaign", line: "helloviza", metaId: CAMPAIGN }, 5);
    const viaCampaign = await resolveAssignee({ conversation: await thread("helloviza", { referralRaw: { source_type: "ad", source_id: AD } }), now: at(1000) });
    expect(viaCampaign).toMatchObject({ state: "assigned", target: { type: "campaign", key: `campaign:${CAMPAIGN}` }, reason: "priority 5" });
    expect(String(viaCampaign.assignee!.id)).toBe(String(IDS.p2));
    const unmapped = await resolveAssignee({ conversation: await thread("helloviza", { referralRaw: { source_type: "ad", source_id: AD2 } }), now: at(1000) });
    expect(unmapped).toMatchObject({ state: "assigned", target: { type: "department", key: "department:helloviza" } });
    expect(String(unmapped.assignee!.id)).toBe(String(IDS.p1));
    const organic = await resolveAssignee({ conversation: await thread("helloviza"), now: at(1000) });
    expect(String(organic.assignee!.id)).toBe(String(IDS.p1));
  });

  it("an AD rule beats the campaign rule; a campaign rule for the WRONG line does not apply; the explicit sourceId arg wins over the thread", async () => {
    await rule(IDS.p1, { type: "ad", line: "helloviza", metaId: AD }, 9);
    await rule(IDS.p2, { type: "campaign", line: "helloviza", metaId: CAMPAIGN }, 1);
    let d = await resolveAssignee({ conversation: await thread("helloviza", { referralRaw: { source_id: AD } }), now: at(1000) });
    expect(d.target).toEqual({ type: "ad", key: `ad:${AD}` });
    expect(String(d.assignee!.id)).toBe(String(IDS.p1));
    // the campaign rule is for helloviza; a plumtrips thread from the same ad ignores it
    await rule(IDS.corp, DEPT("plumtrips"), 1);
    await present(IDS.corp, "plumtrips");
    d = await resolveAssignee({ conversation: await thread("plumtrips", { referralRaw: { source_id: AD } }), now: at(1000) });
    expect(d.target.type).toBe("department");
    expect(String(d.assignee!.id)).toBe(String(IDS.corp));
    // capture passes the parsed id explicitly, before referralRaw is stamped
    d = await resolveAssignee({ conversation: await thread("helloviza"), sourceId: AD, now: at(1000) });
    expect(d.target.type).toBe("ad");
    expect(await resolveTarget("helloviza", "")).toEqual({ type: "department", key: "department:helloviza" });
  });

  it("a campaign rule whose only agent is away → HELD on the campaign row (no silent fall-through to the department row)", async () => {
    await rule(IDS.p1, DEPT("helloviza"), 1);
    await rule(IDS.p2, { type: "campaign", line: "helloviza", metaId: CAMPAIGN }, 1);
    await present(IDS.p2, "helloviza", false, at(500));
    const d = await resolveAssignee({ conversation: await thread("helloviza", { referralRaw: { source_id: AD } }), now: at(1000) });
    expect(d).toMatchObject({ state: "held", target: { type: "campaign" }, reason: "nobody eligible (away or cannot act)" });
  });
});

describe("ties, hold + revive (applyRouting / reResolveHeld)", () => {
  it("two same-priority active agents → TIE: unassigned, both candidates; the Lead gets no owner", async () => {
    await rule(IDS.p1, DEPT("helloviza"), 1);
    await rule(IDS.p2, DEPT("helloviza"), 1);
    await present(IDS.p1, "helloviza");
    await present(IDS.p2, "helloviza");
    const c = await thread("helloviza");
    const lead = await Lead.create({ contactName: "X", contactPhone: "919990000001", type: "individual" });
    await Conversation.updateOne({ _id: c._id }, { $set: { leadId: lead._id } });
    const conv = (await Conversation.findById(c._id))!;
    const d = await resolveAssignee({ conversation: conv, now: at(1000) });
    expect(d).toMatchObject({ state: "tie", assignee: null, reason: "tie at priority 1" });
    expect(d.candidates.map(String).sort()).toEqual([String(IDS.p1), String(IDS.p2)].sort());
    await applyRouting(conv, d, at(1000));
    const after: any = await Conversation.findById(c._id).lean();
    expect(after.assignedTo).toBeNull();
    expect(after.routing).toMatchObject({ state: "tie", targetKey: "department:helloviza", autoAssigned: false, resolvedAt: at(1000) });
    expect(after.routing.candidates.map(String).sort()).toEqual([String(IDS.p1), String(IDS.p2)].sort());
    expect((await Lead.findById(lead._id).lean())!).not.toHaveProperty("assignedTo");
  });

  it("hold + revive: nobody active → held; the mapped agent goes active → the next queue read assigns it to them (Lead owner synced); an already-decided thread is not rewritten", async () => {
    await rule(IDS.p1, DEPT("helloviza"), 1);
    const c = await thread("helloviza");
    const lead = await Lead.create({ contactName: "X", contactPhone: "919990000002", type: "individual" });
    await Conversation.updateOne({ _id: c._id }, { $set: { leadId: lead._id } });
    let conv = (await Conversation.findById(c._id))!;
    await applyRouting(conv, await resolveAssignee({ conversation: conv, now: NOW }), NOW);
    expect((await Conversation.findById(c._id).lean())!.routing.state).toBe("held");

    // still nobody: the read changes nothing
    expect(await reResolveHeld({ lines: ["helloviza"], now: at(1000) })).toEqual({ checked: 1, assigned: 0, tied: 0 });
    expect((await Conversation.findById(c._id).lean())!.routing.resolvedAt).toEqual(NOW);

    await present(IDS.p1, "helloviza", true, at(2000));
    expect(await reResolveHeld({ lines: ["helloviza"], now: at(3000) })).toEqual({ checked: 1, assigned: 1, tied: 0 });
    conv = (await Conversation.findById(c._id))!;
    expect(String(conv.assignedTo)).toBe(String(IDS.p1));
    expect(conv.routing).toMatchObject({ state: "assigned", autoAssigned: true, resolvedAt: at(3000), reason: "priority 1" });
    const l: any = await Lead.findById(lead._id).lean();
    expect(String(l.assignedTo)).toBe(String(IDS.p1));
    expect(l.assignedToName).toBe("Priya One");

    // assigned threads are outside the re-resolve; other lines untouched
    expect(await reResolveHeld({ lines: ["helloviza", "plumtrips"], now: at(4000) })).toEqual({ checked: 0, assigned: 0, tied: 0 });
    expect(await reResolveHeld({ lines: [], now: at(4000) })).toEqual({ checked: 0, assigned: 0, tied: 0 });
  });

  it("a tie whose candidates change is rewritten; one whose candidates are the same is left alone; a RESOLVED thread is never re-resolved", async () => {
    await rule(IDS.p1, DEPT("helloviza"), 1);
    await rule(IDS.p2, DEPT("helloviza"), 1);
    await present(IDS.p1, "helloviza");
    const c = await thread("helloviza");
    let conv = (await Conversation.findById(c._id))!;
    await applyRouting(conv, await resolveAssignee({ conversation: conv, now: NOW }), NOW);
    expect((await Conversation.findById(c._id).lean())!.routing.state).toBe("assigned"); // only p1 present → assigned, not a tie

    const c2 = await thread("helloviza");
    await present(IDS.p2, "helloviza", true, at(500));
    conv = (await Conversation.findById(c2._id))!;
    await applyRouting(conv, await resolveAssignee({ conversation: conv, now: at(1000) }), at(1000));
    expect((await Conversation.findById(c2._id).lean())!.routing.state).toBe("tie");
    expect(await reResolveHeld({ lines: ["helloviza"], now: at(2000) })).toEqual({ checked: 1, assigned: 0, tied: 0 }); // same candidates → untouched
    await present(IDS.p2, "helloviza", false, at(2500));
    expect(await reResolveHeld({ lines: ["helloviza"], now: at(3000) })).toEqual({ checked: 1, assigned: 1, tied: 0 }); // p2 left → p1 wins
    expect(String((await Conversation.findById(c2._id).lean())!.assignedTo)).toBe(String(IDS.p1));

    const c3 = await thread("helloviza", { status: "RESOLVED", routing: { state: "held" } });
    expect(await reResolveHeld({ lines: ["helloviza"], now: at(4000) })).toEqual({ checked: 0, assigned: 0, tied: 0 });
    expect((await Conversation.findById(c3._id).lean())!.assignedTo).toBeNull();
  });
});

describe("CRUD validators", () => {
  it("target: a department is always fine; a campaign / ad must be known (Slice 8 row or Slice 5 map entry)", async () => {
    expect(await validateRuleTarget({ type: "department", line: "helloviza", metaId: "" })).toEqual({ ok: true });
    expect((await validateRuleTarget({ type: "campaign", line: "helloviza", metaId: CAMPAIGN })).ok).toBe(false);
    await Campaign.create({ metaId: CAMPAIGN, name: "Visa Q4" });
    expect(await validateRuleTarget({ type: "campaign", line: "helloviza", metaId: CAMPAIGN })).toEqual({ ok: true });
    expect((await validateRuleTarget({ type: "ad", line: "helloviza", metaId: AD })).ok).toBe(false);
    await CampaignMap.create({ adId: AD, businessLine: "helloviza", label: "x" });
    expect(await validateRuleTarget({ type: "ad", line: "helloviza", metaId: AD })).toEqual({ ok: true });
    expect((await validateRuleTarget({ type: "ad", line: "helloviza", metaId: "" })).ok).toBe(false);
  });

  it("user: must be ACTIVE and hold the target line at WRITE+; READ-only, wrong line, inactive, unknown → rejected", async () => {
    expect(await validateRuleUser(IDS.p1, "helloviza")).toEqual({ ok: true });
    expect((await validateRuleUser(IDS.reader, "helloviza")).ok).toBe(false);
    expect((await validateRuleUser(IDS.p1, "plumtrips")).ok).toBe(false);
    expect((await validateRuleUser(IDS.inactive, "helloviza")).ok).toBe(false);
    expect((await validateRuleUser(new mongoose.Types.ObjectId(), "helloviza")).ok).toBe(false);
    expect((await validateRuleUser("nope", "helloviza")).ok).toBe(false);
    expect(await validateRuleUser(IDS.admin, "concierge")).toEqual({ ok: true }); // ADMIN holds every line by role
  });

  it("one row per (user, target); targetKey is derived, never trusted", async () => {
    const r = await rule(IDS.p1, { type: "department", line: "helloviza", metaId: "junk" }, 1);
    expect(r.targetKey).toBe("department:helloviza");
    expect(r.target.metaId).toBe("");
    await expect(rule(IDS.p1, DEPT("helloviza"), 2)).rejects.toThrow(/duplicate/i);
    await expect(rule(IDS.p1, { type: "campaign", line: "helloviza", metaId: "" }, 2)).rejects.toThrow(/needs a metaId/);
    expect(assignmentTargetKey({ type: "ad", line: "helloviza", metaId: " 123 " })).toBe("ad:123");
  });
});

describe("the static rule is gone", () => {
  it("holidayLead.ts no longer reads a configured assignee or picks the first ADMIN; assignment goes through resolveAssignee; config has no assignee env", () => {
    const capture = readFileSync(join(process.cwd(), "src/services/plumconnect/holidayLead.ts"), "utf8");
    expect(capture).not.toMatch(/holidayLeadAssigneeId|resolveHolidayLeadAssignee|PLUMCONNECT_HOLIDAY_LEAD_ASSIGNEE/);
    expect(capture).not.toMatch(/roles:\s*\{\s*\$in:\s*\[\s*"ADMIN"/);
    expect(capture).toMatch(/resolveAssignee\(\{ conversation: input\.conversation, line: input\.businessLine/);
    expect(capture).toMatch(/applyRouting\(input\.conversation, decision, now\)/);
    const config = readFileSync(join(process.cwd(), "src/config/plumconnect.ts"), "utf8");
    expect(config).not.toMatch(/export (const|function) (PLUMCONNECT_HOLIDAY_LEAD_ASSIGNEE_ENV|holidayLeadAssigneeId)/);
  });
});
