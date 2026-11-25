// apps/backend/src/routes/travelPolicy.test.ts
//
// Travel Policy module — REAL database (in-memory replica set, so the publish
// / cancel transactions really run), real models + freeze hooks + indexes,
// real routers and access gates. Only the auth/workspace middlewares that
// sit in front of the routers in server.ts are replaced by header-driven
// stand-ins.
//
// Covers (docs/audits/travel-policy-audit.md §6, decisions D3/D5/D6):
//   • versioning: number at publish, close-out of the previous version,
//     scheduled state, cancel gives the window back, resolveVersionAt
//   • no back-dating, no overlap (transaction rolls back), one draft per ws
//   • published versions and the audit log are frozen
//   • tenant isolation (service + route), client vs staff gates, real actor
//   • Guest exclusion from KPIs (D3)
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const { clientTravelPolicyRouter, staffTravelPolicyRouter } = await import("./travelPolicy.js");
const svc = await import("../services/travelPolicy.service.js");
const { istToday, addDays } = await import("../services/travelPolicy/core.js");
const { default: TravelPolicyVersion, FROZEN_MESSAGE } = await import("../models/TravelPolicyVersion.js");
const { default: TravelPolicyAudit } = await import("../models/TravelPolicyAudit.js");
const { ensureTravelPolicyIndexes } = await import("../bootstrap/ensureTravelPolicyIndexes.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");

const oid = (s?: string) => new mongoose.Types.ObjectId(s);
const col = (n: string) => mongoose.connection.db!.collection(n);
const HOUSE = "69679a7628330a58d29f2254";

const WS_A = oid();
const WS_B = oid();
const CUST_A = "cust-a";
const CUST_B = "cust-b";
const DESIG_A = oid();
const DESIG_B = oid();

const LEADER_A = { _id: String(oid()), name: "Asha Leader", email: "asha@a.test", roles: ["WORKSPACE_LEADER"] };
const APPROVER_A = { _id: String(oid()), name: "Arun Approver", email: "arun@a.test", roles: ["CUSTOMER"] };
const REQUESTER_A = { _id: String(oid()), name: "Rita Requester", email: "rita@a.test", roles: ["CUSTOMER"] };
const EXLEADER_A = { _id: String(oid()), name: "Old Leader", email: "old@a.test", roles: ["WORKSPACE_LEADER"] };
const TENANT_ADMIN_A = { _id: String(oid()), name: "Tina TenantAdmin", email: "tina@a.test", roles: ["TENANT_ADMIN"], workspaceId: String(WS_A) };
const LEADER_B = { _id: String(oid()), name: "Bela Leader", email: "bela@b.test", roles: ["WORKSPACE_LEADER"] };
const SUPER = { _id: String(oid()), name: "Sam Super", email: "sam@plumtrips.com", roles: ["SUPERADMIN"], workspaceId: HOUSE };
const STAFF_RO = { _id: String(oid()), name: "Rohan Staff", email: "rohan@plumtrips.com", roles: ["EMPLOYEE"], workspaceId: HOUSE };
const STAFF_RW = { _id: String(oid()), name: "Wani Staff", email: "wani@plumtrips.com", roles: ["EMPLOYEE"], workspaceId: HOUSE };
const STAFF_NONE = { _id: String(oid()), name: "Nina Staff", email: "nina@plumtrips.com", roles: ["ADMIN"], workspaceId: HOUSE };

const fakeAuth = (req: any, _res: any, next: any) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "null"));
  next();
};
const fakeWorkspace = async (req: any, _res: any, next: any) => {
  const id = String(req.headers["x-test-ws"] || "");
  const ws: any = await CustomerWorkspace.findById(id).lean();
  if (ws) {
    req.workspace = ws;
    req.workspaceObjectId = ws._id;
    req.workspaceId = String(ws._id);
  }
  next();
};
const app = express();
app.use(express.json());
app.use("/api/workspace/travel-policy", fakeAuth, fakeWorkspace, clientTravelPolicyRouter);
app.use("/api/admin/travel-policy", fakeAuth, staffTravelPolicyRouter);

