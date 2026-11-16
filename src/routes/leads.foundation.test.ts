// CRM disposition foundation (batch 1) — against REAL collections
// (mongodb-memory-server). docs/audits/crm-disposition-audit.md findings:
//   P1-1  PUT /leads/:id is an allow-list: owner / conversion / disposition /
//         stage / status keys are ignored, so reassignment goes only through
//         POST /:id/assign (FULL gate + activity + cascade).
//   P1-2  with CRM_V2_DISPOSITION on, every legacy stage writer answers 409
//         (PUT /:id/stage, bulk stage / status, /win, /lose, /convert); off,
//         they behave exactly as before.
//   P1-7  inactive sub-dispositions are hidden from the pickers and refused as
//         a NEW pick (single, bulk, import) while leads already on one still
//         read normally.
//   P2-13 GETs never seed crmpipelines; startup / the seed script does.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/leads-foundation-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const ids = {
  ADMIN: new mongoose.Types.ObjectId().toHexString(),
  REP: new mongoose.Types.ObjectId().toHexString(),
  OTHER: new mongoose.Types.ObjectId().toHexString(),
};
const USERS: Record<string, any> = {
  admin: { id: ids.ADMIN, sub: ids.ADMIN, roles: ["ADMIN"], email: "ops@plumtrips.com", name: "Ops Admin" },
  rep: { id: ids.REP, sub: ids.REP, roles: ["EMPLOYEE"], email: "rep@plumtrips.com", name: "Rep" },
  other: { id: ids.OTHER, sub: ids.OTHER, roles: ["EMPLOYEE"], email: "other@plumtrips.com", name: "Other" },
};

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = USERS[String(req.headers["x-test-user"] || "admin")];
    next();
  },
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireHouse.js", () => ({
  requireHouse: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

const { default: Lead } = await import("../models/Lead.js");
const { default: LeadActivity } = await import("../models/LeadActivity.js");
const { default: Opportunity } = await import("../models/Opportunity.js");
const { default: CrmPipeline } = await import("../models/CrmPipeline.js");
const { default: User } = await import("../models/User.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { default: leadsRouter } = await import("./leads.js");
const { CRM_V2_DISPOSITION_ENV, CRM_V2_OPPORTUNITY_ENV } = await import("../config/crmV2.js");
const { ensureDefaultPipeline } = await import("../services/crmPipelines.js");

let mongod: MongoMemoryServer;
function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/leads", leadsRouter);
  return a;
}
type Who = "admin" | "rep" | "other";
const get = (who: Who, path: string) => request(app()).get(`/api${path}`).set("x-test-user", who);
const post = (who: Who, path: string, body: any = {}) => request(app()).post(`/api${path}`).set("x-test-user", who).send(body);
const put = (who: Who, path: string, body: any = {}) => request(app()).put(`/api${path}`).set("x-test-user", who).send(body);

const REP = new mongoose.Types.ObjectId(ids.REP);
const OTHER = new mongoose.Types.ObjectId(ids.OTHER);
let seq = 0;
async function lead(o: Record<string, any> = {}) {
  seq += 1;
  const _id = new mongoose.Types.ObjectId();
  const now = new Date();
  await Lead.collection.insertOne({
    _id, leadCode: `LEAD-F-${String(seq).padStart(4, "0")}`, type: "company", companyName: `Co ${seq}`, contactName: `Person ${seq}`, contactPhone: `9${String(seq).padStart(9, "0")}`,
    stage: "new", source: "manual", dealValue: 0, currency: "INR", assignedTo: REP, assignedToName: "Rep", createdAt: now, updatedAt: now, ...o,
  } as any);
  return _id;
}
const setFlags = (dispo: boolean) => {
  if (dispo) process.env[CRM_V2_DISPOSITION_ENV] = "true";
  else delete process.env[CRM_V2_DISPOSITION_ENV];
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Opportunity.syncIndexes();
  await CrmPipeline.syncIndexes();
  const perm = (userId: string, email: string, access: string, scope: string) => ({
    userId, email, workspaceId: "69679a7628330a58d29f2254", universe: "STAFF", level: { code: "L2", name: "Executive" },
    modules: { leads: { access, scope } }, grantedBy: ids.ADMIN,
  });
  await UserPermission.create([perm(ids.REP, "rep@plumtrips.com", "WRITE", "OWN"), perm(ids.OTHER, "other@plumtrips.com", "WRITE", "OWN")] as any);
  await User.collection.insertMany(Object.values(USERS).map((u) => ({ _id: new mongoose.Types.ObjectId(u.id), name: u.name, email: u.email, roles: u.roles, passwordHash: "x" })) as any[]);
}, 120_000);
afterAll(async () => {
  delete process.env[CRM_V2_DISPOSITION_ENV];
  delete process.env[CRM_V2_OPPORTUNITY_ENV];
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all([Lead.deleteMany({}), LeadActivity.deleteMany({}), Opportunity.deleteMany({}), CrmPipeline.deleteMany({})]);
  setFlags(true);
  process.env[CRM_V2_OPPORTUNITY_ENV] = "true";
});

