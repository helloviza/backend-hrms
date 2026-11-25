// apps/backend/src/routes/travelPolicy.fixes.test.ts
//
// Fixes and additions from docs/qa/travel-policy-qa-2026-11-25.md (bug ids in
// the test names), against a REAL replica-set database with real models,
// transactions, routers and gates. Same stand-ins as travelPolicy.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const { clientTravelPolicyRouter, staffTravelPolicyRouter, maskStaffForClient } = await import("./travelPolicy.js");
const svc = await import("../services/travelPolicy.service.js");
const core = await import("../services/travelPolicy/core.js");
const imp = await import("../services/travelPolicy/travellerImport.js");
const { listDesignations } = await import("../services/travelPolicy/designations.js");
const { default: TravelPolicyVersion } = await import("../models/TravelPolicyVersion.js");
const { default: TravelPolicyAudit } = await import("../models/TravelPolicyAudit.js");
const { default: TravelPolicyCity } = await import("../models/TravelPolicyCity.js");
const { default: TravellerProfile } = await import("../models/TravellerProfile.js");
const { ensureTravelPolicyIndexes, backfillCityKeys } = await import("../bootstrap/ensureTravelPolicyIndexes.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");

const oid = (s?: string) => new mongoose.Types.ObjectId(s);
const col = (n: string) => mongoose.connection.db!.collection(n);
const HOUSE = "69679a7628330a58d29f2254";
const WS = oid();
const WS_B = oid();
const CUST = String(oid());
const CUST_B = String(oid());

const LEADER = { _id: String(oid()), name: "Asha Leader", email: "asha@a.test", roles: ["WORKSPACE_LEADER"] };
const APPROVER = { _id: String(oid()), name: "Arun Approver", email: "arun@a.test", roles: ["CUSTOMER"] };
const LEADER_B = { _id: String(oid()), name: "Bela Leader", email: "bela@b.test", roles: ["WORKSPACE_LEADER"] };
const STAFF = { _id: String(oid()), name: "Wani Staff", email: "wani@plumtrips.com", roles: ["EMPLOYEE"], workspaceId: HOUSE };

const app = express();
app.use(express.json());
const auth = (req: any, _res: any, next: any) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "null"));
  next();
};
const ws = async (req: any, _res: any, next: any) => {
  const w: any = await CustomerWorkspace.findById(String(req.headers["x-test-ws"] || "")).lean();
  if (w) Object.assign(req, { workspace: w, workspaceObjectId: w._id, workspaceId: String(w._id) });
  next();
};
app.use("/api/workspace/travel-policy", auth, ws, clientTravelPolicyRouter);
app.use("/api/admin/travel-policy", auth, staffTravelPolicyRouter);
const call = (method: "get" | "post" | "put" | "patch" | "delete", path: string, user: any, w?: any) => {
  const r = (request(app) as any)[method](path).set("x-test-user", JSON.stringify(user));
  return w ? r.set("x-test-ws", String(w)) : r;
};
const C = "/api/workspace/travel-policy";
const S = `/api/admin/travel-policy/w/${WS}`;

const a = { id: LEADER._id, name: LEADER.name, email: LEADER.email, kind: "CLIENT_ADMIN" as const, roles: LEADER.roles };

let mongod: MongoMemoryReplSet;
beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri("travel-policy-fixes"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  expect(await ensureTravelPolicyIndexes({ warn: () => {}, log: () => {} })).toEqual([]);
  await col("customerworkspaces").insertMany([
    { _id: WS, customerId: CUST, companyName: "Acme Pvt Ltd", status: "ACTIVE", config: { features: { travelPolicyEnabled: true } } },
    { _id: WS_B, customerId: CUST_B, companyName: "Beta Corp", status: "ACTIVE", config: { features: { travelPolicyEnabled: true } } },
    { _id: oid(HOUSE), customerId: "house", companyName: "Plumtrips", status: "ACTIVE", config: { features: {} } },
  ] as any[]);
  await col("customers").insertOne({ _id: oid(CUST), legalName: "Acme Pvt Ltd", workspaceCode: "ACM" } as any);
  await col("customermembers").insertMany([{ customerId: CUST, email: APPROVER.email, role: "APPROVER", isActive: true }]);
  await col("userpermissions").insertMany([{ userId: STAFF._id, status: "active", modules: { travelPolicy: { access: "WRITE", scope: "NONE" } } }]);
});

/** Change one amount so the draft really differs. */
let n = 0;
async function tweak(workspace = WS, actor: any = a) {
  const d: any = await TravelPolicyVersion.findOne({ workspaceId: workspace, status: "DRAFT" }).lean();
  n += 1;
  const rules = d.rules.map((r: any, i: number) => (r.category === "ESIM" && i === d.rules.findIndex((x: any) => x.category === "ESIM") ? { ...r, params: { ...r.params, maxCost: 6000 + n } } : r));
  await svc.saveDraft(workspace, actor, { rules, changeSummary: `eSIM ${6000 + n}` });
  return 6000 + n;
}
async function publishTemplate(from: string, today = from) {
  await svc.createDraft(WS, a, { from: "TEMPLATE" });
  return svc.publishDraft(WS, a, { effectiveFrom: from }, today);
}
async function nextVersion(from: string, today: string, opts: any = {}) {
  await svc.createDraft(WS, a, { from: "CURRENT" });
  await tweak();
  return svc.publishDraft(WS, a, { effectiveFrom: from, ...opts }, today);
}
const byId = (id: any): Promise<any> => TravelPolicyVersion.findById(id).lean() as any;

/* ── Decision 1: same-day correction ─────────────────────────────────── */