const client = (user: any, ws: mongoose.Types.ObjectId) => ({
  get: (p: string) => request(app).get(`/api/workspace/travel-policy${p}`).set("x-test-user", JSON.stringify(user)).set("x-test-ws", String(ws)),
  post: (p: string, b: any = {}) => request(app).post(`/api/workspace/travel-policy${p}`).set("x-test-user", JSON.stringify(user)).set("x-test-ws", String(ws)).send(b),
  put: (p: string, b: any = {}) => request(app).put(`/api/workspace/travel-policy${p}`).set("x-test-user", JSON.stringify(user)).set("x-test-ws", String(ws)).send(b),
});
const staff = (user: any) => ({
  get: (p: string) => request(app).get(`/api/admin/travel-policy${p}`).set("x-test-user", JSON.stringify(user)),
  post: (p: string, b: any = {}) => request(app).post(`/api/admin/travel-policy${p}`).set("x-test-user", JSON.stringify(user)).send(b),
});

/** Change one amount (and say so), so the draft is a real new version. */
let bumpN = 0;
async function bump(ws: mongoose.Types.ObjectId, a: any) {
  const d: any = await TravelPolicyVersion.findOne({ workspaceId: ws, status: "DRAFT" }).lean();
  const n = ++bumpN;
  const rules = d.rules.map((r: any) => (r.category === "ESIM" && r.tierKey === d.tiers[0].tierKey ? { ...r, params: { ...r.params, maxCost: 5000 + n } } : r));
  return svc.saveDraft(ws, a, { rules, changeSummary: `eSIM cap ${5000 + n}` });
}

const actor = (u: any, kind: "CLIENT_ADMIN" | "PLUMTRIPS_STAFF" = "CLIENT_ADMIN") => ({ id: u._id, name: u.name, email: u.email, kind, roles: u.roles });

let mongod: MongoMemoryReplSet;

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri("travel-policy-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  expect(await ensureTravelPolicyIndexes({ warn: () => {}, log: () => {} })).toEqual([]);
  await col("customerworkspaces").insertMany([
    { _id: WS_A, customerId: CUST_A, companyName: "Acme Pvt Ltd", status: "ACTIVE", config: { features: { travelPolicyEnabled: true } } },
    { _id: WS_B, customerId: CUST_B, companyName: "Beta Corp", status: "ACTIVE", config: { features: { travelPolicyEnabled: true } } },
    { _id: oid(HOUSE), customerId: "house", companyName: "Plumtrips", status: "ACTIVE", config: { features: {} } },
  ] as any[]);
  await col("customermembers").insertMany([
    { customerId: CUST_A, email: APPROVER_A.email, role: "APPROVER", isActive: true },
    { customerId: CUST_A, email: REQUESTER_A.email, role: "REQUESTER", isActive: true },
    { customerId: CUST_A, email: EXLEADER_A.email, role: "WORKSPACE_LEADER", isActive: false },
  ]);
  await col("designations").insertMany([
    { _id: DESIG_A, workspaceId: WS_A, name: "Manager" },
    { _id: DESIG_B, workspaceId: WS_B, name: "Manager" },
  ]);
  await col("userpermissions").insertMany([
    { userId: STAFF_RO._id, status: "active", modules: { travelPolicy: { access: "READ", scope: "NONE" } } },
    { userId: STAFF_RW._id, status: "active", modules: { travelPolicy: { access: "WRITE", scope: "NONE" } } },
    { userId: TENANT_ADMIN_A._id, status: "active", modules: { travelPolicy: { access: "FULL", scope: "ALL" } } },
  ]);
});

/* ── Versioning ──────────────────────────────────────────────────────── */