/* ───────────────────────── P1-1 ───────────────────────── */

describe("PUT /leads/:id — allow-list (P1-1)", () => {
  it("a WRITE+OWN rep sending assignedTo via PUT does not change the owner; editable fields still save", async () => {
    const id = await lead();
    const r = await put("rep", `/leads/${id}`, {
      assignedTo: ids.OTHER, assignedToName: "Other", contactName: "Renamed", dealValue: 5000, notes: "n",
      convertedToContactId: new mongoose.Types.ObjectId().toHexString(), possibleDuplicateOf: new mongoose.Types.ObjectId().toHexString(),
      importBatchId: "X", onboardingToken: "tok", attribution: { channel: "whatsapp" },
      disposition: "Onboarded", subDisposition: "Onboarded", dispositionStage: "Onboarded", dispositionStatus: "Won", stage: "won", status: "CONVERTED",
    });
    expect(r.status).toBe(200);
    expect(r.body.ignored).toEqual(expect.arrayContaining(["assignedTo", "assignedToName", "convertedToContactId", "possibleDuplicateOf", "importBatchId", "onboardingToken", "attribution", "disposition", "subDisposition", "dispositionStage", "dispositionStatus", "stage", "status"]));
    const l = (await Lead.findById(id).lean())!;
    expect(String(l.assignedTo)).toBe(ids.REP);
    expect(l.assignedToName).toBe("Rep");
    expect(l).toMatchObject({ contactName: "Renamed", dealValue: 5000, notes: "n", stage: "new" });
    // raw-inserted rows lack the defaulted fields — absent and empty both mean "not written"
    expect(l.convertedToContactId ?? null).toBeNull();
    expect(l.possibleDuplicateOf ?? null).toBeNull();
    for (const k of ["importBatchId", "onboardingToken", "disposition", "subDisposition", "dispositionStage", "dispositionStatus"] as const) expect((l as any)[k] ?? "", k).toBe("");
    expect(l.status ?? null).not.toBe("CONVERTED");
    expect(l.attribution?.channel ?? "").toBe("");
    // no assignment activity was written by the PUT
    expect(await LeadActivity.countDocuments({ leadId: id, type: "assignment" })).toBe(0);
  });

  it("reassignment still works through POST /:id/assign for an admin (activity + opportunity cascade)", async () => {
    const id = await lead();
    await Opportunity.create({ pipeline: "corporate", stage: "qualified", leadId: id, ownerUserId: REP, ownerName: "Rep" });
    const r = await post("admin", `/leads/${id}/assign`, { userId: ids.OTHER });
    expect(r.status).toBe(200);
    expect(String((await Lead.findById(id).lean())!.assignedTo)).toBe(ids.OTHER);
    expect(await LeadActivity.countDocuments({ leadId: id, type: "assignment" })).toBe(1);
    await new Promise((res) => setTimeout(res, 50)); // the cascade is fire-and-forget
    expect(String((await Opportunity.findOne({ leadId: id }).lean())!.ownerUserId)).toBe(ids.OTHER);
  });
});

/* ───────────────────────── P1-2 ───────────────────────── */