describe("M4 same-day correction", () => {
  it("replaces the version that started today; the old one is archived with the time and the version that replaced it, and audited", async () => {
    const v1 = await publishTemplate("2026-05-01");
    expect((await svc.getOverview(WS, "2026-05-01")).earliestPublish).toEqual({ date: "2026-05-01", reason: "v1 started today. Publishing today replaces it.", replacesVersion: 1 });
    const v2 = await nextVersion("2026-05-01", "2026-05-01", { reason: "typo in the Junior fare" });
    expect(v2).toMatchObject({ versionNumber: 2, status: "PUBLISHED", effectiveFrom: "2026-05-01", effectiveTo: null });
    const old = await byId(v1._id);
    expect(old).toMatchObject({ status: "ARCHIVED", archiveKind: "REPLACED_SAME_DAY", archiveReason: expect.stringMatching(/^Replaced same day at \d\d:\d\d \(IST\) by v2$/), replacedByVersion: 2, effectiveFrom: "2026-05-01" });
    expect(old.rules).toEqual((await col("travelpolicyversions").findOne({ _id: v1._id }))!.rules); // its content is untouched
    expect((await svc.resolveVersionAt(WS, "2026-05-01"))?.versionNumber).toBe(2);
    const row: any = await TravelPolicyAudit.findOne({ workspaceId: WS, action: "VERSION_REPLACED" }).lean();
    expect(row).toMatchObject({ versionNumber: 1, reason: "typo in the Junior fare", summary: `v1: ${old.archiveReason}`, actor: { name: "Asha Leader" } });
    expect(await TravelPolicyAudit.countDocuments({ workspaceId: WS, action: "VERSION_CLOSED" })).toBe(0);
  });

  it("can be corrected again the same day, and the version before it keeps its end date", async () => {
    const v1 = await publishTemplate("2026-04-01");
    await nextVersion("2026-05-01", "2026-05-01");
    const v3 = await nextVersion("2026-05-01", "2026-05-01");
    expect(v3.versionNumber).toBe(3);
    expect((await byId(v1._id)).effectiveTo).toBe("2026-04-30");
    expect((await svc.resolveVersionAt(WS, "2026-04-30"))?.versionNumber).toBe(1);
    expect((await svc.resolveVersionAt(WS, "2026-05-01"))?.versionNumber).toBe(3);
    expect(await TravelPolicyVersion.countDocuments({ workspaceId: WS, status: "PUBLISHED" })).toBe(2);
  });

  it("only today: a version that started yesterday, or a past date, cannot be replaced", async () => {
    await publishTemplate("2026-05-01");
    await svc.createDraft(WS, a, { from: "CURRENT" });
    await tweak();
    await expect(svc.publishDraft(WS, a, { effectiveFrom: "2026-05-01" }, "2026-05-02")).rejects.toMatchObject({ code: "NOT_PUBLISHABLE" });
    const ok = await svc.publishDraft(WS, a, { effectiveFrom: "2026-05-02" }, "2026-05-02");
    expect(ok.versionNumber).toBe(2);
  });

  it("publishing before an already-scheduled version still needs it cancelled first", async () => {
    await publishTemplate("2026-05-01");
    const v2 = await nextVersion("2026-06-01", "2026-05-01");
    await svc.createDraft(WS, a, { from: "VERSION", versionId: String(v2._id) });
    await tweak();
    for (const d of ["2026-05-01", "2026-05-15", "2026-06-01"]) {
      await expect(svc.publishDraft(WS, a, { effectiveFrom: d }, "2026-05-01")).rejects.toMatchObject({ details: [expect.stringMatching(/v2 is scheduled from 1 Jun 2026.*cancel v2 first/)] });
    }
    expect((await svc.getOverview(WS, "2026-05-01")).earliestPublish).toMatchObject({ date: "2026-06-02", replacesVersion: null });
    await svc.cancelScheduled(WS, a, String(v2._id), "correction first", "2026-05-01");
    expect((await svc.publishDraft(WS, a, { effectiveFrom: "2026-05-01" }, "2026-05-01")).versionNumber).toBe(3);
  });

  it("a replaced version stays frozen", async () => {
    const v1 = await publishTemplate("2026-05-01");
    await nextVersion("2026-05-01", "2026-05-01");
    await expect(TravelPolicyVersion.updateOne({ _id: v1._id }, { $set: { archiveReason: "x" } })).rejects.toThrow(/cannot be edited/);
    await expect(svc.cancelScheduled(WS, a, String(v1._id), "x", "2026-05-01")).rejects.toMatchObject({ status: 400 });
  });
});

/* ── Decision 2 + 3: what can be published ───────────────────────────── */