describe("versioning (service, explicit IST 'today')", () => {
  it("numbers at publish, closes the previous version the day before, derives states, never back-dates", async () => {
    const a = actor(LEADER_A);
    await svc.createDraft(WS_A, a, { from: "TEMPLATE" });

    // no date → refused; back-dated → refused
    await expect(svc.publishDraft(WS_A, a, {}, "2026-01-10")).rejects.toMatchObject({ status: 400, code: "NOT_PUBLISHABLE" });
    await expect(svc.publishDraft(WS_A, a, { effectiveFrom: "2026-01-09" }, "2026-01-10")).rejects.toMatchObject({
      details: expect.arrayContaining([expect.stringMatching(/cannot be in the past/)]),
    });

    const v1 = await svc.publishDraft(WS_A, a, { effectiveFrom: "2026-01-10" }, "2026-01-10");
    expect(v1).toMatchObject({ status: "PUBLISHED", versionNumber: 1, effectiveFrom: "2026-01-10", effectiveTo: null });

    await svc.createDraft(WS_A, a, { from: "CURRENT" });
    await bump(WS_A, a);
    // not after v1's start → refused
    await expect(svc.publishDraft(WS_A, a, { effectiveFrom: "2026-01-10" }, "2026-01-11")).rejects.toMatchObject({
      details: expect.arrayContaining([expect.stringMatching(/must be after v1/)]),
    });
    const v2 = await svc.publishDraft(WS_A, a, { effectiveFrom: "2026-03-01" }, "2026-01-20");
    expect(v2.versionNumber).toBe(2);
    const v1After: any = await TravelPolicyVersion.findById(v1._id).lean();
    expect(v1After.effectiveTo).toBe("2026-02-28");

    // states on different days, and the resolver
    const ov = await svc.getOverview(WS_A, "2026-02-15");
    expect(ov.active?.versionNumber).toBe(1);
    expect(ov.scheduled.map((s) => s.versionNumber)).toEqual([2]);
    expect((await svc.resolveVersionAt(WS_A, "2026-02-28"))?.versionNumber).toBe(1);
    expect((await svc.resolveVersionAt(WS_A, "2026-03-01"))?.versionNumber).toBe(2);
    expect(await svc.resolveVersionAt(WS_A, "2026-01-09")).toBeNull();
    const later = await svc.getOverview(WS_A, "2026-03-05");
    expect(later.versions.find((v) => v.versionNumber === 1)?.state).toBe("SUPERSEDED");
    expect(later.active?.versionNumber).toBe(2);

    // audit trail of the whole sequence, real actor
    const rows: any[] = await TravelPolicyAudit.find({ workspaceId: WS_A }).lean();
    const count = (act: string) => rows.filter((r) => r.action === act).length;
    expect([count("CITIES_SEEDED"), count("DRAFT_CREATED"), count("VERSION_PUBLISHED"), count("VERSION_CLOSED")]).toEqual([1, 2, 2, 1]);
    expect(rows.every((r) => r.actor.name === "Asha Leader" && r.actor.kind === "CLIENT_ADMIN")).toBe(true);
    const closed = rows.find((r) => r.action === "VERSION_CLOSED");
    expect(closed).toMatchObject({ versionNumber: 1, changes: [{ field: "effectiveTo", from: null, to: "2026-02-28" }] });
  });

  it("cancelling a scheduled version archives it and gives its window back; only scheduled ones can be cancelled", async () => {
    const a = actor(LEADER_A);
    await svc.createDraft(WS_A, a, { from: "TEMPLATE" });
    const v1 = await svc.publishDraft(WS_A, a, { effectiveFrom: "2026-01-10" }, "2026-01-10");
    await svc.createDraft(WS_A, a, { from: "CURRENT" });
    await bump(WS_A, a);
    const v2 = await svc.publishDraft(WS_A, a, { effectiveFrom: "2026-03-01" }, "2026-01-20");

    await expect(svc.cancelScheduled(WS_A, a, String(v1._id), "no", "2026-02-01")).rejects.toMatchObject({ status: 400 });
    await expect(svc.cancelScheduled(WS_A, a, String(v2._id), "", "2026-02-01")).rejects.toMatchObject({ status: 400 });
    const out = await svc.cancelScheduled(WS_A, a, String(v2._id), "Board changed its mind", "2026-02-01");
    expect(out).toMatchObject({ status: "ARCHIVED", archiveReason: "Board changed its mind" });
    expect(((await TravelPolicyVersion.findById(v1._id).lean()) as any).effectiveTo).toBeNull();
    expect((await svc.resolveVersionAt(WS_A, "2026-06-01"))?.versionNumber).toBe(1);

    // the next publish takes number 3 (numbers are never reused)
    await svc.createDraft(WS_A, a, { from: "CURRENT" });
    await bump(WS_A, a);
    const v3 = await svc.publishDraft(WS_A, a, { effectiveFrom: "2026-04-01" }, "2026-02-01");
    expect(v3.versionNumber).toBe(3);
  });

  it("an overlapping window is refused and the transaction rolls back (previous version stays open)", async () => {
    const a = actor(LEADER_A);
    await svc.createDraft(WS_A, a, { from: "TEMPLATE" });
    const v1 = await svc.publishDraft(WS_A, a, { effectiveFrom: "2026-01-10" }, "2026-01-10");
    // a corrupt row that already covers the target window (inserted around the service)
    await col("travelpolicyversions").insertOne({
      workspaceId: WS_A, status: "PUBLISHED", versionNumber: 9, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31",
      tiers: [], rules: [], createdBy: a,
    } as any);
    await svc.createDraft(WS_A, a, { from: "CURRENT" });
    await bump(WS_A, a);
    await expect(svc.publishDraft(WS_A, a, { effectiveFrom: "2026-05-01" }, "2026-01-20")).rejects.toMatchObject({ status: 409, code: "OVERLAP" });
    expect(((await TravelPolicyVersion.findById(v1._id).lean()) as any).effectiveTo).toBeNull(); // close-out rolled back
    expect(await TravelPolicyVersion.countDocuments({ workspaceId: WS_A, status: "DRAFT" })).toBe(1); // draft kept
    expect(await TravelPolicyAudit.countDocuments({ workspaceId: WS_A, action: "VERSION_CLOSED" })).toBe(0); // audit rolled back too
  });

  it("one draft per workspace — service refuses, and the partial unique index refuses a raw insert", async () => {
    const a = actor(LEADER_A);
    await svc.createDraft(WS_A, a, { from: "BLANK" });
    await expect(svc.createDraft(WS_A, a, { from: "TEMPLATE" })).rejects.toMatchObject({ status: 409, code: "DRAFT_EXISTS" });
    await expect(col("travelpolicyversions").insertOne({ workspaceId: WS_A, status: "DRAFT", tiers: [], rules: [] } as any)).rejects.toMatchObject({ code: 11000 });
    // another workspace may have its own draft
    await expect(svc.createDraft(WS_B, actor(LEADER_B), { from: "BLANK" })).resolves.toBeTruthy();
    // discarding frees the slot
    await svc.discardDraft(WS_A, a, "start again");
    await expect(svc.createDraft(WS_A, a, { from: "TEMPLATE" })).resolves.toBeTruthy();
  });

  it("a stale save is refused (optimistic check on updatedAt)", async () => {
    const a = actor(LEADER_A);
    const d: any = await svc.createDraft(WS_A, a, { from: "TEMPLATE" });
    const content = { name: "FY27", tiers: d.tiers, rules: d.rules };
    const saved: any = await svc.saveDraft(WS_A, a, content, { baseUpdatedAt: new Date(d.updatedAt).toISOString() });
    await expect(svc.saveDraft(WS_A, a, { ...content, name: "x" }, { baseUpdatedAt: new Date(d.updatedAt).toISOString() })).rejects.toMatchObject({
      code: "DRAFT_CHANGED",
    });
    expect(saved.name).toBe("FY27");
    const audit: any = await TravelPolicyAudit.findOne({ workspaceId: WS_A, action: "DRAFT_SAVED" }).lean();
    expect(audit.changes).toEqual([{ category: "VERSION", field: "name", from: "", to: "FY27" }]);
  });
});