describe("legacy stage writers with dispositions ON → 409 (P1-2)", () => {
  it("PUT /:id/stage, /win, /lose, /convert answer 409 on the caller's own lead and change nothing", async () => {
    const id = await lead({ stage: "contacted" });
    for (const [method, path, body] of [
      ["put", `/leads/${id}/stage`, { stage: "lost" }],
      ["post", `/leads/${id}/win`, {}],
      ["post", `/leads/${id}/lose`, { lostReason: "x" }],
      ["post", `/leads/${id}/convert`, {}],
    ] as const) {
      const r = method === "put" ? await put("rep", path, body) : await post("rep", path, body);
      expect(r.status, path).toBe(409);
      expect(r.body.error, path).toMatch(/set a disposition/i);
    }
    expect((await Lead.findById(id).lean())!.stage).toBe("contacted");
    expect(await LeadActivity.countDocuments({ leadId: id })).toBe(0);
  });

  it("another rep's lead is still 403 (ownership is checked first)", async () => {
    const id = await lead({ assignedTo: OTHER });
    expect((await put("rep", `/leads/${id}/stage`, { stage: "lost" })).status).toBe(403);
    expect((await post("rep", `/leads/${id}/win`)).status).toBe(403);
  });

  it("bulk stage and bulk status answer 409 before touching any lead", async () => {
    const id = await lead();
    const s = await post("admin", "/leads/bulk", { action: "stage", target: { leadIds: [String(id)] }, params: { stage: "lost" } });
    expect(s.status).toBe(409);
    expect(s.body.error).toMatch(/set a disposition/i);
    const st = await post("admin", "/leads/bulk", { action: "status", target: { leadIds: [String(id)] }, params: { status: "LOST" } });
    expect(st.status).toBe(409);
    expect((await Lead.findById(id).lean())!.stage).toBe("new");
  });

  it("dispositions OFF → the same calls behave exactly as before", async () => {
    setFlags(false);
    const id = await lead({ stage: "contacted" });
    const r = await put("rep", `/leads/${id}/stage`, { stage: "proposal_sent" });
    expect(r.status).toBe(200);
    expect((await Lead.findById(id).lean())!.stage).toBe("proposal_sent");
    const w = await post("rep", `/leads/${id}/win`);
    expect(w.status).toBe(200);
    expect((await Lead.findById(id).lean())!.stage).toBe("won");
    const b = await post("admin", "/leads/bulk", { action: "stage", target: { leadIds: [String(await lead())] }, params: { stage: "contacted" } });
    expect(b.status).toBe(200);
    expect(b.body.summary.updated).toBe(1);
  });
});

/* ───────────────────────── P1-7 / P2-13 ───────────────────────── */

describe("pipeline seeding and inactive sub-dispositions (P1-7, P2-13)", () => {
  it("GETs never seed crmpipelines; with no row they answer 503", async () => {
    const id = await lead();
    expect((await get("admin", "/leads/dispositions")).status).toBe(503);
    expect((await get("admin", `/leads/${id}/dispositions`)).status).toBe(503);
    expect(await CrmPipeline.countDocuments({})).toBe(0);
    const w = await post("admin", `/leads/${id}/disposition`, { subDisposition: "Repeated RNR" });
    expect(w.status).toBe(503);
    expect(await CrmPipeline.countDocuments({})).toBe(0);
  });

  it("an inactive sub is hidden from both pickers and refused as a new pick (single / bulk / import); a lead already on it still reads", async () => {
    const p = await ensureDefaultPipeline();
    // v2 seed: "Trust Issue" is one of the 11 retired v1 subs
    expect(p.dispositionSet.find((e) => e.subDisposition === "Trust Issue")!.active).toBe(false);
    // a lead dispositioned under v1, stamped exactly as v1 left it
    const onIt = await lead({
      pipelineId: p._id, disposition: "Not Interested", subDisposition: "Trust Issue", dispositionStage: "Lost", dispositionStatus: "Lost",
      dispositionAt: new Date(), stage: "lost", status: "LOST", lostReason: "Trust Issue",
    });

    const subsOf = (body: any) => body.groups.flatMap((g: any) => g.subs.map((s: any) => s.subDisposition));
    const g1 = await get("admin", "/leads/dispositions");
    expect(g1.status).toBe(200);
    expect(subsOf(g1.body)).not.toContain("Trust Issue");
    expect(subsOf(g1.body)).toContain("Repeated RNR");
    expect(subsOf(g1.body)).toHaveLength(21);
    const g2 = await get("admin", `/leads/${onIt}/dispositions`);
    expect(subsOf(g2.body)).not.toContain("Trust Issue");
    // the lead on the inactive sub still displays its current disposition
    expect(g2.body.current).toMatchObject({ disposition: "Not Interested", subDisposition: "Trust Issue", stage: "Lost", status: "Lost" });
    const one = await get("admin", `/leads/${onIt}`);
    expect(one.status).toBe(200);
    expect(one.body.lead).toMatchObject({ disposition: "Not Interested", subDisposition: "Trust Issue", dispositionStatus: "Lost", stage: "lost", status: "LOST" });

    const fresh = await lead();
    const s = await post("admin", `/leads/${fresh}/disposition`, { subDisposition: "trust issue" });
    expect(s.status).toBe(400);
    expect(s.body.error).toMatch(/no longer in use/);
    const b = await post("admin", "/leads/bulk", { action: "disposition", target: { leadIds: [String(fresh)] }, params: { subDisposition: "Trust Issue" } });
    expect(b.status).toBe(400);
    expect(b.body.error).toMatch(/no longer in use/);
    const imp = await post("admin", "/leads/import/preview", {
      rows: [{ Name: "A", Phone: "9000000001", Disposition: "Not Interested", "Sub-disposition": "Trust Issue" }],
      mapping: { Name: "contactName", Phone: "contactPhone", Disposition: "disposition", "Sub-disposition": "subDisposition" },
    });
    expect(imp.status).toBe(200);
    expect(imp.body.rows[0].valid).toBe(false);
    expect(imp.body.rows[0].errors.join(" ")).toMatch(/no longer in use/);
    expect((await Lead.findById(fresh).lean())!.subDisposition ?? "").toBe("");
  });
});