describe("publish rules", () => {
  it("M5: 0 rules refused; gaps need 'I understand'; both are the server's decision", async () => {
    await svc.createDraft(WS, a, { from: "BLANK" });
    await svc.saveDraft(WS, a, { changeSummary: "start", tiers: [{ tierKey: "a", name: "A" }], rules: [] });
    const pub = (extra: any = {}) => svc.publishDraft(WS, a, { effectiveFrom: "2026-05-01", ...extra }, "2026-05-01");
    await expect(pub({ acknowledgeGaps: true })).rejects.toMatchObject({ code: "NOT_PUBLISHABLE", details: [expect.stringMatching(/no rules/)] });
    await svc.saveDraft(WS, a, { rules: [{ ruleKey: "h", category: "HOTEL", tierKey: "a", scope: { kind: "CITY_CLASS", value: "METRO" }, params: { maxPerNight: 5000 } }] });
    await expect(pub()).rejects.toMatchObject({ code: "GAPS_NOT_ACKNOWLEDGED", details: expect.arrayContaining(["Hotels: A (no rule for Tier-2, Other cities, International)", "Flights has no rule for A"]) });
    const v = await pub({ acknowledgeGaps: true });
    expect(v.versionNumber).toBe(1);
    const row: any = await TravelPolicyAudit.findOne({ workspaceId: WS, action: "VERSION_PUBLISHED" }).lean();
    expect(row.changes.filter((c: any) => c.field === "gapAcknowledged")).toHaveLength(5);
  });

  it("M10 soft limits need confirming at publish; hard limits never save", async () => {
    await svc.createDraft(WS, a, { from: "TEMPLATE" });
    const d: any = await TravelPolicyVersion.findOne({ workspaceId: WS, status: "DRAFT" }).lean();
    const withFare = (fare: any) => d.rules.map((r: any) => (r.ruleKey === "junior-flight" ? { ...r, params: { ...r.params, maxFareInternational: fare } } : r));
    for (const bad of [-1, 10_000_001]) await expect(svc.saveDraft(WS, a, { rules: withFare(bad) })).rejects.toBeInstanceOf(core.PolicyInputError);
    await svc.saveDraft(WS, a, { rules: withFare(600000) });
    await expect(svc.publishDraft(WS, a, { effectiveFrom: "2026-05-01" }, "2026-05-01")).rejects.toMatchObject({ code: "VALUES_NOT_CONFIRMED", details: ["Junior · Flights · Max fare (international) is ₹6,00,000, above the usual ₹5,00,000"] });
    const v = await svc.publishDraft(WS, a, { effectiveFrom: "2026-05-01", confirmValues: true }, "2026-05-01");
    expect(v.status).toBe("PUBLISHED");
    const row: any = await TravelPolicyAudit.findOne({ workspaceId: WS, action: "VERSION_PUBLISHED" }).lean();
    expect(row.changes.find((c: any) => c.field === "valueConfirmed").to).toMatch(/6,00,000/);
  });

  it("M10: an override for a city that is not in the list is refused, on save and on publish", async () => {
    await svc.createDraft(WS, a, { from: "TEMPLATE" });
    const d: any = await TravelPolicyVersion.findOne({ workspaceId: WS, status: "DRAFT" }).lean();
    const rule = (v: string) => ({ ruleKey: "x", category: "HOTEL", tierKey: "junior", scope: { kind: "CITY", value: v }, params: { maxPerNight: 9 } });
    await expect(svc.saveDraft(WS, a, { rules: [...d.rules, rule("Atlantis")] })).rejects.toMatchObject({ errors: [expect.stringMatching(/Junior · Hotels: "Atlantis" is not in this workspace's city list/)] });
    await svc.saveDraft(WS, a, { rules: [...d.rules, rule("Mumbai")] });
    await col("travelpolicycities").deleteOne({ workspaceId: WS, cityKey: "mumbai" }); // only possible around the API
    await expect(svc.publishDraft(WS, a, { effectiveFrom: "2026-05-01" }, "2026-05-01")).rejects.toBeInstanceOf(core.PolicyInputError);
  });

  it("M11: a refused Save & publish saves nothing; a good one saves and publishes in one step", async () => {
    await svc.createDraft(WS, a, { from: "TEMPLATE" });
    const d: any = await TravelPolicyVersion.findOne({ workspaceId: WS, status: "DRAFT" }).lean();
    const edited = { name: "FY27", changeSummary: "edited", effectiveFrom: "2026-04-01", tiers: d.tiers, rules: d.rules.slice(1) };
    await expect(svc.publishDraft(WS, a, { effectiveFrom: "2026-04-01", content: edited, acknowledgeGaps: true }, "2026-05-01")).rejects.toMatchObject({ code: "NOT_PUBLISHABLE" });
    const after: any = await TravelPolicyVersion.findOne({ workspaceId: WS, status: "DRAFT" }).lean();
    expect([after.name, after.effectiveFrom, after.rules.length, +after.updatedAt]).toEqual(["", null, d.rules.length, +d.updatedAt]);
    expect(await TravelPolicyAudit.countDocuments({ workspaceId: WS, action: "DRAFT_SAVED" })).toBe(0);

    const v = await svc.publishDraft(WS, a, { effectiveFrom: "2026-05-01", content: edited, acknowledgeGaps: true, baseUpdatedAt: d.updatedAt }, "2026-05-01");
    expect(v).toMatchObject({ name: "FY27", changeSummary: "edited", effectiveFrom: "2026-05-01" });
    expect(v.rules).toHaveLength(d.rules.length - 1);
    expect(await TravelPolicyAudit.countDocuments({ workspaceId: WS, action: "DRAFT_SAVED" })).toBe(1);
  });

  it("L10: a change summary is required and an unchanged copy is refused", async () => {
    await publishTemplate("2026-05-01");
    await svc.createDraft(WS, a, { from: "CURRENT" });
    await expect(svc.publishDraft(WS, a, { effectiveFrom: "2026-05-10", changeSummary: "x" }, "2026-05-02")).rejects.toMatchObject({ details: ["Nothing has changed since v1"] });
    const d: any = await TravelPolicyVersion.findOne({ workspaceId: WS, status: "DRAFT" }).lean();
    await svc.saveDraft(WS, a, { rules: d.rules.map((r: any, i: number) => (i ? r : { ...r, notes: "n" })) });
    await expect(svc.publishDraft(WS, a, { effectiveFrom: "2026-05-10" }, "2026-05-02")).rejects.toMatchObject({ details: [expect.stringMatching(/change summary/)] });
    await expect(svc.publishDraft(WS, a, { effectiveFrom: "2026-05-10", changeSummary: "   " }, "2026-05-02")).rejects.toMatchObject({ code: "NOT_PUBLISHABLE" });
    expect((await svc.publishDraft(WS, a, { effectiveFrom: "2026-05-10", changeSummary: "Note added" }, "2026-05-02")).changeSummary).toBe("Note added");
  });

  it("H4: a save over someone else's is a conflict the page can recognise", async () => {
    const d: any = await svc.createDraft(WS, a, { from: "TEMPLATE" });
    await svc.saveDraft(WS, a, { name: "theirs" }, { baseUpdatedAt: new Date(d.updatedAt).toISOString() });
    const r = await call("put", `${C}/draft`, LEADER, WS).send({ content: { name: "mine" }, baseUpdatedAt: new Date(d.updatedAt).toISOString() });
    expect([r.status, r.body.code]).toEqual([409, "DRAFT_CHANGED"]);
    const p = await call("post", `${C}/draft/publish`, LEADER, WS).send({ effectiveFrom: "2099-01-01", baseUpdatedAt: new Date(d.updatedAt).toISOString() });
    expect([p.status, p.body.code]).toEqual([409, "DRAFT_CHANGED"]);
    await svc.discardDraft(WS, a);
    const gone = [await call("put", `${C}/draft`, LEADER, WS).send({ content: { name: "x" } }), await call("post", `${C}/draft/publish`, LEADER, WS).send({ effectiveFrom: "2099-01-01" })];
    expect(gone.map((r: any) => [r.status, r.body.code])).toEqual([[404, "DRAFT_GONE"], [404, "DRAFT_GONE"]]);
  });
});

/* ── H3 and the Preview ──────────────────────────────────────────────── */

describe("H3 copy the right version; Preview shows what changes", () => {
  it("copying the scheduled version keeps its change; copying the one in force does not", async () => {
    await publishTemplate("2026-05-01");
    await svc.createDraft(WS, a, { from: "CURRENT" });
    const changed = await tweak();
    const v2 = await svc.publishDraft(WS, a, { effectiveFrom: "2026-06-01" }, "2026-05-01");
    const esim = (d: any) => d.rules.find((r: any) => r.category === "ESIM").params.maxCost;
    const fromScheduled: any = await svc.createDraft(WS, a, { from: "VERSION", versionId: String(v2._id) });
    expect(esim(fromScheduled)).toBe(changed);
    await svc.discardDraft(WS, a);
    expect(esim(await svc.createDraft(WS, a, { from: "VERSION", versionId: String((await svc.resolveVersionAt(WS, "2026-05-01"))!._id) }))).not.toBe(changed);
    expect((await TravelPolicyAudit.find({ workspaceId: WS, action: "DRAFT_CREATED" }).sort({ createdAt: 1 }).lean()).map((x: any) => x.summary)).toEqual(expect.arrayContaining(["Draft created: copy of v2", "Draft created: copy of v1"]));
  });

  it("the preview lists the changes against the version in force and the scheduled one, from unsaved content, writing nothing", async () => {
    const today = core.istToday();
    await publishTemplate(today);
    const v2 = await nextVersion(core.addDays(today, 10), today);
    const d: any = await svc.createDraft(WS, a, { from: "VERSION", versionId: String(v2._id) });
    const rules = d.rules.map((r: any) => (r.ruleKey === "senior-flight" ? { ...r, params: { ...r.params, minAdvanceDaysDomestic: 9 } } : r));
    const p = await svc.previewPublish(WS, core.addDays(today, 20), today, { rules, changeSummary: "x" });
    expect(p.compare.map((c) => [c.kind, c.versionNumber, c.changes.length])).toEqual([["IN_FORCE", 1, 2], ["SCHEDULED", 2, 1]]);
    expect(p.compare[1].changes[0]).toMatchObject({ category: "FLIGHT", field: "Senior" });
    expect(p.problems).toEqual([]);
    expect(p.earliest.date).toBe(core.addDays(today, 11));
    const after: any = await byId(d._id);
    expect(+new Date(after.updatedAt)).toBe(+new Date(d.updatedAt));
    const bad = await svc.previewPublish(WS, core.addDays(today, 20), today, { rules: [{ ...rules[0], params: { maxFareDomestic: -1 } }] });
    expect(bad.problems.join()).toMatch(/enter 0 or more/);
  });
});

/* ── M6 / M7 / M8 / M16 / L-items on the overview and the audit ──────── */

describe("overview, health and audit", () => {
  it("M6: view-only people never see the draft — only that one is being prepared", async () => {
    await publishTemplate(core.istToday());
    const d: any = await svc.createDraft(WS, a, { from: "CURRENT" });
    await tweak();
    const ov = (await call("get", `${C}/`, APPROVER, WS)).body;
    expect([ov.draft, ov.draftPending, ov.inForce.versionNumber, ov.versions.map((v: any) => v.status)]).toEqual([null, true, 1, ["PUBLISHED"]]);
    expect(ov.views.draft).toBeNull();
    expect(ov.health.find((h: any) => h.id === "draft")).toBeUndefined();
    expect((await call("get", `${C}/versions/${d._id}`, APPROVER, WS)).status).toBe(404);
    expect((await call("post", `${C}/draft/preview`, APPROVER, WS).send({})).status).toBe(403);
    const audit = (await call("get", `${C}/audit`, APPROVER, WS)).body;
    expect(audit.rows.map((r: any) => r.action)).not.toContain("DRAFT_SAVED");
    expect((await call("get", `${C}/audit`, LEADER, WS)).body.rows.map((r: any) => r.action)).toContain("DRAFT_SAVED");
    expect((await call("get", `${C}/versions/${d._id}`, LEADER, WS)).status).toBe(200);
  });

  it("staff with READ see the draft and its audit, read-only; client approvers still do not", async () => {
    const READER = { _id: String(oid()), name: "Rohan Reader", email: "rohan@plumtrips.com", roles: ["EMPLOYEE"], workspaceId: HOUSE };
    await col("userpermissions").insertOne({ userId: READER._id, status: "active", modules: { travelPolicy: { access: "READ", scope: "NONE" } } } as any);
    await publishTemplate(core.istToday());
    const d: any = await svc.createDraft(WS, a, { from: "CURRENT" });
    await tweak();
    const ov = (await call("get", `${S}/`, READER)).body;
    expect([ov.access.canWrite, ov.draft._id, ov.draftPending, ov.views.draft.kpis.rules]).toEqual([false, String(d._id), false, 32]);
    expect(ov.health.find((h: any) => h.id === "draft").action).toEqual({ label: "View", do: "draft", tab: "overview" });
    expect((await call("get", `${S}/versions/${d._id}`, READER)).body.version.status).toBe("DRAFT");
    expect((await call("get", `${S}/audit`, READER)).body.rows.map((r: any) => r.action)).toContain("DRAFT_SAVED");
    // read-only: every draft write is refused
    const w = [
      await call("post", `${S}/draft`, READER).send({ from: "BLANK" }),
      await call("put", `${S}/draft`, READER).send({ content: { name: "x" } }),
      await call("delete", `${S}/draft`, READER),
      await call("post", `${S}/draft/publish`, READER).send({ effectiveFrom: "2099-01-01" }),
    ];
    expect(w.map((r: any) => r.status)).toEqual([403, 403, 403, 403]);
    // the client approver is unchanged
    const ap = (await call("get", `${C}/`, APPROVER, WS)).body;
    expect([ap.draft, ap.draftPending, ap.views.draft]).toEqual([null, true, null]);
    expect((await call("get", `${C}/versions/${d._id}`, APPROVER, WS)).status).toBe(404);
    expect((await call("get", `${C}/audit`, APPROVER, WS)).body.rows.map((r: any) => r.action)).not.toContain("DRAFT_SAVED");
  });

  it("the replacement label is Indian time, zero-padded, whatever the server's zone", () => {
    expect(svc.replacedLabel(2, new Date("2026-11-25T13:50:30Z"))).toBe("Replaced same day at 19:20 (IST) by v2");
    expect(svc.replacedLabel(10, new Date("2026-11-24T18:35:00Z"))).toBe("Replaced same day at 00:05 (IST) by v10");
  });

  it("M6: with only a draft, a view-only person sees Not configured and an empty mapping basis", async () => {
    await svc.createDraft(WS, a, { from: "TEMPLATE" });
    const ov = (await call("get", `${C}/`, APPROVER, WS)).body;
    expect([ov.basis, ov.draftPending, ov.kpis.rules]).toEqual([null, true, 0]);
    expect((await call("get", `${C}/mapping`, APPROVER, WS)).body.basis).toBeNull();
    expect(ov.health[0]).toMatchObject({ id: "not-configured" });
    expect(ov.health[0].action).toBeUndefined();
  });

  it("M6: each view carries its own numbers", async () => {
    await publishTemplate(core.istToday());
    await svc.createDraft(WS, a, { from: "BLANK" });
    const ov = await svc.getOverview(WS);
    expect(ov.views.inForce!.kpis.rules).toBe(32);
    expect(ov.views.draft!.kpis.rules).toBe(0);
    expect(ov.kpis.rules).toBe(32);
  });

  it("M7: every health action does something", async () => {
    expect((await svc.getOverview(WS)).health.find((h) => h.id === "not-configured")!.action).toMatchObject({ do: "create" });
    await svc.createDraft(WS, a, { from: "TEMPLATE" });
    const ov = await svc.getOverview(WS);
    expect(ov.health.find((h) => h.id === "not-configured")!.action).toMatchObject({ do: "draft", tab: "tiers" });
    expect(ov.health.find((h) => h.id === "draft")!.action).toMatchObject({ do: "preview" });
    await svc.saveDraft(WS, a, { rules: [] });
    expect((await svc.getOverview(WS)).health.find((h) => h.id === "gap-HOTEL")!.action).toMatchObject({ tab: "rules", category: "HOTEL", tierKey: "leadership" });
  });

  it("Expense Band notice: a client is sent to their account team, staff to Workspace Manager", async () => {
    await col("customerworkspaces").updateOne({ _id: WS }, { $set: { "config.features.expenseBandEnabled": true } });
    await publishTemplate(core.istToday());
    const text = (ov: any) => ov.health.find((h: any) => h.id === "expense-band").text;
    expect(text((await call("get", `${C}/`, LEADER, WS)).body)).toMatch(/Ask your Plumtrips account team/);
    expect(text((await call("get", `${S}/`, STAFF)).body)).toMatch(/Workspace Manager/);
  });

  it("M8: the Version filter finds publishes, creates and discards — including rows written before the fix", async () => {
    await publishTemplate("2026-05-01");
    await svc.createDraft(WS, a, { from: "CURRENT" });
    await svc.discardDraft(WS, a, "no");
    await col("travelpolicyaudits").insertOne({ workspaceId: WS, action: "VERSION_PUBLISHED", entity: "VERSION", categories: ["FLIGHT"], summary: "old", changes: [], actor: {}, createdAt: new Date() } as any);
    const acts = (await svc.listAudit(WS, { category: "VERSION" })).rows.map((r: any) => r.action).sort();
    expect(acts).toEqual(["DRAFT_CREATED", "DRAFT_CREATED", "DRAFT_DISCARDED", "VERSION_PUBLISHED", "VERSION_PUBLISHED"]);
  });

  it("M16: the audit pages without losing or repeating rows, even with equal timestamps", async () => {
    const at = new Date("2026-05-01T10:00:00Z");
    await col("travelpolicyaudits").insertMany(Array.from({ length: 250 }, (_, i) => ({ workspaceId: WS, action: "CITY_UPDATED", entity: "CITY", categories: ["CITY"], summary: `row ${i}`, changes: [], actor: {}, createdAt: i % 2 ? at : new Date(+at + i) })) as any[]);
    const seen: string[] = [];
    let before: string | undefined;
    let pages = 0;
    do {
      const p = await svc.listAudit(WS, { before });
      seen.push(...p.rows.map((r: any) => r.summary));
      before = p.next ?? undefined;
      pages++;
    } while (before && pages < 10);
    expect([pages, seen.length, new Set(seen).size]).toEqual([3, 250, 250]);
  });

  it("M16: a save with more than 300 changes keeps them all", async () => {
    await svc.createDraft(WS, a, { from: "BLANK" });
    const rules = Array.from({ length: 400 }, (_, i) => ({ ruleKey: `r${i}`, category: "FLIGHT", tierKey: "a", params: { maxFareDomestic: i + 1 } }));
    await svc.saveDraft(WS, a, { tiers: [{ tierKey: "a", name: "A" }], rules });
    const row: any = await TravelPolicyAudit.findOne({ workspaceId: WS, action: "DRAFT_SAVED" }).lean();
    expect(row.changes).toHaveLength(401);
  });

  it("L6/L7: reopening is logged as reopening; the draft is first in the list", async () => {
    await publishTemplate("2026-05-01");
    const v2 = await nextVersion("2026-06-01", "2026-05-02");
    await svc.cancelScheduled(WS, a, String(v2._id), "x", "2026-05-02");
    expect(await TravelPolicyAudit.countDocuments({ workspaceId: WS, action: "VERSION_REOPENED" })).toBe(1);
    await svc.createDraft(WS, a, { from: "CURRENT" });
    const list = (await svc.getOverview(WS, "2026-05-02")).versions;
    expect(list.map((v) => v.status)).toEqual(["DRAFT", "ARCHIVED", "PUBLISHED"]);
    expect(list[1].archiveKind).toBe("CANCELLED");
  });

  it("L9: the client sees staff by name, never email or roles, anywhere in a response; staff still see everything", async () => {
    await call("post", `${S}/draft`, STAFF).send({ from: "TEMPLATE" }).expect(201);
    const today = core.istToday();
    await call("post", `${S}/draft/publish`, STAFF).send({ effectiveFrom: today, changeSummary: "first" }).expect(200);
    for (const p of ["/", "/audit", "/mapping", "/lookups"]) {
      const res = await call("get", `${C}${p}`, LEADER, WS);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain("wani@plumtrips.com");
      expect(res.text).not.toContain("EMPLOYEE");
    }
    const audit = (await call("get", `${C}/audit`, LEADER, WS)).body;
    expect(audit.rows[0].actor).toMatchObject({ name: "Wani Staff", email: "", kind: "PLUMTRIPS_STAFF" });
    expect(audit.actors[0]).toMatchObject({ name: "Wani Staff", email: "" });
    const v = (await call("get", `${C}/`, LEADER, WS)).body.versions[0];
    expect(v.publishedBy).toMatchObject({ name: "Wani Staff", email: "", roles: [] });
    expect((await call("get", `${S}/audit`, STAFF)).body.rows[0].actor.email).toBe("wani@plumtrips.com");
    expect(maskStaffForClient({ x: [{ kind: "PLUMTRIPS_STAFF", name: "w@p.com", email: "w@p.com" }], y: { kind: "CLIENT_ADMIN", email: "a@a.test" } })).toEqual({ x: [{ kind: "PLUMTRIPS_STAFF", name: "", email: "" }], y: { kind: "CLIENT_ADMIN", email: "a@a.test" } });
  });

  it("staff picker: A–Z without capitals first, unnamed last with an id, and the total", async () => {
    await col("customerworkspaces").insertMany([
      { customerId: "c1", companyName: "", status: "ACTIVE" },
      { customerId: "c2", companyName: "alpha ltd", status: "ACTIVE" },
      { customerId: "c3", companyName: "Zed", status: "ACTIVE" },
    ] as any[]);
    const r = (await call("get", "/api/admin/travel-policy/workspaces", STAFF)).body;
    expect(r.total).toBe(5);
    expect(r.workspaces.map((w: any) => w.name.replace(/\(.*\)/, "(id)"))).toEqual(["Acme Pvt Ltd", "alpha ltd", "Beta Corp", "Zed", "No name (id)"]);
  });
});

/* ── Import from Expense Bands, cities ───────────────────────────────── */

describe("setting: what domestic means (Policy Compliance)", () => {
  const stored = async (w = WS) => ((await col("customerworkspaces").findOne({ _id: w })) as any).config.policyDomesticBasis;
  it("defaults to India; leader and staff change it, audited once with the old and new value; approver cannot; other companies untouched", async () => {
    expect((await call("get", C, LEADER, WS)).body.settings).toEqual({ domesticBasis: "INDIA" });
    expect((await call("put", `${C}/settings`, APPROVER, WS).send({ domesticBasis: "WORK_COUNTRY" })).status).toBe(403);
    expect(await stored()).toBeUndefined();

    expect((await call("put", `${C}/settings`, LEADER, WS).send({ domesticBasis: "WORK_COUNTRY" })).body).toEqual({ settings: { domesticBasis: "WORK_COUNTRY" } });
    expect(await stored()).toBe("WORK_COUNTRY");
    expect(await stored(WS_B)).toBeUndefined();
    expect((await call("get", C, APPROVER, WS)).body.settings).toEqual({ domesticBasis: "WORK_COUNTRY" });
    await call("put", `${C}/settings`, LEADER, WS).send({ domesticBasis: "WORK_COUNTRY" }); // same value: not logged again
    const rows: any[] = await TravelPolicyAudit.find({ workspaceId: WS, action: "SETTING_CHANGED" }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      categories: ["SETTING"],
      summary: "Domestic now means: within the traveller's work country",
      changes: [{ field: "Domestic means", from: "Within India", to: "Within the traveller's work country" }],
    });
    expect((await call("put", `${S}/settings`, STAFF).send({ domesticBasis: "INDIA" })).status).toBe(200);
    expect(await stored()).toBe("INDIA");
  });
  it("refuses any other value", async () => {
    for (const domesticBasis of ["EUROPE", "", null, { $ne: 1 }]) {
      expect((await call("put", `${C}/settings`, LEADER, WS).send({ domesticBasis })).status).toBe(400);
    }
    expect(await stored()).toBeUndefined();
  });
});

describe("M15 / M17 expense bands and cities", () => {
  it("M15: says which bands it skipped, keeps tier names unique, and seeds the city list for every starting point", async () => {
    await col("expensebands").insertMany([
      { workspaceId: WS, bandNumber: 1, bandName: "Manager", maxFlightFarePerPerson: 10000, maxHotelFarePerNight: 5000 },
      { workspaceId: WS, bandNumber: 2, bandName: "manager", maxFlightFarePerPerson: 8000 },
      { workspaceId: WS, bandNumber: 4, bandName: "L4", maxFlightFarePerPerson: 0, maxHotelFarePerNight: 0 },
    ] as any[]);
    const d: any = await svc.createDraft(WS, a, { from: "EXPENSE_BANDS" });
    expect(d.tiers.map((t: any) => t.name)).toEqual(["Manager", "manager (L2)"]);
    expect(d.notice).toMatch(/Skipped L4: no travel caps set/);
    expect(d.notice).toMatch(/city list was added/);
    expect(d.changeSummary).toMatch(/Skipped L4/);
    expect((await TravelPolicyAudit.findOne({ workspaceId: WS, action: "DRAFT_CREATED" }).lean() as any).summary).toMatch(/imported from Expense Bands\. Skipped L4/);
    expect(await TravelPolicyCity.countDocuments({ workspaceId: WS })).toBe(51);
    await svc.createDraft(WS_B, { ...a, id: LEADER_B._id }, { from: "BLANK" });
    expect(await TravelPolicyCity.countDocuments({ workspaceId: WS_B })).toBe(51);
  });

  it("M17: renaming a city keeps its key, so its override still applies; a new city with the old name does not take it over", async () => {
    await svc.createDraft(WS, a, { from: "TEMPLATE" });
    const d: any = await TravelPolicyVersion.findOne({ workspaceId: WS, status: "DRAFT" }).lean();
    await svc.saveDraft(WS, a, { rules: [...d.rules, { ruleKey: "mum", category: "HOTEL", tierKey: "junior", scope: { kind: "CITY", value: "mumbai" }, params: { maxPerNight: 7777 } }] });
    const v = await svc.publishDraft(WS, a, { effectiveFrom: "2026-05-01" }, "2026-05-01");
    const pick = async (city: string) => {
      const cities = await svc.listCities(WS);
      return (core.selectRule(v.rules, "HOTEL", "junior", { cityKey: core.normalizeKey(city), country: "IN" }, cities as any)!.rule.params as any).maxPerNight;
    };
    expect(await pick("Mumbai")).toBe(7777);
    const mum: any = await TravelPolicyCity.findOne({ workspaceId: WS, nameKey: "mumbai" }).lean();
    const renamed: any = await svc.updateCity(WS, a, String(mum._id), { name: "Bombay" });
    expect([renamed.nameKey, renamed.cityKey]).toEqual(["bombay", "mumbai"]);
    expect(await pick("Bombay")).toBe(7777);
    const fresh: any = await svc.createCity(WS, a, { name: "Mumbai", category: "METRO", country: "IN" });
    expect(fresh.cityKey).toBe("mumbai 2");
    expect(await pick("Mumbai")).toBe(5000); // Junior's Metro rule
    // and the new city can have its own override
    await svc.createDraft(WS, a, { from: "CURRENT" });
    const d2: any = await TravelPolicyVersion.findOne({ workspaceId: WS, status: "DRAFT" }).lean();
    await svc.saveDraft(WS, a, { rules: [...d2.rules, { ruleKey: "mum2", category: "HOTEL", tierKey: "junior", scope: { kind: "CITY", value: "mumbai 2" }, params: { maxPerNight: 1111 } }] });
  });

  it("M17: cities from before cityKey are given one at boot, uniquely", async () => {
    await col("travelpolicycities").insertMany([
      { workspaceId: WS, name: "Hyderabad", nameKey: "hyderabad", country: "IN", category: "METRO" },
      { workspaceId: WS, name: "Hyderabad", nameKey: "hyderabad", country: "PK", category: "INTERNATIONAL" },
    ] as any[]);
    expect(await backfillCityKeys()).toBe(2);
    expect((await TravelPolicyCity.find({ workspaceId: WS }).sort({ cityKey: 1 }).lean()).map((c) => c.cityKey)).toEqual(["hyderabad", "hyderabad 2"]);
    expect(await backfillCityKeys()).toBe(0);
  });

  it("M10: a city needs a real country", async () => {
    await expect(svc.createCity(WS, a, { name: "Nowhere", category: "INTERNATIONAL", country: "ZZ" })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/"ZZ" is not a country code/) });
  });
});

/* ── Mapping ─────────────────────────────────────────────────────────── */

describe("L2 / L3 mapping", () => {
  it("counts and logs only real changes, in words", async () => {
    await publishTemplate(core.istToday());
    const t = oid();
    await col("travellerprofiles").insertOne({ _id: t, workspaceId: WS, firstName: "Ravi", lastName: "K", isActive: true } as any);
    const set = (b: any) => svc.setAssignments(WS, a, { travellerProfileIds: [String(t)], ...b });
    expect(await set({ clear: true })).toEqual({ updated: 0, unchanged: 1 });
    expect(await set({ tierKey: "mid" })).toEqual({ updated: 1, unchanged: 0 });
    expect(await set({ tierKey: "mid" })).toEqual({ updated: 0, unchanged: 1 });
    expect(await set({ excluded: "GUEST" })).toEqual({ updated: 1, unchanged: 0 });
    const rows: any[] = await TravelPolicyAudit.find({ workspaceId: WS, action: "ASSIGNMENT_SET" }).sort({ createdAt: 1 }).lean();
    expect(rows.map((r) => [r.summary, r.changes[0].from, r.changes[0].to])).toEqual([
      ["Ravi K: pinned to Mid-Level", null, "Pinned to Mid-Level"],
      ["Ravi K: marked Guest", "Pinned to Mid-Level", "Guest"],
    ]);
  });
});

/* ── Designations manager ────────────────────────────────────────────── */

describe("designations manager", () => {
  it("add, rename, deactivate — no duplicates in any case, audited, with who uses it", async () => {
    const add = (name: string) => call("post", `${C}/designations`, LEADER, WS).send({ name });
    const r = await add("  Senior   Manager ");
    expect([r.status, r.body.designation.name]).toEqual([201, "Senior Manager"]);
    expect((await add("senior manager")).status).toBe(409);
    expect((await add("")).status).toBe(400);
    const id = r.body.designation._id;
    await col("travellerprofiles").insertOne({ workspaceId: WS, firstName: "R", lastName: "K", designationId: oid(id), isActive: true } as any);
    await svc.createDraft(WS, a, { from: "TEMPLATE" });
    const d: any = await TravelPolicyVersion.findOne({ workspaceId: WS, status: "DRAFT" }).lean();
    await svc.saveDraft(WS, a, { tiers: d.tiers.map((t: any) => (t.tierKey === "senior" ? { ...t, designationIds: [id] } : t)) });
    expect(await listDesignations(WS)).toEqual([{ _id: id, name: "Senior Manager", level: null, isActive: true, travellers: 1, tier: "Senior" }]);

    expect((await call("patch", `${C}/designations/${id}`, LEADER, WS).send({ name: "Sr Manager", reason: "house style" })).body).toEqual({ changed: true });
    expect((await call("patch", `${C}/designations/${id}`, LEADER, WS).send({ isActive: false })).body).toEqual({ changed: true });
    expect((await call("patch", `${C}/designations/${id}`, LEADER, WS).send({ isActive: false })).body).toEqual({ changed: false });
    // deactivating keeps people and tiers as they are
    expect((await svc.getMapping(WS)).rows[0].resolution).toMatchObject({ tierKey: "senior", source: "DESIGNATION" });
    expect((await svc.getLookups(WS)).designations[0]).toMatchObject({ name: "Sr Manager", isActive: false });
    const rows: any[] = await TravelPolicyAudit.find({ workspaceId: WS, entity: "ORG" }).sort({ createdAt: 1 }).lean();
    expect(rows.map((x) => x.summary)).toEqual(['Designation "Senior Manager" added', 'Designation "Senior Manager" renamed to "Sr Manager"', 'Designation "Sr Manager" deactivated']);
    expect(rows[1].reason).toBe("house style");
  });

  it("approver cannot write; another workspace's designation is not found", async () => {
    const other = oid();
    await col("designations").insertOne({ _id: other, workspaceId: WS_B, name: "CEO" } as any);
    expect((await call("post", `${C}/designations`, APPROVER, WS).send({ name: "X" })).status).toBe(403);
    expect((await call("patch", `${C}/designations/${other}`, LEADER, WS).send({ name: "X" })).status).toBe(404);
    expect((await call("get", `${C}/designations`, LEADER, WS)).body.designations).toEqual([]);
    expect((await col("designations").findOne({ _id: other }))!.name).toBe("CEO");
  });
});

/* ── Traveller import ────────────────────────────────────────────────── */

const csv = (rows: string[][]) => Buffer.from(["Employee ID,Name,Email,Department,Designation,Band", ...rows.map((r) => r.join(","))].join("\n"));
const upload = (path: string, buf: Buffer, user: any = LEADER, fields: Record<string, string> = {}, name = "people.csv") => {
  let r = call("post", `${C}/mapping/import/${path}`, user, WS);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r.attach("file", buf, name);
};
const seed = async () => {
  const ids = { asha: oid(), ravi: oid(), off: oid(), dup1: oid(), dup2: oid(), other: oid() };
  const manager = oid();
  await col("designations").insertOne({ _id: manager, workspaceId: WS, name: "Manager", isActive: true } as any);
  await col("departments").insertOne({ workspaceId: WS, name: "Finance", isActive: false } as any);
  await col("travellerprofiles").insertMany([
    { _id: ids.asha, workspaceId: WS, travelerId: "ACM-001", employeeId: "E1", firstName: "Asha", lastName: "Rao", email: "asha.rao@a.test", designationId: manager, isActive: true },
    { _id: ids.ravi, workspaceId: WS, travelerId: "ACM-002", firstName: "Ravi", middleName: "S", lastName: "Kumar", email: "ravi@a.test", isActive: true },
    { _id: ids.off, workspaceId: WS, travelerId: "ACM-003", employeeId: "E3", firstName: "Old", lastName: "Person", isActive: false },
    { _id: ids.dup1, workspaceId: WS, travelerId: "ACM-004", firstName: "Twin", lastName: "One", email: "shared@a.test", isActive: true },
    { _id: ids.dup2, workspaceId: WS, travelerId: "ACM-005", firstName: "Twin", lastName: "Two", email: "shared@a.test", isActive: true },
    { _id: ids.other, workspaceId: WS_B, travelerId: "B-1", employeeId: "E9", firstName: "Other", lastName: "Company", email: "other@b.test", isActive: true },
  ] as any[]);
  return { ...ids, manager };
};

describe("traveller import", () => {
  it("dry run: matches by employee ID then email, never by name; every problem is named; nothing is written", async () => {
    await seed();
    const before = await TravellerProfile.countDocuments({});
    const r = await upload("preview", csv([
      ["E1", "Asha Rao", "", "Sales", "manager", "L3"], //                2 update by ID (designation same in another case)
      ["", "Ravi Kumar", "RAVI@a.test", "finance", "Lead", "Band 5"], //   3 update by email
      ["E20", "Asha Rao", "new@a.test", "Sales", "Lead", "7"], //          4 same NAME as an existing person → a new traveller
      ["E1", "Asha Rao", "", "", "", ""], //                               5 duplicate ID in file
      ["E2", "Ravi Kumar", "asha.rao@a.test", "", "", ""], //              6 email is Asha's, who has E1
      ["E3", "Old Person", "", "", "", ""], //                             7 deactivated
      ["", "Twin", "shared@a.test", "", "", ""], //                        8 ambiguous email
      ["", "No Keys", "", "", "", ""], //                                  9 nothing to match on
      ["E21", "Mononym", "", "", "", ""], //                              10 one name only
      ["E22", "Bad Band", "bb@a.test", "", "", "L11"], //                 11
      ["E23", "Bad Mail", "nope", "", "", ""], //                         12
      ["E9", "Other Company", "", "", "", ""], //                         13 another workspace's ID → not a match, a new person here
      ["ACM-002", "Ravi Kumar", "", "Sales", "", ""], //                  14 already on row 3 (by system id)
    ]));
    expect(r.status).toBe(200);
    const by = new Map<number, any>(r.body.rows.map((x: any) => [x.rowNumber, x]));
    expect(by.get(2)).toMatchObject({ action: "UPDATE", matchedBy: "EMPLOYEE_ID", changes: [{ field: "Department", from: null, to: "Sales" }, { field: "Band", from: null, to: "L3" }] });
    expect(by.get(3).changes.map((c: any) => c.to)).toEqual(["Finance", "Lead", "L5"]); // the stored spelling, not the file's
    expect(by.get(3)).toMatchObject({ action: "UPDATE", matchedBy: "EMAIL", travellerName: "Ravi S Kumar", warnings: [] });
    expect(by.get(4)).toMatchObject({ action: "CREATE", matchedBy: null, travellerProfileId: null });
    expect(by.get(5).errors[0]).toBe("Employee ID E1 is also on row 2");
    expect(by.get(6).errors[0]).toBe("Asha Rao already has employee ID E1. An import cannot change it");
    expect(by.get(7).errors[0]).toMatch(/deactivated/);
    expect(by.get(8).errors[0]).toMatch(/2 travellers have the email/);
    expect(by.get(9).errors[0]).toBe("Needs an employee ID or an email");
    expect(by.get(10).errors[0]).toMatch(/first and a last name/);
    expect(by.get(11).errors[0]).toBe('Band "L11" is not a band from L1 to L10');
    expect(by.get(12).errors[0]).toMatch(/not an email address/);
    expect(by.get(13).action).toBe("CREATE");
    expect(by.get(14).errors[0]).toBe("Ravi S Kumar is already on row 3");
    expect(r.body.counts).toEqual({ create: 2, update: 2, unchanged: 0, error: 9 });
    expect(r.body.newDepartments).toEqual(["Sales"]);
    expect(r.body.newDesignations).toEqual(["Lead"]);
    expect(r.body.reactivated).toEqual(['Department "Finance"']);
    expect([await TravellerProfile.countDocuments({}), await col("departments").countDocuments({}), await col("designations").countDocuments({}), await TravelPolicyAudit.countDocuments({})]).toEqual([before, 1, 1, 0]);
  });

  it("apply: writes the good rows, creates what was missing once, audits every field, sends nothing and touches no login", async () => {
    const ids = await seed();
    const file = csv([
      ["E1", "ASHA R RAO", "", "Sales", "Director", "L3"],
      ["E30", "Neha Ann Iyer", "neha@a.test", "sales", "Director", "9"],
      ["", "x", "", "", "", ""],
    ]);
    const plan = (await upload("preview", file)).body;
    expect(plan.rows[0].warnings[0]).toMatch(/Name stays "Asha Rao"/);
    const r = await upload("apply", file, LEADER, { planId: plan.planId, reason: "HR master Nov" });
    expect(r.body).toEqual({ created: 1, updated: 1, unchanged: 0, skipped: 1, failed: [] });
    const asha: any = await TravellerProfile.findById(ids.asha).lean();
    expect([asha.firstName, asha.lastName, asha.bandNumber, asha.email, asha.employeeId, asha.travelerId]).toEqual(["Asha", "Rao", 3, "asha.rao@a.test", "E1", "ACM-001"]);
    const neha: any = await TravellerProfile.findOne({ workspaceId: WS, employeeId: "E30" }).lean();
    expect(neha).toMatchObject({ firstName: "Neha", middleName: "Ann", lastName: "Iyer", email: "neha@a.test", bandNumber: 9, travelerId: "ACM-006", source: "BULK_IMPORT", isActive: true });
    expect(String(neha.createdBy)).toBe(LEADER._id);
    expect(neha.claimedBy).toBeUndefined();
    expect(String(neha.departmentId)).toBe(String(asha.departmentId));
    expect([await col("departments").countDocuments({ workspaceId: WS, name: "Sales" }), await col("designations").countDocuments({ workspaceId: WS, name: "Director" })]).toEqual([1, 1]);
    expect([await col("users").countDocuments({}), await col("customermembers").countDocuments({ email: "neha@a.test" })]).toEqual([0, 0]); // no login, no invite
    const row: any = await TravelPolicyAudit.findOne({ workspaceId: WS, action: "TRAVELLERS_IMPORTED" }).lean();
    expect(row).toMatchObject({ reason: "HR master Nov", actor: { name: "Asha Leader" }, summary: "Travellers imported from people.csv: 1 created, 1 updated, 1 row skipped with errors" });
    expect(row.changes.map((c: any) => [c.field, c.from, c.to])).toEqual([
      ["Asha Rao · Department", null, "Sales"],
      ["Asha Rao · Designation", "Manager", "Director"],
      ["Asha Rao · Band", null, "L3"],
      ["Neha Ann Iyer", null, "Employee ID: E30 · Name: Neha Ann Iyer · Email: neha@a.test · Department: Sales · Designation: Director · Band: L9"],
    ]);
    expect(await TravelPolicyAudit.countDocuments({ workspaceId: WS, action: { $in: ["DEPARTMENT_CREATED", "DESIGNATION_CREATED"] } })).toBe(2);
    // the same file again changes nothing
    const again = (await upload("preview", file)).body;
    expect(again.counts).toEqual({ create: 0, update: 0, unchanged: 2, error: 1 });
    expect((await upload("apply", file, LEADER, { planId: again.planId })).status).toBe(400);
  });

  it("designation and band then decide the tier; the policy's own band beats the login's", async () => {
    const ids = await seed();
    const login = oid();
    await col("users").insertOne({ _id: login, email: "ravi@a.test", bandNumber: 9 } as any);
    await col("travellerprofiles").updateOne({ _id: ids.ravi }, { $set: { claimedBy: login } });
    const file = csv([["E1", "", "", "", "Director", ""], ["", "", "ravi@a.test", "", "", "L5"]]);
    const plan = (await upload("preview", file)).body;
    expect(plan.rows[1].warnings[0]).toBe("Their login has band L9. Travel Policy will use L5; expense limits stay on L9");
    await upload("apply", file, LEADER, { planId: plan.planId }).expect(200);
    const director: any = await col("designations").findOne({ workspaceId: WS, name: "Director" });
    await svc.createDraft(WS, a, { from: "TEMPLATE" });
    const d: any = await TravelPolicyVersion.findOne({ workspaceId: WS, status: "DRAFT" }).lean();
    await svc.saveDraft(WS, a, {
      tiers: d.tiers.map((t: any) => (t.tierKey === "leadership" ? { ...t, designationIds: [String(director._id)], bandNumbers: [9] } : t.tierKey === "mid" ? { ...t, bandNumbers: [5] } : t)),
    });
    const rows = new Map((await svc.getMapping(WS)).rows.map((r) => [r.name, r]));
    expect(rows.get("Asha Rao")!.resolution).toMatchObject({ tierKey: "leadership", source: "DESIGNATION" });
    expect(rows.get("Ravi S Kumar")).toMatchObject({ bandNumber: 5, bandSource: "PROFILE", resolution: { tierKey: "mid", source: "BAND" } });
    expect((await col("users").findOne({ _id: login }))!.bandNumber).toBe(9);
  });

  it("a deactivated duplicate does not make an active traveller ambiguous", async () => {
    const ids = await seed();
    await col("travellerprofiles").insertMany([
      { workspaceId: WS, travelerId: "ACM-007", firstName: "Ravi", lastName: "Old", email: "ravi@a.test", isActive: false },
      { workspaceId: WS, travelerId: "ACM-008", firstName: "Asha", lastName: "Old", employeeId: "E1", email: "x@a.test", isActive: false },
    ] as any[]);
    const plan = (await upload("preview", csv([["E1", "", "", "Sales", "", ""], ["", "", "ravi@a.test", "Sales", "", ""]]))).body;
    expect(plan.rows.map((r: any) => [r.action, r.travellerProfileId])).toEqual([["UPDATE", String(ids.asha)], ["UPDATE", String(ids.ravi)]]);
  });

  it("refuses to apply when travellers changed since the preview, and hands back the new plan", async () => {
    const ids = await seed();
    const file = csv([["E1", "", "", "Sales", "", "L3"]]);
    const plan = (await upload("preview", file)).body;
    await col("travellerprofiles").updateOne({ _id: ids.asha }, { $set: { bandNumber: 3 } });
    const r = await upload("apply", file, LEADER, { planId: plan.planId });
    expect([r.status, r.body.code]).toEqual([409, "IMPORT_PLAN_CHANGED"]);
    expect(r.body.details.rows[0].changes.map((c: any) => c.field)).toEqual(["Department"]);
    expect((await upload("apply", file, LEADER, {})).status).toBe(409); // no preview, no apply
    expect(await col("departments").countDocuments({ name: "Sales" })).toBe(0);
  });

  it("CSTEP: the employee ID is the traveller ID — required for a new traveller, fills a blank one, never changes a set one", async () => {
    await col("customerworkspaces").updateOne({ _id: WS }, { $set: { "config.features.cstepEnabled": true } });
    const [blank, set] = [oid(), oid()];
    await col("travellerprofiles").insertMany([
      { _id: blank, workspaceId: WS, travelerId: "", firstName: "Blank", lastName: "Id", email: "blank@a.test", isActive: true },
      { _id: set, workspaceId: WS, travelerId: "C7", employeeId: "C7", firstName: "Has", lastName: "Id", email: "has@a.test", isActive: true },
    ] as any[]);
    const file = csv([["c5", "", "blank@a.test", "", "", ""], ["C8", "", "has@a.test", "", "", ""], ["", "No Id", "noid@a.test", "", "", ""], ["C9", "New Person", "np@a.test", "", "", ""]]);
    const plan = (await upload("preview", file)).body;
    expect(plan.rows.map((x: any) => x.action)).toEqual(["UPDATE", "ERROR", "ERROR", "CREATE"]);
    await upload("apply", file, LEADER, { planId: plan.planId }).expect(200);
    expect(await TravellerProfile.findById(blank).lean()).toMatchObject({ travelerId: "C5", employeeId: "C5" });
    expect(await TravellerProfile.findById(set).lean()).toMatchObject({ travelerId: "C7" });
    expect(await TravellerProfile.findOne({ workspaceId: WS, employeeId: "C9" }).lean()).toMatchObject({ travelerId: "C9" });
  });

  it("XLSX works, numbers included; unreadable, empty, wrong and oversized files are refused in words", async () => {
    await seed();
    const wb = new ExcelJS.Workbook();
    const sh = wb.addWorksheet("S");
    sh.addRow(["Employee ID", "Name", "Email", "Department", "Designation", "Band"]);
    sh.addRow([4021, "Sita Devi", { text: "sita@a.test", hyperlink: "mailto:sita@a.test" }, "Ops", "Clerk", 4]);
    const r = await upload("preview", Buffer.from(await wb.xlsx.writeBuffer()), LEADER, {}, "p.xlsx");
    expect(r.body.rows[0]).toMatchObject({ action: "CREATE", cells: { employeeId: "4021", email: "sita@a.test", band: "4" } });
    expect((await upload("preview", Buffer.from("not a sheet"), LEADER, {}, "p.xlsx")).body.error).toMatch(/could not be read/);
    expect((await upload("preview", csv([]))).body.error).toMatch(/no data rows/);
    expect((await upload("preview", Buffer.from("Foo,Bar\n1,2"))).body.error).toMatch(/needs an "Employee ID" or an "Email" column/);
    expect((await upload("preview", csv(Array.from({ length: 1001 }, (_, i) => [`X${i}`, "A B", "", "", "", ""])))).body.error).toMatch(/limit is 1000/);
    const t = await call("get", `${C}/mapping/import/template`, LEADER, WS);
    expect(t.text).toMatch(/Employee ID,Name,Email,Department,Designation,Band/);
  });

  it("leader and staff only; a staff import is logged under the staff member", async () => {
    await seed();
    const file = csv([["E1", "", "", "Sales", "", ""]]);
    for (const p of ["preview", "apply"]) expect((await upload(p, file, APPROVER, { planId: "x" })).status).toBe(403);
    expect((await call("get", `${C}/mapping/import/template`, APPROVER, WS)).status).toBe(403);
    const plan = (await call("post", `${S}/mapping/import/preview`, STAFF).attach("file", file, "p.csv")).body;
    await call("post", `${S}/mapping/import/apply`, STAFF).field("planId", plan.planId).attach("file", file, "p.csv").expect(200);
    const row: any = await TravelPolicyAudit.findOne({ workspaceId: WS, action: "TRAVELLERS_IMPORTED" }).lean();
    expect(row.actor).toMatchObject({ kind: "PLUMTRIPS_STAFF", name: "Wani Staff" });
  });

  it("parseBand / splitName", () => {
    expect(["5", "L5", "l 10", "Band 2", "band L3", "4.0", ""].map((x) => imp.parseBand(x).value)).toEqual([5, 5, 10, 2, 3, 4, null]);
    for (const bad of ["0", "11", "X5", "5.5", "-3"]) expect(imp.parseBand(bad).error).toBeTruthy();
    expect(imp.splitName(" Asha   Devi  Rao ")).toEqual({ firstName: "Asha", middleName: "Devi", lastName: "Rao" });
    expect(imp.splitName("Asha")).toBeNull();
  });
});