/* ── Freeze ──────────────────────────────────────────────────────────── */

describe("published versions and the audit log are frozen", () => {
  it("every edit path on a published version throws; the draft-only save cannot reach it", async () => {
    const a = actor(LEADER_A);
    await svc.createDraft(WS_A, a, { from: "TEMPLATE" });
    const v1 = await svc.publishDraft(WS_A, a, { effectiveFrom: "2026-01-10" }, "2026-01-10");
    const id = v1._id;
    await expect(TravelPolicyVersion.updateOne({ _id: id }, { $set: { name: "hack" } })).rejects.toThrow(FROZEN_MESSAGE);
    await expect(TravelPolicyVersion.findOneAndUpdate({ _id: id }, { $set: { rules: [] } })).rejects.toThrow(FROZEN_MESSAGE);
    await expect(TravelPolicyVersion.updateMany({ workspaceId: WS_A }, { $set: { name: "hack" } })).rejects.toThrow(FROZEN_MESSAGE);
    await expect(TravelPolicyVersion.replaceOne({ _id: id }, { status: "DRAFT" } as any)).rejects.toThrow(FROZEN_MESSAGE);
    await expect(TravelPolicyVersion.deleteOne({ _id: id })).rejects.toThrow(FROZEN_MESSAGE);
    await expect(TravelPolicyVersion.deleteMany({ workspaceId: WS_A })).rejects.toThrow(FROZEN_MESSAGE);
    const doc: any = await TravelPolicyVersion.findById(id);
    doc.name = "hack";
    await expect(doc.save()).rejects.toThrow(FROZEN_MESSAGE);
    await expect(doc.deleteOne()).rejects.toThrow(FROZEN_MESSAGE);
    // a save goes to the DRAFT only — with no draft open it is a 404, and v1 is untouched
    await expect(svc.saveDraft(WS_A, a, { name: "hack" })).rejects.toMatchObject({ status: 404 });
    const fresh: any = await TravelPolicyVersion.findById(id).lean();
    expect(fresh.name).toBe("");
    expect(fresh.rules.length).toBeGreaterThan(0);
  });

  it("the audit log is append-only", async () => {
    await svc.createDraft(WS_A, actor(LEADER_A), { from: "BLANK" });
    const row: any = await TravelPolicyAudit.findOne({ workspaceId: WS_A });
    await expect(TravelPolicyAudit.updateOne({ _id: row._id }, { $set: { summary: "x" } })).rejects.toThrow(/append-only/);
    await expect(TravelPolicyAudit.deleteMany({ workspaceId: WS_A })).rejects.toThrow(/append-only/);
    row.summary = "x";
    await expect(row.save()).rejects.toThrow(/append-only/);
  });
});