/* ─────────── prod's real shape: entries stored with NO `active` key ─────────── */

describe("a pipeline row stored before `active` existed (entries have no active key)", () => {
  async function rawPipeline() {
    const { CORPORATE_CALLING_PIPELINE, CORPORATE_CALLING_SET } = await import("../models/crmDisposition.js");
    const set = CORPORATE_CALLING_SET.map((e: any) => {
      const { active: _drop, ...rest } = e;
      return rest;
    });
    expect(set.every((e: any) => !("active" in e))).toBe(true);
    const now = new Date();
    const _id = new mongoose.Types.ObjectId();
    // the RAW collection, like the prod row: no model defaults applied
    await CrmPipeline.collection.insertOne({ _id, ...CORPORATE_CALLING_PIPELINE, dispositionSet: set, teamIds: [], active: true, createdAt: now, updatedAt: now } as any);
    return { _id, total: set.length };
  }
  const subsOf = (body: any) => body.groups.flatMap((g: any) => g.subs.map((s: any) => s.subDisposition));

  it("pickers list every entry, single / bulk / import picks work, and nothing writes active back", async () => {
    const { _id, total } = await rawPipeline();
    expect(total).toBe(32);
    const id = await lead();

    const g1 = await get("admin", "/leads/dispositions");
    expect(g1.status).toBe(200);
    expect(subsOf(g1.body)).toHaveLength(32);
    const g2 = await get("admin", `/leads/${id}/dispositions`);
    expect(g2.status).toBe(200);
    expect(subsOf(g2.body)).toHaveLength(32);

    const s = await post("rep", `/leads/${id}/disposition`, { subDisposition: "Trust Issue" });
    expect(s.status).toBe(200);
    expect((await Lead.findById(id).lean())!).toMatchObject({ subDisposition: "Trust Issue", dispositionStatus: "Lost" });

    const other = await lead();
    const b = await post("admin", "/leads/bulk", { action: "disposition", target: { leadIds: [String(other)] }, params: { disposition: "Onboarded" } });
    expect(b.status).toBe(200);
    expect((await Lead.findById(other).lean())!.subDisposition).toBe("Onboarded");

    const imp = await post("admin", "/leads/import/preview", {
      rows: [{ Name: "A", Phone: "9000000002", Disposition: "Not Interested", "Sub-disposition": "Trust Issue" }],
      mapping: { Name: "contactName", Phone: "contactPhone", Disposition: "disposition", "Sub-disposition": "subDisposition" },
    });
    expect(imp.status).toBe(200);
    expect(imp.body.rows[0].valid, imp.body.rows[0].errors?.join(" ")).toBe(true);

    const tpl = await get("admin", "/leads/import/template");
    expect(tpl.status).toBe(200);

    // reads and picks never rewrote the stored row
    const raw: any = await CrmPipeline.collection.findOne({ _id });
    expect(raw.dispositionSet.some((e: any) => "active" in e)).toBe(false);
  });

  it("lean (raw) entries: the template offers all 32 subs and the importer resolves them", async () => {
    await rawPipeline();
    const { buildImportTemplate } = await import("../services/leadImportTemplate.js");
    const { resolveDispositionCells } = await import("../services/leadImport.js");
    const lean: any = await CrmPipeline.findOne({}).lean();
    expect(lean.dispositionSet.some((e: any) => "active" in e)).toBe(false);
    const wb = buildImportTemplate({ reps: [], dispositionSet: lean.dispositionSet, exampleOwner: null, ownScope: false });
    const cells: string[] = [];
    wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => cells.push(String(c.value ?? "")))));
    for (const e of lean.dispositionSet) expect(cells, e.subDisposition).toContain(e.subDisposition);
    for (const e of lean.dispositionSet) expect("entry" in resolveDispositionCells(e.disposition, e.subDisposition, lean.dispositionSet), e.subDisposition).toBe(true);
    expect("entry" in resolveDispositionCells("Onboarded", "", lean.dispositionSet)).toBe(true);
  });
});