/* ── Tenant isolation ────────────────────────────────────────────────── */

describe("tenant isolation", () => {
  it("service: another workspace's version, city and travellers are not reachable", async () => {
    const d: any = await svc.createDraft(WS_A, actor(LEADER_A), { from: "TEMPLATE" });
    const cityA: any = await col("travelpolicycities").findOne({ workspaceId: WS_A });
    const tA = oid();
    await col("travellerprofiles").insertOne({ _id: tA, workspaceId: WS_A, firstName: "Ravi", lastName: "A", isActive: true } as any);

    await expect(svc.getVersion(WS_B, String(d._id))).rejects.toMatchObject({ status: 404 });
    await expect(svc.updateCity(WS_B, actor(LEADER_B), String(cityA._id), { category: "OTHER" })).rejects.toMatchObject({ status: 404 });
    await svc.createDraft(WS_B, actor(LEADER_B), { from: "TEMPLATE" });
    await expect(svc.setAssignments(WS_B, actor(LEADER_B), { travellerProfileIds: [String(tA)], tierKey: "mid" })).rejects.toMatchObject({ status: 404 });
    expect(await col("travelpolicytierassignments").countDocuments({})).toBe(0);
    // a draft in B cannot map A's designation
    const draftB: any = await svc.saveDraft(WS_B, actor(LEADER_B), {
      tiers: [{ tierKey: "mid", name: "Mid", designationIds: [String(DESIG_A)] }],
      rules: [],
    });
    expect(draftB.tiers[0].designationIds).toEqual([String(DESIG_A)]);
    const pre = await svc.previewPublish(WS_B, "2099-01-01");
    expect(pre.problems.join(" ")).toMatch(/not in this workspace/);
  });

  it("routes: a client leader only ever acts on their own workspace; a body workspaceId is ignored", async () => {
    const res = await client(LEADER_A, WS_A).post("/draft", { from: "BLANK", workspaceId: String(WS_B) });
    expect(res.status).toBe(201);
    expect(String(res.body.version.workspaceId)).toBe(String(WS_A));
    expect(await TravelPolicyVersion.countDocuments({ workspaceId: WS_B })).toBe(0);

    const otherId = String(res.body.version._id);
    const peek = await client(LEADER_B, WS_B).get(`/versions/${otherId}`);
    expect(peek.status).toBe(404);
    const ovB = await client(LEADER_B, WS_B).get("/");
    expect(ovB.status).toBe(200);
    expect(ovB.body.draft).toBeNull();
    expect(ovB.body.workspace.name).toBe("Beta Corp");
  });
});

/* ── Access gates ────────────────────────────────────────────────────── */

describe("client gate (D5)", () => {
  it("feature off → refused for everyone on the client entry", async () => {
    await col("customerworkspaces").updateOne({ _id: WS_A }, { $set: { "config.features.travelPolicyEnabled": false } });
    const r = await client(LEADER_A, WS_A).get("/");
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("FEATURE_OFF");
  });

  it("leader edits; approver reads only; requester and a deactivated leader are refused", async () => {
    expect((await client(LEADER_A, WS_A).post("/draft", { from: "TEMPLATE" })).status).toBe(201);

    const ap = client(APPROVER_A, WS_A);
    const ov = await ap.get("/");
    expect(ov.status).toBe(200);
    expect(ov.body.access).toEqual({ canWrite: false, entry: "CLIENT" });
    expect((await ap.get("/mapping")).status).toBe(200);
    expect((await ap.get("/audit")).status).toBe(200);
    const w = await ap.put("/draft", { content: { name: "x" } });
    expect(w.status).toBe(403);
    expect(w.body.code).toBe("TRAVEL_POLICY_READ_ONLY");
    expect((await ap.post("/draft/publish", { effectiveFrom: "2099-01-01" })).status).toBe(403);
    expect((await ap.post("/cities", { name: "Bhilai", category: "TIER2" })).status).toBe(403);

    expect((await client(REQUESTER_A, WS_A).get("/")).status).toBe(403);
    expect((await client(EXLEADER_A, WS_A).get("/")).status).toBe(403);
  });

  it("TENANT_ADMIN is a client admin on the client entry (D6)", async () => {
    const r = await client(TENANT_ADMIN_A, WS_A).post("/draft", { from: "BLANK" });
    expect(r.status).toBe(201);
    const audit: any = await TravelPolicyAudit.findOne({ workspaceId: WS_A, action: "DRAFT_CREATED" }).lean();
    expect(audit.actor).toMatchObject({ kind: "CLIENT_ADMIN", name: "Tina TenantAdmin" });
  });

  it("Plumtrips staff are sent to the staff entry", async () => {
    const r = await client(SUPER, oid(HOUSE)).get("/");
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("USE_STAFF_ENTRY");
  });
});

describe("staff gate (D6)", () => {
  it("TENANT_ADMIN never passes the staff entry, even holding the grant", async () => {
    const r = await staff(TENANT_ADMIN_A).get(`/w/${WS_A}/`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("TRAVEL_POLICY_ACCESS_REQUIRED");
    expect((await staff(TENANT_ADMIN_A).get("/workspaces")).status).toBe(403);
  });

  it("a HOUSE user without the grant is refused, whatever their role", async () => {
    expect((await staff(STAFF_NONE).get(`/w/${WS_A}/`)).status).toBe(403);
  });

  it("READ grant views (even with the client flag off); WRITE grant edits and is audited as PLUMTRIPS_STAFF", async () => {
    await col("customerworkspaces").updateOne({ _id: WS_A }, { $set: { "config.features.travelPolicyEnabled": false } });
    const ro = await staff(STAFF_RO).get(`/w/${WS_A}/`);
    expect(ro.status).toBe(200);
    expect(ro.body.access).toEqual({ canWrite: false, entry: "STAFF" });
    expect(ro.body.workspace.travelPolicyEnabled).toBe(false);
    expect((await staff(STAFF_RO).post(`/w/${WS_A}/draft`, { from: "BLANK" })).status).toBe(403);

    const rw = await staff(STAFF_RW).post(`/w/${WS_A}/draft`, { from: "TEMPLATE" });
    expect(rw.status).toBe(201);
    const audit: any = await TravelPolicyAudit.findOne({ workspaceId: WS_A, action: "DRAFT_CREATED" }).lean();
    expect(audit.actor).toMatchObject({ kind: "PLUMTRIPS_STAFF", id: STAFF_RW._id, name: "Wani Staff", email: "wani@plumtrips.com" });
    expect(audit.workspaceName).toBe("Acme Pvt Ltd");
  });

  it("SuperAdmin passes; the HOUSE workspace and unknown ids are not targets; the picker excludes HOUSE", async () => {
    expect((await staff(SUPER).get(`/w/${WS_B}/`)).status).toBe(200);
    expect((await staff(SUPER).get(`/w/${HOUSE}/`)).status).toBe(404);
    expect((await staff(SUPER).get(`/w/${oid()}/`)).status).toBe(404);
    expect((await staff(SUPER).get(`/w/not-an-id/`)).status).toBe(404);
    const pick = await staff(SUPER).get("/workspaces?q=a");
    expect(pick.status).toBe(200);
    expect(pick.body.workspaces.map((w: any) => w._id)).not.toContain(HOUSE);
  });
});

/* ── Mapping + KPIs ──────────────────────────────────────────────────── */

describe("mapping and KPIs (D2/D3)", () => {
  it("resolves by designation and band, honours overrides, excludes Guests from coverage", async () => {
    const a = actor(LEADER_A);
    const bandUser = oid();
    await col("users").insertOne({ _id: bandUser, email: "b@a.test", bandNumber: 9 } as any);
    const [t1, t2, t3, t4] = [oid(), oid(), oid(), oid()];
    await col("travellerprofiles").insertMany([
      { _id: t1, workspaceId: WS_A, firstName: "Des", lastName: "Mapped", designationId: DESIG_A, isActive: true },
      { _id: t2, workspaceId: WS_A, firstName: "Band", lastName: "Mapped", claimedBy: bandUser, isActive: true },
      { _id: t3, workspaceId: WS_A, firstName: "No", lastName: "Body", isActive: true },
      { _id: t4, workspaceId: WS_A, firstName: "Visiting", lastName: "Consultant", isActive: true },
      { workspaceId: WS_A, firstName: "Gone", lastName: "Away", isActive: false },
      { workspaceId: WS_B, firstName: "Other", lastName: "Company", isActive: true },
    ] as any[]);
    const d: any = await svc.createDraft(WS_A, a, { from: "TEMPLATE" });
    const tiers = d.tiers.map((t: any) =>
      t.tierKey === "mid" ? { ...t, designationIds: [String(DESIG_A)] } : t.tierKey === "leadership" ? { ...t, bandNumbers: [9, 10] } : t,
    );
    await svc.saveDraft(WS_A, a, { tiers, rules: d.rules });

    await svc.setAssignments(WS_A, a, { travellerProfileIds: [String(t4)], excluded: "GUEST", reason: "Consultant" });
    let ov = await svc.getOverview(WS_A);
    expect(ov.kpis).toMatchObject({ travellers: 4, employees: 3, guests: 1, mapped: 2, unmapped: 1, coverage: 66.7 });
    expect(ov.health.find((h) => h.id === "unmapped")?.text).toMatch(/^1 employee not mapped/);

    await svc.setAssignments(WS_A, a, { travellerProfileIds: [String(t3)], tierKey: "junior", reason: "New joiner" });
    const m = await svc.getMapping(WS_A);
    const by = new Map(m.rows.map((r) => [r.name, r.resolution]));
    expect(by.get("Des Mapped")).toMatchObject({ tierKey: "mid", source: "DESIGNATION" });
    expect(by.get("Band Mapped")).toMatchObject({ tierKey: "leadership", source: "BAND" });
    expect(by.get("No Body")).toMatchObject({ tierKey: "junior", source: "OVERRIDE" });
    expect(by.get("Visiting Consultant")?.status).toBe("GUEST");
    ov = await svc.getOverview(WS_A);
    expect(ov.kpis).toMatchObject({ employees: 3, mapped: 3, unmapped: 0, coverage: 100 });

    // an unknown tier is refused; clearing an override is audited
    await expect(svc.setAssignments(WS_A, a, { travellerProfileIds: [String(t3)], tierKey: "nope" })).rejects.toMatchObject({ status: 400 });
    await svc.setAssignments(WS_A, a, { travellerProfileIds: [String(t3)], clear: true, reason: "undo" });
    expect(await TravelPolicyAudit.countDocuments({ workspaceId: WS_A, action: "ASSIGNMENT_CLEARED" })).toBe(1);
  });

  it("Not configured: an empty workspace gets no rules and no template fallback", async () => {
    const ov = await svc.getOverview(WS_B, istToday());
    expect(ov.active).toBeNull();
    expect(ov.basis).toBeNull();
    expect(ov.kpis.rules).toBe(0);
    expect(ov.health[0]).toMatchObject({ id: "not-configured", severity: "error" });
    expect(await svc.resolveVersionAt(WS_B, addDays(istToday(), 30))).toBeNull();
  });
});
